/**
 * web-search.js — best-effort 论文相关讨论 (Tavily).
 *
 * 必读: ARXIV_WEB_SEARCH_API_KEY 注入到 process.env; 缺失或失败 → 返回 [], 不抛.
 * 缓存: ext_data_dir/web_cache.json, key = arxiv_id, value = { ts, results: [...] }.
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_RESULTS = 5;

function loadCache(cacheFile) {
  try { return JSON.parse(fs.readFileSync(cacheFile, 'utf8')); }
  catch { return {}; }
}

function saveCache(cacheFile, data) {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(data));
  } catch { /* noop */ }
}

function postJson(url, headers, body, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const data = Buffer.from(JSON.stringify(body));
    const req = lib.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body: text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('web-search timeout')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function searchTavily({ apiKey, query }) {
  return postJson('https://api.tavily.com/search', { 'Authorization': `Bearer ${apiKey}` }, {
    api_key: apiKey,
    query,
    max_results: MAX_RESULTS,
    exclude_domains: ['arxiv.org'],
    include_answer: false,
  });
}

function mapResults(tavilyBody) {
  let parsed;
  try { parsed = JSON.parse(tavilyBody); } catch { return []; }
  const list = Array.isArray(parsed?.results) ? parsed.results : [];
  return list.slice(0, MAX_RESULTS).map((r) => ({
    title: String(r.title || '').slice(0, 500),
    url: String(r.url || '').slice(0, 1000),
    snippet: String(r.content || '').slice(0, 500),
    source: classifySource(r.url || ''),
  }));
}

function classifySource(url) {
  if (/reddit\.com/i.test(url)) return 'reddit';
  if (/twitter\.com|x\.com/i.test(url)) return 'twitter';
  if (/github\.com/i.test(url)) return 'github';
  if (/medium\.com|blog|wordpress|substack/i.test(url)) return 'blog';
  return 'other';
}

async function searchForPaper({ arxivId, title, abstract, dataDir, logger }) {
  const cacheFile = path.join(dataDir, 'web_cache.json');
  const cache = loadCache(cacheFile);
  const now = Date.now();
  if (cache[arxivId] && (now - (cache[arxivId].ts || 0)) < CACHE_TTL_MS) {
    return cache[arxivId].results;
  }
  const apiKey = process.env.ARXIV_WEB_SEARCH_API_KEY;
  if (!apiKey) {
    if (logger) logger.warn('web-search skipped: ARXIV_WEB_SEARCH_API_KEY not set');
    return [];
  }
  const query = `${title} ${abstract.split(/\s+/).slice(0, 8).join(' ')}`.slice(0, 300);
  try {
    const { status, body } = await searchTavily({ apiKey, query });
    if (status !== 200) {
      if (logger) logger.warn(`tavily status ${status}`);
      return [];
    }
    const results = mapResults(body);
    cache[arxivId] = { ts: now, results };
    saveCache(cacheFile, cache);
    return results;
  } catch (e) {
    if (logger) logger.warn(`web-search failed for ${arxivId}: ${e.message}`);
    return [];
  }
}

module.exports = { searchForPaper };
