/**
 * paper-summarizer.js — 把 arxiv 摘要翻译成中文短摘要 (≤ 200 字).
 *
 * 优先级:
 *   1) 用户自定义 ARXIV_SUMMARIZER_ENDPOINT (POST {title, abstract} -> {summary})
 *   2) 平台 LLM 网关 (ARXIV_LLM_API_BASE / ARXIV_LLM_API_KEY, 默认 qwen3.6-plus @ 192.168.4.254:29928)
 *   3) 直接把 abstract 截断到 200 字 (英文兜底, 非中文, 仅作为最坏情况)
 *
 * 永不抛错; 任何一步失败都安全降级.
 */

const http = require('http');
const https = require('https');

const DEFAULT_LLM_BASE = 'http://192.168.4.254:29928/v1';
const DEFAULT_LLM_MODEL = 'qwen3.6-plus';
const SUMMARIZER_TIMEOUT_MS = 16_000;

function postJsonRaw(url, body, { timeoutMs = SUMMARIZER_TIMEOUT_MS } = {}) {
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

async function callUserEndpoint({ title, abstract }) {
  const url = process.env.ARXIV_SUMMARIZER_ENDPOINT;
  if (!url) return null;
  try {
    const { status, body } = await postJsonRaw(url, { title, abstract });
    if (status !== 200) return null;
    const parsed = JSON.parse(body);
    const s = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
    if (!s) return null;
    return s.slice(0, 200);
  } catch {
    return null;
  }
}

function resolveLlm() {
  const apiBase = process.env.ARXIV_LLM_API_BASE || DEFAULT_LLM_BASE;
  const apiKey = process.env.ARXIV_LLM_API_KEY || '';
  const model = process.env.ARXIV_LLM_MODEL || DEFAULT_LLM_MODEL;
  return { apiBase: apiBase.replace(/\/+$/, ''), apiKey, model };
}

const SYSTEM_PROMPT = [
  '你是一名严谨的学术编辑, 负责把英文学术论文摘要改写成中文短摘要.',
  '要求:',
  '1) 输出纯中文, 长度 80-180 字.',
  '2) 保留核心贡献、方法、关键结果; 模型/方法名等专有名词可保留英文 (如 GPT-4, VLA, LoRA).',
  '3) 避免空洞表述 ("本文提出了一种新方法"), 直接说方法是什么、解决什么问题.',
  '4) 不得包含 markdown, bullet 列表或代码块.',
  '5) 只输出摘要正文, 不要重复标题, 不要加 "摘要:" 前缀.',
].join('\n');

async function callPlatformLlm({ title, abstract }) {
  const { apiBase, apiKey, model } = resolveLlm();
  if (!apiKey) return null;
  const userPrompt = `标题: ${title || '(无标题)'}\n\n摘要:\n${abstract || '(无摘要)'}`;
  try {
    const { status, body } = await postJsonRaw(`${apiBase}/chat/completions`, {
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
      stream: false,
    }, SUMMARIZER_TIMEOUT_MS);
    if (status !== 200) return null;
    const parsed = JSON.parse(body);
    const content = parsed.choices?.[0]?.message?.content;
    const s = typeof content === 'string' ? content.trim() : '';
    if (!s) return null;
    return s.slice(0, 200);
  } catch {
    return null;
  }
}

function fallback({ abstract }) {
  if (!abstract) return '';
  const s = abstract.replace(/\s+/g, ' ').trim();
  return s.length > 200 ? s.slice(0, 197) + '...' : s;
}

async function summarize({ title, abstract }) {
  if (!abstract && !title) return '';
  const fromUser = await callUserEndpoint({ title, abstract });
  if (fromUser) return fromUser;
  const fromPlatform = await callPlatformLlm({ title, abstract });
  if (fromPlatform) return fromPlatform;
  return fallback({ abstract });
}

module.exports = { summarize };
