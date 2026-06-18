/**
 * routes/ext.js — 拓展系统的三入口路由集合.
 *
 *   metaRouter   → /api/extensions           列表 / 单 manifest / build-status / admin reload
 *   invokeRouter → /api/ext                  统一调用入口 (POST), worker_thread 跑 handler
 *   staticRouter → /extension/<name>/*       前端资源 + 按需 vite build + loading 页 + 共用 SDK
 *
 * 三个 router 分挂在不同前缀, 但共享 extension-registry 单例. server.js:
 *   app.use('/api/extensions', ext.metaRouter);
 *   app.use('/api/ext',        ext.invokeRouter);
 *   app.use('/extension',      ext.staticRouter);
 */
const express = require('express');
const multer = require('multer');
const { auth, adminAuth } = require('../middleware/auth');
const registry = require('../services/extension-registry');
const { invokeHandler } = require('../services/extension-invoker');
const buildPipeline = require('../services/extension-build-pipeline');
const { runSessionMessage } = require('../services/session-message-runner');
const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  EXTENSION_HANDLER_MAX_PAYLOAD_BYTES,
  EXTENSION_INVOKE_RATE_PER_SEC,
} = require('../config');

// ===== meta router =====
const metaRouter = express.Router();
const upload = multer({
  dest: path.join(os.tmpdir(), 'mobius-extension-upload'),
  limits: { fileSize: 50 * 1024 * 1024 },
});

function safeUserSegment(username) {
  return String(username || 'unknown').replace(/[^A-Za-z0-9_.@-]/g, '_').slice(0, 120) || 'unknown';
}

function safeFileName(name) {
  const base = path.basename(String(name || 'source.bin')).replace(/[^\w\u4e00-\u9fff .@()+,-]/g, '_').trim();
  return (base || 'source.bin').slice(0, 180);
}

function safeResolveUnder(root, ...parts) {
  const base = path.resolve(root);
  const abs = path.resolve(base, ...parts);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

// 拓展列表 (公开给已登录用户; 拓展项目卡片在前端项目页就要它).
metaRouter.get('/', auth, (req, res) => {
  res.json({
    extensions: registry.getAll(),
    errors: registry.getLastReloadErrors(),
  });
});

// 单个拓展 manifest (前端 loading 页轮询会用)
metaRouter.get('/:name', auth, (req, res) => {
  const entry = registry.get(req.params.name);
  if (!entry) return res.status(404).json({ error: '未找到该拓展' });
  res.json({
    name: entry.name,
    display_name: entry.display_name,
    description: entry.description,
    version: entry.version,
    icon_url: entry.icon_url,
    entry_url: `/extension/${entry.name}/`,
  });
});

// 编译状态 (loading 页轮询)
metaRouter.get('/:name/build-status', auth, (req, res) => {
  const entry = registry.get(req.params.name);
  if (!entry) return res.status(404).json({ error: '未找到该拓展' });
  res.json(buildPipeline.getStatus(entry));
});

metaRouter.post('/:name/upload', auth, upload.single('file'), (req, res) => {
  const entry = registry.get(req.params.name);
  if (!entry) {
    if (req.file) try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(404).json({ ok: false, error: '未找到该拓展' });
  }
  if (!req.file) return res.status(400).json({ ok: false, error: 'No file' });

  const userSegment = safeUserSegment(req.user.id);
  const uploadDir = safeResolveUnder(entry.data_dir, 'users', userSegment, 'uploads');
  if (!uploadDir) {
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(400).json({ ok: false, error: 'bad upload path' });
  }
  try {
    fs.mkdirSync(uploadDir, { recursive: true });
    const originalName = safeFileName(req.file.originalname);
    const stampedName = `${Date.now()}-${originalName}`;
    const dest = safeResolveUnder(uploadDir, stampedName);
    if (!dest) throw new Error('bad destination');
    fs.renameSync(req.file.path, dest);
    res.json({
      ok: true,
      file: {
        path: dest,
        name: originalName,
        stored_name: stampedName,
        size: req.file.size,
        mime_type: req.file.mimetype || '',
      },
    });
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch {}
    res.status(500).json({ ok: false, error: e.message || 'upload failed' });
  }
});

// 管理员: 列出所有"被某用户隐藏的拓展项目"对.
// 路径不与 GET /:name 冲突 (express 按注册顺序, /:name 只匹配单段;
// 但 "hidden" 万一被当成扩展名匹到 /:name 也会 404, 故为稳妥起见放在前面).
// 即:实际放置在 GET /:name 注册之前的位置, 见上方 staticRouter 之前的注册顺序补丁.
metaRouter.get('/_admin/hidden', adminAuth, (req, res) => {
  const { Projects } = require('../repositories/projects');
  res.json({ hidden: Projects.listHidden() });
});

// 管理员: 撤销某用户对某拓展项目的隐藏 (DELETE 该行). 不恢复彻底删除的数据.
metaRouter.post('/_admin/hidden/:projectId/:userId/restore', adminAuth, (req, res) => {
  const { Projects } = require('../repositories/projects');
  const project = Projects.findById(req.params.projectId);
  if (!project || project.kind !== 'extension') {
    return res.status(404).json({ error: '未找到拓展项目' });
  }
  Projects.setHidden(req.params.projectId, req.params.userId, false);
  res.json({ ok: true });
});

// 管理员: 强制重新扫描 mobius/extension/ 并 diff DB
metaRouter.post('/reload', adminAuth, (req, res) => {
  const result = registry.reload();
  res.json(result);
});

// 管理员: 强制重新编译某个拓展前端 (清掉 dist 再 build)
metaRouter.post('/:name/rebuild', adminAuth, async (req, res) => {
  const entry = registry.get(req.params.name);
  if (!entry) return res.status(404).json({ error: '未找到该拓展' });
  try {
    await buildPipeline.forceRebuild(entry);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== invoke router (statless POST /api/ext) =====
const invokeRouter = express.Router();
// 单独限制 payload 大小, 配合 worker 内部的返回值大小校验.
invokeRouter.use(express.json({ limit: EXTENSION_HANDLER_MAX_PAYLOAD_BYTES }));

const POST_ACTIONS_KEY = '__mobius_post_actions';
const POST_ACTION_RESULT_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,60}$/;

// 每用户简单令牌桶速率限制 (每秒 N 次). 内存即可, 重启丢失无所谓.
const rateMap = new Map(); // user_id → { count, windowStartMs }
function rateAllow(userId) {
  const now = Date.now();
  const rec = rateMap.get(userId);
  if (!rec || now - rec.windowStartMs >= 1000) {
    rateMap.set(userId, { count: 1, windowStartMs: now });
    return true;
  }
  if (rec.count >= EXTENSION_INVOKE_RATE_PER_SEC) return false;
  rec.count += 1;
  return true;
}

async function runPostActions(value, req) {
  if (!value || typeof value !== 'object') return value;
  const actions = Array.isArray(value[POST_ACTIONS_KEY]) ? value[POST_ACTIONS_KEY] : [];
  delete value[POST_ACTIONS_KEY];
  if (!actions.length) return value;

  const results = [];
  for (const action of actions.slice(0, 5)) {
    if (!action || action.type !== 'session_message') continue;
    const requestedResultKey = typeof action.result_key === 'string' ? action.result_key.trim() : '';
    const resultKey = POST_ACTION_RESULT_KEY_RE.test(requestedResultKey)
      ? requestedResultKey
      : '';
    try {
      const hasInputText = Object.prototype.hasOwnProperty.call(action, 'input_text');
      const started = await runSessionMessage({
        user: req.user,
        sessionId: String(action.session_id || ''),
        content: String(action.content || ''),
        inputText: hasInputText ? String(action.input_text || '') : '',
        hasInputText,
        requestId: typeof action.request_id === 'string' ? action.request_id : null,
        source: typeof action.source === 'string' ? action.source : 'extension.post_action.session_message',
        logger: console,
      });
      const publicResult = {
        type: action.type,
        ok: true,
        session_id: started.session_id,
        turn_number: started.turn_number,
        request_id: started.request_id,
        backend: started.backend,
      };
      results.push(publicResult);
      if (resultKey) value[resultKey] = publicResult;
      if (value.session && value.session.session_id === started.session_id) {
        value.session.started = true;
        value.session.start_result = publicResult;
      }
    } catch (e) {
      const publicResult = {
        type: action.type,
        ok: false,
        session_id: String(action.session_id || ''),
        error: e.message || '后端启动 Session 失败',
        status: e.status || 500,
        category: e.category || 'backend',
      };
      results.push(publicResult);
      if (resultKey) value[resultKey] = publicResult;
      value.error = value.error || publicResult.error;
      if (value.session && value.session.session_id === publicResult.session_id) {
        value.session.started = false;
        value.session.start_error = publicResult.error;
      }
      if (value.project && (!action.project_id || value.project.id === action.project_id)) {
        value.project.status = 'session_failed';
        value.project.error = publicResult.error;
      }
    }
  }
  if (results.length) value.post_actions = results;
  return value;
}

invokeRouter.post('/', auth, async (req, res) => {
  const { extension_name, ext_main_payload } = req.body || {};
  if (typeof extension_name !== 'string') {
    return res.status(400).json({ ok: false, error: 'extension_name 必填且必须是字符串' });
  }
  if (!registry.EXT_NAME_RE.test(extension_name)) {
    return res.status(400).json({ ok: false, error: 'extension_name 非法' });
  }
  const entry = registry.get(extension_name);
  if (!entry) {
    return res.status(404).json({ ok: false, error: '未找到该拓展或已被禁用' });
  }
  if (!rateAllow(req.user.id)) {
    return res.status(429).json({ ok: false, error: '调用频率超限, 请稍后重试' });
  }
  try {
    const result = await invokeHandler({
      entry,
      username: req.user.id,
      display_name: req.user.display_name,
      ext_main_payload: ext_main_payload === undefined ? {} : ext_main_payload,
    });
    if (result.__timeout) {
      return res.status(504).json({ ok: false, error: 'handler timeout (>30s)' });
    }
    if (result.__oversize) {
      return res.status(502).json({ ok: false, error: 'handler 返回值过大' });
    }
    if (result.__error) {
      return res.status(500).json({ ok: false, error: result.__error });
    }
    res.json(await runPostActions(result.value, req));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ===== static router (/extension/<name>/*) =====
const staticRouter = express.Router();

// 共用 SDK: /extension/_sdk/ext.js
// 拓展前端 import 'window.__EXT_NAME__' 跟调用 /api/ext 的最小封装.
const SDK_JS = [
  '// auto-generated by mobius extension system',
  'export async function extCall(payload) {',
  '  const token = localStorage.getItem("cc-token") || "";',
  '  const r = await fetch("/api/ext", {',
  '    method: "POST",',
  '    credentials: "include",',
  '    headers: {',
  '      "content-type": "application/json",',
  '      "authorization": token ? ("Bearer " + token) : "",',
  '    },',
  '    body: JSON.stringify({',
  '      extension_name: window.__EXT_NAME__,',
  '      ext_main_payload: payload || {},',
  '    }),',
  '  });',
  '  let data; try { data = await r.json(); } catch { data = { ok: false, error: "bad json" }; }',
  '  if (!r.ok) throw Object.assign(new Error(data.error || ("ext_call " + r.status)), { status: r.status, data });',
  '  return data;',
  '}',
  '',
  'export function extName() { return window.__EXT_NAME__; }',
  '',
  'export async function extUpload(file, extra) {',
  '  const token = localStorage.getItem("cc-token") || "";',
  '  const form = new FormData();',
  '  form.append("file", file);',
  '  if (extra && typeof extra === "object") {',
  '    for (const [k, v] of Object.entries(extra)) form.append(k, typeof v === "string" ? v : JSON.stringify(v));',
  '  }',
  '  const r = await fetch("/api/extensions/" + encodeURIComponent(window.__EXT_NAME__) + "/upload", {',
  '    method: "POST",',
  '    credentials: "include",',
  '    headers: token ? { "authorization": "Bearer " + token } : {},',
  '    body: form,',
  '  });',
  '  let data; try { data = await r.json(); } catch { data = { ok: false, error: "bad json" }; }',
  '  if (!r.ok) throw Object.assign(new Error(data.error || ("ext_upload " + r.status)), { status: r.status, data });',
  '  return data;',
  '}',
  '',
].join('\n');

staticRouter.get('/_sdk/ext.js', (req, res) => {
  res.set('content-type', 'application/javascript; charset=utf-8');
  res.send(SDK_JS);
});

// /extension/<name>/        → loading 或 index.html (注入 window.__EXT_NAME__)
// /extension/<name>/<asset> → dist/<asset> (mime 白名单)
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2':'font/woff2',
  '.wasm': 'application/wasm',
  '.ico':  'image/x-icon',
  '.map':  'application/json; charset=utf-8',
};

function buildLoadingHtml(entry) {
  const safeName = entry.name.replace(/[^a-z0-9-]/g, '');
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${entry.display_name} - 加载中</title>
<style>
  html,body{height:100%;margin:0;background:#0b0f17;color:#cbd5e1;font-family:system-ui,sans-serif}
  .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}
  .title{font-size:16px;font-weight:600;color:#e2e8f0}
  .desc{font-size:13px;color:#94a3b8;max-width:480px;text-align:center;line-height:1.6}
  .spin{width:28px;height:28px;border:3px solid #1e293b;border-top-color:#60a5fa;border-radius:50%;animation:s 0.8s linear infinite}
  @keyframes s{to{transform:rotate(360deg)}}
  .log{margin-top:12px;font-family:ui-monospace,monospace;font-size:11px;color:#64748b;max-width:560px;white-space:pre-wrap;text-align:left}
</style>
</head><body>
<div class="wrap">
  <div class="spin"></div>
  <div class="title">正在准备拓展: ${entry.display_name}</div>
  <div class="desc">首次访问需要编译前端代码, 通常需要 10-30 秒. 编译失败请联系管理员重试.</div>
  <div class="log" id="log"></div>
</div>
<script>
const NAME = ${JSON.stringify(safeName)};
let lastTail = '';
async function tick() {
  try {
    const token = localStorage.getItem('cc-token') || '';
    const r = await fetch('/api/extensions/' + NAME + '/build-status', {
      credentials: 'include',
      headers: token ? { 'authorization': 'Bearer ' + token } : {},
    });
    if (r.status === 401) { document.getElementById('log').textContent = '需要登录 (主前端登录后再访问)'; return; }
    const data = await r.json();
    if (data.state === 'ready') { location.reload(); return; }
    if (data.state === 'error') {
      document.getElementById('log').textContent = '编译失败:\\n' + (data.log_tail || '(无日志)');
      return;
    }
    if (data.log_tail && data.log_tail !== lastTail) {
      lastTail = data.log_tail;
      document.getElementById('log').textContent = data.log_tail;
    }
  } catch (e) { /* keep polling */ }
  setTimeout(tick, 1500);
}
tick();
</script>
</body></html>`;
}

function safeResolveAsset(distDir, rel) {
  const abs = path.resolve(distDir, rel.replace(/^\/+/, ''));
  if (abs !== distDir && !abs.startsWith(distDir + path.sep)) return null;
  return abs;
}

// 单一 handler 处理 /extension/<name> 和 /extension/<name>/<rel>...
// 区分:
//   - 无尾斜杠的 /<name>            → 301 → /<name>/
//   - 尾斜杠的 /<name>/             → 视为 index
//   - /<name>/<rel>                  → rel 资源
//
// 必须先注册 /:name/* 路由 (匹配 /<name>/...), 否则 /:name 会先吃掉 /<name>/.
staticRouter.get('/:name/*', async (req, res) => {
  // /<name>/<rel> 走资源/index 分支 (rel='' 即尾斜杠 → index)
  await serveExtension(req, res, req.params.name, req.params[0] || '');
});

staticRouter.get('/:name', (req, res) => {
  // /<name> (无尾斜杠) → 301 到 /<name>/
  res.redirect(301, `/extension/${req.params.name}/`);
});

async function serveExtension(req, res, name, rel) {
  if (!registry.EXT_NAME_RE.test(name)) return res.status(400).send('bad extension name');
  const entry = registry.get(name);
  if (!entry) return res.status(404).send('extension not found');

  const distDir = path.join(entry.frontend_dir, 'dist');
  const isIndex = !rel || rel === '' || rel === '/' || rel.endsWith('/');

  // dist 不存在 → 入队编译并返回 loading 页
  const distExists = fs.existsSync(path.join(distDir, 'index.html'));
  if (!distExists) {
    buildPipeline.enqueue(entry);
    if (isIndex) {
      res.set('content-type', 'text/html; charset=utf-8');
      return res.send(buildLoadingHtml(entry));
    }
    return res.status(503).send('extension not built yet');
  }

  // index.html: 注入 window.__EXT_NAME__
  if (isIndex) {
    const indexPath = path.join(distDir, 'index.html');
    try {
      const html = fs.readFileSync(indexPath, 'utf8');
      const injected = html.replace(
        /<head([^>]*)>/i,
        `<head$1>\n<script>window.__EXT_NAME__=${JSON.stringify(name)};</script>`
      );
      res.set('content-type', 'text/html; charset=utf-8');
      // 缓存安全: 用 no-store, 避免开发期 dist 重建后浏览器拿到老 html.
      res.set('cache-control', 'no-store');
      return res.send(injected);
    } catch (e) {
      return res.status(500).send('failed to read index.html: ' + e.message);
    }
  }

  // 普通静态资源
  let abs = safeResolveAsset(distDir, rel);
  if (!abs) return res.status(400).send('bad path');
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    // Next.js 静态导出等 SPA 框架把 page 存为 <name>.html, 链接可能不带 .html 后缀.
    // 仅对"无扩展名"路径尝试补 .html, assets (.css/.js/.png 等) 不受影响.
    if (path.extname(rel) === '') {
      const withHtml = abs + '.html';
      if (fs.existsSync(withHtml) && fs.statSync(withHtml).isFile()) {
        abs = withHtml;
      } else {
        return res.status(404).send('not found');
      }
    } else {
      return res.status(404).send('not found');
    }
  }
  const ext = path.extname(abs).toLowerCase();
  const mime = MIME[ext];
  if (!mime) return res.status(403).send('mime not allowed');
  res.set('content-type', mime);
  // SVG 走严格 CSP, 防 svg xss
  if (ext === '.svg') res.set('content-security-policy', "default-src 'none'");
  fs.createReadStream(abs).pipe(res);
}

// SPA 框架 (如 Next.js) 静态导出的 chunk/runtime 走根路径 /_next/static/...,
// 不带 /extension/<name>/ 前缀 — webpack/runtime 直接拼绝对路径, 跟它所挂的
// HTML 路径无关. 如果只走 /extension/<name>/ 路由, 浏览器在加载
// /extension/jsoncrack/editor 时会发起 /_next/static/chunks/2591.<hash>.js
// 这种 unprefixed 请求, 当前 mobius 路由不知道, 落到 catchall 被退回
// 主前端的 index.html (text/html), 浏览器拿不到 JS, 报
// "Loading chunk 2591 failed" 这类错.
//
// 兜底: 把 /_next/* 也接进 extension 注册中心, 遍历所有 extension 的
// frontend/dist/_next/<rel>, 第一个匹配的静态文件直接返回. 多 extension
// 同名文件按 registry 顺序, 通常不会冲突; 必要的时候再用 Referer 锁定.
const unprefixedNextRouter = express.Router();
unprefixedNextRouter.get('/*', (req, res) => {
  const rel = (req.params[0] || '').replace(/^\/+/, '');
  if (!rel) return res.status(404).send('not found');
  // 防穿越: 只允许 _next/static, _next/data 这类合法子路径
  if (rel.split('/').some((seg) => seg === '..' || seg === '')) {
    return res.status(400).send('bad path');
  }
  for (const entry of registry.getAll()) {
    if (!entry?.frontend_dir) continue;
    const distDir = path.join(entry.frontend_dir, 'dist');
    const nextRoot = path.resolve(distDir, '_next');
    const abs = path.resolve(nextRoot, rel);
    if (abs !== nextRoot && !abs.startsWith(nextRoot + path.sep)) continue;
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
      const ext = path.extname(abs).toLowerCase();
      const mime = MIME[ext];
      if (!mime) return res.status(403).send('mime not allowed');
      res.set('content-type', mime);
      return fs.createReadStream(abs).pipe(res);
    }
  }
  return res.status(404).send('not found');
});

module.exports = { metaRouter, invokeRouter, staticRouter, unprefixedNextRouter };
