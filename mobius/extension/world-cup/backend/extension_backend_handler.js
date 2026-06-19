/**
 * world-cup/backend/extension_backend_handler.js
 *
 * 世界杯内容聚合后端，职责：
 *   - 周期性抓取 RSS / feed（公开体育媒体 world-cup / football 频道）
 *   - 去重、清洗、本地 JSON 存储（不会清空旧数据）
 *   - 对前端提供 read（聚合内容）/ sync_now（强制刷新）/ whoami / sources_meta
 *
 * 全部外部内容视为不可信：长度截断、标签剥离、HTML 转义交给前端。
 *
 * 存储：ext_data_dir 是唯一可写区
 *   - news.json       抓回来的新闻条目（去重、按时间倒序、带来源/抓取时间/许可）
 *   - sync_state.json 最近一次同步状态（成功源数、失败源数、时间戳、degraded 标记）
 *   - sync_log.jsonl  最近 N 次同步日志（覆盖式 ring buffer）
 *
 * 数据流：cron（外部）→ sync_now → 写 news.json → 前端 read 只读 news.json。
 */

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const EXTENSION_NAME = 'world-cup';
const MAX_NEWS_ITEMS = 200;       // 存储上限
const PER_SOURCE_LIMIT = 18;      // 每个 RSS 源最多保留条数
const SYNC_LOG_LIMIT = 80;        // 同步日志 ring buffer 上限
const FETCH_TIMEOUT_MS = 4000;
const FETCH_RETRIES = 1;

// RSS / feed 来源 —— 公开频道，全部只读 GET。
// 来源说明与授权信息：BBC / Guardian / Sky Sports / ESPN 均提供公开 RSS，
// 仅供本站做"标题 + 摘要 + 链接"的导览，原文版权归原媒体所有。
const RSS_SOURCES = [
  { id: 'bbc-football',    name: 'BBC Sport · Football',    url: 'https://feeds.bbci.co.uk/sport/football/rss.xml' },
  { id: 'guardian-football', name: 'The Guardian · Football', url: 'https://www.theguardian.com/football/rss' },
  { id: 'sky-sports-football', name: 'Sky Sports · Football News', url: 'https://www.skysports.com/rss/12040' },
  { id: 'espn-soccer',     name: 'ESPN · Soccer',           url: 'https://www.espn.com/espn/rss/soccer/news' },
];

// 世界杯相关关键词：用于在抓回的 feed 里做相关性排序（不剔除其他条目）
const WORLD_CUP_KEYWORDS = [
  'world cup', 'wc26', 'wc2026', 'fifa', 'international duty',
  '世界杯', '世预赛', '国家队', '国际比赛',
  // 常见强队英文名（用于把国家队新闻往上排）
  'argentina', 'brazil', 'france', 'england', 'spain', 'germany', 'portugal',
  'netherlands', 'italy', 'belgium', 'croatia', 'mexico', 'usa', 'japan', 'korea',
];

// ----- 工具函数 -----

function sha1(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex');
}

function nowIso() { return new Date().toISOString(); }

function clampInt(n, fallback, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(v)));
}

function trimText(value, max = 500) {
  const s = String(value || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

function decodeHtml(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/<[^>]+>/g, ' ')   // 剥离描述里的标签
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTag(block, tag) {
  const re = new RegExp(`<(?:[a-z0-9_-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[a-z0-9_-]+:)?${tag}>`, 'i');
  const m = block.match(re);
  return m ? decodeHtml(m[1]) : '';
}

function extractAtomLink(block) {
  // 优先取 rel="alternate" 的 link
  const alt = block.match(/<link\b[^>]*\brel=["']alternate["'][^>]*\bhref=["']([^"']+)["']/i)
         || block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']alternate["']/i);
  if (alt) return decodeHtml(alt[1]);
  const any = block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i);
  return any ? decodeHtml(any[1]) : '';
}

function normalizeDate(value) {
  if (!value) return nowIso();
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : nowIso();
}

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'MobiusWorldCupHub/0.1 (+local content aggregation; contact: admin)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      },
      redirect: 'follow',
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetries(url, logger) {
  let lastErr;
  for (let i = 0; i <= FETCH_RETRIES; i++) {
    try {
      return await fetchWithTimeout(url);
    } catch (e) {
      lastErr = e;
      if (i < FETCH_RETRIES) {
        await new Promise((r) => setTimeout(r, 600 * (i + 1)));
      }
    }
  }
  logger?.warn(`fetch failed: ${url} — ${lastErr?.message || lastErr}`);
  throw lastErr || new Error('fetch failed');
}

// 解析 RSS 2.0 / Atom 1.0
function parseFeed(raw, source) {
  const items = [];
  const blocks = raw.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  for (const block of blocks) {
    const title = extractTag(block, 'title');
    const link = extractTag(block, 'link') || extractTag(block, 'guid');
    if (!title || !link) continue;
    const summary = extractTag(block, 'description') || extractTag(block, 'summary');
    // 媒体缩略图：media:thumbnail / enclosure / media:content
    let image = '';
    const mThumb = block.match(/<media:thumbnail\b[^>]*\burl=["']([^"']+)["']/i);
    const mContent = block.match(/<media:content\b[^>]*\burl=["']([^"']+)["']/i);
    const enc = block.match(/<enclosure\b[^>]*\burl=["']([^"']+)["'][^>]*\btype=["']image\//i);
    image = (mThumb && mThumb[1]) || (mContent && mContent[1]) || (enc && enc[1]) || '';
    items.push({
      source: source.name,
      source_id: source.id,
      title,
      summary,
      url: link,
      image,
      image_license: '© ' + source.name,
      ts: normalizeDate(extractTag(block, 'pubDate') || extractTag(block, 'date')),
      raw_source: 'rss',
    });
  }
  const entries = raw.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  for (const block of entries) {
    const title = extractTag(block, 'title');
    const url = extractAtomLink(block) || extractTag(block, 'id');
    if (!title || !url) continue;
    items.push({
      source: source.name,
      source_id: source.id,
      title,
      summary: extractTag(block, 'summary') || extractTag(block, 'content'),
      url,
      image: '',
      image_license: '© ' + source.name,
      ts: normalizeDate(extractTag(block, 'updated') || extractTag(block, 'published')),
      raw_source: 'atom',
    });
  }
  return items;
}

function scoreRelevance(text) {
  const t = text.toLowerCase();
  let score = 0;
  for (const kw of WORLD_CUP_KEYWORDS) if (t.includes(kw)) score += 1;
  return score;
}

function normalizeItem(raw) {
  const title = trimText(raw.title, 220);
  const url = trimText(raw.url, 900);
  const summary = trimText(raw.summary || '', 600);
  const image = trimText(raw.image || '', 900);
  const dedupeKey = sha1((url || title).toLowerCase());
  const relevance = scoreRelevance(`${title} ${summary}`);
  return {
    id: sha1(`${dedupeKey}:${title}`).slice(0, 16),
    dedupe_key: dedupeKey,
    title,
    summary,
    url,
    image,
    image_license: trimText(raw.image_license || raw.source || '', 80),
    source: trimText(raw.source || '', 80),
    source_id: trimText(raw.source_id || '', 40),
    ts: normalizeDate(raw.ts),
    relevance,
    first_seen_at: nowIso(),
    fetched_at: nowIso(),
  };
}

// ----- 持久化 -----

async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

async function writeJson(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

async function appendSyncLog(logFile, entry) {
  let list = [];
  try { list = JSON.parse(await fs.readFile(logFile, 'utf8')); } catch {}
  list.push(entry);
  if (list.length > SYNC_LOG_LIMIT) list = list.slice(-SYNC_LOG_LIMIT);
  await fs.writeFile(logFile, JSON.stringify(list, null, 2));
}

// ----- 占位 / 示例数据（兜底） -----

function placeholderContent() {
  // 仅在所有真实源失败、且没有任何旧数据时使用，每条都标 sample:true
  const ts = nowIso();
  return [
    {
      id: 'sample-1',
      dedupe_key: 'sample-fifa-overview',
      title: 'FIFA 世界杯概述（示例数据）',
      summary: 'FIFA 世界杯是全球国家队最高荣誉的足球赛事，每四年举办一次。2026 年由加拿大、墨西哥、美国联合主办，48 队参赛，赛程覆盖 6 月 11 日至 7 月 19 日。',
      url: 'https://www.fifa.com/fifaplus/en/tournaments/mens/worldcup/canadamexicousa2026',
      image: 'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6e/FIFA_World_Cup_Trophy.jpg/1280px-FIFA_World_Cup_Trophy.jpg',
      image_license: '© FIFA / Wikimedia',
      source: '示例数据',
      source_id: 'sample',
      ts,
      relevance: 5,
      first_seen_at: ts,
      fetched_at: ts,
      sample: true,
    },
    {
      id: 'sample-2',
      dedupe_key: 'sample-host-cities',
      title: '2026 东道主：加拿大 · 墨西哥 · 美国（示例数据）',
      summary: '2026 世界杯为史上首次三国联办，比赛分布在 16 座城市：加拿大 2 城、墨西哥 3 城、美国 11 城。决赛将在纽约大都会体育场举行。',
      url: 'https://en.wikipedia.org/wiki/2026_FIFA_World_Cup',
      image: 'https://upload.wikimedia.org/wikipedia/commons/thumb/9/97/MetLife_Stadium_%28cropped%29.jpg/1280px-MetLife_Stadium_%28cropped%29.jpg',
      image_license: '© Wikimedia Commons',
      source: '示例数据',
      source_id: 'sample',
      ts,
      relevance: 3,
      first_seen_at: ts,
      fetched_at: ts,
      sample: true,
    },
    {
      id: 'sample-3',
      dedupe_key: 'sample-format',
      title: '赛制：48 队 · 12 组 · 32 强淘汰（示例数据）',
      summary: '2026 起世界杯扩军至 48 支球队，分为 12 个小组每组 4 队。各组前 2 名 + 8 个成绩最佳的第 3 名晋级 32 强，淘汰赛轮次扩展为 5 轮。',
      url: 'https://en.wikipedia.org/wiki/2026_FIFA_World_Cup#Format',
      image: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/42/Soccer_ball.svg/512px-Soccer_ball.svg.png',
      image_license: '© Wikimedia Commons / Public Domain',
      source: '示例数据',
      source_id: 'sample',
      ts,
      relevance: 2,
      first_seen_at: ts,
      fetched_at: ts,
      sample: true,
    },
  ];
}

// ----- 同步 -----

async function doSync({ ext_data_dir, logger, force }) {
  const newsFile = path.join(ext_data_dir, 'news.json');
  const stateFile = path.join(ext_data_dir, 'sync_state.json');
  const logFile = path.join(ext_data_dir, 'sync_log.jsonl');

  const existing = await readJson(newsFile, []);
  const existingMap = new Map();
  for (const item of existing) existingMap.set(item.dedupe_key, item);

  const fetchedRaw = [];
  const sourceResults = [];
  // 并发抓取（每源 4s × 2 尝试 = ≤8s；并发总时长受单源最大值约束）
  const results = await Promise.allSettled(
    RSS_SOURCES.map(async (source) => {
      const raw = await fetchWithRetries(source.url, logger);
      return { source, items: parseFeed(raw, source).slice(0, PER_SOURCE_LIMIT) };
    })
  );
  for (let i = 0; i < RSS_SOURCES.length; i++) {
    const source = RSS_SOURCES[i];
    const r = results[i];
    if (r.status === 'fulfilled') {
      for (const it of r.value.items) fetchedRaw.push(it);
      sourceResults.push({ id: source.id, name: source.name, ok: true, items: r.value.items.length });
      logger?.info(`rss ok: ${source.id} items=${r.value.items.length}`);
    } else {
      const msg = String(r.reason?.message || r.reason || 'unknown');
      sourceResults.push({ id: source.id, name: source.name, ok: false, error: msg.slice(0, 200) });
      logger?.warn(`rss fail: ${source.id} — ${msg}`);
    }
  }

  // 合并：新抓回的覆盖旧条目的 fetched_at；relevance 取最大；其余字段保留较新的 fetched
  for (const raw of fetchedRaw) {
    const norm = normalizeItem(raw);
    const prev = existingMap.get(norm.dedupe_key);
    if (prev) {
      existingMap.set(norm.dedupe_key, {
        ...prev,
        ...norm,
        relevance: Math.max(prev.relevance || 0, norm.relevance),
        first_seen_at: prev.first_seen_at,
        fetched_at: nowIso(),
        sample: false,
      });
    } else {
      existingMap.set(norm.dedupe_key, norm);
    }
  }

  let merged = Array.from(existingMap.values());
  // 排序：sample 沉到底部；其余按 ts 倒序
  merged.sort((a, b) => {
    if (!!a.sample !== !!b.sample) return a.sample ? 1 : -1;
    return (b.ts || '').localeCompare(a.ts || '');
  });

  const okCount = sourceResults.filter((s) => s.ok).length;
  const degraded = okCount === 0;

  if (merged.length === 0) {
    // 全源失败且无历史 → 兜底占位
    merged = placeholderContent();
    logger?.warn('all sources failed AND no cached news; using placeholder seed');
  } else if (degraded) {
    // 全源失败但有旧数据 → 保留旧数据，标记 degraded
    logger?.warn('all sources failed; keeping cached news');
  }

  // 落地前裁剪到上限（保留 sample 兜底）
  const capped = merged.slice(0, MAX_NEWS_ITEMS);

  await writeJson(newsFile, capped);
  const state = {
    last_sync_at: nowIso(),
    last_sync_status: degraded ? 'degraded' : (okCount === RSS_SOURCES.length ? 'ok' : 'partial'),
    ok_sources: okCount,
    total_sources: RSS_SOURCES.length,
    cached_items: capped.length,
    degraded,
    sources: sourceResults,
  };
  await writeJson(stateFile, state);
  await appendSyncLog(logFile, {
    at: state.last_sync_at,
    status: state.last_sync_status,
    ok: okCount,
    total: RSS_SOURCES.length,
    fetched: fetchedRaw.length,
    kept: capped.length,
    forced: !!force,
  });
  return state;
}

// ----- 主 handler -----

module.exports = async function worldCupHandler({
  username,
  display_name,
  ext_main_payload,
  ext_data_dir,
  logger,
}) {
  const action = ext_main_payload && ext_main_payload.action;

  try {
    if (action === 'whoami') {
      return { ok: true, username, display_name: display_name || username || '' };
    }

    if (action === 'sources_meta') {
      return {
        ok: true,
        sources: RSS_SOURCES.map((s) => ({
          id: s.id, name: s.name,
          // 不暴露 URL 到前端也没必要；这里给一份说明就够了
          kind: 'rss',
          license: '© ' + s.name + ' (公开 RSS，仅作标题/摘要导览，原文版权归原作者所有)',
        })),
      };
    }

    if (action === 'sync_now') {
      const state = await doSync({ ext_data_dir, logger, force: true });
      return { ok: true, state };
    }

    if (action === 'read') {
      const newsFile = path.join(ext_data_dir, 'news.json');
      const stateFile = path.join(ext_data_dir, 'sync_state.json');
      let news = await readJson(newsFile, null);
      let state = await readJson(stateFile, null);
      if (!news || news.length === 0) {
        // 首次访问：先尝试同步，失败则用占位
        try {
          state = await doSync({ ext_data_dir, logger, force: false });
          news = await readJson(newsFile, []);
        } catch (e) {
          logger?.warn(`initial sync failed: ${e.message || e}`);
        }
        if (!news || news.length === 0) {
          news = placeholderContent();
          state = state || {
            last_sync_at: null,
            last_sync_status: 'never',
            degraded: true,
            ok_sources: 0,
            total_sources: RSS_SOURCES.length,
            cached_items: news.length,
            sources: [],
          };
        }
      }
      const limit = clampInt(ext_main_payload.limit, 60, 1, 200);
      return {
        ok: true,
        news: news.slice(0, limit),
        total_cached: news.length,
        state,
        server_time: nowIso(),
      };
    }

    return { ok: false, error: 'unknown action' };
  } catch (e) {
    logger?.error(`handler error: ${e.stack || e.message || e}`);
    return { ok: false, error: 'internal error' };
  }
};
