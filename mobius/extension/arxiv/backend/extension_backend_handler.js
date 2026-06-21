/**
 * arxiv/backend/extension_backend_handler.js — Arxiv 论文抓取拓展的入口.
 *
 * 协议: 由 mobius/backend/services/extension-invoker.js 在 worker_thread 内 require.
 *   入参 { username, display_name, ext_main_payload, ext_data_dir, extension_name, logger }
 *   出参 { ok: true, ... } 或 { ok: false, error: '...' }
 *
 * 路由 (按 ext_main_payload.action):
 *   - list_topics                 → 返回所有主题 (含 is_preset 标记)
 *   - list_presets                → 返回 4 个预置模板 (key/name/query/interval), 用于前端"从预置添加"
 *   - add_topic { name, query, schedule_cron?, interval_minutes?, preset_key? } → 新增 + 注册 cron
 *   - update_topic { topic_id, name?, query?, interval_minutes? } → 更新主题 + 重建 cron
 *   - delete_topic { topic_id }   → 删主题 + 取消 cron
 *   - refresh_topic { topic_id }  → 立即抓取一次
 *   - list_papers { topic_id, limit? } → 返回主题的论文列表
 *   - scheduled_fetch (内部)      → cron 触发的抓取, 由 extension-scheduler 调用
 *
 * 预置 (seed) 主题:
 *   4 个预置 (VLA / 世界生成 / 在线RL / Agent) 首次打开 db 时通过 dbSvc.seedPresets 注入;
 *   标记 is_preset=1, preset_key 唯一; 用户可编辑/删除, 删除后不会自动恢复.
 *   想重新添加某个已删除的预置, 用前端的 "从预置添加" 下拉 (调 add_topic, 传 preset_key).
 *
 * cron 持久化:
 *   handler 严格 stateless, 不能持有 timer. 走 mobius 已有的 extension-scheduler:
 *     - 写 schedule 文件到 ${ext_data_dir}/schedules/<topic_id>.json
 *     - extension-scheduler 每 60s 扫一次, 命中后调回本 handler 的 scheduled_fetch
 *     - 删主题 = rm 调度文件 + 清表
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const dbSvc = require('./services/db');
const arxivFetcher = require('./services/arxiv-fetcher');
const webSearchSvc = require('./services/web-search');
const summarizer = require('./services/paper-summarizer');

const DEFAULT_INTERVAL_MINUTES = 60;
const MIN_INTERVAL_MINUTES = 5;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
const MAX_FETCH_PER_TICK = 20;

const PRESETS = [
  {
    key: 'vla',
    name: 'VLA',
    title: 'Vision-Language-Action',
    query: 'cat:cs.RO AND ("vision-language-action" OR VLA OR "robot foundation model")',
    schedule_cron: '0 9 * * *',
    interval_minutes: 360,
  },
  {
    key: 'world',
    name: '世界生成',
    title: 'World Models & Generative Simulation',
    query: 'cat:cs.LG AND ("world model" OR "generative simulation" OR "video generation")',
    schedule_cron: '0 9 * * *',
    interval_minutes: 360,
  },
  {
    key: 'online-rl',
    name: '在线RL',
    title: 'Online Reinforcement Learning',
    query: 'cat:cs.LG AND ("online reinforcement learning" OR "continual reinforcement learning" OR "adaptive RL")',
    schedule_cron: '0 9 * * *',
    interval_minutes: 240,
  },
  {
    key: 'agent',
    name: 'Agent',
    title: 'Agentic Systems',
    query: 'cat:cs.AI AND ("LLM agent" OR "autonomous agent" OR "tool use")',
    schedule_cron: '0 9 * * *',
    interval_minutes: 240,
  },
];

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function clampInterval(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_INTERVAL_MINUTES;
  return Math.max(MIN_INTERVAL_MINUTES, Math.min(MAX_INTERVAL_MINUTES, Math.floor(v)));
}

function newId() {
  return 't_' + crypto.randomBytes(6).toString('hex');
}

function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function writeSchedule({ dataDir, userId, topic, payload }) {
  const dir = path.join(dataDir, 'schedules');
  ensureDir(dir);
  const file = path.join(dir, `${topic.id}.json`);
  const nextRun = new Date(Date.now() + topic.interval_minutes * 60_000).toISOString();
  writeJsonAtomic(file, {
    id: topic.id,
    extension_name: 'arxiv',
    user_id: userId,
    enabled: true,
    interval_minutes: topic.interval_minutes,
    next_run_at: nextRun,
    payload: { action: 'scheduled_fetch', topic_id: topic.id, ...payload },
    updated_at: nowIso(),
  });
  return file;
}

function removeSchedule(dataDir, topicId) {
  const file = path.join(dataDir, 'schedules', `${topicId}.json`);
  try { fs.unlinkSync(file); } catch { /* noop */ }
  try { fs.unlinkSync(file + '.lock'); } catch { /* noop */ }
}

// ===== actions =====

function actionListTopics(db) {
  const rows = db.prepare(`
    SELECT id, name, query, schedule_cron, interval_minutes, is_active,
           is_preset, preset_key, last_fetched_at, last_status, last_error,
           created_at, updated_at
      FROM topics
     ORDER BY is_preset DESC, created_at DESC
  `).all();
  return rows.map((r) => ({
    ...r,
    is_active: !!r.is_active,
    is_preset: !!r.is_preset,
  }));
}

function actionListPresets() {
  // 只返回模板 (key/name/query/interval/title), 不带任何 db id.
  // 前端用 key 判断 "是否已添加", 调 add_topic 时把 key 传回来.
  return { ok: true, presets: PRESETS.map((p) => ({ ...p })) };
}

function actionAddTopic({ db, username, extDataDir, extMainPayload }) {
  const name = String(extMainPayload.name || '').trim().slice(0, 100);
  const query = String(extMainPayload.query || '').trim().slice(0, 500);
  const scheduleCron = String(extMainPayload.schedule_cron || '0 9 * * *').trim().slice(0, 60);
  const intervalMinutes = clampInterval(extMainPayload.interval_minutes);
  const presetKey = String(extMainPayload.preset_key || '').trim() || null;
  if (!name) return { ok: false, error: 'name 不能为空' };
  if (!query) return { ok: false, error: 'query 不能为空' };

  // 预置恢复: 如果传了 preset_key 且 db 里没有该 key 的行, 标记为预置; 否则报错
  let isPreset = 0;
  if (presetKey) {
    const exists = db.prepare('SELECT id, name FROM topics WHERE preset_key = ?').get(presetKey);
    if (exists) {
      return { ok: false, error: `预置「${exists.name}」已存在, 不能重复添加` };
    }
    isPreset = 1;
  }

  const id = newId();
  const now = nowIso();
  db.prepare(`
    INSERT INTO topics (id, name, query, schedule_cron, interval_minutes, is_active, is_preset, preset_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
  `).run(id, name, query, scheduleCron, intervalMinutes, isPreset, presetKey, now, now);

  const topic = { id, name, query, schedule_cron: scheduleCron, interval_minutes: intervalMinutes };
  writeSchedule({ dataDir: extDataDir, userId: username, topic, payload: {} });
  return {
    ok: true,
    topic: {
      ...topic,
      is_active: true,
      is_preset: !!isPreset,
      preset_key: presetKey,
      created_at: now,
      updated_at: now,
    },
  };
}

function actionUpdateTopic({ db, extDataDir, extMainPayload }) {
  const id = String(extMainPayload.topic_id || '').trim();
  if (!id) return { ok: false, error: 'topic_id 必填' };
  const existing = db.prepare('SELECT id, name, query, schedule_cron, interval_minutes, is_active FROM topics WHERE id = ?').get(id);
  if (!existing) return { ok: false, error: '主题不存在' };

  const fields = [];
  const values = [];
  if (typeof extMainPayload.name === 'string') {
    const name = extMainPayload.name.trim().slice(0, 100);
    if (!name) return { ok: false, error: 'name 不能为空' };
    fields.push('name = ?'); values.push(name);
  }
  if (typeof extMainPayload.query === 'string') {
    const query = extMainPayload.query.trim().slice(0, 500);
    if (!query) return { ok: false, error: 'query 不能为空' };
    fields.push('query = ?'); values.push(query);
  }
  if (extMainPayload.interval_minutes != null) {
    fields.push('interval_minutes = ?'); values.push(clampInterval(extMainPayload.interval_minutes));
  }
  if (!fields.length) return { ok: false, error: '没有可更新的字段' };
  fields.push('updated_at = ?'); values.push(nowIso());
  values.push(id);
  db.prepare(`UPDATE topics SET ${fields.join(', ')} WHERE id = ?`).run(...values);

  // query 变化 → 重建 cron; interval 变化 → 重建 cron; name 变化不动调度
  const cronChanged = (typeof extMainPayload.query === 'string') || (extMainPayload.interval_minutes != null);
  if (cronChanged) {
    const fresh = db.prepare('SELECT id, name, query, schedule_cron, interval_minutes, is_active FROM topics WHERE id = ?').get(id);
    // query 改了时, 让下一次抓取自然走新查询, 不强制重抓
    writeSchedule({ dataDir: extDataDir, userId: existing.name, topic: fresh, payload: {} });
  }
  const topic = db.prepare('SELECT id, name, query, schedule_cron, interval_minutes, is_active, last_fetched_at, last_status, last_error, created_at, updated_at FROM topics WHERE id = ?').get(id);
  return { ok: true, topic: { ...topic, is_active: !!topic.is_active } };
}

function actionDeleteTopic({ db, extDataDir, extMainPayload }) {
  const id = String(extMainPayload.topic_id || '').trim();
  if (!id) return { ok: false, error: 'topic_id 必填' };
  // 先拿要删的 web_results (papers 主键), 然后 papers, 然后 topic
  const paperIds = db.prepare('SELECT id FROM papers WHERE topic_id = ?').all(id).map((r) => r.id);
  const delPwr = db.prepare('DELETE FROM paper_web_results WHERE paper_id = ?');
  for (const pid of paperIds) delPwr.run(pid);
  db.prepare('DELETE FROM papers WHERE topic_id = ?').run(id);
  db.prepare('DELETE FROM topics WHERE id = ?').run(id);
  removeSchedule(extDataDir, id);
  return { ok: true, removed: { topic_id: id, papers: paperIds.length } };
}

async function doFetch({ db, extDataDir, topic, logger }) {
  const since = topic.last_fetched_at || new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const existingIds = db.prepare('SELECT arxiv_id FROM papers WHERE topic_id = ?').all(topic.id).map((r) => r.arxiv_id);
  const { fresh, total } = await arxivFetcher.fetchNew({
    query: topic.query,
    maxResults: MAX_FETCH_PER_TICK,
    since,
    existingIds,
  });
  let inserted = 0;
  const now = nowIso();
  const insertPaper = db.prepare(`
    INSERT OR IGNORE INTO papers (topic_id, arxiv_id, title, authors, abstract, summary, url, published_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPwr = db.prepare(`
    INSERT INTO paper_web_results (paper_id, title, url, snippet, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const p of fresh) {
    const summary = await summarizer.summarize({ title: p.title, abstract: p.abstract });
    const info = insertPaper.run(
      topic.id, p.arxiv_id, p.title,
      JSON.stringify(p.authors || []), p.abstract, summary,
      p.url, p.published_at, now
    );
    if (info.changes === 0) continue; // 已被并发插入
    inserted += 1;
    const paperId = info.lastInsertRowid;
    try {
      const web = await webSearchSvc.searchForPaper({
        arxivId: p.arxiv_id,
        title: p.title,
        abstract: p.abstract,
        dataDir: extDataDir,
        logger,
      });
      for (const w of web) {
        insertPwr.run(paperId, w.title, w.url, w.snippet || '', w.source || 'other', now);
      }
    } catch (e) {
      if (logger) logger.warn(`web-search skipped for ${p.arxiv_id}: ${e.message}`);
    }
  }
  db.prepare('UPDATE topics SET last_fetched_at = ?, last_status = ?, last_error = ? WHERE id = ?')
    .run(now, 'ok', '', topic.id);
  return { ok: true, fetched: total, inserted, topic_id: topic.id };
}

async function actionRefreshTopic({ db, extDataDir, logger, extMainPayload }) {
  const id = String(extMainPayload.topic_id || '').trim();
  if (!id) return { ok: false, error: 'topic_id 必填' };
  const topic = db.prepare('SELECT * FROM topics WHERE id = ?').get(id);
  if (!topic) return { ok: false, error: 'topic 不存在' };
  return await doFetch({ db, extDataDir, topic, logger });
}

async function actionScheduledFetch({ db, extDataDir, logger, extMainPayload }) {
  const id = String(extMainPayload.topic_id || '').trim();
  if (!id) return { ok: false, error: 'topic_id 必填' };
  const topic = db.prepare('SELECT * FROM topics WHERE id = ?').get(id);
  if (!topic) {
    // 主题已删, 调度器不知道, 我们吃掉这个 tick
    return { ok: true, skipped: 'topic gone' };
  }
  if (!topic.is_active) {
    return { ok: true, skipped: 'inactive' };
  }
  try {
    return await doFetch({ db, extDataDir, topic, logger });
  } catch (e) {
    const msg = e.message || String(e);
    if (logger) logger.warn(`scheduled_fetch failed for ${id}: ${msg}`);
    db.prepare('UPDATE topics SET last_status = ?, last_error = ? WHERE id = ?')
      .run('error', msg, id);
    return { ok: false, error: msg };
  }
}

function actionListPapers({ db, extMainPayload }) {
  const topicId = String(extMainPayload.topic_id || '').trim();
  if (!topicId) return { ok: false, error: 'topic_id 必填' };
  const limit = Math.max(1, Math.min(200, Number(extMainPayload.limit) || 50));
  const papers = db.prepare(`
    SELECT id, topic_id, arxiv_id, title, authors, abstract, summary, url, published_at, created_at
      FROM papers
     WHERE topic_id = ?
     ORDER BY (published_at IS NULL), published_at DESC, id DESC
     LIMIT ?
  `).all(topicId, limit);
  const pwrStmt = db.prepare(`
    SELECT id, title, url, snippet, source, created_at
      FROM paper_web_results
     WHERE paper_id = ?
     ORDER BY id ASC
  `);
  const out = papers.map((p) => ({
    ...p,
    authors: safeJson(p.authors, []),
    web_results: pwrStmt.all(p.id),
  }));
  return { ok: true, papers: out, total: out.length };
}

function safeJson(s, fallback) {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : fallback; }
  catch { return fallback; }
}

// ===== entry =====

module.exports = async function arxivHandler({
  username,
  display_name,
  ext_main_payload,
  ext_data_dir,
  logger,
}) {
  const payload = ext_main_payload || {};
  const action = String(payload.action || '').trim();

  let db;
  try {
    db = dbSvc.open(ext_data_dir);
  } catch (e) {
    if (logger) logger.error('db open failed: ' + e.message);
    return { ok: false, error: 'db init failed' };
  }

  // 首次打开 db 时注入预置主题; idempotent. 对新插入的行同步写 schedule 文件,
  // 让 extension-scheduler 知道按 interval 触发抓取.
  try {
    const seeded = dbSvc.seedPresets(PRESETS);
    for (const s of seeded) {
      writeSchedule({
        dataDir: ext_data_dir,
        userId: username,
        topic: {
          id: s.id,
          name: s.name,
          query: s.query,
          schedule_cron: '0 9 * * *',
          interval_minutes: s.interval_minutes,
        },
        payload: {},
      });
    }
  } catch (e) {
    if (logger) logger.warn('seedPresets failed: ' + e.message);
  }

  try {
    switch (action) {
      case 'list_topics':
        return { ok: true, topics: actionListTopics(db) };
      case 'list_presets':
        return actionListPresets();
      case 'add_topic':
        return actionAddTopic({ db, username, extDataDir: ext_data_dir, extMainPayload: payload });
      case 'update_topic':
        return actionUpdateTopic({ db, extDataDir: ext_data_dir, extMainPayload: payload });
      case 'delete_topic':
        return actionDeleteTopic({ db, extDataDir: ext_data_dir, extMainPayload: payload });
      case 'refresh_topic':
        return await actionRefreshTopic({ db, extDataDir: ext_data_dir, logger, extMainPayload: payload });
      case 'list_papers':
        return actionListPapers({ db, extMainPayload: payload });
      case 'scheduled_fetch':
        return await actionScheduledFetch({ db, extDataDir: ext_data_dir, logger, extMainPayload: payload });
      default:
        return { ok: false, error: `unknown action: ${action}` };
    }
  } catch (e) {
    if (logger) logger.error(`action ${action} failed: ${e.message}`);
    return { ok: false, error: e.message || 'handler error' };
  } finally {
    // 每次调用结束关连接, 严格 stateless, 不持连接/不持 timer
    dbSvc.close();
  }
};
