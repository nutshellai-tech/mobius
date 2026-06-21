/**
 * arxiv/backend/services/db.js — SQLite 持久层.
 *
 * 落盘位置: ${ext_data_dir}/arxiv.db
 * 表:
 *   topics(id, name, query, schedule_cron, interval_minutes, is_active,
 *          is_preset, preset_key, last_fetched_at, last_status, last_error,
 *          created_at, updated_at)
 *   papers(id, topic_id, arxiv_id, title, authors, abstract, summary, url, published_at, created_at)
 *   paper_web_results(id, paper_id, title, url, snippet, source, created_at)
 *
 * 约束: handler 在 worker_thread 内运行, 每次新建 DB 连接, 完成后关闭 (避免跨调用持有文件锁).
 *
 * 预置 (seed) 主题:
 *   通过 seedPresets(presets) 注入; 标识 preset_key, 用于去重和"恢复已删除预置"功能.
 *   用户已删除的预置不会被自动恢复 (尊重用户意图).
 */
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

let db = null;

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function open(dataDir) {
  if (db) return db;
  ensureDir(dataDir);
  const dbPath = path.join(dataDir, 'arxiv.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS topics (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      query           TEXT NOT NULL,
      schedule_cron   TEXT NOT NULL DEFAULT '0 9 * * *',
      interval_minutes INTEGER NOT NULL DEFAULT 60,
      is_active       INTEGER NOT NULL DEFAULT 1,
      is_preset       INTEGER NOT NULL DEFAULT 0,
      preset_key      TEXT,
      last_fetched_at TEXT,
      last_status     TEXT,
      last_error      TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS papers (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      topic_id      TEXT NOT NULL,
      arxiv_id      TEXT NOT NULL,
      title         TEXT NOT NULL,
      authors       TEXT NOT NULL,
      abstract      TEXT NOT NULL,
      summary       TEXT NOT NULL,
      url           TEXT NOT NULL,
      published_at  TEXT,
      created_at    TEXT NOT NULL,
      UNIQUE(topic_id, arxiv_id)
    );
    CREATE INDEX IF NOT EXISTS idx_papers_topic ON papers(topic_id);
    CREATE TABLE IF NOT EXISTS paper_web_results (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      paper_id   INTEGER NOT NULL,
      title      TEXT NOT NULL,
      url        TEXT NOT NULL,
      snippet    TEXT,
      source     TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (paper_id) REFERENCES papers(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_pwr_paper ON paper_web_results(paper_id);
    CREATE TABLE IF NOT EXISTS _meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // 兼容老库: 老 topics 表没有 is_preset/preset_key, 补上.
  // 必须在 CREATE INDEX 之前跑, 否则索引会引用不存在的列.
  const cols = db.prepare('PRAGMA table_info(topics)').all().map((c) => c.name);
  if (!cols.includes('is_preset')) {
    db.exec('ALTER TABLE topics ADD COLUMN is_preset INTEGER NOT NULL DEFAULT 0');
  }
  if (!cols.includes('preset_key')) {
    db.exec('ALTER TABLE topics ADD COLUMN preset_key TEXT');
  }

  // 现在 preset_key 列肯定存在, 才可以建唯一索引 (partial: 只约束非 NULL 值)
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_topics_preset_key
      ON topics(preset_key) WHERE preset_key IS NOT NULL`);
  } catch (e) {
    // 索引可能因为已有重复 preset_key 数据而失败; 记 warn, 不阻塞启动
    console.warn('[arxiv db] unique index on preset_key failed:', e.message);
  }

  return db;
}

/**
 * 注入 4 个预置主题. 行为:
 *   - 只在 "首次" 调用时执行 (靠 _meta.presets_seeded 标记).
 *   - 后续调用直接跳过, 避免用户删了又被自动塞回来.
 *   - 首次注入时, 已有同 name 但无 preset_key 的旧行 → 标记为对应预置 (保留用户编辑过的 query);
 *     没有则插入新行 (id = preset_<key>).
 *
 * 返回新插入的 rows (供 handler 注册 schedule 文件).
 */
function seedPresets(presets) {
  if (!Array.isArray(presets) || !presets.length) return [];
  const seen = db.prepare('SELECT value FROM _meta WHERE key = ?').get('presets_seeded');
  if (seen) return [];

  const now = new Date().toISOString();
  const findByKey = db.prepare('SELECT id FROM topics WHERE preset_key = ?');
  const findByName = db.prepare('SELECT id FROM topics WHERE name = ? AND preset_key IS NULL');
  const tagExisting = db.prepare('UPDATE topics SET preset_key = ?, is_preset = 1, updated_at = ? WHERE id = ?');
  const insert = db.prepare(`
    INSERT INTO topics (id, name, query, schedule_cron, interval_minutes, is_active, is_preset, preset_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?)
  `);
  const inserted = [];
  for (const p of presets) {
    const key = String(p.key || '').trim();
    if (!key) continue;
    const byKey = findByKey.get(key);
    if (byKey) continue;
    const byName = findByName.get(String(p.name || '').trim());
    if (byName) {
      tagExisting.run(key, now, byName.id);
      continue;
    }
    insert.run(
      `preset_${key}`,
      String(p.name || '').trim(),
      String(p.query || '').trim(),
      String(p.schedule_cron || '0 9 * * *'),
      Number(p.interval) || 60,
      key,
      now,
      now
    );
    inserted.push({
      id: `preset_${key}`,
      key,
      name: p.name,
      query: p.query,
      interval_minutes: p.interval || 60,
    });
  }
  db.prepare('INSERT INTO _meta (key, value) VALUES (?, ?)').run('presets_seeded', now);
  return inserted;
}

function close() {
  if (db) {
    try { db.close(); } catch { /* noop */ }
    db = null;
  }
}

module.exports = { open, close, seedPresets };
