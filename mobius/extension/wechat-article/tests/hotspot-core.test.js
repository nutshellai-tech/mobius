const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const core = require('../backend/lib/hotspot-core');
const store = require('../backend/lib/store');
const hotspotStore = require('../backend/lib/hotspot-store');

test('RSS/Atom items keep source trust and reported time', () => {
  const source = core.DEFAULT_SOURCES.find((x) => x.kind === 'official');
  const date = new Date().toUTCString();
  const xml = `<rss><channel><item><title><![CDATA[OpenAI 发布 Agent 工具]]></title><link>https://openai.com/news/agent?utm_source=x</link><pubDate>${date}</pubDate><description>官方发布新的 Agent 能力</description></item></channel></rss>`;
  const rows = core.parseFeed(xml, source);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].official, 1);
  assert.equal(rows[0].date_confidence, 'reported');
  assert.equal(rows[0].language, 'zh');
});

test('deterministic fallback merges strongly related same-language reports', () => {
  const base = { published_at: new Date().toISOString(), language: 'zh' };
  const groups = core.deterministicGroups([
    { ...base, id: 'a', title: 'OpenAI 发布 Agent 工具调用新能力', summary: '新的 Agent 工具调用与自动化能力' },
    { ...base, id: 'b', title: 'OpenAI Agent 工具调用能力正式发布', summary: 'Agent 可调用工具完成自动化任务' },
    { ...base, id: 'c', title: '英伟达发布新一代 GPU 芯片', summary: '面向数据中心的 GPU 算力与显存升级' },
  ]);
  assert.equal(groups.length, 2);
  assert.equal(groups.some((g) => g.items.length === 2), true);
});

test('hotspot persistence creates traceable topic prefill', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-hotspot-test-'));
  const db = store.open(dir);
  try {
    hotspotStore.seedSources(db, core.DEFAULT_SOURCES);
    const search = hotspotStore.createSearch(db, { query: 'Agent', window_hours: 72, region: 'all', categories: [] });
    const source = core.DEFAULT_SOURCES[0];
    const item = {
      id: 'hi_test', source_id: source.id, title: 'OpenAI 发布 Agent 新能力', url: 'https://openai.com/news/agent',
      summary: '官方发布新的 Agent 工具调用能力', published_at: new Date().toISOString(), fetched_at: new Date().toISOString(),
      content_hash: 'hash_test', raw_excerpt: '官方发布', language: 'zh', official: 1, date_confidence: 'reported',
      metadata: { source_name: source.name, tier: source.tier, kind: source.kind, region: source.region },
    };
    hotspotStore.upsertItems(db, [item]);
    const clusters = await core.clusterAndScore([item], { searchId: search.id, windowHours: 72, query: 'Agent', profile: {}, categories: [], provider: null });
    hotspotStore.replaceClusters(db, search.id, clusters);
    hotspotStore.updateSearch(db, search.id, { status: 'done', coverage: { attempted: 1, succeeded: 1 }, result_count: 1, completed_at: new Date().toISOString() });
    const listed = hotspotStore.listHotspots(db, { searchId: search.id });
    assert.equal(listed.hotspots.length, 1);
    assert.equal(listed.hotspots[0].risk, 'official_confirmed');
    const topic = hotspotStore.createTopic(db, listed.hotspots[0], {}, { audience: 'AI 开发者' });
    assert.equal(topic.prefill.audience, 'AI 开发者');
    assert.deepEqual(topic.prefill.referenceUrls, ['https://openai.com/news/agent']);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
