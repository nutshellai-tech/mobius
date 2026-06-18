/**
 * arxiv-fetcher.js — 拉取 arxiv API, 解析 Atom XML, 去重后返回新论文.
 *
 * 协议: 走 arxiv 官方 export API, 不需要 API key. 速率限制 ≤ 1 req / 3s.
 * 去重: 查 papers 表已存在的 arxiv_id, 过滤后只返回新行.
 */

const http = require('http');
const https = require('https');

const ENDPOINT = 'https://export.arxiv.org/api/query';

function parseEntry(xml, idMap) {
  // 极简 Atom 解析, 不引 xml 库. arxiv 返回结构稳定.
  const get = (re) => {
    const m = xml.match(re);
    return m ? m[1].trim() : '';
  };
  const getAll = (re) => {
    const out = [];
    let m;
    const r = new RegExp(re.source, re.flags + 'g');
    while ((m = r.exec(xml)) !== null) out.push(decodeXml(m[1].trim()));
    return out;
  };
  const fullId = get(/<id>\s*([^<]+?)\s*<\/id>/);
  // id 形如 http://arxiv.org/abs/2606.12345v1
  const arxivId = (fullId.split('/').pop() || '').replace(/v\d+$/, '');
  const title = decodeXml(get(/<title>\s*([\s\S]*?)\s*<\/title>/)).replace(/\s+/g, ' ');
  const abstract = decodeXml(get(/<summary>\s*([\s\S]*?)\s*<\/summary>/)).replace(/\s+/g, ' ').trim();
  const published = get(/<published>\s*([^<]+?)\s*<\/published>/);
  const updated = get(/<updated>\s*([^<]+?)\s*<\/updated>/);
  const authors = getAll(/<author>\s*<name>\s*([^<]+?)\s*<\/name>\s*<\/author>/);
  return {
    arxiv_id: arxivId,
    title: title.slice(0, 500),
    authors,
    abstract: abstract.slice(0, 5000),
    url: `https://arxiv.org/abs/${arxivId}`,
    published_at: (published || updated || '').slice(0, 19) || null,
  };
}

function decodeXml(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function httpGet(url, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => { req.destroy(new Error('arxiv api timeout')); });
    req.on('error', reject);
  });
}

function buildQuery({ query, maxResults = 20, since }) {
  // arxiv API 对 URL 编码挑剔: 括号、+、%20 表现不一致.
  // 手拼 search_query, 空格用 %20, 其它保留.
  let q = query || 'all';
  if (since) {
    const d = new Date(since);
    if (!Number.isNaN(d.getTime())) {
      const pad = (n) => String(n).padStart(2, '0');
      const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}0000`;
      const now = new Date();
      const endStamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}2359`;
      q = `(${q}) AND submittedDate:[${stamp} TO ${endStamp}]`;
    }
  }
  const params = [
    `search_query=${encodeURIComponent(q)}`,
    `max_results=${maxResults}`,
    'sortBy=submittedDate',
    'sortOrder=descending',
  ];
  return `${ENDPOINT}?${params.join('&')}`;
}

async function fetchOnce({ query, maxResults = 20, since }) {
  const url = buildQuery({ query, maxResults, since });
  const { status, body } = await httpGet(url);
  if (status !== 200) {
    throw new Error(`arxiv api status ${status}`);
  }
  // 切 entry
  const entries = body.split(/<entry>/).slice(1).map((chunk) => '<entry>' + chunk.split(/<\/entry>/)[0] + '</entry>');
  return entries.map((e) => parseEntry(e)).filter((p) => p.arxiv_id && p.title);
}

async function fetchNew({ query, maxResults = 20, since, existingIds }) {
  const all = await fetchOnce({ query, maxResults, since });
  const seen = new Set(existingIds || []);
  const fresh = all.filter((p) => !seen.has(p.arxiv_id));
  return { fresh, total: all.length };
}

module.exports = { fetchNew, fetchOnce };
