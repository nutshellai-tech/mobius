const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { createExtensionAnalysisSession, loadUser } = require('../../../backend/services/extension-agent-bridge');

const EXTENSION_NAME = 'finance-news-wall';
const EXTENSION_DISPLAY_NAME = '金融新闻墙';
const FINANCE_NEWS_SKILL_ID = 'builtin:finance-news-wall';
const MAX_EVENTS = 1000;
const MAX_RUNS = 120;
const MAX_SCAN_ITEMS = 80;
// ---------------------------------------------------------------------------
// LLM 接入配置（通过环境变量注入，不要在代码里硬编码 IP 或 Key）
//
// 在项目根目录 .env 中配置（填一次，所有扩展共享）：
//   ASSISTANT_API_BASE=http://your-llm-host/v1    # LLM API 地址（兼容 OpenAI 格式）
//   ASSISTANT_API_KEY=sk-your-api-key-here         # LLM API 鉴权 Key
//   ASSISTANT_MODEL=your-model-name               # 默认模型名称
//
// 也可单独为本扩展设置（优先级更高）：
//   FINANCE_NEWS_LLM_API_BASE=http://...
//   FINANCE_NEWS_LLM_MODEL=your-model-name
// ---------------------------------------------------------------------------
const DEFAULT_LLM_BASE = (
  process.env.FINANCE_NEWS_LLM_API_BASE
  || process.env.ASSISTANT_API_BASE
  || ''
).replace(/\/+$/, '');
const DEFAULT_LLM_MODEL = process.env.FINANCE_NEWS_LLM_MODEL
  || process.env.ASSISTANT_MODEL
  || 'gpt-4o-mini';

const DEFAULT_RSS_SOURCES = [
  { id: 'federal-reserve', name: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml', enabled: true },
  { id: 'sec-press', name: 'SEC Press Releases', url: 'https://www.sec.gov/news/pressreleases.rss', enabled: true },
  { id: 'yahoo-finance', name: 'Yahoo Finance', url: 'https://finance.yahoo.com/news/rssindex', enabled: true },
];

const DEFAULT_BOARD_DEFS = [
  {
    id: 'macro-global',
    name: '全球宏观',
    description: '央行、通胀、就业、财政、经济数据和全球风险偏好。',
    keywords: ['美联储', 'Fed', 'CPI', 'PCE', '非农', '就业', '通胀', 'GDP', 'PMI', '央行', '财政', '美债收益率'],
    asset_classes: ['macro', 'rates', 'fx'],
    regions: ['GLOBAL', 'US', 'CN', 'EU', 'JP'],
    interval_minutes: 10,
  },
  {
    id: 'rates-fx',
    name: '利率与汇率',
    description: '利率预期、债券收益率、美元、人民币、日元和流动性。',
    keywords: ['利率', '降息', '加息', '美债', '收益率', '美元指数', '人民币', '日元', '汇率', '流动性', '逆回购'],
    asset_classes: ['rates', 'fx'],
    regions: ['GLOBAL', 'US', 'CN', 'JP', 'EU'],
    interval_minutes: 10,
  },
  {
    id: 'china-policy-a-share',
    name: 'A股与中国政策',
    description: 'A股、国内政策、监管、产业政策、资金面和市场情绪。',
    keywords: ['A股', '沪深300', '创业板', '科创板', '北向资金', '融资融券', '证监会', '交易所', '国常会', '发改委', '财政部', '并购重组'],
    asset_classes: ['equity'],
    regions: ['CN'],
    interval_minutes: 5,
  },
  {
    id: 'hk-china-internet',
    name: '港股与中概互联网',
    description: '恒生科技、港股、中概股、互联网平台和南向资金。',
    keywords: ['港股', '恒生指数', '恒生科技', '中概股', 'ADR', '腾讯', '阿里', '美团', '京东', '百度', '网易', '南向资金', '互联网监管'],
    asset_classes: ['equity'],
    regions: ['CN', 'HK', 'US'],
    interval_minutes: 10,
  },
  {
    id: 'us-global-equity',
    name: '美股与全球股指',
    description: '美股指数、全球股指、财报、科技巨头和风险偏好。',
    keywords: ['美股', 'S&P 500', 'Nasdaq', 'Dow Jones', '纳斯达克', '财报', 'guidance', 'buyback', 'Apple', 'Microsoft', 'Nvidia', 'Tesla'],
    asset_classes: ['equity'],
    regions: ['US', 'GLOBAL'],
    interval_minutes: 10,
  },
  {
    id: 'tech-supply-chain',
    name: '科技与产业链',
    description: 'AI、半导体、算力、光模块、新能源、机器人和供应链限制。',
    keywords: ['AI', '人工智能', 'GPU', '算力', '半导体', '芯片', '光模块', '数据中心', '新能源车', '锂电', '光伏', '储能', '机器人', '出口管制'],
    asset_classes: ['equity'],
    regions: ['CN', 'US', 'GLOBAL'],
    interval_minutes: 10,
  },
  {
    id: 'commodities-energy',
    name: '商品、能源与贵金属',
    description: '原油、天然气、黄金、铜、农产品和供需冲击。',
    keywords: ['原油', 'WTI', 'Brent', 'OPEC', 'EIA', '天然气', '黄金', '白银', '铜', '铁矿石', '农产品', '供应中断', '航运'],
    asset_classes: ['commodities'],
    regions: ['GLOBAL', 'US', 'CN', 'EU'],
    interval_minutes: 10,
  },
  {
    id: 'finance-property-credit',
    name: '金融、地产与信用风险',
    description: '银行、券商、保险、地产、信用债、流动性和违约风险。',
    keywords: ['银行', '券商', '保险', '房地产', '地产政策', '按揭', '信用债', '城投债', '违约', '流动性', '不良贷款', '评级下调'],
    asset_classes: ['equity', 'rates'],
    regions: ['CN', 'US', 'GLOBAL'],
    interval_minutes: 10,
  },
  {
    id: 'geopolitics-regulation',
    name: '地缘政治与监管突发',
    description: '战争、制裁、关税、出口管制、监管调查和突发事故。',
    keywords: ['战争', '冲突', '制裁', '关税', '出口管制', '贸易摩擦', '选举', '监管调查', '反垄断', 'SEC', 'DOJ', '数据安全'],
    asset_classes: ['macro', 'equity', 'commodities'],
    regions: ['GLOBAL', 'US', 'CN', 'EU'],
    interval_minutes: 10,
  },
  {
    id: 'crypto-assets',
    name: '加密资产',
    description: 'Bitcoin、Ethereum、ETF、稳定币、交易所和加密监管。',
    keywords: ['Bitcoin', 'BTC', 'Ethereum', 'ETH', 'ETF', 'stablecoin', '稳定币', 'Coinbase', 'Binance', '加密监管', '链上清算'],
    asset_classes: ['crypto'],
    regions: ['GLOBAL', 'US'],
    interval_minutes: 15,
    enabled: false,
    show_on_home: false,
  },
];

const KEY_FIELDS = [
  'llm_api_key',
  'newsapi_key',
  'alphavantage_key',
  'finnhub_key',
  'brave_search_key',
];

function pickKey(value) {
  return value && !/^replace-me/i.test(value) ? value : '';
}

function sha1(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex');
}

function safeUserSegment(username) {
  return String(username || 'unknown').replace(/[^A-Za-z0-9_.@-]/g, '_').slice(0, 120) || 'unknown';
}

function nowIso() {
  return new Date().toISOString();
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function trimText(value, max = 500) {
  const s = String(value || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function normalizeId(value, fallback = 'source') {
  const s = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (s || fallback).slice(0, 80);
}

function listFromInput(values) {
  if (Array.isArray(values)) return values;
  if (typeof values === 'string') {
    return values
      .split(/[\n,，;；]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function uniqueStrings(values, max = 80) {
  const out = [];
  const seen = new Set();
  for (const raw of listFromInput(values)) {
    const value = trimText(raw, max);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function detectMarket(code) {
  const c = String(code || '').trim().toUpperCase();
  if (/^\d{6}$/.test(c)) return 'A股';
  if (/^\d{5}$/.test(c)) return '港股';
  if (/^[A-Z.]{1,6}$/.test(c)) return '美股';
  return '';
}

function normalizeStock(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return null;
    const parts = text.split(/\s+/).filter(Boolean);
    let code = '';
    let name = text;
    for (const part of parts) {
      const normalized = part.toUpperCase();
      if (/^\d{5,6}$/.test(normalized) || /^[A-Z.]{1,6}$/.test(normalized)) {
        code = normalized;
        name = parts.filter((p) => p !== part).join(' ') || text;
        break;
      }
    }
    return normalizeStock({ name, code });
  }
  const code = trimText(raw.code || raw.ticker || '', 24).toUpperCase();
  const name = trimText(raw.name || raw.company || code, 80);
  if (!name && !code) return null;
  const market = trimText(raw.market || detectMarket(code) || '自定义', 20);
  const aliases = uniqueStrings([name, code, ...(Array.isArray(raw.aliases) ? raw.aliases : [])], 80);
  return {
    market,
    code,
    name: name || code,
    aliases,
    weight: Math.max(0.2, Math.min(3, Number(raw.weight) || 1)),
  };
}

function normalizeStocks(value) {
  return listFromInput(value)
    .map(normalizeStock)
    .filter(Boolean)
    .slice(0, 200);
}

function boardIdFromInput(raw, fallback = {}) {
  const explicit = normalizeId(raw?.id || '', '');
  if (explicit) return explicit;
  if (fallback.id) return fallback.id;
  const name = trimText(raw?.name || '', 80);
  if (name) return `custom-${sha1(name).slice(0, 10)}`;
  return 'board';
}

function normalizeBoard(raw, fallback = {}) {
  const merged = { ...fallback, ...(raw && typeof raw === 'object' ? raw : {}) };
  const id = boardIdFromInput(merged, fallback);
  const name = trimText(merged.name || fallback.name || id, 80);
  const stocks = normalizeStocks(merged.stocks);
  return {
    id,
    type: merged.type === 'custom' ? 'custom' : 'default',
    name,
    description: trimText(merged.description || '', 240),
    enabled: merged.enabled !== false,
    show_on_home: merged.show_on_home !== false,
    keywords: uniqueStrings(merged.keywords || [], 80).slice(0, 120),
    exclude_keywords: uniqueStrings(merged.exclude_keywords || merged.excludes || [], 80).slice(0, 80),
    stocks,
    asset_classes: uniqueStrings(merged.asset_classes || [], 40).slice(0, 12),
    regions: uniqueStrings(merged.regions || [], 20).slice(0, 12),
    interval_minutes: clampInt(merged.interval_minutes, fallback.interval_minutes || 10, 5, 7 * 24 * 60),
    max_items: clampInt(merged.max_items, fallback.max_items || 30, 1, MAX_SCAN_ITEMS),
    impact_threshold: clampInt(merged.impact_threshold, fallback.impact_threshold || 60, 1, 100),
    auto_session_threshold: clampInt(merged.auto_session_threshold, fallback.auto_session_threshold || 90, 1, 100),
  };
}

function defaultBoards() {
  return DEFAULT_BOARD_DEFS.map((board) => normalizeBoard({
    ...board,
    type: 'default',
    max_items: 30,
    impact_threshold: 60,
    auto_session_threshold: 90,
  }));
}

function normalizeBoards(rawBoards) {
  const defaults = defaultBoards();
  const byId = new Map(defaults.map((board) => [board.id, board]));
  for (const raw of Array.isArray(rawBoards) ? rawBoards : []) {
    const fallback = byId.get(boardIdFromInput(raw, {})) || {};
    const normalized = normalizeBoard(raw, fallback);
    byId.set(normalized.id, normalized);
  }
  return Array.from(byId.values());
}

function boardById(settings, boardId) {
  const boards = Array.isArray(settings.boards) ? settings.boards : [];
  return boards.find((board) => board.id === boardId)
    || boards.find((board) => board.id === settings.active_board_id)
    || boards.find((board) => board.enabled)
    || boards[0]
    || null;
}

function boardSearchText(board, fallback = '') {
  if (!board) return trimText(fallback || '全球金融市场', 300);
  const stockTerms = (board.stocks || [])
    .flatMap((stock) => [stock.name, stock.code, ...(stock.aliases || [])])
    .filter(Boolean);
  return uniqueStrings([
    board.name,
    board.description,
    ...(board.keywords || []),
    ...stockTerms,
    fallback,
  ], 80).slice(0, 36).join(' ');
}

function scheduleIdFor(paths, boardId) {
  return `${paths.userSeg}-${normalizeId(boardId || 'default', 'default')}`;
}

function scheduleFileFor(paths, boardId) {
  return path.join(paths.schedulesDir, `${scheduleIdFor(paths, boardId)}.json`);
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

async function readScheduleStatuses(paths) {
  const statuses = {};
  let entries = [];
  try {
    entries = await fs.readdir(paths.schedulesDir, { withFileTypes: true });
  } catch {
    return statuses;
  }
  const prefix = `${paths.userSeg}-`;
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || !entry.name.endsWith('.json') || !entry.name.startsWith(prefix)) return;
    const file = path.join(paths.schedulesDir, entry.name);
    const schedule = await readJson(file, null);
    if (!schedule || typeof schedule !== 'object') return;
    const boardIdFromFile = entry.name.slice(prefix.length, -'.json'.length);
    const boardId = trimText(schedule.payload?.board_id || schedule.board_id || boardIdFromFile || 'default', 80);
    statuses[boardId] = schedule;
  }));
  return statuses;
}

function pathsFor(extDataDir, username) {
  const userSeg = safeUserSegment(username);
  const userDir = path.join(extDataDir, 'users', userSeg);
  return {
    userSeg,
    userDir,
    settings: path.join(userDir, 'settings.json'),
    secrets: path.join(userDir, 'secrets.json'),
    events: path.join(userDir, 'events.json'),
    runs: path.join(userDir, 'runs.json'),
    schedulesDir: path.join(extDataDir, 'schedules'),
    scheduleFile: path.join(extDataDir, 'schedules', `${userSeg}-default.json`),
  };
}

function defaultSettings() {
  const boards = defaultBoards();
  return {
    boards,
    active_board_id: boards.find((board) => board.enabled)?.id || boards[0]?.id || 'macro-global',
    providers: {
      rss: { enabled: true, sources: DEFAULT_RSS_SOURCES },
      newsapi: { enabled: false },
      alphavantage: { enabled: false },
      finnhub: { enabled: false },
      brave_search: { enabled: false },
      llm: { enabled: true, api_base: DEFAULT_LLM_BASE, model: DEFAULT_LLM_MODEL },
    },
    watchlist: ['Federal Reserve', 'CPI', 'PCE', 'Treasury yields', 'oil', 'USD', 'earnings'],
    manual: { direction: '全球金融市场', max_items: 30 },
    schedule: { enabled: false, direction: '全球金融市场', interval_minutes: 30, max_items: 30 },
  };
}

function mergeSettings(current, incoming) {
  const base = current && typeof current === 'object' ? current : defaultSettings();
  const src = incoming && typeof incoming === 'object' ? incoming : {};
  const baseBoards = normalizeBoards(base.boards);
  const next = {
    ...base,
    boards: baseBoards,
    active_board_id: base.active_board_id || baseBoards.find((board) => board.enabled)?.id || baseBoards[0]?.id || 'macro-global',
    providers: { ...(base.providers || {}) },
    manual: { ...(base.manual || {}) },
    schedule: { ...(base.schedule || {}) },
  };

  if (Array.isArray(src.watchlist)) {
    next.watchlist = src.watchlist.map((x) => trimText(x, 80)).filter(Boolean).slice(0, 120);
  }
  if (src.manual && typeof src.manual === 'object') {
    next.manual.direction = trimText(src.manual.direction || next.manual.direction, 160);
    next.manual.max_items = clampInt(src.manual.max_items, next.manual.max_items || 30, 1, MAX_SCAN_ITEMS);
  }
  if (src.schedule && typeof src.schedule === 'object') {
    next.schedule.enabled = src.schedule.enabled === true;
    next.schedule.direction = trimText(src.schedule.direction || next.schedule.direction, 160);
    next.schedule.interval_minutes = clampInt(src.schedule.interval_minutes, next.schedule.interval_minutes || 30, 5, 7 * 24 * 60);
    next.schedule.max_items = clampInt(src.schedule.max_items, next.schedule.max_items || 30, 1, MAX_SCAN_ITEMS);
  }
  if (Array.isArray(src.boards)) {
    next.boards = normalizeBoards(src.boards);
  }
  if (typeof src.active_board_id === 'string') {
    const active = boardById({ boards: next.boards }, src.active_board_id);
    if (active) next.active_board_id = active.id;
  }
  if (!next.boards.some((board) => board.id === next.active_board_id)) {
    next.active_board_id = next.boards.find((board) => board.enabled)?.id || next.boards[0]?.id || 'macro-global';
  }
  if (src.providers && typeof src.providers === 'object') {
    const providerNames = ['rss', 'newsapi', 'alphavantage', 'finnhub', 'brave_search', 'llm'];
    for (const name of providerNames) {
      const p = src.providers[name];
      if (!p || typeof p !== 'object') continue;
      next.providers[name] = { ...(next.providers[name] || {}) };
      if (typeof p.enabled === 'boolean') next.providers[name].enabled = p.enabled;
      if (name === 'rss' && Array.isArray(p.sources)) {
        next.providers.rss.sources = p.sources.map((row) => ({
          id: normalizeId(row.id || row.name || row.url, 'rss'),
          name: trimText(row.name || row.id || 'RSS', 80),
          url: trimText(row.url, 600),
          enabled: row.enabled !== false,
        })).filter((row) => /^https?:\/\//i.test(row.url)).slice(0, 80);
      }
      if (name === 'llm') {
        if (typeof p.api_base === 'string') next.providers.llm.api_base = trimText(p.api_base, 300).replace(/\/+$/, '');
        if (typeof p.model === 'string') next.providers.llm.model = trimText(p.model, 120);
      }
    }
  }
  return next;
}

function maskSecret(value) {
  const s = String(value || '');
  if (!s) return '';
  if (s.length <= 8) return '****';
  return `${s.slice(0, 3)}****${s.slice(-4)}`;
}

function redactSettings(settings, secrets, scheduleStatuses) {
  const out = JSON.parse(JSON.stringify(settings || defaultSettings()));
  out.secret_status = {};
  for (const key of KEY_FIELDS) {
    out.secret_status[key] = {
      configured: !!(secrets && secrets[key]),
      masked: maskSecret(secrets && secrets[key]),
    };
  }
  out.schedule_statuses = scheduleStatuses || {};
  out.schedule_status = out.schedule_statuses[out.active_board_id] || null;
  return out;
}

async function loadSettingsAndSecrets(p) {
  const settings = mergeSettings(defaultSettings(), await readJson(p.settings, {}));
  const secrets = await readJson(p.secrets, {});
  return { settings, secrets: secrets && typeof secrets === 'object' ? secrets : {} };
}

async function saveSecrets(p, incomingSecrets, clearSecrets) {
  const current = await readJson(p.secrets, {});
  const next = current && typeof current === 'object' ? current : {};
  for (const key of Array.isArray(clearSecrets) ? clearSecrets : []) {
    if (KEY_FIELDS.includes(key)) delete next[key];
  }
  if (incomingSecrets && typeof incomingSecrets === 'object') {
    for (const key of KEY_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(incomingSecrets, key)) {
        const value = String(incomingSecrets[key] || '').trim();
        if (value) next[key] = value;
      }
    }
  }
  await writeJson(p.secrets, next);
  return next;
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTag(block, tag) {
  const re = new RegExp(`<(?:[a-z0-9_-]+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:[a-z0-9_-]+:)?${tag}>`, 'i');
  const m = block.match(re);
  return m ? decodeHtml(m[1]) : '';
}

function extractAtomLink(block) {
  const m = block.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i);
  return m ? decodeHtml(m[1]) : '';
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 9000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': 'MobiusFinanceNewsWall/0.1',
        ...(options.headers || {}),
      },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 180)}`);
    return text;
  } finally {
    clearTimeout(t);
  }
}

function parseFeed(raw, source) {
  const items = [];
  const itemBlocks = raw.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  for (const block of itemBlocks) {
    const title = extractTag(block, 'title');
    const url = extractTag(block, 'link') || extractTag(block, 'guid');
    if (!title || !url) continue;
    items.push({
      source: source.name,
      source_id: source.id,
      title,
      summary: extractTag(block, 'description') || extractTag(block, 'summary'),
      url,
      ts: normalizeDate(extractTag(block, 'pubDate') || extractTag(block, 'date')),
      raw_source: 'rss',
    });
  }
  const entryBlocks = raw.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  for (const block of entryBlocks) {
    const title = extractTag(block, 'title');
    const url = extractAtomLink(block) || extractTag(block, 'id');
    if (!title || !url) continue;
    items.push({
      source: source.name,
      source_id: source.id,
      title,
      summary: extractTag(block, 'summary') || extractTag(block, 'content'),
      url,
      ts: normalizeDate(extractTag(block, 'updated') || extractTag(block, 'published')),
      raw_source: 'rss',
    });
  }
  return items;
}

function normalizeDate(value) {
  const t = Date.parse(value || '');
  return Number.isFinite(t) ? new Date(t).toISOString() : nowIso();
}

function normalizeEvent(raw, direction) {
  const title = trimText(raw.title, 300);
  const summary = trimText(raw.summary || raw.description || '', 900);
  const url = trimText(raw.url || '', 900);
  const dedupeKey = sha1((url || title).toLowerCase());
  const base = {
    id: sha1(`${dedupeKey}:${title}`).slice(0, 16),
    dedupe_key: dedupeKey,
    ts: normalizeDate(raw.ts || raw.publishedAt || raw.time_published),
    source: trimText(raw.source || raw.source_name || raw.provider || 'unknown', 100),
    source_id: trimText(raw.source_id || raw.raw_source || '', 80),
    title,
    summary,
    url,
    direction_query: trimText(direction, 160),
    raw_source: trimText(raw.raw_source || '', 80),
    first_seen_at: nowIso(),
    last_seen_at: nowIso(),
  };
  return scoreEvent(base, direction);
}

function scoreEvent(event, direction) {
  const text = `${event.title} ${event.summary}`.toLowerCase();
  let score = 18;
  const critical = ['rate decision', 'interest rate', 'federal reserve', 'fed ', 'cpi', 'pce', 'payrolls', 'inflation', 'recession', 'default', 'bank failure', 'bankruptcy', 'war', 'sanction', 'tariff', 'opec', 'oil supply', 'liquidity', 'treasury yield', 'yen intervention', 'yuan', 'earnings guidance'];
  const high = ['merger', 'acquisition', 'guidance', 'sec', 'lawsuit', 'regulation', 'gdp', 'unemployment', 'jobs', 'bond', 'yield', 'dollar', 'currency', 'crude', 'gold', 'chip', 'ai', 'export control'];
  for (const kw of critical) if (text.includes(kw)) score += 14;
  for (const kw of high) if (text.includes(kw)) score += 7;
  for (const token of String(direction || '').toLowerCase().split(/[\s,，;；|/]+/).filter((x) => x.length >= 2)) {
    if (text.includes(token)) score += 8;
  }
  const ageHours = Math.max(0, (Date.now() - Date.parse(event.ts || nowIso())) / 3_600_000);
  if (ageHours < 1) score += 10;
  else if (ageHours < 6) score += 6;
  if (/federalreserve|sec\.gov|treasury|bis|ecb|imf|worldbank/i.test(event.url || '')) score += 8;
  score = Math.max(1, Math.min(100, score));
  return {
    ...event,
    impact_score: score,
    urgency: score >= 82 ? 'critical' : score >= 64 ? 'high' : score >= 40 ? 'medium' : 'low',
    asset_classes: inferAssetClasses(text),
    topics: inferTopics(text),
    region: inferRegions(text),
    direction: inferDirection(text),
    confidence: Math.min(0.95, 0.45 + score / 180),
  };
}

function inferAssetClasses(text) {
  const out = [];
  if (/(stock|equity|earnings|nasdaq|s&p|ipo|share|a股|港股)/i.test(text)) out.push('equity');
  if (/(bond|treasury|yield|rate|利率|国债)/i.test(text)) out.push('rates');
  if (/(dollar|yen|yuan|euro|fx|currency|汇率|人民币)/i.test(text)) out.push('fx');
  if (/(oil|crude|gas|gold|copper|commodity|原油|黄金|铜)/i.test(text)) out.push('commodities');
  if (/(bitcoin|crypto|stablecoin|token|加密)/i.test(text)) out.push('crypto');
  return out.length ? out : ['macro'];
}

function inferTopics(text) {
  const out = [];
  if (/(fed|rate|inflation|cpi|pce|gdp|payroll|unemployment|央行|通胀)/i.test(text)) out.push('macro');
  if (/(sec|regulation|lawsuit|sanction|tariff|监管|制裁|关税)/i.test(text)) out.push('policy');
  if (/(earnings|guidance|revenue|profit|财报|业绩)/i.test(text)) out.push('earnings');
  if (/(war|conflict|election|geopolitical|地缘|战争)/i.test(text)) out.push('geopolitics');
  if (/(merger|acquisition|m&a|收购|并购)/i.test(text)) out.push('deals');
  return out.length ? out : ['market'];
}

function inferRegions(text) {
  const out = [];
  if (/(china|yuan|a股|人民币|中国|hong kong|香港)/i.test(text)) out.push('CN');
  if (/(fed|sec|treasury|dollar|nasdaq|s&p|us |u\.s\.|美国)/i.test(text)) out.push('US');
  if (/(ecb|euro|europe|欧洲|欧元)/i.test(text)) out.push('EU');
  if (/(japan|yen|boj|日本|日元)/i.test(text)) out.push('JP');
  return out.length ? out : ['GLOBAL'];
}

function inferDirection(text) {
  if (/(cut|dovish|stimulus|easing|降息|宽松|刺激)/i.test(text)) return 'dovish';
  if (/(hike|hawkish|tightening|加息|紧缩)/i.test(text)) return 'hawkish';
  if (/(beat|surge|rally|upgrade|bullish|上涨|利好)/i.test(text)) return 'bullish';
  if (/(miss|drop|selloff|downgrade|bearish|下跌|利空)/i.test(text)) return 'bearish';
  if (/(war|default|bankruptcy|sanction|risk|危机|冲突)/i.test(text)) return 'risk_off';
  return 'neutral';
}

function urgencyFromScore(score) {
  return score >= 82 ? 'critical' : score >= 64 ? 'high' : score >= 40 ? 'medium' : 'low';
}

function arrayIntersection(a, b) {
  const set = new Set((Array.isArray(a) ? a : []).map((item) => String(item).toLowerCase()));
  return (Array.isArray(b) ? b : []).filter((item) => set.has(String(item).toLowerCase()));
}

function unionStrings(...lists) {
  return uniqueStrings(lists.flatMap((list) => Array.isArray(list) ? list : []), 120);
}

function compactMatchedStock(stock, alias) {
  return {
    market: stock.market || '',
    code: stock.code || '',
    name: stock.name || stock.code || '',
    alias: alias || '',
  };
}

function unionStocks(a, b) {
  const out = [];
  const seen = new Set();
  for (const stock of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    if (!stock || typeof stock !== 'object') continue;
    const key = `${stock.market || ''}:${stock.code || ''}:${stock.name || ''}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      market: trimText(stock.market || '', 20),
      code: trimText(stock.code || '', 24),
      name: trimText(stock.name || stock.code || '', 80),
      alias: trimText(stock.alias || '', 80),
    });
  }
  return out.slice(0, 60);
}

function decorateEventForBoard(event, board) {
  if (!board) return event;
  const textRaw = `${event.title || ''} ${event.summary || ''} ${event.source || ''}`;
  const text = textRaw.toLowerCase();
  const matchedKeywords = (board.keywords || [])
    .filter((keyword) => keyword && text.includes(String(keyword).toLowerCase()))
    .slice(0, 24);
  const excludedKeywords = (board.exclude_keywords || [])
    .filter((keyword) => keyword && text.includes(String(keyword).toLowerCase()))
    .slice(0, 12);
  const matchedStocks = [];
  for (const stock of board.stocks || []) {
    const aliases = uniqueStrings([stock.name, stock.code, ...(stock.aliases || [])], 80);
    const alias = aliases.find((item) => item && text.includes(String(item).toLowerCase()));
    if (alias) matchedStocks.push(compactMatchedStock(stock, alias));
  }
  const assetHits = arrayIntersection(board.asset_classes, event.asset_classes);
  const regionHits = arrayIntersection(board.regions, event.region);
  let relevance = 0;
  relevance += matchedKeywords.length * 12;
  relevance += matchedStocks.reduce((sum, stock) => {
    const sourceStock = (board.stocks || []).find((row) => row.code === stock.code && row.name === stock.name);
    return sum + Math.round(22 * (sourceStock?.weight || 1));
  }, 0);
  relevance += assetHits.length * 6;
  relevance += regionHits.length * 4;
  if (board.name && text.includes(board.name.toLowerCase())) relevance += 12;
  if (!matchedKeywords.length && !matchedStocks.length && !assetHits.length && !regionHits.length) {
    relevance += 3;
  }
  if (excludedKeywords.length) relevance = 0;
  relevance = Math.max(0, Math.min(100, relevance));

  const reasons = [];
  if (matchedKeywords.length) reasons.push(`关键词: ${matchedKeywords.slice(0, 8).join('、')}`);
  if (matchedStocks.length) reasons.push(`股票: ${matchedStocks.slice(0, 8).map((stock) => stock.code ? `${stock.name} ${stock.code}` : stock.name).join('、')}`);
  if (assetHits.length) reasons.push(`资产类别: ${assetHits.join('、')}`);
  if (regionHits.length) reasons.push(`地区: ${regionHits.join('、')}`);
  if (excludedKeywords.length) reasons.push(`排除词: ${excludedKeywords.join('、')}`);
  if (!reasons.length) reasons.push('来自当前板块扫描方向');

  const boostedImpact = Math.max(
    Number(event.impact_score || 0),
    Math.min(100, Number(event.impact_score || 0) + Math.floor(relevance / 5)),
  );
  return {
    ...event,
    board_ids: unionStrings(event.board_ids, [board.id]),
    board_names: unionStrings(event.board_names, [board.name]),
    matched_keywords: unionStrings(event.matched_keywords, matchedKeywords),
    matched_stocks: unionStocks(event.matched_stocks, matchedStocks),
    match_reasons: unionStrings(event.match_reasons, reasons),
    excluded_by_board: excludedKeywords.length > 0,
    relevance_score: Math.max(Number(event.relevance_score || 0), relevance),
    impact_score: boostedImpact,
    urgency: urgencyFromScore(boostedImpact),
  };
}

async function fetchRssEvents(settings, direction, maxItems, logger) {
  const rss = settings.providers?.rss || {};
  if (rss.enabled === false) return [];
  const sources = Array.isArray(rss.sources) && rss.sources.length ? rss.sources : DEFAULT_RSS_SOURCES;
  const enabled = sources.filter((s) => s && s.enabled !== false && /^https?:\/\//i.test(s.url)).slice(0, 20);
  const results = await Promise.allSettled(enabled.map(async (source) => {
    const raw = await fetchWithTimeout(source.url, {}, 9000);
    return parseFeed(raw, source);
  }));
  const out = [];
  for (const result of results) {
    if (result.status === 'fulfilled') out.push(...result.value);
    else logger?.warn('rss fetch failed', result.reason?.message || String(result.reason));
  }
  return out.slice(0, maxItems * 3).map((item) => normalizeEvent(item, direction));
}

async function fetchNewsApiEvents(settings, secrets, direction, maxItems) {
  if (settings.providers?.newsapi?.enabled !== true || !secrets.newsapi_key) return [];
  const q = encodeURIComponent(direction || 'financial markets');
  const url = `https://newsapi.org/v2/everything?q=${q}&sortBy=publishedAt&pageSize=${Math.min(maxItems, 50)}&language=en&apiKey=${encodeURIComponent(secrets.newsapi_key)}`;
  const data = JSON.parse(await fetchWithTimeout(url, {}, 9000));
  return (Array.isArray(data.articles) ? data.articles : []).map((a) => normalizeEvent({
    source: a.source?.name || 'NewsAPI',
    title: a.title,
    summary: a.description || a.content,
    url: a.url,
    ts: a.publishedAt,
    raw_source: 'newsapi',
  }, direction));
}

async function fetchAlphaVantageEvents(settings, secrets, direction, maxItems) {
  if (settings.providers?.alphavantage?.enabled !== true || !secrets.alphavantage_key) return [];
  const url = `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&sort=LATEST&limit=${Math.min(maxItems, 50)}&apikey=${encodeURIComponent(secrets.alphavantage_key)}`;
  const data = JSON.parse(await fetchWithTimeout(url, {}, 9000));
  return (Array.isArray(data.feed) ? data.feed : []).map((a) => normalizeEvent({
    source: a.source || 'Alpha Vantage',
    title: a.title,
    summary: a.summary,
    url: a.url,
    ts: a.time_published,
    raw_source: 'alphavantage',
  }, direction));
}

async function fetchFinnhubEvents(settings, secrets, direction, maxItems) {
  if (settings.providers?.finnhub?.enabled !== true || !secrets.finnhub_key) return [];
  const url = `https://finnhub.io/api/v1/news?category=general&token=${encodeURIComponent(secrets.finnhub_key)}`;
  const data = JSON.parse(await fetchWithTimeout(url, {}, 9000));
  return (Array.isArray(data) ? data : []).slice(0, maxItems).map((a) => normalizeEvent({
    source: 'Finnhub',
    title: a.headline,
    summary: a.summary,
    url: a.url,
    ts: a.datetime ? new Date(Number(a.datetime) * 1000).toISOString() : nowIso(),
    raw_source: 'finnhub',
  }, direction));
}

async function fetchBraveEvents(settings, secrets, direction, maxItems) {
  if (settings.providers?.brave_search?.enabled !== true || !secrets.brave_search_key) return [];
  const q = encodeURIComponent(direction || 'financial markets');
  const url = `https://api.search.brave.com/res/v1/news/search?q=${q}&count=${Math.min(maxItems, 20)}&freshness=pd`;
  const data = JSON.parse(await fetchWithTimeout(url, {
    headers: { 'X-Subscription-Token': secrets.brave_search_key },
  }, 9000));
  return (Array.isArray(data.results) ? data.results : []).map((a) => normalizeEvent({
    source: a.meta_url?.hostname || 'Brave News',
    title: a.title,
    summary: a.description,
    url: a.url,
    ts: a.age || nowIso(),
    raw_source: 'brave_search',
  }, direction));
}

async function enrichWithLlm(settings, secrets, direction, events, logger, board) {
  if (settings.providers?.llm?.enabled === false || events.length === 0) return events;
  const apiKey = pickKey(secrets.llm_api_key)
    || pickKey(process.env.FINANCE_NEWS_LLM_API_KEY)
    || pickKey(process.env.ASSISTANT_API_KEY)
    || pickKey(process.env.BEST_API_KEY);
  if (!apiKey) return events;
  const apiBase = (settings.providers?.llm?.api_base || DEFAULT_LLM_BASE).replace(/\/+$/, '');
  const model = settings.providers?.llm?.model || DEFAULT_LLM_MODEL;
  const sample = events.slice(0, 30).map((e) => ({
    id: e.id,
    title: e.title,
    summary: e.summary,
    source: e.source,
    ts: e.ts,
    url: e.url,
  }));
  const boardContext = board ? {
    name: board.name,
    description: board.description,
    keywords: board.keywords,
    stocks: (board.stocks || []).map((stock) => ({ market: stock.market, code: stock.code, name: stock.name })),
  } : null;
  const prompt = [
    '你是金融新闻分类器。只返回 JSON，不要 Markdown。',
    '返回 {"events":[...]}。每个 item 必须有 id, title_zh, summary_zh, why_zh, impact_score 1-100, urgency low|medium|high|critical, direction, asset_classes, topics, region, confidence 0-1。',
    'title_zh 必须使用中文，压缩为 14-36 个汉字，保留关键机构、资产或公司名。',
    'summary_zh 必须使用中文，压缩为 1-2 句，并说明为什么可能影响市场。',
    'why_zh 必须使用中文，说明影响路径，例如利率、汇率、风险偏好、行业链、监管或资金流。',
    `用户方向: ${direction || '全球金融市场'}`,
    boardContext ? `当前板块: ${JSON.stringify(boardContext).slice(0, 3000)}` : '',
    `News: ${JSON.stringify(sample).slice(0, 12000)}`,
  ].filter(Boolean).join('\n');
  try {
    const raw = await fetchWithTimeout(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.1,
        messages: [
          { role: 'system', content: '你是严谨的金融新闻分类器，只输出可解析的紧凑 JSON。' },
          { role: 'user', content: prompt },
        ],
      }),
    }, 16_000);
    const data = JSON.parse(raw);
    const content = data.choices?.[0]?.message?.content || '';
    const jsonText = (content.match(/\{[\s\S]*\}/) || [content])[0];
    const parsed = JSON.parse(jsonText);
    const rows = Array.isArray(parsed.events) ? parsed.events : [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    return events.map((event) => {
      const enriched = byId.get(event.id);
      if (!enriched) return event;
      const summaryZh = enriched.summary_zh || enriched.summary;
      return {
        ...event,
        title_zh: trimText(enriched.title_zh || event.title_zh || '', 220),
        summary: trimText(summaryZh || event.summary, 900),
        summary_zh: trimText(summaryZh || event.summary_zh || '', 900),
        why_zh: trimText(enriched.why_zh || enriched.impact_reason_zh || event.why_zh || '', 900),
        impact_score: clampInt(enriched.impact_score, event.impact_score, 1, 100),
        urgency: ['low', 'medium', 'high', 'critical'].includes(enriched.urgency) ? enriched.urgency : event.urgency,
        direction: trimText(enriched.direction || event.direction, 40),
        asset_classes: Array.isArray(enriched.asset_classes) ? enriched.asset_classes.slice(0, 8) : event.asset_classes,
        topics: Array.isArray(enriched.topics) ? enriched.topics.slice(0, 8) : event.topics,
        region: Array.isArray(enriched.region) ? enriched.region.slice(0, 8) : event.region,
        confidence: Math.max(0, Math.min(1, Number(enriched.confidence) || event.confidence)),
        llm_enriched: true,
      };
    });
  } catch (e) {
    logger?.warn('llm enrichment failed', e.message);
    return events;
  }
}

function mergeEvents(existing, incoming) {
  const map = new Map();
  for (const event of Array.isArray(existing) ? existing : []) {
    if (event && event.dedupe_key) map.set(event.dedupe_key, event);
  }
  for (const event of incoming) {
    const prev = map.get(event.dedupe_key);
    if (prev) {
      const impactScore = Math.max(Number(prev.impact_score || 0), Number(event.impact_score || 0));
      map.set(event.dedupe_key, {
        ...prev,
        ...event,
        id: prev.id || event.id,
        first_seen_at: prev.first_seen_at || event.first_seen_at,
        last_seen_at: nowIso(),
        board_ids: unionStrings(prev.board_ids, event.board_ids),
        board_names: unionStrings(prev.board_names, event.board_names),
        matched_keywords: unionStrings(prev.matched_keywords, event.matched_keywords),
        matched_stocks: unionStocks(prev.matched_stocks, event.matched_stocks),
        match_reasons: unionStrings(prev.match_reasons, event.match_reasons),
        relevance_score: Math.max(Number(prev.relevance_score || 0), Number(event.relevance_score || 0)),
        impact_score: impactScore,
        urgency: urgencyFromScore(impactScore),
      });
    } else {
      map.set(event.dedupe_key, event);
    }
  }
  return Array.from(map.values())
    .sort((a, b) => Date.parse(b.ts || 0) - Date.parse(a.ts || 0))
    .slice(0, MAX_EVENTS);
}

function filterEvents(events, filters = {}) {
  let rows = Array.isArray(events) ? events : [];
  const q = String(filters.query || '').trim().toLowerCase();
  if (q) {
    rows = rows.filter((e) => [
      e.title,
      e.summary,
      e.source,
      ...(e.board_names || []),
      ...(e.matched_keywords || []),
      ...(e.match_reasons || []),
      ...(e.matched_stocks || []).flatMap((stock) => [stock.name, stock.code, stock.market]),
    ].join(' ').toLowerCase().includes(q));
  }
  if (filters.board_id && filters.board_id !== 'all') rows = rows.filter((e) => (e.board_ids || []).includes(filters.board_id));
  if (filters.stock && filters.stock !== 'all') {
    const stockQuery = String(filters.stock).trim().toLowerCase();
    rows = rows.filter((e) => (e.matched_stocks || []).some((stock) => `${stock.name} ${stock.code} ${stock.market}`.toLowerCase().includes(stockQuery)));
  }
  if (filters.urgency && filters.urgency !== 'all') rows = rows.filter((e) => e.urgency === filters.urgency);
  if (filters.asset_class && filters.asset_class !== 'all') rows = rows.filter((e) => (e.asset_classes || []).includes(filters.asset_class));
  if (filters.topic && filters.topic !== 'all') rows = rows.filter((e) => (e.topics || []).includes(filters.topic));
  return rows;
}

async function runScan({ paths, settings, secrets, payload, username, logger }) {
  const board = boardById(settings, payload.board_id || payload.boardId || settings.active_board_id);
  const typedDirection = trimText(payload.direction || '', 160);
  const direction = trimText(typedDirection || boardSearchText(board, settings.manual?.direction || '全球金融市场'), 300);
  const maxItems = clampInt(payload.max_items || payload.maxItems || board?.max_items || settings.manual?.max_items, 30, 1, MAX_SCAN_ITEMS);
  const startedAt = nowIso();
  const providers = [
    fetchRssEvents(settings, direction, maxItems, logger),
    fetchNewsApiEvents(settings, secrets, direction, maxItems),
    fetchAlphaVantageEvents(settings, secrets, direction, maxItems),
    fetchFinnhubEvents(settings, secrets, direction, maxItems),
    fetchBraveEvents(settings, secrets, direction, maxItems),
  ];
  const settled = await Promise.allSettled(providers);
  let events = [];
  const errors = [];
  for (const item of settled) {
    if (item.status === 'fulfilled') events.push(...item.value);
    else errors.push(item.reason?.message || String(item.reason));
  }
  const unique = mergeEvents([], events).slice(0, Math.min(maxItems * 2, MAX_SCAN_ITEMS));
  const enriched = await enrichWithLlm(settings, secrets, direction, unique, logger, board);
  const decorated = board ? enriched.map((event) => decorateEventForBoard(event, board)) : enriched;
  const nonExcluded = decorated.filter((event) => event.excluded_by_board !== true);
  const relevant = board
    ? nonExcluded.filter((event) => Number(event.relevance_score || 0) > 0 || Number(event.impact_score || 0) >= Number(board.impact_threshold || 60))
    : nonExcluded;
  const selected = (relevant.length ? relevant : nonExcluded.length ? nonExcluded : decorated)
    .sort((a, b) => {
      const scoreA = Number(a.relevance_score || 0) * 2 + Number(a.impact_score || 0);
      const scoreB = Number(b.relevance_score || 0) * 2 + Number(b.impact_score || 0);
      if (scoreB !== scoreA) return scoreB - scoreA;
      return Date.parse(b.ts || 0) - Date.parse(a.ts || 0);
    })
    .slice(0, maxItems);
  const existing = await readJson(paths.events, []);
  const merged = mergeEvents(existing, selected);
  await writeJson(paths.events, merged);

  const run = {
    id: sha1(`${username}:${board?.id || 'all'}:${direction}:${startedAt}`).slice(0, 12),
    board_id: board?.id || '',
    board_name: board?.name || '',
    direction,
    typed_direction: typedDirection,
    scheduled: payload.scheduled === true,
    schedule_id: payload.schedule_id || '',
    started_at: startedAt,
    completed_at: nowIso(),
    fetched_count: events.length,
    new_or_updated_count: selected.length,
    errors,
    top_events: selected.sort((a, b) => b.impact_score - a.impact_score).slice(0, 12),
  };
  const runs = await readJson(paths.runs, []);
  await writeJson(paths.runs, [run, ...(Array.isArray(runs) ? runs : [])].slice(0, MAX_RUNS));
  return { ok: true, run, events: run.top_events, total_events: merged.length };
}

function schedulePatchFromPayload(settings, payload, username, paths, existing, boardId) {
  const board = boardById(settings, boardId);
  const schedule = {
    enabled: existing?.enabled === true,
    direction: boardSearchText(board, settings.manual?.direction || '全球金融市场'),
    interval_minutes: board?.interval_minutes || settings.schedule?.interval_minutes || 30,
    max_items: board?.max_items || settings.schedule?.max_items || 30,
    ...(payload.schedule && typeof payload.schedule === 'object' ? payload.schedule : {}),
  };
  schedule.enabled = schedule.enabled === true;
  schedule.direction = trimText(schedule.direction || boardSearchText(board, '全球金融市场'), 300);
  schedule.interval_minutes = clampInt(schedule.interval_minutes, board?.interval_minutes || 30, 5, 7 * 24 * 60);
  schedule.max_items = clampInt(schedule.max_items, board?.max_items || 30, 1, MAX_SCAN_ITEMS);
  const now = Date.now();
  return {
    id: scheduleIdFor(paths, board?.id || 'default'),
    extension_name: EXTENSION_NAME,
    user_id: username,
    board_id: board?.id || '',
    board_name: board?.name || '',
    enabled: schedule.enabled,
    interval_minutes: schedule.interval_minutes,
    next_run_at: schedule.enabled
      ? (existing?.next_run_at && Date.parse(existing.next_run_at) > now ? existing.next_run_at : new Date(now + schedule.interval_minutes * 60_000).toISOString())
      : existing?.next_run_at || null,
    payload: {
      action: 'run_scan',
      board_id: board?.id || '',
      direction: schedule.direction,
      max_items: schedule.max_items,
    },
    last_run_at: existing?.last_run_at || null,
    last_status: existing?.last_status || '',
    last_error: existing?.last_error || '',
    updated_at: nowIso(),
  };
}

function upsertBoard(settings, rawBoard) {
  if (!rawBoard || typeof rawBoard !== 'object') {
    throw new Error('板块参数无效');
  }
  const name = trimText(rawBoard.name || '', 80);
  if (!name) throw new Error('板块名称不能为空');
  const boards = normalizeBoards(settings.boards);
  const incomingId = boardIdFromInput(rawBoard, {});
  const existing = boards.find((board) => board.id === incomingId) || null;
  const type = existing?.type === 'default' ? 'default' : 'custom';
  const normalized = normalizeBoard({ ...rawBoard, id: incomingId, name, type }, existing || { type });
  normalized.type = type;
  const nextBoards = existing
    ? boards.map((board) => board.id === normalized.id ? normalized : board)
    : [...boards, normalized];
  return {
    ...settings,
    boards: normalizeBoards(nextBoards),
    active_board_id: normalized.id,
  };
}

async function deleteCustomBoard(settings, paths, boardId) {
  const id = normalizeId(boardId, '');
  const boards = normalizeBoards(settings.boards);
  const target = boards.find((board) => board.id === id);
  if (!target) throw new Error('未找到板块');
  if (target.type !== 'custom') throw new Error('默认板块不能删除，可以关闭启用状态');
  await fs.rm(scheduleFileFor(paths, id), { force: true });
  const nextBoards = boards.filter((board) => board.id !== id);
  const active = settings.active_board_id === id
    ? (nextBoards.find((board) => board.enabled)?.id || nextBoards[0]?.id || 'macro-global')
    : settings.active_board_id;
  return {
    ...settings,
    boards: normalizeBoards(nextBoards),
    active_board_id: active,
  };
}

function toCsv(rows) {
  const cols = ['ts', 'board_names', 'matched_stocks', 'match_reasons', 'relevance_score', 'urgency', 'impact_score', 'source', 'title', 'summary', 'asset_classes', 'topics', 'region', 'direction', 'url'];
  const esc = (value) => `"${String(Array.isArray(value) ? value.join('|') : value ?? '').replace(/"/g, '""')}"`;
  const valueFor = (row, col) => {
    if (col === 'matched_stocks') return (row.matched_stocks || []).map((stock) => stock.code ? `${stock.name} ${stock.code}` : stock.name);
    return row[col];
  };
  return [cols.join(','), ...rows.map((row) => cols.map((col) => esc(valueFor(row, col))).join(','))].join('\n');
}

function toMarkdown(rows) {
  return rows.map((e) => [
    `### ${e.title}`,
    `- 时间: ${e.ts}`,
    `- 板块: ${(e.board_names || []).join(', ') || '-'}`,
    `- 相关股票: ${(e.matched_stocks || []).map((stock) => stock.code ? `${stock.name} ${stock.code}` : stock.name).join(', ') || '-'}`,
    `- 匹配原因: ${(e.match_reasons || []).join('；') || '-'}`,
    `- 相关度: ${e.relevance_score || 0}`,
    `- 来源: ${e.source}`,
    `- 影响: ${e.urgency} / ${e.impact_score}`,
    `- 方向: ${e.direction}`,
    `- 标签: ${(e.asset_classes || []).join(', ')} · ${(e.topics || []).join(', ')}`,
    `- 摘要: ${e.summary || ''}`,
    `- 链接: ${e.url || ''}`,
  ].join('\n')).join('\n\n');
}

function stockSummary(board) {
  return (board?.stocks || [])
    .slice(0, 30)
    .map((stock) => stock.code ? `${stock.name} ${stock.code}(${stock.market})` : `${stock.name}(${stock.market})`)
    .join('、');
}

function buildSessionDescription(run, events, board) {
  const top = events.slice(0, 12).map((e, i) => [
    `${i + 1}. [${e.urgency}/${e.impact_score}] ${e.title}`,
    `   来源: ${e.source} ${e.url || ''}`,
    `   板块: ${(e.board_names || []).join(', ') || run.board_name || '-'}`,
    `   相关股票: ${(e.matched_stocks || []).map((stock) => stock.code ? `${stock.name} ${stock.code}` : stock.name).join(', ') || '-'}`,
    `   匹配原因: ${(e.match_reasons || []).join('；') || '-'}`,
    `   摘要: ${e.summary || ''}`,
    `   标签: ${(e.asset_classes || []).join(', ')} / ${(e.topics || []).join(', ')}`,
  ].join('\n')).join('\n');
  return [
    '请基于金融新闻墙的一次扫描结果做深度研判。',
    '',
    `扫描板块: ${run.board_name || board?.name || '-'}`,
    `板块描述: ${board?.description || '-'}`,
    `板块相关股票: ${stockSummary(board) || '-'}`,
    `扫描方向: ${run.direction}`,
    `扫描时间: ${run.completed_at || run.started_at}`,
    `触发方式: ${run.scheduled ? '定时触发' : '手动触发'}`,
    '',
    '重点事件:',
    top || '(无事件)',
    '',
    '要求:',
    '- 先验证来源可信度和是否存在重复报道。',
    '- 区分事实、推断和不确定性。',
    '- 分析可能影响的资产类别、市场方向、时效性和后续观察指标。',
    '- 输出一份结构化中文报告，包含摘要、事件列表、影响路径、风险点和跟踪清单。',
  ].join('\n');
}

module.exports = async function financeNewsWallHandler({
  username,
  display_name,
  ext_main_payload,
  ext_data_dir,
  logger,
}) {
  const payload = ext_main_payload && typeof ext_main_payload === 'object' ? ext_main_payload : {};
  const action = payload.action || 'get_state';
  const p = pathsFor(ext_data_dir, username);
  await ensureDir(p.userDir);

  const { settings, secrets } = await loadSettingsAndSecrets(p);
  const scheduleStatuses = await readScheduleStatuses(p);

  if (action === 'whoami') {
    return { ok: true, username, display_name: display_name || username };
  }

  if (action === 'get_state') {
    const events = await readJson(p.events, []);
    const runs = await readJson(p.runs, []);
    return {
      ok: true,
      username,
      display_name: display_name || username,
      settings: redactSettings(settings, secrets, scheduleStatuses),
      events: (Array.isArray(events) ? events : []).slice(0, 200),
      runs: (Array.isArray(runs) ? runs : []).slice(0, 30),
    };
  }

  if (action === 'save_settings') {
    const nextSettings = mergeSettings(settings, payload.settings || {});
    const nextSecrets = await saveSecrets(p, payload.secrets, payload.clear_secrets);
    await writeJson(p.settings, nextSettings);
    return { ok: true, settings: redactSettings(nextSettings, nextSecrets, await readScheduleStatuses(p)) };
  }

  if (action === 'set_active_board') {
    const board = boardById(settings, payload.board_id || payload.boardId);
    if (!board) return { ok: false, error: '未找到板块' };
    const nextSettings = mergeSettings(settings, { active_board_id: board.id });
    await writeJson(p.settings, nextSettings);
    return { ok: true, settings: redactSettings(nextSettings, secrets, await readScheduleStatuses(p)) };
  }

  if (action === 'save_board') {
    try {
      const nextSettings = upsertBoard(settings, payload.board || {});
      await writeJson(p.settings, nextSettings);
      return { ok: true, settings: redactSettings(nextSettings, secrets, await readScheduleStatuses(p)) };
    } catch (e) {
      return { ok: false, error: e.message || '保存板块失败' };
    }
  }

  if (action === 'delete_board') {
    try {
      const nextSettings = await deleteCustomBoard(settings, p, payload.board_id || payload.boardId);
      await writeJson(p.settings, nextSettings);
      return { ok: true, settings: redactSettings(nextSettings, secrets, await readScheduleStatuses(p)) };
    } catch (e) {
      return { ok: false, error: e.message || '删除板块失败' };
    }
  }

  if (action === 'save_schedule') {
    const board = boardById(settings, payload.board_id || payload.schedule?.board_id || settings.active_board_id);
    if (!board) return { ok: false, error: '未找到板块' };
    const scheduleInput = payload.schedule && typeof payload.schedule === 'object' ? payload.schedule : {};
    const boards = (settings.boards || []).map((item) => item.id === board.id ? normalizeBoard({
      ...item,
      interval_minutes: scheduleInput.interval_minutes,
      max_items: scheduleInput.max_items,
    }, item) : item);
    const nextSettings = mergeSettings(settings, {
      active_board_id: board.id,
      boards,
      schedule: {
        enabled: scheduleInput.enabled === true,
        direction: scheduleInput.direction || boardSearchText(board, settings.manual?.direction),
        interval_minutes: scheduleInput.interval_minutes || board.interval_minutes,
        max_items: scheduleInput.max_items || board.max_items,
      },
    });
    await writeJson(p.settings, nextSettings);
    const existing = await readJson(scheduleFileFor(p, board.id), null);
    const schedule = schedulePatchFromPayload(nextSettings, payload, username, p, existing, board.id);
    await writeJson(scheduleFileFor(p, board.id), schedule);
    return { ok: true, schedule };
  }

  if (action === 'run_scan') {
    return runScan({ paths: p, settings, secrets, payload, username, logger });
  }

  if (action === 'list_events') {
    const events = await readJson(p.events, []);
    const filtered = filterEvents(events, payload.filters || {});
    const limit = clampInt(payload.limit, 80, 1, 300);
    return { ok: true, events: filtered.slice(0, limit), total: filtered.length };
  }

  if (action === 'export_events') {
    const events = filterEvents(await readJson(p.events, []), payload.filters || {});
    const format = payload.format === 'csv' ? 'csv' : (payload.format === 'markdown' ? 'markdown' : 'json');
    const content = format === 'csv' ? toCsv(events)
      : format === 'markdown' ? toMarkdown(events)
        : JSON.stringify(events, null, 2);
    return {
      ok: true,
      filename: `finance-news-wall-${new Date().toISOString().slice(0, 10)}.${format === 'markdown' ? 'md' : format}`,
      mime: format === 'csv' ? 'text/csv;charset=utf-8' : format === 'markdown' ? 'text/markdown;charset=utf-8' : 'application/json;charset=utf-8',
      content,
    };
  }

  if (action === 'import_config') {
    const raw = String(payload.content || '');
    if (Buffer.byteLength(raw, 'utf8') > 1024 * 1024) return { ok: false, error: 'import content too large' };
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return { ok: false, error: '导入文件不是有效 JSON' }; }
    const nextSettings = mergeSettings(settings, parsed.settings || parsed);
    await writeJson(p.settings, nextSettings);
    return { ok: true, settings: redactSettings(nextSettings, secrets, await readScheduleStatuses(p)) };
  }

  if (action === 'create_analysis_session') {
    const runs = await readJson(p.runs, []);
    const run = (Array.isArray(runs) ? runs : []).find((r) => r.id === payload.run_id) || (Array.isArray(runs) ? runs[0] : null);
    if (!run) return { ok: false, error: '暂无可用于分析的扫描结果' };
    const events = Array.isArray(run.top_events) ? run.top_events : [];
    const board = boardById(settings, run.board_id || settings.active_board_id);
    const user = loadUser(username);
    const sessionDescription = buildSessionDescription(run, events, board);
    const titleSubject = run.board_name || board?.name || trimText(run.direction, 48);
    const created = createExtensionAnalysisSession({
      user,
      extensionName: EXTENSION_NAME,
      extensionDisplayName: EXTENSION_DISPLAY_NAME,
      projectDescription: '金融新闻墙自动创建的分析工作区，用于保存新闻扫描后的深度研判 Session。',
      issueTitle: `金融新闻研判：${trimText(titleSubject, 48)}`,
      issueDescription: `金融新闻墙扫描板块：${run.board_name || board?.name || '-'}\n扫描方向：${run.direction}\n最近扫描时间：${run.completed_at || run.started_at}`,
      sessionName: `研判：${trimText(titleSubject, 50)}`,
      sessionDescription,
      model: payload.model || 'codex',
      language: 'zh',
      forceSkillIds: [FINANCE_NEWS_SKILL_ID],
    });
    return { ok: true, ...created, url: `/u/${encodeURIComponent(user.id)}/p/${encodeURIComponent(created.project.id)}/i/${encodeURIComponent(created.issue.id)}?session=${encodeURIComponent(created.session.session_id)}` };
  }

  return { ok: false, error: `unknown action: ${action}` };
};
