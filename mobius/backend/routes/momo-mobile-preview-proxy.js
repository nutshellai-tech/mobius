const fs = require('fs');
const path = require('path');
const cookie = require('cookie');
const express = require('express');
const httpProxy = require('http-proxy');
const { TEST_ROOT } = require('../config');

const PATH_PREFIX = '/momo_mobile_preview';
const COOKIE_NAME = 'momo_mobile_preview_token';
const TOKEN_FILE = process.env.MOMO_MOBILE_PREVIEW_TOKEN_FILE ||
  path.join(TEST_ROOT, '.tmp', 'momo-mobile-preview', 'access-token');
const TARGET = process.env.MOMO_MOBILE_PREVIEW_TARGET || 'http://127.0.0.1:6088';

const proxy = httpProxy.createProxyServer({
  ws: true,
  xfwd: true,
  changeOrigin: false,
  target: TARGET,
});

proxy.on('error', (err, req, res) => {
  console.error('[momo-preview-proxy] proxy error:', err.message);
  try {
    if (res && !res.headersSent && res.writeHead) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('小莫移动端预览代理失败: ' + err.message);
    }
  } catch {}
});

function readToken() {
  const fromEnv = (process.env.MOMO_MOBILE_PREVIEW_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

function tokenFromQuery(rawUrl) {
  try {
    const u = new URL(rawUrl, 'http://x');
    return u.searchParams.get('preview_token') || '';
  } catch {
    return '';
  }
}

function tokenFromCookie(req) {
  try {
    return cookie.parse(req.headers?.cookie || '')[COOKIE_NAME] || '';
  } catch {
    return '';
  }
}

function isAuthorized(req) {
  const expected = readToken();
  if (!expected) return { ok: false, status: 503, message: '小莫移动端预览 token 尚未生成，请先启动 desktopPreview/run-local-preview.sh' };
  const supplied = tokenFromQuery(req.url || req.originalUrl || '') || tokenFromCookie(req);
  if (supplied !== expected) return { ok: false, status: 401, message: '小莫移动端预览需要有效 preview_token' };
  return { ok: true, expected };
}

function stripPreviewToken(rawUrl) {
  try {
    const u = new URL(rawUrl, 'http://x');
    u.searchParams.delete('preview_token');
    return u.pathname + u.search;
  } catch {
    return rawUrl;
  }
}

function setPreviewCookie(res, token) {
  res.setHeader('Set-Cookie', cookie.serialize(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: PATH_PREFIX,
    maxAge: 12 * 3600,
  }));
}

const router = express.Router();

function previewUrl(req, token) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = forwardedProto || req.protocol || 'http';
  const hostHeader = req.get('host') || '127.0.0.1:45616';
  const host = hostHeader.replace(/:\d+$/, '');
  const explicitPort = (hostHeader.match(/:(\d+)$/) || [])[1];
  const port = explicitPort || (proto === 'https' ? '443' : '80');
  const params = new URLSearchParams({
    host,
    port,
    path: 'momo_mobile_preview/websockify',
    autoconnect: 'true',
    resize: 'scale',
    preview_token: token,
  });
  if (proto === 'https') params.set('encrypt', '1');
  return `${PATH_PREFIX}/vnc.html?${params.toString()}`;
}

router.get('/open', (req, res) => {
  const token = readToken();
  if (!token) {
    return res.status(503).send('小莫移动端预览 token 尚未生成，请先启动 desktopPreview/run-local-preview.sh');
  }
  setPreviewCookie(res, token);
  res.redirect(302, previewUrl(req, token));
});

router.use((req, res) => {
  const auth = isAuthorized(req);
  if (!auth.ok) return res.status(auth.status).send(auth.message);
  if (tokenFromQuery(req.originalUrl || req.url || '')) setPreviewCookie(res, auth.expected);
  req.url = stripPreviewToken(req.url);
  proxy.web(req, res, { target: TARGET });
});

function handleUpgrade(req, socket, head) {
  const rawPath = (req.url || '').split('?')[0];
  if (rawPath !== PATH_PREFIX && !rawPath.startsWith(`${PATH_PREFIX}/`)) return false;

  const auth = isAuthorized(req);
  if (!auth.ok) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return true;
  }

  req.url = stripPreviewToken(req.url.slice(PATH_PREFIX.length) || '/');
  proxy.ws(req, socket, head, { target: TARGET.replace(/^http:/, 'ws:') });
  return true;
}

module.exports = {
  router,
  handleUpgrade,
  PATH_PREFIX,
  TOKEN_FILE,
};
