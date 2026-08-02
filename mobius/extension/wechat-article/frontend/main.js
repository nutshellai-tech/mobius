// wechat-article 前端主逻辑（零编译原生 ESM）。仅通过 extCall SDK 调后端。
// 三 tab：选题/写作（自填主题→生成→编辑→预览→推送）、我的文章、设置。
// 轮询用自递归 setTimeout（pollRecursive），仅 running 时轮询；UI tick 用 setInterval 不受约束。

import { extCall } from "/extension/_sdk/ext.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const app = $("#app");

const state = {
  config: null, channels: [], default_model: "",
  articles: [], current: null, tab: "write", pollStop: null, pollJobId: "",
  activeJob: null, completedJob: null,
};

const ACTIVE_JOB_STATES = new Set(["queued", "running", "researching", "outlining", "writing", "reviewing", "rendering", "uploading"]);
const TERMINAL_JOB_STATES = new Set(["done", "waiting_user", "failed", "cancelled", "unknown_external_result"]);
const ACTIVE_JOB_STORAGE_KEY = "wechat-article-active-job";

async function api(action, payload = {}) {
  try { return await extCall({ action, ...payload }); }
  catch (e) { toast((e.data && e.data.error) || e.message || "调用失败"); throw e; }
}
function toast(msg) {
  let t = $("#toast"); if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add("show"); clearTimeout(t._tm); t._tm = setTimeout(() => t.classList.remove("show"), 3000);
}
// 自递归轮询（拓展自包含，不依赖主前端 polling.ts；天然不重叠）
function pollRecursive(fn, intervalMs) {
  let stop = false;
  (async () => { while (!stop) { try { await fn(); } catch (_) {} if (stop) return; await new Promise((r) => setTimeout(r, intervalMs)); } })();
  return () => { stop = true; };
}
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// 前端轻量 Markdown → HTML（实时预览用；推送前以后端 render_preview 为准）
function mdToHtml(md) {
  const lines = String(md || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  const inline = (s) => esc(s)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, a, u) => `<img src="${u}" alt="${a}" style="max-width:100%"/>`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => `<a href="${u}">${t}</a>`)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\s*\[事实\d+\]/g, "");
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) { const b = []; i++; while (i < lines.length && !/^```/.test(lines[i])) b.push(lines[i++]); i++; out.push(`<pre>${esc(b.join("\n"))}</pre>`); continue; }
    if (/^#\s+/.test(l)) { out.push(`<h1>${inline(l.replace(/^#\s+/, ""))}</h1>`); i++; continue; }
    if (/^##\s+/.test(l)) { out.push(`<h2>${inline(l.replace(/^##\s+/, ""))}</h2>`); i++; continue; }
    if (/^###\s+/.test(l)) { out.push(`<h3>${inline(l.replace(/^###\s+/, ""))}</h3>`); i++; continue; }
    if (/^>\s?/.test(l)) { out.push(`<blockquote>${inline(l.replace(/^>\s?/, ""))}</blockquote>`); i++; continue; }
    if (/^[-*+]\s+/.test(l)) { const it = []; while (i < lines.length && /^[-*+]\s+/.test(lines[i])) it.push(`<li>${inline(lines[i++].replace(/^[-*+]\s+/, ""))}</li>`); out.push(`<ul>${it.join("")}</ul>`); continue; }
    if (/^\d+\.\s+/.test(l)) { const it = []; while (i < lines.length && /^\d+\.\s+/.test(lines[i])) it.push(`<li>${inline(lines[i++].replace(/^\d+\.\s+/, ""))}</li>`); out.push(`<ol>${it.join("")}</ol>`); continue; }
    if (/^(-{3,}|\*{3,})$/.test(l.trim())) { out.push("<hr/>"); i++; continue; }
    if (l.trim() === "") { i++; continue; }
    out.push(`<p>${inline(l)}</p>`); i++;
  }
  return out.join("\n");
}

async function bootstrap() {
  try {
    const r = await api("get_config");
    state.config = r.config; state.channels = r.channels || []; state.default_model = r.default_model || "";
    const la = await api("list_articles");
    state.articles = la.articles || [];
    const lj = await api("list_jobs", { limit: 20 });
    const active = (lj.jobs || []).find((j) => j.kind === "article" && ACTIVE_JOB_STATES.has(j.state));
    const savedJobId = localStorage.getItem(ACTIVE_JOB_STORAGE_KEY) || "";
    if (active) state.activeJob = active;
    else if (savedJobId) state.activeJob = { jobId: savedJobId, state: "queued", phase: "init", progress: 0, message: "正在恢复后台任务状态" };
  } catch (_) {}
  render();
  if (state.activeJob?.jobId) runJobPoll(state.activeJob.jobId, { resumed: true });
}

function render() {
  const cfg = state.config || {};
  app.innerHTML = `
    <header class="topbar">
      <div class="brand">公众号图文生成</div>
      <nav class="tabs">
        <button id="tab-write" class="${state.tab === "write" ? "active" : ""}">选题 / 写作</button>
        <button id="tab-list" class="${state.tab === "list" ? "active" : ""}">我的文章</button>
        <button id="tab-settings" class="${state.tab === "settings" ? "active" : ""}">设置</button>
      </nav>
      <div class="spacer"></div>
      <button id="job-indicator" class="job-indicator" hidden></button>
      <div class="pill">${cfg.wx_configured ? "微信已配置" : "微信未配置"} · ${cfg.crypto_available ? "加密就绪" : "缺主密钥"}</div>
    </header>
    <main id="view"></main>`;
  $("#tab-write").onclick = () => { state.tab = "write"; render(); };
  $("#tab-list").onclick = () => { state.tab = "list"; render(); };
  $("#tab-settings").onclick = () => { state.tab = "settings"; render(); };
  $("#job-indicator").onclick = onJobIndicatorClick;
  if (state.tab === "write") renderWrite();
  else if (state.tab === "list") renderList();
  else renderSettings();
  paintJobStatus();
}

// ---------- 选题 / 写作 ----------
function renderWrite() {
  if (state.current) { renderEditor(); return; }
  const hasActiveJob = !!state.activeJob;
  const ch = state.channels;
  const chOpts = ch.map((c) => `<option value="${c.key}" ${c.key === state.default_model ? "selected" : ""}>${esc(c.label)} · ${esc(c.model)}</option>`).join("");
  $("#view").innerHTML = `
    <section class="card">
      <h2>新建一篇图文</h2>
      <label><span>主题 / 标题 *</span><input id="f-title" type="text" placeholder="例：OpenAI 发布 GPT-5，多模态能力翻倍"/></label>
      <div class="row" style="margin:8px 0">
        <button id="btn-clarify" class="btn">AI 补全角度与待核实问题</button>
        <span class="muted">先用一句话给主题，再让 AI 帮你想角度</span>
      </div>
      <div class="grid2">
        <label><span>角度 / 切入点</span><textarea id="f-angle" placeholder="为什么现在写、给读者什么增量信息"></textarea></label>
        <div>
          <label><span>框架</span><select id="f-framework">
            <option value="interpretation">热点解读</option><option value="opinion">观点文章</option><option value="list">实用清单</option>
          </select></label>
          <label><span>目标读者</span><input id="f-audience" type="text" placeholder="AI 从业者 / 产品经理 / 普通读者"/></label>
        </div>
      </div>
      <label><span>参考链接（可信源，每行一条；优先一手源）</span><textarea id="f-refs" placeholder="https://openai.com/blog/..."></textarea></label>
      <label><span>需核实的问题（可选）</span><textarea id="f-questions" placeholder="哪些数字/日期/能力描述必须查证"></textarea></label>
      <div class="row">
        <label style="margin:0; min-width:240px"><span>生成模型</span><select id="f-model"><option value="">默认</option>${chOpts}</select></label>
        <button id="btn-start" class="primary" ${hasActiveJob ? "disabled" : ""}>${hasActiveJob ? "后台生成中…" : "开始生成初稿"}</button>
        <span class="muted">约 1–3 分钟（资料→大纲→正文→去AI味→渲染）</span>
      </div>
      <div id="progress"></div>
    </section>`;
  $("#btn-clarify").onclick = onClarify;
  $("#btn-start").onclick = onStart;
}

async function onClarify() {
  const title = $("#f-title").value.trim();
  if (!title) return toast("先填主题");
  const btn = $("#btn-clarify"); btn.disabled = true; btn.textContent = "AI 思考中…";
  try {
    const r = await api("clarify_topic", { title, model_key: $("#f-model").value });
    if (r.ok) {
      if (r.core_claim) $("#f-angle").value = (r.core_claim || "") + ($("#f-angle").value ? "\n" + $("#f-angle").value : "");
      if (r.audience) $("#f-audience").value = r.audience;
      if (r.framework && ["interpretation", "opinion", "list"].includes(r.framework)) $("#f-framework").value = r.framework;
      if (Array.isArray(r.questions)) $("#f-questions").value = r.questions.map((q) => "- " + q).join("\n");
      toast("已补全，可再手动调整");
    } else toast(r.error || "补全失败");
  } finally { btn.disabled = false; btn.textContent = "AI 补全角度与待核实问题"; }
}

async function onStart() {
  const title = $("#f-title").value.trim();
  if (!title) return toast("先填主题");
  const btn = $("#btn-start"); btn.disabled = true;
  const params = {
    title,
    angle: $("#f-angle").value.trim(),
    framework: $("#f-framework").value,
    audience: $("#f-audience").value.trim(),
    referenceUrls: $("#f-refs").value.split("\n").map((s) => s.trim()).filter(Boolean),
    questions: $("#f-questions").value.trim(),
    model_key: $("#f-model").value,
  };
  try {
    const r = await api("start_article", params);
    if (!r.ok) { toast(r.error || "启动失败"); btn.disabled = false; return; }
    state.completedJob = null;
    state.activeJob = { jobId: r.job_id, state: "queued", phase: "init", progress: 0, message: "已转入后台队列" };
    localStorage.setItem(ACTIVE_JOB_STORAGE_KEY, r.job_id);
    btn.textContent = "后台生成中…";
    paintJobStatus();
    toast("已在后台生成，可安全切换页面；回来后会自动恢复进度");
    runJobPoll(r.job_id);
  } catch (_) { btn.disabled = false; }
}

function runJobPoll(jobId, { resumed = false } = {}) {
  if (state.pollStop && state.pollJobId === jobId) return;
  if (state.pollStop) state.pollStop();
  state.pollJobId = jobId;
  localStorage.setItem(ACTIVE_JOB_STORAGE_KEY, jobId);
  if (resumed) toast("已恢复后台生成任务，继续同步进度");
  state.pollStop = pollRecursive(async () => {
    const s = await api("job_status", { job_id: jobId });
    if (!s.ok) {
      state.pollStop && state.pollStop(); state.pollStop = null; state.pollJobId = "";
      state.activeJob = null;
      state.completedJob = { jobId, state: "failed", phase: "error", progress: 0, error: s.error || "后台任务不存在或无法恢复" };
      localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
      paintJobStatus();
      return;
    }
    const st = s.status;
    if (!st) return;
    state.activeJob = { ...st, jobId };
    paintJobStatus();
    if (TERMINAL_JOB_STATES.has(st.state)) {
      state.pollStop && state.pollStop(); state.pollStop = null;
      state.pollJobId = "";
      state.activeJob = null;
      state.completedJob = { ...st, jobId };
      localStorage.removeItem(ACTIVE_JOB_STORAGE_KEY);
      if (st.articleId) {
        await refreshArticles();
        if (state.tab === "write" && !state.current) await loadArticle(st.articleId);
        else toast("✅ 初稿已在后台生成，点击顶部状态可打开");
      } else if (st.state === "failed") {
        toast("生成失败：" + (st.error || st.message || "未知错误"));
        const btn = $("#btn-start"); if (btn) { btn.disabled = false; btn.textContent = "重新生成初稿"; }
      } else if (st.state === "unknown_external_result") toast("推送超时，结果未知，请到公众号后台核对");
      paintJobStatus();
    }
  }, 2500);
}

const phases = { init: "排队", research: "检索资料", outline: "拟定大纲", write: "撰写正文", review: "去 AI 味 + 主张账本", render: "渲染", upload: "推送到草稿箱", error: "生成失败" };

function paintJobStatus() {
  const current = state.activeJob || state.completedJob;
  const indicator = $("#job-indicator");
  if (indicator) {
    indicator.hidden = !current;
    if (current) {
      const pct = Math.round((current.progress || 0) * 100);
      indicator.classList.toggle("failed", current.state === "failed");
      indicator.classList.toggle("ready", !!current.articleId);
      indicator.textContent = current.articleId ? "初稿已生成 · 点击打开"
        : current.state === "failed" ? "生成失败 · 点击查看"
        : `后台生成 ${pct}% · ${phases[current.phase] || current.state}`;
    }
  }
  const box = $("#progress");
  if (!box) return;
  if (!current) { box.innerHTML = ""; return; }
  const pct = Math.max(5, Math.round((current.progress || 0) * 100));
  const failed = current.state === "failed";
  box.innerHTML = `<div class="progress ${failed ? "failed" : ""}">
    <div class="bar"><i style="width:${pct}%"></i></div>
    <div class="msg">${esc(phases[current.phase] || current.state)} · ${esc(current.error || current.message || "")}</div>
    ${state.activeJob ? '<div class="background-note">任务正在服务器后台运行，可以切换 Tab、离开或关闭当前页面。</div>' : ""}
  </div>`;
}

async function onJobIndicatorClick() {
  const job = state.completedJob;
  if (job?.articleId) { state.tab = "write"; await loadArticle(job.articleId); return; }
  state.tab = "write"; render();
}

async function refreshArticles() {
  try { const r = await api("list_articles"); state.articles = r.articles || []; } catch (_) {}
}

async function loadArticle(id) {
  const r = await api("get_article", { article_id: id });
  if (!r.ok) return toast(r.error || "加载失败");
  state.current = { article: r.article, evidence: r.evidence || [], claims: r.claims || [] };
  if (state.completedJob?.articleId === id) state.completedJob = null;
  render();
  renderEditor();
}

function renderEditor() {
  const a = state.current.article;
  const lint = a.quality && a.quality.lint;
  const evHtml = state.current.evidence.map((e) => `<div class="item"><div class="src"><span class="tag ${e.tier}">${e.tier}</span> ${esc(e.source_name)}</div><div class="ex">${esc((e.excerpt || "").slice(0, 140))}</div></div>`).join("") || '<div class="muted" style="padding:10px">无证据</div>';
  const claimsHtml = state.current.claims.map((c) => `<div class="claim"><div class="row"><span class="tag ${c.risk}">${c.risk}</span><span class="tag">${c.relation}</span>${c.resolved ? '<span class="tag">已处理</span>' : ""}</div><div class="tx">${esc(c.claim_text)}</div>${c.resolved ? "" : `<button data-cid="${c.id}">标记已核实</button>`}</div>`).join("") || '<div class="muted" style="padding:10px">无主张</div>';
  $("#view").innerHTML = `
    <section class="card">
      <div class="editor-meta">
        <input id="e-title" type="text" value="${esc(a.title)}" placeholder="标题（≤32 字）"/>
        <input id="e-digest" type="text" value="${esc(a.digest)}" placeholder="摘要（≤120 字）"/>
      </div>
      <div class="editor-body">
        <div class="pane"><div class="head">Markdown 正文</div><textarea id="e-md">${esc(a.body_md)}</textarea></div>
        <div class="pane"><div class="head">375px 微信预览</div><div class="phone"><div class="preview-content" id="e-prev"></div></div></div>
        <div class="pane aside evidence"><div class="head">证据 / 主张账本</div>${evHtml}${claimsHtml}</div>
      </div>
      <div class="editor-actions">
        <button id="btn-save" class="primary">保存</button>
        <button id="btn-versions" class="btn">历史版本</button>
        <button id="btn-regen-cover" class="btn">生成封面</button>
        <button id="btn-push" class="btn">推送到草稿箱</button>
        <span id="lint-sum" class="lint-summary"></span>
        <div class="spacer" style="flex:1"></div>
        <button id="btn-back" class="btn">返回新建</button>
      </div>
      <div id="versions" style="margin-top:12px"></div>
    </section>`;
  const md = $("#e-md"), prev = $("#e-prev");
  const refresh = () => { prev.innerHTML = mdToHtml(md.value); updateLint(); };
  md.oninput = debounce(refresh, 250);
  refresh();
  updateLint();
  $("#btn-save").onclick = onSave;
  $("#btn-back").onclick = () => { state.current = null; render(); };
  $("#btn-versions").onclick = onVersions;
  $("#btn-regen-cover").onclick = onCover;
  $("#btn-push").onclick = onPush;
  $$("[data-cid]").forEach((b) => b.onclick = async () => {
    const r = await api("resolve_claim", { claim_id: b.dataset.cid });
    if (r.ok) { const c = state.current.claims.find((x) => x.id === b.dataset.cid); if (c) c.resolved = 1; renderEditor(); }
  });
}
function updateLint() {
  const el = $("#lint-sum"); if (!el) return;
  const lint = state.current.article.quality && state.current.article.quality.lint;
  if (!lint) { el.className = "lint-summary"; el.textContent = ""; return; }
  if (lint.ok) { el.className = "lint-summary ok"; el.textContent = `主张账本通过（${lint.stats.claims} 条，高风险 ${lint.stats.high_risk}）`; }
  else { el.className = "lint-summary block"; el.textContent = `${lint.blockers.length} 项阻断：` + lint.blockers.slice(0, 2).join("；"); }
}
async function onSave() {
  const a = state.current.article;
  const r = await api("save_article", { article_id: a.id, title: $("#e-title").value, digest: $("#e-digest").value, body_md: $("#e-md").value });
  if (r.ok) { state.current.article = r.article; toast("已保存（含历史版本）"); }
}
async function onVersions() {
  const r = await api("list_versions", { article_id: state.current.article.id });
  const box = $("#versions");
  if (!r.ok) return toast(r.error);
  box.innerHTML = '<div class="muted" style="margin:6px 0">历史版本（点击恢复）</div>' + r.versions.map((v) => `<div class="list-item" data-vid="${v.id}"><div class="t">v${v.version_no} · ${esc(v.title)}</div><div class="d">${esc(v.created_at)} ${esc(v.note||"")}</div></div>`).join("");
  $$("[data-vid]").forEach((el) => el.onclick = async () => {
    const rr = await api("restore_version", { version_id: el.dataset.vid });
    if (rr.ok) { await loadArticle(state.current.article.id); toast("已恢复"); }
  });
}
async function onCover() {
  const r = await api("generate_cover", { title: $("#e-title").value, subtitle: $("#e-digest").value });
  if (r.ok) { toast(r.need_rasterize ? "生成 SVG 占位封面（无 sharp，需手动栅格化）" : "封面已生成"); }
  else toast(r.error || "失败");
}
async function onPush() {
  if (!(state.config && state.config.wx_configured)) return toast("请先在设置页配置微信 AppID/AppSecret");
  await onSave();
  const r = await api("push_draft", { article_id: state.current.article.id });
  if (!r.ok) return toast(r.error || "推送失败");
  toast("正在推送…");
  state.pollStop = pollRecursive(async () => {
    const s = await api("job_status", { job_id: r.job_id });
    const st = s.status; if (!st) return;
    if (st.state === "done") { state.pollStop && state.pollStop(); state.pollStop = null; toast("✅ 已推送至公众号草稿箱，请到后台预览与发布"); }
    else if (st.state === "unknown_external_result") { state.pollStop && state.pollStop(); state.pollStop = null; toast("推送超时，结果未知，请到后台核对"); }
    else if (st.state === "failed") { state.pollStop && state.pollStop(); state.pollStop = null; toast("推送失败：" + (st.error || "")); }
  }, 2500);
}

// ---------- 文章列表 ----------
function renderList() {
  $("#view").innerHTML = `<section class="card"><h2>我的文章（${state.articles.length}）</h2>
    <div id="alist"></div></section>`;
  const box = $("#alist");
  if (!state.articles.length) { box.innerHTML = '<p class="muted">还没有文章，去「选题/写作」生成第一篇。</p>'; return; }
  box.innerHTML = state.articles.map((a) => `<div class="list-item" data-id="${a.id}"><div class="t">${esc(a.title||"未命名")}</div><span class="tag">${esc(a.state||"")}</span><div class="d">${esc(a.updated_at||"")}</div></div>`).join("");
  $$("[data-id]").forEach((el) => el.onclick = async () => { state.tab = "write"; await loadArticle(el.dataset.id); });
}

// ---------- 设置 ----------
function renderSettings() {
  const c = state.config || {};
  const p = c.account_profile || {}, st = c.style || {}, b = c.budgets || {};
  const chOpts = state.channels.map((x) => `<option value="${x.key}" ${x.key === c.model_key ? "selected" : ""}>${esc(x.label)} · ${esc(x.model)}</option>`).join("");
  $("#view").innerHTML = `
    <section class="card"><h2>账号画像</h2>
      <div class="grid2">
        <label><span>账号定位</span><input id="p-pos" type="text" value="${esc(p.positioning)}"/></label>
        <label><span>目标读者</span><input id="p-aud" type="text" value="${esc(p.audience)}"/></label>
        <label><span>语气</span><input id="p-tone" type="text" value="${esc(p.tone)}"/></label>
        <label><span>商业目标</span><input id="p-goal" type="text" value="${esc(p.goals)}"/></label>
      </div>
      <label><span>禁写范围</span><input id="p-forbid" type="text" value="${esc(p.forbidden)}"/></label>
      <button id="btn-save-profile" class="primary">保存画像</button>
    </section>
    <section class="card"><h2>风格档案</h2>
      <div class="grid2">
        <label><span>语气倾向</span><input id="s-tone" type="text" value="${esc(st.tone)}"/></label>
        <label><span>观点强度</span><input id="s-op" type="text" value="${esc(st.opinion_strength)}"/></label>
      </div>
      <label><span>禁用表达（逗号分隔）</span><input id="s-ban" type="text" value="${esc(st.banned_phrases)}"/></label>
      <button id="btn-save-style" class="primary">保存风格</button>
    </section>
    <section class="card"><h2>微信草稿箱凭据</h2>
      <div class="muted">当前：${c.wx_configured ? "已配置（" + esc(c.wx_appid_masked) + "）" : "未配置"}。需公众号拥有草稿接口权限，且服务器出口 IP 在白名单。</div>
      <div class="grid2">
        <label><span>AppID</span><input id="wx-appid" type="text" placeholder="${c.wx_appid_masked || "wx..."}"/></label>
        <label><span>AppSecret</span><input id="wx-secret" type="password" placeholder="${c.wx_configured ? "已保存（留空不改）" : ""}"/></label>
      </div>
      <button id="btn-save-wx" class="primary">保存凭据</button>
    </section>
    <section class="card"><h2>生成与预算</h2>
      <div class="grid2">
        <label><span>默认模型</span><select id="cfg-model"><option value="">默认</option>${chOpts}</select></label>
        <label><span>AI 辅助声明（文末）</span><input id="cfg-decl" type="text" value="${esc(c.ai_declaration)}"/></label>
        <label><span>每篇搜索次数</span><input id="b-search" type="text" value="${b.per_article_search ?? 6}"/></label>
        <label><span>每篇 Token 上限</span><input id="b-tok" type="text" value="${b.per_article_tokens ?? 20000}"/></label>
        <label><span>每篇金额上限（元）</span><input id="b-amt" type="text" value="${b.per_article_amount ?? 2}"/></label>
        <label><span>每日金额上限（元）</span><input id="b-day" type="text" value="${b.daily_amount ?? 20}"/></label>
      </div>
      <div class="row">
        <button id="btn-save-cfg" class="primary">保存配置</button>
        <button id="btn-test" class="btn">测试模型连通</button>
        <span class="muted">${c.crypto_available ? "" : "⚠ 缺主密钥，凭据无法加密保存"}</span>
      </div>
    </section>`;
  $("#btn-save-profile").onclick = async () => {
    const r = await api("save_account_profile", { profile: { positioning: $("#p-pos").value, audience: $("#p-aud").value, tone: $("#p-tone").value, goals: $("#p-goal").value, forbidden: $("#p-forbid").value } });
    if (r.ok) { state.config = r.config; toast("画像已保存"); }
  };
  $("#btn-save-style").onclick = async () => {
    const r = await api("save_style_profile", { style: { tone: $("#s-tone").value, opinion_strength: $("#s-op").value, banned_phrases: $("#s-ban").value } });
    if (r.ok) { state.config = r.config; toast("风格已保存"); }
  };
  $("#btn-save-wx").onclick = async () => {
    const wx = {};
    if ($("#wx-appid").value) wx.appid = $("#wx-appid").value.trim();
    if ($("#wx-secret").value) wx.secret = $("#wx-secret").value.trim();
    const r = await api("save_config", { config: { wx } });
    if (r.ok) { state.config = r.config; toast("凭据已加密保存"); render(); }
  };
  $("#btn-save-cfg").onclick = async () => {
    const r = await api("save_config", { config: { model_key: $("#cfg-model").value, ai_declaration: $("#cfg-decl").value,
      budgets: { per_article_search: Number($("#b-search").value) || 6, per_article_tokens: Number($("#b-tok").value) || 20000,
        per_article_amount: Number($("#b-amt").value) || 2, daily_amount: Number($("#b-day").value) || 20 } } });
    if (r.ok) { state.config = r.config; toast("配置已保存"); }
  };
  $("#btn-test").onclick = async () => {
    const btn = $("#btn-test"); btn.disabled = true; btn.textContent = "测试中…";
    const r = await api("test_provider", { model_key: $("#cfg-model").value });
    btn.disabled = false; btn.textContent = "测试模型连通";
    toast(r.ok && r.alive ? "✅ 连通：" + r.model : "❌ " + (r.error || "无响应"));
  };
}

bootstrap();
