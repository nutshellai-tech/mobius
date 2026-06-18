/**
 * paper-summarizer.js — 把 arxiv 摘要生成中文摘要 (≤ 200 字).
 *
 * MVP 优先: 默认直接使用 arxiv 自带 abstract, 不强依赖 LLM.
 * 如果有 ARXIV_SUMMARIZER_ENDPOINT (POST JSON {title, abstract} -> {summary})
 *   且成功, 用它的返回; 否则 fall back 到 abstract (截断到 200 字).
 * 永不抛错.
 */

const http = require('http');
const https = require('https');

function postJson(url, body, { timeoutMs = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const data = Buffer.from(JSON.stringify(body));
    const req = lib.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('summarizer timeout')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function callEndpoint({ title, abstract }) {
  const url = process.env.ARXIV_SUMMARIZER_ENDPOINT;
  if (!url) return null;
  try {
    const { status, body } = await postJson(url, { title, abstract });
    if (status !== 200) return null;
    const parsed = JSON.parse(body);
    const s = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
    if (!s) return null;
    return s.slice(0, 200);
  } catch {
    return null;
  }
}

function fallback({ abstract }) {
  if (!abstract) return '';
  // MVP: 直接把 abstract 截断到 200 字 (按字符算)
  const s = abstract.replace(/\s+/g, ' ').trim();
  return s.length > 200 ? s.slice(0, 197) + '...' : s;
}

async function summarize({ title, abstract }) {
  const fromEndpoint = await callEndpoint({ title, abstract });
  if (fromEndpoint) return fromEndpoint;
  return fallback({ abstract });
}

module.exports = { summarize };
