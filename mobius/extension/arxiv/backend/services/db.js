/**
 * arxiv/backend/services/db.js — SQLite 持久层.
 *
 * 落盘位置: ${ext_data_dir}/arxiv.db
 * 表:
 *   topics(id, name, query, schedule_cron, interval_minutes, is_active, last_fetched_at, created_at, updated_at)
 *   papers(id, topic_id, arxiv_id, title, authors, abstract, summary, url, published_at, created_at)
 *   paper_web_results(id, paper_id, title, url, snippet, source, created_at)
 *
 * 约束: handler 在 worker_thread 内运行, 每次新建 DB 连接, 完成后关闭 (避免跨调用持有文件锁).
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
  `);
  return db;
}

function close() {
  if (db) {
    try { db.close(); } catch { /* noop */ }
    db = null;
  }
}

module.exports = { open, close };
