/**
 * code-server-proxy.js — /code-server/<userId>__<projectId>/* 反代 + JWT.
 *
 * 流程:
 *   1. window.open(`/code-server/<key>/?folder=...&_jwt=<token>`)
 *   2. 路由检 _jwt → 写 cookie cc_cs_jwt → 302 去掉 _jwt 的干净 URL
 *   3. 后续 HTTP / WS 全走 cookie
 *   4. jwt.id 必须 === URL 里的 userId, 防越权
 *   5. pool.ensure() lazy 起进程, 反代过去
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const httpProxy = require('http-proxy');
const cookie = require('cookie');
const { JWT_SECRET } = require('../config');
const { Projects } = require('../repositories/projects');
const { canReadProject } = require('../services/access-control');
const pool = require('../services/code-server-pool');
const { resolveCodeServerWorkspace, validateCodeServerPayload } = require('../services/code-server-workspace');

const COOKIE_NAME = 'cc_cs_jwt';
const PATH_PREFIX = '/code-server/';

// 小莫面板的 "Skill" 快捷按钮使用一个虚拟 projectId 直接打开 mobius-assistant
// 技能源目录, 不需要真实项目行. 仅管理员可访问, 防止普通用户改动内置技能.
const SKILL_VIRTUAL_PROJECT_ID = 'xm-skills';
const BUILTIN_MOBIUS_ASSISTANT_SKILL_DIR = path.resolve(__dirname, '..', '..', '..', 'skills', 'mobius-assistant');

const proxy = httpProxy.createProxyServer({
  ws: true,
  xfwd: true,
  changeOrigin: false,
});

proxy.on('error', (err, req, res) => {
  console.error('[cs-proxy] proxy error:', err.message);
  try {
    if (res && !res.headersSent && res.writeHead) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('code-server 代理失败: ' + err.message);
    }
  } catch {}
});

function parseKey(urlPath) {
  if (!urlPath.startsWith(PATH_PREFIX)) return null;
  const after = urlPath.slice(PATH_PREFIX.length);
  const sep = after.indexOf('/');
  const key = sep === -1 ? after : after.slice(0, sep);
  const rest = sep === -1 ? '/' : after.slice(sep);
  const m = key.match(/^([A-Za-z0-9_-]+)__([A-Za-z0-9_-]+)$/);
  if (!m) return null;
  return { userId: m[1], projectId: m[2], rest, key };
}

function extractJwt(req) {
  try {
    const u = new URL(req.url, 'http://x');
    const q = u.searchParams.get('_jwt');
    if (q) return { token: q, from: 'query' };
  } catch {}
  const cookies = cookie.parse(req.headers?.cookie || '');
  if (cookies[COOKIE_NAME]) return { token: cookies[COOKIE_NAME], from: 'cookie' };
  return null;
}

function verifyJwt(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

function queryParam(rawUrl, name) {
  try {
    return new URL(rawUrl, 'http://x').searchParams.get(name) || '';
  } catch {
    return '';
  }
}

function hasQueryParam(rawUrl, name) {
  try {
    return new URL(rawUrl, 'http://x').searchParams.has(name);
  } catch {
    return false;
  }
}

function liveEntry(k) {
  const entry = pool.get(k);
  return entry && entry.proc && !entry.proc.killed ? entry : null;
}

function pickWorkspace(project, rawUrl, k) {
  const hasFolder = hasQueryParam(rawUrl, 'folder');
  if (!hasFolder) {
    const existing = liveEntry(k);
    if (existing?.bindPath) return { workspacePath: existing.bindPath, hasFolder };
  }
  return { ...resolveCodeServerWorkspace(project, queryParam(rawUrl, 'folder')), hasFolder };
}

function checkProjectAccess(user, projectId) {
  if (projectId === SKILL_VIRTUAL_PROJECT_ID) {
    if (user?.role !== 'admin') return { ok: false, status: 403, msg: '仅管理员可编辑小莫内置技能' };
    const skillDir = BUILTIN_MOBIUS_ASSISTANT_SKILL_DIR;
    if (!fs.existsSync(skillDir) || !fs.statSync(skillDir).isDirectory()) {
      return { ok: false, status: 404, msg: '小莫内置技能目录不存在: ' + skillDir };
    }
    return {
      ok: true,
      project: { id: projectId, bind_path: skillDir, bind_path_manual: true, kind: '' },
    };
  }
  const p = Projects.findById(projectId);
  if (!p) return { ok: false, status: 404, msg: '项目不存在' };
  if (!canReadProject(user, p)) return { ok: false, status: 404, msg: '项目不存在' };
  if (!p.bind_path) return { ok: false, status: 400, msg: '项目未配置 bind_path' };
  return { ok: true, project: p };
}

const router = express.Router();

router.use(async (req, res, next) => {
  const urlPath = req.originalUrl.split('?')[0];
  const parsed = parseKey(urlPath);
  if (!parsed) return res.status(404).send('bad code-server path');

  const found = extractJwt(req);
  if (!found) return res.status(401).send('需要登录: 缺 JWT (cookie 或 _jwt query)');
  const user = verifyJwt(found.token);
  if (!user) return res.status(401).send('JWT 校验失败');
  if (user.id !== parsed.userId) return res.status(403).send('用户身份不匹配 URL key');

  const acc = checkProjectAccess(user, parsed.projectId);
  if (!acc.ok) return res.status(acc.status).send(acc.msg);

  if (found.from === 'query') {
    res.setHeader('Set-Cookie', cookie.serialize(COOKIE_NAME, found.token, {
      httpOnly: true, sameSite: 'lax', path: '/code-server', maxAge: 4 * 3600,
    }));
    const cleanUrl = new URL(req.originalUrl, 'http://x');
    cleanUrl.searchParams.delete('_jwt');
    return res.redirect(302, cleanUrl.pathname + cleanUrl.search + cleanUrl.hash);
  }

  const workspace = pickWorkspace(acc.project, req.originalUrl, parsed.key);
  if (workspace.error) {
    if (workspace.code === 'BIND_PATH_DENIED') return res.status(403).send(workspace.error);
    return res.status(404).send(workspace.error);
  }
  const payloadCheck = validateCodeServerPayload(acc.project, queryParam(req.originalUrl, 'payload'), workspace.workspacePath);
  if (!payloadCheck.ok) return res.status(403).send(payloadCheck.error);

  let entry;
  try { entry = await pool.ensure(user, parsed.projectId, workspace.workspacePath); }
  catch (e) {
    console.error('[cs-proxy] pool.ensure failed:', e.message);
    if (e.code === 'BIND_PATH_RO') return res.status(403).send(`📂 此项目目录对服务进程不可写: ${workspace.workspacePath}\n请联系管理员 chmod 调权限`);
    if (e.code === 'BIND_PATH_INVALID') return res.status(404).send(`📂 项目目录不存在: ${workspace.workspacePath}`);
    return res.status(503).send('code-server 启动失败: ' + e.message);
  }
  pool.touch(parsed.key);

  req.url = parsed.rest + (req.originalUrl.includes('?') ? '?' + req.originalUrl.split('?').slice(1).join('?') : '');
  if (workspace.hasFolder) {
    req.url = req.url.replace(
      /([?&]folder=)[^&]*/,
      `$1${encodeURIComponent(workspace.workspacePath)}`,
    );
  }
  proxy.web(req, res, { target: `http://127.0.0.1:${entry.port}` });
});

async function handleUpgrade(req, socket, head) {
  const urlPath = req.url.split('?')[0];
  const parsed = parseKey(urlPath);
  if (!parsed) return socket.destroy();

  const found = extractJwt(req);
  if (!found) return socket.destroy();
  const user = verifyJwt(found.token);
  if (!user || user.id !== parsed.userId) return socket.destroy();

  const acc = checkProjectAccess(user, parsed.projectId);
  if (!acc.ok) return socket.destroy();

  const workspace = pickWorkspace(acc.project, req.url, parsed.key);
  if (workspace.error) return socket.destroy();

  let entry;
  try { entry = await pool.ensure(user, parsed.projectId, workspace.workspacePath); }
  catch (e) { console.error('[cs-proxy/ws] ensure failed:', e.message); return socket.destroy(); }
  pool.touch(parsed.key);

  req.url = parsed.rest + (req.url.includes('?') ? '?' + req.url.split('?').slice(1).join('?') : '');
  proxy.ws(req, socket, head, { target: `ws://127.0.0.1:${entry.port}` });
}

const adminRouter = express.Router();
adminRouter.get('/list', (req, res) => {
  const found = extractJwt(req);
  const user = found && verifyJwt(found.token);
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  res.json(pool.list());
});

module.exports = { router, handleUpgrade, adminRouter };
