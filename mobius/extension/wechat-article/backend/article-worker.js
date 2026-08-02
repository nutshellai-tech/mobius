#!/usr/bin/env node
// article-worker.js — detached 长任务编排（方案 §4）。
// 由 handler 经 spawn(process.execPath, [__filename, specPath], {detached:true}) 启动，与 30s 的 handler 隔离。
// 读 argv[2] = spec.json（含 jobId / extDataDir / topic / mode / articleId）。10s 心跳；阶段推进写 checkpoint；
// 协作式取消（阶段间查 status.state===cancelled）+ 强制取消（handler 杀进程组）。
// 状态机：queued→researching→outlining→writing→reviewing→(waiting_user|rendering→uploading)→done。
// 无微信凭据时停在 waiting_user（产出可编辑稿 + 微信预览），不强行推送。

const fs = require("fs"), path = require("path");

const specPath = process.argv[2];
if (!specPath) { console.error("article-worker: missing spec path"); process.exit(2); }
let SPEC;
try { SPEC = JSON.parse(fs.readFileSync(specPath, "utf8")); }
catch (e) { console.error("article-worker: bad spec: " + e.message); process.exit(2); }

const { extDataDir, mode } = SPEC;
const jobId = SPEC.jobId || SPEC.id; // createJob 写入字段名为 id
if (!extDataDir || !jobId) { console.error("article-worker: spec missing extDataDir/jobId"); process.exit(2); }

const job = require("./lib/job-store");
const store = require("./lib/store");
const cfg = require("./lib/config-store");
const llm = require("./lib/llm");
const research = require("./lib/research");
const claims = require("./lib/claims");
const write = require("./lib/write");
const humanize = require("./lib/humanize");
const { render } = require("./lib/render");

const logFile = path.join(extDataDir, "jobs", jobId, "worker.log");
const log = (...a) => { try { fs.appendFileSync(logFile, a.map((x) => String(x)).join(" ") + "\n"); } catch (_) {} };
const logger = { info: (...a) => log("[info]", ...a), warn: (...a) => log("[warn]", ...a), error: (...a) => log("[error]", ...a) };

function setState(state, phase, message, extra = {}) {
  job.updateStatus(extDataDir, jobId, { state, phase, message, ...extra });
  job.appendEvent(extDataDir, jobId, { type: "state", state, phase, message });
  log("[state]", state, phase, message);
}
function setProgress(progress, message) { job.updateStatus(extDataDir, jobId, { progress, message }); }
function isCancelled() { const st = job.readStatusRaw(extDataDir, jobId); return st && st.state === "cancelled"; }
function throwIfCancelled() { if (isCancelled()) { setState("cancelled", "cancelled", "用户取消"); stopHeartbeat(); process.exit(0); } }

let heartbeatTimer;
function startHeartbeat() { heartbeatTimer = setInterval(() => { try { job.heartbeat(extDataDir, jobId); } catch (_) {} }, 10_000); heartbeatTimer.unref && heartbeatTimer.unref(); }
function stopHeartbeat() { if (heartbeatTimer) clearInterval(heartbeatTimer); }

function openDb() { try { return store.open(extDataDir); } catch (e) { logger.warn("db open 失败（降级无库）: " + e.message); return null; } }

async function runArticle() {
  const topic = SPEC.topic || { title: SPEC.title || "未命名选题", angle: "", framework: SPEC.framework || "interpretation", referenceUrls: SPEC.referenceUrls || [], questions: SPEC.questions || "" };
  const config = cfg.load(extDataDir);
  const provider = llm.findProvider(SPEC.modelKey || config.model_key || null);
  const profile = config.account_profile || {};
  const style = config.style || {};
  const budgets = config.budgets || {};
  const db = openDb();

  // researching
  setState("researching", "research", "开始检索资料");
  const { evidence, note } = await research.runResearch({ topic, db, provider, budgets, logger });
  throwIfCancelled();
  job.writeCheckpoint(extDataDir, jobId, { phase: "research", evidence });
  setProgress(0.25, note || "资料就绪");

  // outlining
  setState("outlining", "outline", "抽取事实并拟定大纲");
  let facts = [];
  try { facts = await claims.extractFacts({ provider, evidence, topic }); }
  catch (e) { logger.warn("事实抽取失败，降级为无结构化事实继续生成: " + (e.message || e)); }
  throwIfCancelled();
  let outlineObj;
  try { outlineObj = await write.outline({ provider, topic, facts, profile, style }); }
  catch (e) {
    logger.warn("大纲生成失败，使用基础大纲继续生成: " + (e.message || e));
    outlineObj = { title: topic.title, digest: "", outline: [] };
  }
  throwIfCancelled();
  job.writeCheckpoint(extDataDir, jobId, { phase: "outline", facts, outline: outlineObj });
  setProgress(0.4, "大纲就绪");

  // writing
  setState("writing", "write", "撰写正文");
  const { bodyMd } = await write.draft({ provider, topic, profile, style, facts, outlineObj });
  throwIfCancelled();
  job.writeCheckpoint(extDataDir, jobId, { phase: "draft", bodyMd });

  // reviewing: humanize + 主张账本绑定
  setState("reviewing", "review", "去 AI 味 + 主张账本");
  let hum;
  try { hum = await humanize.humanize({ provider, bodyMd, style }); }
  catch (e) {
    logger.warn("去 AI 味阶段超时或失败，保留原稿继续: " + (e.message || e));
    hum = { bodyMd, detection: humanize.detect(bodyMd), changed: false, skipped: "model_error" };
  }
  throwIfCancelled();
  let boundClaims = [];
  try { boundClaims = await claims.bindToArticle({ provider, bodyMd: hum.bodyMd, evidence }); }
  catch (e) { logger.warn("主张账本绑定失败，降级为空账本继续: " + (e.message || e)); }
  const lintResult = claims.lint({ claims: boundClaims, evidence });
  job.writeCheckpoint(extDataDir, jobId, { phase: "review", bodyMd: hum.bodyMd, claims: boundClaims, lint: lintResult, humanize: hum.detection });

  // rendering
  setState("rendering", "render", "渲染微信 HTML");
  const bodyHtml = render(hum.bodyMd);
  const title = (outlineObj.title || topic.title || "未命名").slice(0, 32);
  const digest = (outlineObj.digest || "").slice(0, 120);
  const articleId = SPEC.articleId || ("art_" + jobId.replace(/^article_/, ""));

  if (db) {
    try {
      store.upsertArticle(db, { id: articleId, topic_id: topic.id || null, job_id: jobId, title, digest, body_md: hum.bodyMd, body_html: bodyHtml,
        framework: topic.framework, outline: JSON.stringify(outlineObj), state: "draft",
        quality: JSON.stringify({ lint: lintResult, humanize: hum.detection, facts: facts.length, evidence: evidence.length }) });
      const insEv = db.prepare("INSERT OR REPLACE INTO evidence (id,article_id,source_url,source_name,author,published_at,fetched_at,excerpt,content_hash,tier,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
      evidence.forEach((e) => insEv.run(e.id, articleId, e.source_url, e.source_name, e.author, e.published_at, e.fetched_at, e.excerpt, e.content_hash, e.tier, new Date().toISOString()));
      const insCl = db.prepare("INSERT OR REPLACE INTO claim (id,article_id,paragraph_idx,claim_text,risk,evidence_id,relation,resolved,note,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)");
      boundClaims.forEach((c) => insCl.run(c.id, articleId, c.paragraph_idx, c.claim_text, c.risk, c.evidence_id, c.relation, c.resolved, "", new Date().toISOString()));
    } catch (e) { logger.warn("落库失败: " + e.message); }
  }

  // 自动推送：仅当 mode=auto_push 且凭据齐全；否则停 waiting_user
  const wantPush = SPEC.mode === "auto_push" && config.wx && config.wx.appid && config.wx.secret;
  if (wantPush) {
    await pushToWechat({ db, articleId, title, digest, bodyHtml, config, declaration: config.ai_declaration });
  }

  setState(wantPush ? "done" : "waiting_user", wantPush ? "done" : "review", wantPush ? "已推送至草稿箱" : "初稿就绪，等待编辑确认",
    { progress: 1, articleId, title, digest });
  job.writeCheckpoint(extDataDir, jobId, { phase: "done", articleId, title, digest, bodyMd: hum.bodyMd, bodyHtml });
  if (db) try { db.close(); } catch (_) {}
}

async function runPushOnly() {
  const articleId = SPEC.articleId;
  if (!articleId) throw new Error("push_only 缺 articleId");
  const config = cfg.load(extDataDir);
  if (!config.wx || !config.wx.appid || !config.wx.secret) throw new Error("未配置微信凭据");
  const db = openDb();
  if (!db) throw new Error("数据库不可用");
  const art = store.getArticle(db, articleId);
  if (!art) throw new Error("文章不存在: " + articleId);
  setState("uploading", "upload", "推送到微信草稿箱");
  await pushToWechat({ db, articleId, title: art.title, digest: art.digest, bodyHtml: art.body_html, config, declaration: config.ai_declaration });
  setState("done", "done", "已推送至草稿箱", { progress: 1, articleId });
  try { db.close(); } catch (_) {}
}

async function pushToWechat({ db, articleId, title, digest, bodyHtml, config, declaration }) {
  const wechat = require("./lib/wechat");
  const image = require("./lib/image");
  const ctx = { extDataDir, appid: config.wx.appid, secret: config.wx.secret, logger };
  let thumbMediaId = "";
  try {
    const cover = await image.generatePlaceholderCover({ extDataDir, title, subtitle: digest });
    if (!cover.need_rasterize) thumbMediaId = await wechat.uploadThumb(ctx, cover.path);
    else logger.warn("封面为 SVG（无 sharp 栅格化），跳过上传，请在后台手动设置封面");
  } catch (e) { logger.warn("封面生成/上传失败: " + e.message); }
  let r;
  try {
    r = await wechat.addDraft(ctx, { title, author: "", digest, bodyHtml, coverMediaId: thumbMediaId, declaration });
  } catch (e) {
    if (e.unknown) {
      setState("unknown_external_result", "upload", "draft/add 超时，结果未知，请用 reconcile_draft 对账或查公众号后台");
      if (db) try { store.upsertArticle(db, { id: articleId, state: "unknown" }); } catch (_) {}
      stopHeartbeat(); process.exit(0);
    }
    throw e;
  }
  if (db) try { store.upsertArticle(db, { id: articleId, state: "pushed", cover_media_id: thumbMediaId }); } catch (_) {}
  return r;
}

async function main() {
  startHeartbeat();
  if (mode === "push_only") await runPushOnly();
  else await runArticle();
  stopHeartbeat();
  process.exit(0);
}

main().catch((e) => {
  stopHeartbeat();
  try { setState("failed", "error", "worker 异常: " + String(e && e.message || e).slice(0, 300)); } catch (_) {}
  logger.error(String((e && e.stack) || e));
  process.exit(1);
});
