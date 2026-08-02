// lib/store.js — SQLite 持久层（better-sqlite3）。
// 约束（SKILL + 方案 §5）：handler/worker 每次开关连接（stateless / 进程即用即弃）；
// WAL + foreign_keys + busy_timeout；网络请求绝不放进事务；迁移走 PRAGMA user_version。
// 库文件落 ext_data_dir/data.db。表覆盖方案 §5 全部核心实体（source/hot_item/hot_cluster/
// account_profile/topic/evidence/claim/article/article_version/article_image/operation/style_profile/published_history）。

const path = require("path");
const fs = require("fs");
let Database;
try { Database = require("better-sqlite3"); } catch (e) { Database = null; }

const SCHEMA_VERSION = 1;
const DB_FILE = "data.db";
const now = () => new Date().toISOString();
const SINGLE = "default"; // 单用户：account_profile / style_profile 用固定 id

function open(extDataDir) {
  if (!Database) throw new Error("better-sqlite3 不可用（依赖 mobius/node_modules 解析）");
  if (!extDataDir) throw new Error("ext_data_dir 缺失");
  fs.mkdirSync(extDataDir, { recursive: true });
  const db = new Database(path.join(extDataDir, DB_FILE));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

function close(db) { try { db && db.close(); } catch (_) {} }

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS source (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT, url TEXT, tier TEXT,
      weight REAL DEFAULT 1, enabled INTEGER DEFAULT 1,
      success_count INTEGER DEFAULT 0, fail_count INTEGER DEFAULT 0, consec_fail INTEGER DEFAULT 0,
      last_check TEXT, created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS hot_item (
      id TEXT PRIMARY KEY, source_id TEXT, title TEXT, url TEXT, summary TEXT,
      published_at TEXT, fetched_at TEXT, content_hash TEXT UNIQUE, raw_excerpt TEXT, created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_hotitem_pub ON hot_item(published_at);
    CREATE TABLE IF NOT EXISTS hot_cluster (
      id TEXT PRIMARY KEY, canonical_title TEXT, entities TEXT, item_ids TEXT,
      source_count INTEGER DEFAULT 0, spread_speed REAL DEFAULT 0, cn_heat REAL DEFAULT 0,
      account_match REAL DEFAULT 0, evidence_strength REAL DEFAULT 0, total_score REAL DEFAULT 0,
      risk TEXT, created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS account_profile (
      id TEXT PRIMARY KEY, positioning TEXT, audience TEXT, forbidden TEXT, goals TEXT, tone TEXT, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS topic (
      id TEXT PRIMARY KEY, origin TEXT, cluster_id TEXT,
      title TEXT, angle TEXT, audience TEXT, framework TEXT, score REAL DEFAULT 0, questions TEXT,
      created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS evidence (
      id TEXT PRIMARY KEY, article_id TEXT, source_url TEXT, source_name TEXT, author TEXT,
      published_at TEXT, fetched_at TEXT, excerpt TEXT, content_hash TEXT, tier TEXT, created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_evidence_article ON evidence(article_id);
    CREATE TABLE IF NOT EXISTS claim (
      id TEXT PRIMARY KEY, article_id TEXT, paragraph_idx INTEGER, claim_text TEXT, risk TEXT,
      evidence_id TEXT, relation TEXT, resolved INTEGER DEFAULT 0, note TEXT, created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_claim_article ON claim(article_id);
    CREATE TABLE IF NOT EXISTS article (
      id TEXT PRIMARY KEY, topic_id TEXT, job_id TEXT,
      title TEXT, author TEXT, digest TEXT, body_md TEXT, body_html TEXT,
      framework TEXT, outline TEXT, state TEXT, ai_declaration TEXT,
      cover_url TEXT, cover_media_id TEXT, quality TEXT, cost TEXT,
      created_at TEXT, updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_article_state ON article(state);
    CREATE TABLE IF NOT EXISTS article_version (
      id TEXT PRIMARY KEY, article_id TEXT, version_no INTEGER,
      title TEXT, digest TEXT, body_md TEXT, note TEXT, created_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_version_article ON article_version(article_id);
    CREATE TABLE IF NOT EXISTS article_image (
      id TEXT PRIMARY KEY, article_id TEXT, kind TEXT, position INTEGER, prompt TEXT,
      file_path TEXT, content_hash TEXT, wx_media_id TEXT, wx_url TEXT, created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS operation (
      id TEXT PRIMARY KEY, kind TEXT, input_hash TEXT, status TEXT, external_id TEXT,
      cost_tokens INTEGER DEFAULT 0, cost_amount REAL DEFAULT 0, result_excerpt TEXT,
      created_at TEXT, updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_operation_hash ON operation(input_hash, kind);
    CREATE TABLE IF NOT EXISTS style_profile (
      id TEXT PRIMARY KEY, tone TEXT, structure TEXT, syntax TEXT, opinion_strength TEXT,
      banned_phrases TEXT, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS published_history (
      id TEXT PRIMARY KEY, article_id TEXT, media_id TEXT, pushed_at TEXT,
      edit_minutes REAL, retention_rate REAL, published INTEGER DEFAULT 0, note TEXT
    );
  `);
  const cur = db.pragma("user_version", { simple: true }) || 0;
  if (cur < SCHEMA_VERSION) db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

// ---------- 单用户档案 ----------
function getProfile(db) { return db.prepare("SELECT * FROM account_profile WHERE id=?").get(SINGLE) || null; }
function setProfile(db, p) {
  db.prepare(`INSERT INTO account_profile (id,positioning,audience,forbidden,goals,tone,updated_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET positioning=excluded.positioning,audience=excluded.audience,forbidden=excluded.forbidden,
      goals=excluded.goals,tone=excluded.tone,updated_at=excluded.updated_at`)
    .run(SINGLE, p.positioning || "", p.audience || "", p.forbidden || "", p.goals || "", p.tone || "", now());
  return getProfile(db);
}
function getStyle(db) { return db.prepare("SELECT * FROM style_profile WHERE id=?").get(SINGLE) || null; }
function setStyle(db, s) {
  db.prepare(`INSERT INTO style_profile (id,tone,structure,syntax,opinion_strength,banned_phrases,updated_at) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET tone=excluded.tone,structure=excluded.structure,syntax=excluded.syntax,
      opinion_strength=excluded.opinion_strength,banned_phrases=excluded.banned_phrases,updated_at=excluded.updated_at`)
    .run(SINGLE, s.tone || "", s.structure || "", s.syntax || "", s.opinion_strength || "", s.banned_phrases || "", now());
  return getStyle(db);
}

// ---------- article CRUD（业务状态在 DB；执行态在 jobs/ 文件） ----------
function upsertArticle(db, a) {
  const row = db.prepare("SELECT id FROM article WHERE id=?").get(a.id);
  if (row) {
    db.prepare(`UPDATE article SET topic_id=COALESCE(@topic_id,topic_id),job_id=COALESCE(@job_id,job_id),
      title=COALESCE(@title,title),author=COALESCE(@author,author),digest=COALESCE(@digest,digest),
      body_md=COALESCE(@body_md,body_md),body_html=COALESCE(@body_html,body_html),
      framework=COALESCE(@framework,framework),outline=COALESCE(@outline,outline),state=COALESCE(@state,state),
      ai_declaration=COALESCE(@ai_declaration,ai_declaration),cover_url=COALESCE(@cover_url,cover_url),
      cover_media_id=COALESCE(@cover_media_id,cover_media_id),quality=COALESCE(@quality,quality),
      cost=COALESCE(@cost,cost),updated_at=@updated_at WHERE id=@id`)
      .run({ id: a.id, topic_id: a.topic_id ?? null, job_id: a.job_id ?? null, title: a.title ?? null,
        author: a.author ?? null, digest: a.digest ?? null, body_md: a.body_md ?? null,
        body_html: a.body_html ?? null, framework: a.framework ?? null, outline: a.outline ?? null,
        state: a.state ?? null, ai_declaration: a.ai_declaration ?? null, cover_url: a.cover_url ?? null,
        cover_media_id: a.cover_media_id ?? null, quality: a.quality ?? null, cost: a.cost ?? null, updated_at: now() });
  } else {
    db.prepare(`INSERT INTO article (id,topic_id,job_id,title,author,digest,body_md,body_html,framework,outline,
      state,ai_declaration,cover_url,cover_media_id,quality,cost,created_at,updated_at)
      VALUES (@id,@topic_id,@job_id,@title,@author,@digest,@body_md,@body_html,@framework,@outline,
      @state,@ai_declaration,@cover_url,@cover_media_id,@quality,@cost,@c,@u)`)
      .run({ id: a.id, topic_id: a.topic_id ?? null, job_id: a.job_id ?? null, title: a.title ?? null,
        author: a.author ?? null, digest: a.digest ?? null, body_md: a.body_md ?? null, body_html: a.body_html ?? null,
        framework: a.framework ?? null, outline: a.outline ?? null, state: a.state ?? null,
        ai_declaration: a.ai_declaration ?? null, cover_url: a.cover_url ?? null, cover_media_id: a.cover_media_id ?? null,
        quality: a.quality ?? null, cost: a.cost ?? null, c: now(), u: now() });
  }
  return db.prepare("SELECT * FROM article WHERE id=?").get(a.id);
}
function getArticle(db, id) { return db.prepare("SELECT * FROM article WHERE id=?").get(id) || null; }
function listArticles(db, limit = 50) {
  return db.prepare("SELECT id,title,state,framework,digest,cover_url,created_at,updated_at FROM article ORDER BY updated_at DESC LIMIT ?").all(limit);
}

module.exports = { open, close, migrate, SINGLE, now,
  getProfile, setProfile, getStyle, setStyle,
  upsertArticle, getArticle, listArticles };
