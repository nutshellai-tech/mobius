/**
 * project-yongle / 人类共鸣计划 — extension backend handler
 *
 * 中文版“共鸣内容 Agent / 研究工作台”的后端入口。
 *
 * 由于扩展 handler 是 stateless / 30s 超时, 流式输出采用 "双通道轮询" 模式:
 *   - send_message 同步执行 LLM 流式调用, 把增量 chunks 实时写入 chunks 文件
 *   - 前端在发出 send_message 的同时, 平行启动 poll_turn 轮询读取增量
 *
 * 所有数据落在 ${ext_data_dir}/users/<user>/ 下:
 *   state.json                    - 项目档案 (人群描述、风格偏好、API 设置)
 *   conversations/<cid>/
 *     meta.json                   - 标题/状态/时间
 *     messages.jsonl              - 一行一条消息 (role/content/ts/meta)
 *     chunks/<turn_id>.json       - 流式增量 (cursor + chunks 数组)
 *     sources.json                - 该对话内抓取/导入的素材引用
 *   drafts/<did>/
 *     meta.json                   - kind(copy|story|song|video)/audience/ref_conv
 *     content.md                  - 生成稿正文
 *   templates.json                - 用户自定义模板 (与内置模板合并)
 *   data_pool.json                - 全局数据池 (跨对话积累)
 *
 * 文件锁: 使用 lockfile-free 的最朴素 read-then-write 模式 + JSONL 追加 (高并发场景不推荐
 * 但 handler 是 worker_thread 内的, 单 handler 调用串行没问题; 不同调用之间靠 mtime 解决).
 */

const fs = require('fs/promises');
const fss = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const EXTENSION_NAME = 'project-yongle';
const EXTENSION_DISPLAY_NAME = '人类共鸣计划';

// ---------------------------------------------------------------------------
// LLM 接入配置（通过环境变量注入，不要在代码里硬编码 IP 或 Key）
//
// 在项目根目录 .env 中配置：
//   PROJECT_YONGLE_LLM_API_BASE=http://your-llm-host/v1  # LLM API 地址（兼容 OpenAI 格式）
//   PROJECT_YONGLE_LLM_API_KEY=sk-your-api-key-here      # LLM API 鉴权 Key
//   PROJECT_YONGLE_LLM_MODEL=your-model-name             # 默认模型名称
// ---------------------------------------------------------------------------
const DEFAULT_LLM_BASE = (process.env.PROJECT_YONGLE_LLM_API_BASE || '').replace(/\/+$/, '');
const DEFAULT_LLM_MODEL = process.env.PROJECT_YONGLE_LLM_MODEL || 'gpt-4o-mini';

const MAX_MESSAGES_PER_CONV = 200;
const MAX_CONV_PER_USER = 60;
const MAX_DRAFT_PER_USER = 200;
const MAX_TEMPLATES = 80;
const MAX_DATA_POOL = 500;
const MAX_INPUT_BYTES = 32 * 1024;
const STREAM_BUDGET_MS = 24_000;
const FETCH_BUDGET_MS = 12_000;

// ---------- 内置模板 ----------
const BUILTIN_TEMPLATES = [
  {
    id: 'builtin-copy-empathy',
    kind: 'copy',
    name: '共情破冰短文案',
    audience: '年轻职场人',
    summary: '60-100 字, 一开头点中目标人群最近的情绪痛点, 中间给画面, 结尾给一句可分享的金句。',
    structure: [
      '【钩子】一句正在发生的现实情绪',
      '【画面】一个具体场景细节',
      '【转折】打破或安慰这份情绪',
      '【金句】可被截图分享的一句话',
    ],
    sample: '你以为只有你在凌晨两点还醒着. 写字楼对面的灯也是. 我们这一代人, 是用 KPI 喂饱失眠的物种. 真正的体面, 是肯按时关灯, 也肯按时把自己接回家.',
    builtin: true,
  },
  {
    id: 'builtin-copy-product',
    kind: 'copy',
    name: '产品共鸣型种草文案',
    audience: '小红书目标人群',
    summary: '120-180 字, 不夸功能, 先说用户具体场景里的难受, 再带出产品如何承接这份情绪。',
    structure: [
      '【场景】描述一个真实生活片段',
      '【难受】这个片段里的隐痛',
      '【转折】产品/服务如何接住这一刻',
      '【可信细节】具体材料、工艺、数据',
      '【召唤】给读者一个轻动作',
    ],
    sample: '',
    builtin: true,
  },
  {
    id: 'builtin-story-3acts',
    kind: 'story',
    name: '三幕短剧情大纲',
    audience: '短视频用户',
    summary: '90 秒短剧的剧情骨架, 起承转合都钉在情绪共鸣点上。',
    structure: [
      '【钩子 0-5s】反常画面或台词',
      '【铺设 5-30s】交代人物、关系、目标',
      '【推压 30-60s】冲突升级、情绪到临界',
      '【共鸣点 60-80s】镜头停在情绪命中之处',
      '【收束 80-90s】一句让人想转发的台词',
    ],
    sample: '',
    builtin: true,
  },
  {
    id: 'builtin-song-cn-pop',
    kind: 'song',
    name: '中文流行歌曲共鸣骨架',
    audience: '通用',
    summary: '主歌-副歌-桥段三段式, 每段都钉一个共鸣意象。',
    structure: [
      '【主歌1】一个具体场景 + 一个细小动作',
      '【副歌】把场景里的情绪喊出来 (8 行内)',
      '【主歌2】时间或视角切换, 重复主歌1的结构',
      '【副歌】重复, 词不变, 但情绪更重',
      '【桥段】一句反向的、自嘲或顿悟的句子',
      '【尾副歌】副歌再来一次, 末句改写, 收住情绪',
    ],
    sample: '',
    builtin: true,
  },
  {
    id: 'builtin-video-plan',
    kind: 'video',
    name: '60 秒共鸣视频方案',
    audience: '短视频/品牌广告',
    summary: '镜头-台词-情绪三栏对齐的拍摄方案, 重点放共鸣命中。',
    structure: [
      '【镜头 1】画面与运镜',
      '【台词 1】对应一句字幕或独白',
      '【情绪 1】这一刻观众应该感到什么',
      '... 重复 8-12 个镜头 ...',
      '【收尾画面】品牌或主题落点',
    ],
    sample: '',
    builtin: true,
  },
];

// ---------- 内置数据源 (示例, 真实抓取在 fetch_platform_data) ----------
const BUILTIN_PLATFORMS = [
  { id: 'zhihu',   name: '知乎',     hint: '提问回答, 长讨论, 用户描述情绪与故事',      base_url: 'https://www.zhihu.com' },
  { id: 'weibo',   name: '微博',     hint: '即时热点、话题情绪、UGC 评论',                base_url: 'https://weibo.com' },
  { id: 'douyin',  name: '抖音',     hint: '短视频评论、话题挑战、情感剧情',              base_url: 'https://www.douyin.com' },
  { id: 'xhs',     name: '小红书',   hint: '生活笔记、消费体验、情绪日记',                base_url: 'https://www.xiaohongshu.com' },
  { id: 'douban',  name: '豆瓣',     hint: '影评、书评、长文情绪、文艺人群',              base_url: 'https://www.douban.com' },
  { id: 'bilibili',name: '哔哩哔哩', hint: '弹幕、年轻人话题、亚文化',                    base_url: 'https://www.bilibili.com' },
  { id: 'web',     name: '通用网页', hint: '直接给一个 URL, 抓取其纯文本',                base_url: '' },
];

// ============================================================================
// 工具函数
// ============================================================================

function nowIso() { return new Date().toISOString(); }
function shortId(n = 8) { return crypto.randomBytes(n).toString('hex').slice(0, n); }
function sha1(s) { return crypto.createHash('sha1').update(String(s)).digest('hex'); }

function safeUserSegment(username) {
  return String(username || 'unknown').replace(/[^A-Za-z0-9_.@-]/g, '_').slice(0, 120) || 'unknown';
}

function safeResolve(root, ...parts) {
  const base = path.resolve(root);
  const abs = path.resolve(base, ...parts);
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new Error('path escapes extension data dir');
  }
  return abs;
}

function trimText(value, max = 800) {
  const text = String(value == null ? '' : value);
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

function ensureArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function readJson(file, fallback) {
  try {
    const txt = await fs.readFile(file, 'utf8');
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await ensureDir(path.dirname(file));
  const tmp = file + '.tmp-' + shortId(4);
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

async function appendJsonl(file, value) {
  await ensureDir(path.dirname(file));
  await fs.appendFile(file, JSON.stringify(value) + '\n', 'utf8');
}

async function readJsonl(file) {
  try {
    const txt = await fs.readFile(file, 'utf8');
    return txt.split(/\r?\n/).filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function userRoot(extDataDir, username) {
  return safeResolve(extDataDir, 'users', safeUserSegment(username));
}

function statePath(extDataDir, username) {
  return safeResolve(userRoot(extDataDir, username), 'state.json');
}

function convRoot(extDataDir, username, cid) {
  if (!cid || !/^[A-Za-z0-9_-]{4,40}$/.test(String(cid))) {
    throw new Error('invalid conversation id');
  }
  return safeResolve(userRoot(extDataDir, username), 'conversations', cid);
}

function draftRoot(extDataDir, username, did) {
  if (!did || !/^[A-Za-z0-9_-]{4,40}$/.test(String(did))) {
    throw new Error('invalid draft id');
  }
  return safeResolve(userRoot(extDataDir, username), 'drafts', did);
}

// ============================================================================
// 用户档案 / 设置
// ============================================================================

function defaultState() {
  return {
    version: 1,
    profile: {
      project_name: '',
      audience: '',
      goal: '',
      tone: '',
      do_list: [],
      dont_list: [],
    },
    settings: {
      llm_api_base: '',
      llm_api_key: '',
      llm_model: '',
      auto_save_drafts: true,
    },
    current_conv_id: '',
    updated_at: nowIso(),
  };
}

async function readState(extDataDir, username) {
  const state = await readJson(statePath(extDataDir, username), null);
  if (!state || typeof state !== 'object') return defaultState();
  const base = defaultState();
  return {
    ...base,
    ...state,
    profile: { ...base.profile, ...(state.profile || {}) },
    settings: { ...base.settings, ...(state.settings || {}) },
  };
}

async function saveState(extDataDir, username, state) {
  state.updated_at = nowIso();
  await writeJson(statePath(extDataDir, username), state);
  return state;
}

// ============================================================================
// 对话
// ============================================================================

async function listConversations(extDataDir, username) {
  const root = safeResolve(userRoot(extDataDir, username), 'conversations');
  if (!(await exists(root))) return [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  const items = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const meta = await readJson(path.join(root, ent.name, 'meta.json'), null);
    if (!meta) continue;
    items.push(meta);
  }
  items.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  return items.slice(0, MAX_CONV_PER_USER);
}

async function createConversation(extDataDir, username, { title, audience }) {
  const cid = shortId(10);
  const dir = convRoot(extDataDir, username, cid);
  await ensureDir(dir);
  const meta = {
    id: cid,
    title: trimText(title || '新对话', 80),
    audience: trimText(audience || '', 240),
    status: 'idle',
    message_count: 0,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  await writeJson(path.join(dir, 'meta.json'), meta);
  await fs.writeFile(path.join(dir, 'messages.jsonl'), '', 'utf8');
  return meta;
}

async function getConversation(extDataDir, username, cid) {
  const dir = convRoot(extDataDir, username, cid);
  const meta = await readJson(path.join(dir, 'meta.json'), null);
  if (!meta) return null;
  const messages = await readJsonl(path.join(dir, 'messages.jsonl'));
  return { meta, messages: messages.slice(-MAX_MESSAGES_PER_CONV) };
}

async function deleteConversation(extDataDir, username, cid) {
  const dir = convRoot(extDataDir, username, cid);
  await fs.rm(dir, { recursive: true, force: true });
}

async function renameConversation(extDataDir, username, cid, title, audience) {
  const dir = convRoot(extDataDir, username, cid);
  const meta = await readJson(path.join(dir, 'meta.json'), null);
  if (!meta) throw new Error('对话不存在');
  if (typeof title === 'string') meta.title = trimText(title, 80) || meta.title;
  if (typeof audience === 'string') meta.audience = trimText(audience, 240);
  meta.updated_at = nowIso();
  await writeJson(path.join(dir, 'meta.json'), meta);
  return meta;
}

async function appendMessage(extDataDir, username, cid, message) {
  const dir = convRoot(extDataDir, username, cid);
  const msg = {
    id: shortId(8),
    role: message.role || 'user',
    content: String(message.content || ''),
    ts: nowIso(),
    meta: message.meta || null,
  };
  await appendJsonl(path.join(dir, 'messages.jsonl'), msg);
  const meta = await readJson(path.join(dir, 'meta.json'), null);
  if (meta) {
    meta.message_count = (Number(meta.message_count) || 0) + 1;
    meta.updated_at = nowIso();
    if (msg.role === 'user' && (!meta.title || meta.title === '新对话')) {
      meta.title = trimText(msg.content.split(/\r?\n/)[0], 36) || meta.title;
    }
    await writeJson(path.join(dir, 'meta.json'), meta);
  }
  return msg;
}

// ============================================================================
// 流式 chunk 文件 (供 poll_turn 读)
// ============================================================================

function chunkFile(dir, turnId) {
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(String(turnId))) throw new Error('invalid turn id');
  return path.join(dir, 'chunks', `${turnId}.json`);
}

async function initChunk(dir, turnId) {
  const file = chunkFile(dir, turnId);
  const empty = { turn_id: turnId, status: 'running', chunks: [], steps: [], created_at: nowIso(), updated_at: nowIso() };
  await ensureDir(path.dirname(file));
  await writeJson(file, empty);
  return empty;
}

async function appendChunk(dir, turnId, delta, kind = 'text') {
  const file = chunkFile(dir, turnId);
  const data = await readJson(file, null);
  if (!data) return null;
  const item = { i: data.chunks.length, kind, delta: String(delta || ''), ts: nowIso() };
  data.chunks.push(item);
  data.updated_at = item.ts;
  await writeJson(file, data);
  return item;
}

async function appendStep(dir, turnId, name, detail = '') {
  const file = chunkFile(dir, turnId);
  const data = await readJson(file, null);
  if (!data) return null;
  data.steps.push({ name, detail, ts: nowIso() });
  data.updated_at = nowIso();
  await writeJson(file, data);
}

async function finalizeChunk(dir, turnId, status, finalText, extra = {}) {
  const file = chunkFile(dir, turnId);
  const data = await readJson(file, null) || { turn_id: turnId, chunks: [], steps: [] };
  data.status = status;
  data.final_text = finalText || '';
  data.updated_at = nowIso();
  Object.assign(data, extra);
  await writeJson(file, data);
}

async function readChunkSince(dir, turnId, since = 0) {
  const file = chunkFile(dir, turnId);
  const data = await readJson(file, null);
  if (!data) return { ok: false, error: 'turn 不存在' };
  const cur = Math.max(0, Number(since) | 0);
  const newChunks = data.chunks.slice(cur);
  return {
    ok: true,
    turn_id: turnId,
    status: data.status,
    cursor: data.chunks.length,
    chunks: newChunks,
    steps: data.steps || [],
    final_text: data.final_text || '',
    error: data.error || '',
    meta: data.meta || null,
  };
}

// ============================================================================
// HTTP fetch (用于多平台数据抓取)
// ============================================================================

function fetchWithTimeout(urlStr, options = {}, timeoutMs = FETCH_BUDGET_MS) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(urlStr); } catch (e) { reject(new Error('invalid url: ' + e.message)); return; }
    if (!/^https?:$/.test(parsed.protocol)) { reject(new Error('only http/https allowed')); return; }
    const lib = parsed.protocol === 'https:' ? https : http;
    const reqOpts = {
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'MobiusResonanceAgent/0.1 (+https://mobius/extension/project-yongle)',
        'Accept': 'text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        ...(options.headers || {}),
      },
      timeout: timeoutMs,
    };
    const req = lib.request(parsed, reqOpts, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        try {
          const next = new URL(res.headers.location, parsed).toString();
          fetchWithTimeout(next, options, timeoutMs).then(resolve, reject);
        } catch (e) { reject(e); }
        return;
      }
      const chunks = [];
      let bytes = 0;
      const limit = 2 * 1024 * 1024;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > limit) { req.destroy(new Error('response too large')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (!res.statusCode || res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 180)}`));
          return;
        }
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTitle(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? htmlToText(m[1]).slice(0, 200) : '';
}

// ============================================================================
// LLM 调用 (OpenAI 兼容, 流式)
// ============================================================================

function resolveLlmConfig(state) {
  const apiBase = (state.settings?.llm_api_base || DEFAULT_LLM_BASE).replace(/\/+$/, '');
  const apiKey = state.settings?.llm_api_key
    || process.env.PROJECT_YONGLE_LLM_API_KEY
    || '';
  const model = state.settings?.llm_model || DEFAULT_LLM_MODEL;
  return { apiBase, apiKey, model };
}

/**
 * 流式 chat.completions, 每接到一段 delta 调用 onDelta(text).
 * 总预算 deadlineMs (相对 Date.now()), 超过则中断。
 * 返回 { text: 累积全文, finishReason }
 */
async function streamChatCompletions({ apiBase, apiKey, model, messages, temperature = 0.5, onDelta, deadlineMs }) {
  if (!apiKey) throw new Error('未配置 LLM API Key (PROJECT_YONGLE_LLM_API_KEY)');
  const url = `${apiBase}/chat/completions`;
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(url); } catch (e) { reject(new Error('invalid api base')); return; }
    const lib = parsed.protocol === 'https:' ? https : http;
    const body = JSON.stringify({ model, messages, temperature, stream: true });
    const req = lib.request({
      method: 'POST',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + (parsed.search || ''),
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: Math.max(2000, deadlineMs - Date.now()),
    }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => reject(new Error(`LLM HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString('utf8').slice(0, 300)}`)));
        return;
      }
      let buffer = '';
      let accumulated = '';
      let finishReason = '';
      let aborted = false;
      const timer = setInterval(() => {
        if (Date.now() > deadlineMs && !aborted) {
          aborted = true;
          try { req.destroy(); } catch {}
        }
      }, 250);
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          if (line.startsWith('data:')) {
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') {
              continue;
            }
            try {
              const obj = JSON.parse(payload);
              const choice = obj.choices && obj.choices[0];
              const delta = choice?.delta?.content || choice?.message?.content || '';
              if (delta) {
                accumulated += delta;
                try { onDelta && onDelta(delta); } catch {}
              }
              if (choice?.finish_reason) finishReason = choice.finish_reason;
            } catch { /* tolerate partial chunks */ }
          }
        }
      });
      res.on('end', () => {
        clearInterval(timer);
        resolve({ text: accumulated, finishReason: finishReason || (aborted ? 'aborted' : 'stop') });
      });
      res.on('error', (err) => { clearInterval(timer); reject(err); });
    });
    req.on('timeout', () => req.destroy(new Error('LLM request timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * 非流式 chat.completions, 一次返回完整文本 (用于短任务: 解析意图、抽取共鸣点等)
 */
async function chatCompletions({ apiBase, apiKey, model, messages, temperature = 0.2, timeoutMs = 16_000 }) {
  if (!apiKey) throw new Error('未配置 LLM API Key (PROJECT_YONGLE_LLM_API_KEY)');
  const res = await fetchWithTimeout(`${apiBase}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, temperature, stream: false }),
  }, timeoutMs);
  const data = JSON.parse(res.body);
  return data.choices?.[0]?.message?.content || '';
}

// ============================================================================
// system prompt 构造
// ============================================================================

const STEP_MARK_RE = /<<<STEP:([a-z0-9_-]+)(?::([^>]*))?>>>/gi;
const RESONANCE_MARK_RE = /<<<RESONANCE:(.*?)>>>/gi;

function buildSystemPrompt(state, opts = {}) {
  const profile = state.profile || {};
  const lines = [
    `你是"${EXTENSION_DISPLAY_NAME}"的核心 Agent, 一个面向中文创作者的共鸣内容研究 / 生成助理。`,
    '',
    '【你的目标】',
    '- 帮助用户为特定目标人群找到"情绪共鸣点", 并据此产出文案 / 剧情 / 歌词 / 视频方案。',
    '- 你会在多轮对话中持续逼近这些共鸣点, 而不是一次给完所有内容。',
    '',
    '【当前项目】',
    `- 项目名: ${profile.project_name || '(未填)'}`,
    `- 目标人群: ${profile.audience || '(未填)'}`,
    `- 目的: ${profile.goal || '(未填)'}`,
    `- 期望调性: ${profile.tone || '(未填)'}`,
  ];
  if (Array.isArray(profile.do_list) && profile.do_list.length) {
    lines.push(`- 要做: ${profile.do_list.slice(0, 8).join(' / ')}`);
  }
  if (Array.isArray(profile.dont_list) && profile.dont_list.length) {
    lines.push(`- 不要: ${profile.dont_list.slice(0, 8).join(' / ')}`);
  }
  lines.push('');
  lines.push('【说话风格】');
  lines.push('- 用简明中文, 不堆砌, 不空喊。');
  lines.push('- 当你不确定时, 主动反问 1-2 个最关键的问题, 不要假装知道。');
  lines.push('- 引用任何外部信息时, 在句尾用 (来源: 站点名/URL 缩略) 标注; 没有来源就说"这是我的推测"。');
  lines.push('');
  lines.push('【关键约定】');
  lines.push('- 当你判断需要执行后台动作时, 在文本中插入一行特殊标记 (用三对尖括号包裹, 单行独占):');
  lines.push('  - `<<<INTENT:fetch:platform_id:query>>>`  -- 想要抓取某平台关于 query 的内容');
  lines.push('  - `<<<INTENT:fetch_url:https://...>>>`     -- 想要抓取具体网页');
  lines.push('  - `<<<INTENT:save_data:title>>>`            -- 将刚才你引用的资料保存到数据池');
  lines.push('  - `<<<INTENT:apply_template:template_id>>>` -- 将这个模板的结构插入到下一轮回答');
  lines.push('  - `<<<INTENT:generate:kind:title>>>`        -- 准备生成一份文案/剧情/歌词/视频方案 (kind=copy|story|song|video)');
  lines.push('  - `<<<INTENT:save_draft:kind:title>>>`      -- 把当前回答的主体作为草稿保存');
  lines.push('  系统不会把这些标记给用户看, 但会基于它们调度真实工具。');
  lines.push('');
  lines.push('- 你在分析共鸣点时, 可以用 `<<<RESONANCE:一句共鸣点>>>` 把命中的共鸣点单独标记出来, 系统会收集到画布上。');
  lines.push('');
  lines.push('- 步骤进度用 `<<<STEP:阶段名:细节>>>` 输出, 阶段名建议: understand / research / extract / draft / refine / done。');
  lines.push('');
  lines.push('【格式约束】');
  lines.push('- 你必须保留 INTENT/RESONANCE/STEP 标记的原始格式 (三对尖括号), 不要替换成 Markdown。');
  lines.push('- 标记之外的正文可以正常使用 Markdown。');

  if (opts.appliedTemplate) {
    const t = opts.appliedTemplate;
    lines.push('');
    lines.push(`【当前轮要应用的模板: ${t.name}】`);
    lines.push(`- 摘要: ${t.summary || ''}`);
    if (Array.isArray(t.structure) && t.structure.length) {
      lines.push('- 结构:');
      for (const s of t.structure) lines.push(`  - ${s}`);
    }
    if (t.sample) lines.push(`- 参考样例: ${t.sample}`);
    lines.push('请把回答的主体严格按这个结构组织。');
  }

  if (opts.dataContext && opts.dataContext.length) {
    lines.push('');
    lines.push('【当前可用的素材片段 (来自数据池)】');
    for (const item of opts.dataContext.slice(0, 6)) {
      lines.push(`- [${item.title}] ${trimText(item.text, 320)}`);
      if (item.source_url) lines.push(`  来源: ${item.source_url}`);
    }
  }
  return lines.join('\n');
}

function trimMessagesForLlm(messages, maxBytes = 24_000) {
  const out = [];
  let bytes = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    const len = Buffer.byteLength(String(m.content || ''), 'utf8') + 32;
    if (bytes + len > maxBytes && out.length >= 2) break;
    bytes += len;
    out.unshift({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') });
  }
  return out;
}

// ============================================================================
// 后处理: 从 LLM 输出中抽取 INTENT/STEP/RESONANCE 并执行
// ============================================================================

function parseIntents(text) {
  const out = [];
  const re = /<<<INTENT:([^>]+)>>>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const parts = m[1].split(':');
    const kind = parts.shift();
    const args = parts.join(':');
    out.push({ kind, args });
  }
  return out;
}

function parseResonancePoints(text) {
  const out = [];
  let m;
  RESONANCE_MARK_RE.lastIndex = 0;
  while ((m = RESONANCE_MARK_RE.exec(text)) !== null) {
    const v = m[1].trim();
    if (v) out.push(v);
  }
  return out;
}

function parseSteps(text) {
  const out = [];
  let m;
  STEP_MARK_RE.lastIndex = 0;
  while ((m = STEP_MARK_RE.exec(text)) !== null) {
    out.push({ name: m[1], detail: m[2] || '' });
  }
  return out;
}

function stripMarks(text) {
  return String(text || '')
    .replace(/<<<INTENT:[^>]+>>>\s*/g, '')
    .replace(/<<<STEP:[^>]+>>>\s*/g, '')
    .replace(/<<<RESONANCE:[^>]+>>>\s*/g, '')
    .trim();
}

// ============================================================================
// 数据池 (跨对话积累)
// ============================================================================

function dataPoolPath(extDataDir, username) {
  return safeResolve(userRoot(extDataDir, username), 'data_pool.json');
}

async function readDataPool(extDataDir, username) {
  const raw = await readJson(dataPoolPath(extDataDir, username), { items: [] });
  return Array.isArray(raw.items) ? raw : { items: [] };
}

async function appendDataPool(extDataDir, username, item) {
  const pool = await readDataPool(extDataDir, username);
  const id = sha1(`${item.platform || ''}:${item.source_url || ''}:${item.title || ''}`).slice(0, 16);
  if (pool.items.some((it) => it.id === id)) return pool;
  pool.items.unshift({
    id,
    platform: trimText(item.platform || '', 40),
    source_url: trimText(item.source_url || '', 600),
    title: trimText(item.title || '', 240),
    text: trimText(item.text || '', 4000),
    tags: ensureArray(item.tags).slice(0, 8).map((t) => trimText(t, 30)),
    audience: trimText(item.audience || '', 160),
    created_at: nowIso(),
  });
  pool.items = pool.items.slice(0, MAX_DATA_POOL);
  await writeJson(dataPoolPath(extDataDir, username), pool);
  return pool;
}

async function deleteDataPoolItem(extDataDir, username, id) {
  const pool = await readDataPool(extDataDir, username);
  pool.items = pool.items.filter((it) => it.id !== id);
  await writeJson(dataPoolPath(extDataDir, username), pool);
  return pool;
}

// ============================================================================
// 模板
// ============================================================================

function templatesPath(extDataDir, username) {
  return safeResolve(userRoot(extDataDir, username), 'templates.json');
}

async function readUserTemplates(extDataDir, username) {
  const raw = await readJson(templatesPath(extDataDir, username), { items: [] });
  return Array.isArray(raw.items) ? raw.items : [];
}

async function listTemplates(extDataDir, username) {
  const user = await readUserTemplates(extDataDir, username);
  return [...BUILTIN_TEMPLATES, ...user];
}

async function saveTemplate(extDataDir, username, tpl) {
  const list = await readUserTemplates(extDataDir, username);
  const id = tpl.id && /^[A-Za-z0-9_-]{4,40}$/.test(tpl.id) ? tpl.id : `tpl-${shortId(6)}`;
  const clean = {
    id,
    kind: ['copy', 'story', 'song', 'video'].includes(tpl.kind) ? tpl.kind : 'copy',
    name: trimText(tpl.name || '未命名模板', 80),
    audience: trimText(tpl.audience || '', 160),
    summary: trimText(tpl.summary || '', 600),
    structure: ensureArray(tpl.structure).slice(0, 20).map((s) => trimText(s, 240)),
    sample: trimText(tpl.sample || '', 2000),
    builtin: false,
    updated_at: nowIso(),
  };
  const idx = list.findIndex((it) => it.id === id);
  if (idx >= 0) list[idx] = clean;
  else list.unshift(clean);
  const trimmed = list.slice(0, MAX_TEMPLATES);
  await writeJson(templatesPath(extDataDir, username), { items: trimmed });
  return clean;
}

async function deleteTemplate(extDataDir, username, id) {
  const list = await readUserTemplates(extDataDir, username);
  const next = list.filter((it) => it.id !== id);
  await writeJson(templatesPath(extDataDir, username), { items: next });
  return next;
}

// ============================================================================
// 草稿库
// ============================================================================

async function listDrafts(extDataDir, username) {
  const root = safeResolve(userRoot(extDataDir, username), 'drafts');
  if (!(await exists(root))) return [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const meta = await readJson(path.join(root, ent.name, 'meta.json'), null);
    if (!meta) continue;
    out.push(meta);
  }
  out.sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
  return out.slice(0, MAX_DRAFT_PER_USER);
}

async function getDraft(extDataDir, username, did) {
  const dir = draftRoot(extDataDir, username, did);
  const meta = await readJson(path.join(dir, 'meta.json'), null);
  if (!meta) return null;
  let content = '';
  try { content = await fs.readFile(path.join(dir, 'content.md'), 'utf8'); } catch {}
  return { meta, content };
}

async function saveDraft(extDataDir, username, payload) {
  const did = payload.id && /^[A-Za-z0-9_-]{4,40}$/.test(payload.id) ? payload.id : `dft-${shortId(8)}`;
  const dir = draftRoot(extDataDir, username, did);
  await ensureDir(dir);
  const oldMeta = await readJson(path.join(dir, 'meta.json'), null);
  const meta = {
    id: did,
    kind: ['copy', 'story', 'song', 'video'].includes(payload.kind) ? payload.kind : (oldMeta?.kind || 'copy'),
    title: trimText(payload.title || oldMeta?.title || '未命名草稿', 80),
    audience: trimText(payload.audience || oldMeta?.audience || '', 240),
    ref_conv_id: trimText(payload.ref_conv_id || oldMeta?.ref_conv_id || '', 40),
    template_id: trimText(payload.template_id || oldMeta?.template_id || '', 40),
    created_at: oldMeta?.created_at || nowIso(),
    updated_at: nowIso(),
  };
  await writeJson(path.join(dir, 'meta.json'), meta);
  if (typeof payload.content === 'string') {
    await fs.writeFile(path.join(dir, 'content.md'), payload.content, 'utf8');
  }
  return meta;
}

async function deleteDraft(extDataDir, username, did) {
  const dir = draftRoot(extDataDir, username, did);
  await fs.rm(dir, { recursive: true, force: true });
}

// ============================================================================
// 多平台抓取 (真实 fetch + 启发式提取)
// ============================================================================

async function fetchUrl(targetUrl) {
  const res = await fetchWithTimeout(targetUrl, {}, FETCH_BUDGET_MS);
  const contentType = String(res.headers['content-type'] || '');
  if (contentType.includes('application/json')) {
    return {
      title: '',
      text: trimText(res.body, 8000),
      url: targetUrl,
      content_type: 'json',
    };
  }
  const title = extractTitle(res.body);
  const text = htmlToText(res.body);
  return { title, text: trimText(text, 8000), url: targetUrl, content_type: 'html' };
}

async function fetchPlatform(platformId, query) {
  const platform = BUILTIN_PLATFORMS.find((p) => p.id === platformId);
  if (!platform) throw new Error(`未知平台: ${platformId}`);
  if (platformId === 'web') {
    return fetchUrl(query);
  }
  // 大多数平台用 search url 形式 — 受限于 SSR + 防爬, 这里走真实 HTTP 但结果可能不全
  // 真实落地一般会接平台开放 API; 这里走 "尽力而为" 的搜索页抓取
  const searchUrls = {
    zhihu: `https://www.zhihu.com/search?type=content&q=${encodeURIComponent(query)}`,
    weibo: `https://s.weibo.com/weibo?q=${encodeURIComponent(query)}`,
    douyin: `https://www.douyin.com/search/${encodeURIComponent(query)}`,
    xhs: `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(query)}`,
    douban: `https://search.douban.com/movie/subject_search?search_text=${encodeURIComponent(query)}`,
    bilibili: `https://search.bilibili.com/all?keyword=${encodeURIComponent(query)}`,
  };
  const url = searchUrls[platformId];
  if (!url) throw new Error(`平台 ${platformId} 暂未配置搜索入口`);
  try {
    const res = await fetchUrl(url);
    return { ...res, platform: platform.name, query };
  } catch (e) {
    // 抓取失败时返回 stub, 不至于让对话挂掉
    return {
      title: `[${platform.name}] ${query}`,
      text: `直接抓取 ${platform.name} 搜索结果失败 (${e.message})。可以让用户提供具体 URL 或粘贴段落, Agent 会基于现有上下文继续推进。`,
      url,
      platform: platform.name,
      query,
      content_type: 'stub',
    };
  }
}

// ============================================================================
// 主流程: send_message
// ============================================================================

async function handleSendMessage({ extDataDir, username, payload, logger }) {
  const cid = String(payload.conversation_id || '').trim();
  const content = String(payload.content || '').trim();
  if (!cid) throw new Error('缺少 conversation_id');
  if (!content) throw new Error('消息内容为空');
  if (Buffer.byteLength(content, 'utf8') > MAX_INPUT_BYTES) {
    throw new Error(`消息超长 (${MAX_INPUT_BYTES} 字节上限)`);
  }
  const state = await readState(extDataDir, username);
  const conv = await getConversation(extDataDir, username, cid);
  if (!conv) throw new Error('对话不存在');
  await appendMessage(extDataDir, username, cid, { role: 'user', content });

  const turnId = `t-${shortId(8)}`;
  const dir = convRoot(extDataDir, username, cid);
  await initChunk(dir, turnId);

  // 读取应用中的 template / data context
  const appliedTemplateId = String(payload.apply_template_id || '').trim();
  let appliedTemplate = null;
  if (appliedTemplateId) {
    const tpls = await listTemplates(extDataDir, username);
    appliedTemplate = tpls.find((t) => t.id === appliedTemplateId) || null;
  }
  // 当前对话引用过的素材片段
  const sourcesPath = path.join(dir, 'sources.json');
  const sourcesObj = await readJson(sourcesPath, { items: [] });
  const dataContext = Array.isArray(sourcesObj.items) ? sourcesObj.items.slice(0, 6) : [];

  const systemPrompt = buildSystemPrompt(state, { appliedTemplate, dataContext });
  const recent = await readJsonl(path.join(dir, 'messages.jsonl'));
  const messages = [
    { role: 'system', content: systemPrompt },
    ...trimMessagesForLlm(recent, 18_000),
  ];

  await appendStep(dir, turnId, 'understand', '解析用户输入与上下文');

  const { apiBase, apiKey, model } = resolveLlmConfig(state);

  const deadlineMs = Date.now() + STREAM_BUDGET_MS;
  let accumulated = '';

  try {
    const result = await streamChatCompletions({
      apiBase, apiKey, model, messages, temperature: 0.55,
      deadlineMs,
      onDelta: (delta) => {
        accumulated += delta;
        // 异步写, 不 await — 节流靠 250ms tick 自然合并
        appendChunk(dir, turnId, delta).catch(() => {});
      },
    });
    accumulated = result.text || accumulated;
  } catch (e) {
    logger?.warn?.('LLM stream failed', { error: e.message, model });
    const errText = `\n\n[模型调用失败: ${e.message}]\n这里给出一份不依赖外部模型的回退建议: 请先确认 \`.env\` 中的 PROJECT_YONGLE_LLM_API_KEY 是否填了真实密钥, 然后重试。如果只想本地体验, 可在右上角侧栏粘贴自定义 OpenAI 兼容 API。`;
    accumulated += errText;
    await appendChunk(dir, turnId, errText);
  }

  await appendStep(dir, turnId, 'extract', '提取共鸣点与意图');
  const intents = parseIntents(accumulated);
  const resonance = parseResonancePoints(accumulated);
  const steps = parseSteps(accumulated);

  // 把模型识别出的 step 名字写到 chunk.steps 里, 前端可显示阶段链
  for (const s of steps) await appendStep(dir, turnId, s.name, s.detail);

  // 调度 INTENT
  const intentResults = [];
  for (const intent of intents.slice(0, 4)) { // 一轮最多 4 个意图, 防爆
    if (Date.now() > deadlineMs - 1000) break; // 接近预算就停
    try {
      if (intent.kind === 'fetch') {
        const [platformId, ...rest] = intent.args.split(':');
        const query = rest.join(':');
        await appendStep(dir, turnId, 'research', `抓取 ${platformId}: ${query}`);
        const res = await fetchPlatform(platformId, query);
        sourcesObj.items = sourcesObj.items || [];
        sourcesObj.items.unshift({
          title: res.title || `[${platformId}] ${query}`,
          text: res.text,
          source_url: res.url || '',
          platform: platformId,
        });
        sourcesObj.items = sourcesObj.items.slice(0, 20);
        await writeJson(sourcesPath, sourcesObj);
        await appendDataPool(extDataDir, username, {
          platform: platformId, source_url: res.url, title: res.title || query, text: res.text, audience: state.profile?.audience || '',
        });
        intentResults.push({ kind: 'fetch', ok: true, platform: platformId, query, title: res.title || query });
        await appendChunk(dir, turnId, `\n\n[已抓取 ${platformId}: ${query}]\n`, 'system');
      } else if (intent.kind === 'fetch_url') {
        await appendStep(dir, turnId, 'research', `抓取 URL: ${intent.args}`);
        const res = await fetchUrl(intent.args);
        sourcesObj.items = sourcesObj.items || [];
        sourcesObj.items.unshift({ title: res.title, text: res.text, source_url: res.url, platform: 'web' });
        sourcesObj.items = sourcesObj.items.slice(0, 20);
        await writeJson(sourcesPath, sourcesObj);
        await appendDataPool(extDataDir, username, {
          platform: 'web', source_url: res.url, title: res.title, text: res.text, audience: state.profile?.audience || '',
        });
        intentResults.push({ kind: 'fetch_url', ok: true, url: intent.args, title: res.title });
        await appendChunk(dir, turnId, `\n\n[已抓取 URL: ${res.title || intent.args}]\n`, 'system');
      } else if (intent.kind === 'save_draft') {
        const [kind, ...titleParts] = intent.args.split(':');
        const draft = await saveDraft(extDataDir, username, {
          kind,
          title: titleParts.join(':') || `${EXTENSION_DISPLAY_NAME} 草稿`,
          audience: state.profile?.audience || '',
          ref_conv_id: cid,
          content: stripMarks(accumulated),
        });
        intentResults.push({ kind: 'save_draft', ok: true, draft_id: draft.id, title: draft.title });
        await appendChunk(dir, turnId, `\n\n[已保存草稿: ${draft.title}]\n`, 'system');
      } else if (intent.kind === 'save_data') {
        // 把当前回答中引用的最近一份素材另存到数据池 (已在 fetch 自动入池, 这里只是确认)
        intentResults.push({ kind: 'save_data', ok: true, note: '资料已在抓取时入池' });
      } else if (intent.kind === 'apply_template') {
        intentResults.push({ kind: 'apply_template', ok: true, template_id: intent.args, hint: '下一轮发送消息时携带 apply_template_id 即可生效' });
      } else if (intent.kind === 'generate') {
        // generate 意图本身在前端用按钮触发更顺手 — 这里只记录暗示
        intentResults.push({ kind: 'generate', ok: true, args: intent.args, hint: '右侧画布可点"生成草稿"' });
      } else {
        intentResults.push({ kind: intent.kind, ok: false, error: '未识别的意图' });
      }
    } catch (e) {
      intentResults.push({ kind: intent.kind, ok: false, error: e.message });
      await appendChunk(dir, turnId, `\n\n[意图 ${intent.kind} 执行失败: ${e.message}]\n`, 'system');
    }
  }

  const cleanFinal = stripMarks(accumulated);

  // 保存 assistant 消息 (用清理后的正文, 但保留 raw 在 meta 里)
  await appendMessage(extDataDir, username, cid, {
    role: 'assistant',
    content: cleanFinal,
    meta: {
      turn_id: turnId,
      raw: accumulated,
      resonance,
      intents: intentResults,
      steps,
    },
  });

  await finalizeChunk(dir, turnId, 'done', cleanFinal, {
    resonance,
    intents: intentResults,
    meta: { applied_template_id: appliedTemplateId || '' },
  });

  if (state.settings?.auto_save_drafts) {
    // 自动保存触发条件: 模型显式 save_draft 已经处理过
  }

  return {
    ok: true,
    turn_id: turnId,
    final_text: cleanFinal,
    resonance,
    intents: intentResults,
    sources: sourcesObj.items,
  };
}

// ============================================================================
// 生成专门草稿 (走非流式快速通道, 严格按 kind 模板组织)
// ============================================================================

async function handleGenerateArtifact({ extDataDir, username, payload }) {
  const cid = String(payload.conversation_id || '').trim();
  const kind = ['copy', 'story', 'song', 'video'].includes(payload.kind) ? payload.kind : 'copy';
  const title = trimText(payload.title || '', 80);
  const briefExtra = trimText(payload.brief || '', 1000);
  const state = await readState(extDataDir, username);
  const conv = cid ? await getConversation(extDataDir, username, cid) : null;
  const recentText = conv ? conv.messages.slice(-12).map((m) => `${m.role === 'user' ? '用户' : 'Agent'}: ${trimText(m.content, 600)}`).join('\n') : '';
  const tpls = await listTemplates(extDataDir, username);
  const templateId = String(payload.template_id || '').trim();
  const template = templateId ? tpls.find((t) => t.id === templateId) : tpls.find((t) => t.kind === kind && t.builtin);

  const kindLabel = { copy: '文案', story: '剧情大纲', song: '歌词', video: '视频拍摄方案' }[kind];
  const sys = [
    `你是"${EXTENSION_DISPLAY_NAME}"的内容生成器, 现在专门负责输出${kindLabel}。`,
    `目标人群: ${state.profile?.audience || '通用中文创作者人群'}`,
    `调性: ${state.profile?.tone || '真诚、克制、有画面感'}`,
    '【格式要求】',
    '- 直接输出最终成稿, 不要解释你怎么写的。',
    '- 不要使用 INTENT/STEP/RESONANCE 等特殊标记, 这一轮是纯成稿模式。',
    '- 中文输出。',
  ];
  if (template) {
    sys.push('');
    sys.push(`【遵循模板: ${template.name}】`);
    if (template.summary) sys.push(`- 摘要: ${template.summary}`);
    if (Array.isArray(template.structure) && template.structure.length) {
      sys.push('- 结构:');
      for (const s of template.structure) sys.push(`  - ${s}`);
    }
    if (template.sample) sys.push(`- 样例参考: ${template.sample}`);
  }
  const userMsg = [
    `标题或方向: ${title || '(沿用对话上下文)'}`,
    briefExtra ? `补充要求: ${briefExtra}` : '',
    recentText ? `近期对话上下文:\n${recentText}` : '',
  ].filter(Boolean).join('\n\n');

  const { apiBase, apiKey, model } = resolveLlmConfig(state);
  let content = '';
  try {
    content = await chatCompletions({
      apiBase, apiKey, model,
      messages: [
        { role: 'system', content: sys.join('\n') },
        { role: 'user', content: userMsg },
      ],
      temperature: 0.7,
      timeoutMs: 24_000,
    });
  } catch (e) {
    throw new Error(`生成失败: ${e.message}`);
  }

  const draft = await saveDraft(extDataDir, username, {
    kind,
    title: title || `${kindLabel} 草稿`,
    audience: state.profile?.audience || '',
    ref_conv_id: cid,
    template_id: template?.id || '',
    content,
  });
  return { ok: true, draft, content };
}

// ============================================================================
// dispatcher
// ============================================================================

module.exports = async function extensionBackendHandler({
  username,
  display_name,
  ext_main_payload,
  ext_data_dir,
  extension_name,
  logger,
}) {
  const p = ext_main_payload || {};
  const action = String(p.action || '').trim();

  await ensureDir(userRoot(ext_data_dir, username));

  try {
    if (action === 'whoami') {
      return { ok: true, username, display_name: display_name || username, extension_name, extension_display_name: EXTENSION_DISPLAY_NAME };
    }

    if (action === 'get_state') {
      const [state, conversations, templates, drafts, pool] = await Promise.all([
        readState(ext_data_dir, username),
        listConversations(ext_data_dir, username),
        listTemplates(ext_data_dir, username),
        listDrafts(ext_data_dir, username),
        readDataPool(ext_data_dir, username),
      ]);
      return {
        ok: true,
        username,
        display_name: display_name || username,
        state,
        conversations,
        templates,
        drafts,
        platforms: BUILTIN_PLATFORMS,
        data_pool: pool.items || [],
      };
    }

    if (action === 'update_profile') {
      const state = await readState(ext_data_dir, username);
      const next = p.profile || {};
      state.profile = {
        ...state.profile,
        project_name: trimText(next.project_name ?? state.profile.project_name, 80),
        audience: trimText(next.audience ?? state.profile.audience, 600),
        goal: trimText(next.goal ?? state.profile.goal, 600),
        tone: trimText(next.tone ?? state.profile.tone, 240),
        do_list: ensureArray(next.do_list ?? state.profile.do_list).slice(0, 12).map((s) => trimText(s, 80)),
        dont_list: ensureArray(next.dont_list ?? state.profile.dont_list).slice(0, 12).map((s) => trimText(s, 80)),
      };
      await saveState(ext_data_dir, username, state);
      return { ok: true, state };
    }

    if (action === 'update_settings') {
      const state = await readState(ext_data_dir, username);
      const next = p.settings || {};
      if (typeof next.llm_api_base === 'string') state.settings.llm_api_base = trimText(next.llm_api_base, 240);
      if (typeof next.llm_api_key === 'string') state.settings.llm_api_key = trimText(next.llm_api_key, 240);
      if (typeof next.llm_model === 'string') state.settings.llm_model = trimText(next.llm_model, 120);
      if (typeof next.auto_save_drafts === 'boolean') state.settings.auto_save_drafts = next.auto_save_drafts;
      await saveState(ext_data_dir, username, state);
      return { ok: true, state };
    }

    if (action === 'list_conversations') {
      return { ok: true, conversations: await listConversations(ext_data_dir, username) };
    }

    if (action === 'create_conversation') {
      const meta = await createConversation(ext_data_dir, username, {
        title: p.title || '',
        audience: p.audience || '',
      });
      const state = await readState(ext_data_dir, username);
      state.current_conv_id = meta.id;
      await saveState(ext_data_dir, username, state);
      return { ok: true, conversation: meta };
    }

    if (action === 'get_conversation') {
      const data = await getConversation(ext_data_dir, username, String(p.conversation_id || ''));
      if (!data) return { ok: false, error: '对话不存在' };
      return { ok: true, ...data };
    }

    if (action === 'rename_conversation') {
      const meta = await renameConversation(ext_data_dir, username, String(p.conversation_id || ''), p.title, p.audience);
      return { ok: true, conversation: meta };
    }

    if (action === 'delete_conversation') {
      await deleteConversation(ext_data_dir, username, String(p.conversation_id || ''));
      return { ok: true };
    }

    if (action === 'send_message') {
      return handleSendMessage({ extDataDir: ext_data_dir, username, payload: p, logger });
    }

    if (action === 'poll_turn') {
      const cid = String(p.conversation_id || '').trim();
      const turnId = String(p.turn_id || '').trim();
      if (!cid || !turnId) return { ok: false, error: '缺少 conversation_id 或 turn_id' };
      const dir = convRoot(ext_data_dir, username, cid);
      return readChunkSince(dir, turnId, Number(p.cursor || 0));
    }

    if (action === 'find_active_turn') {
      // 扫描 chunks 目录, 按 mtime 倒序找最近一个还在 running 的 turn (或刚 done 的)
      const cid = String(p.conversation_id || '').trim();
      if (!cid) return { ok: false, error: '缺少 conversation_id' };
      const dir = path.join(convRoot(ext_data_dir, username, cid), 'chunks');
      if (!(await exists(dir))) return { ok: true, turn_id: '', status: '' };
      const files = await fs.readdir(dir).catch(() => []);
      const candidates = [];
      for (const name of files) {
        if (!/^t-[A-Za-z0-9_-]+\.json$/.test(name)) continue;
        try {
          const st = await fs.stat(path.join(dir, name));
          candidates.push({ name, mtime: st.mtimeMs });
        } catch { /* skip */ }
      }
      candidates.sort((a, b) => b.mtime - a.mtime);
      // 只看最近 5 个
      for (const c of candidates.slice(0, 5)) {
        const data = await readJson(path.join(dir, c.name), null);
        if (!data) continue;
        // 接受 running, 或最近 8s 内完成的 — 让前端有机会一次拿到全文
        if (data.status === 'running' || (Date.now() - new Date(data.updated_at || 0).getTime()) < 8000) {
          return {
            ok: true,
            turn_id: data.turn_id,
            status: data.status,
            cursor: (data.chunks || []).length,
            chunks: data.chunks || [],
            steps: data.steps || [],
            final_text: data.final_text || '',
            resonance: data.resonance || [],
            intents: data.intents || [],
          };
        }
      }
      return { ok: true, turn_id: '', status: '' };
    }

    if (action === 'list_templates') {
      return { ok: true, templates: await listTemplates(ext_data_dir, username) };
    }

    if (action === 'save_template') {
      const tpl = await saveTemplate(ext_data_dir, username, p.template || {});
      return { ok: true, template: tpl, templates: await listTemplates(ext_data_dir, username) };
    }

    if (action === 'delete_template') {
      const next = await deleteTemplate(ext_data_dir, username, String(p.template_id || ''));
      return { ok: true, templates: [...BUILTIN_TEMPLATES, ...next] };
    }

    if (action === 'list_drafts') {
      return { ok: true, drafts: await listDrafts(ext_data_dir, username) };
    }

    if (action === 'get_draft') {
      const data = await getDraft(ext_data_dir, username, String(p.draft_id || ''));
      if (!data) return { ok: false, error: '草稿不存在' };
      return { ok: true, ...data };
    }

    if (action === 'save_draft') {
      const meta = await saveDraft(ext_data_dir, username, p.draft || {});
      return { ok: true, draft: meta, drafts: await listDrafts(ext_data_dir, username) };
    }

    if (action === 'delete_draft') {
      await deleteDraft(ext_data_dir, username, String(p.draft_id || ''));
      return { ok: true, drafts: await listDrafts(ext_data_dir, username) };
    }

    if (action === 'generate_artifact') {
      return handleGenerateArtifact({ extDataDir: ext_data_dir, username, payload: p });
    }

    if (action === 'fetch_platform_data') {
      const platformId = String(p.platform || '').trim();
      const query = String(p.query || '').trim();
      if (!platformId || !query) return { ok: false, error: '需要 platform 与 query' };
      const state = await readState(ext_data_dir, username);
      const res = await fetchPlatform(platformId, query);
      const pool = await appendDataPool(ext_data_dir, username, {
        platform: platformId,
        source_url: res.url,
        title: res.title || query,
        text: res.text,
        audience: state.profile?.audience || '',
      });
      return { ok: true, result: res, data_pool: pool.items };
    }

    if (action === 'list_data_pool') {
      const pool = await readDataPool(ext_data_dir, username);
      return { ok: true, data_pool: pool.items };
    }

    if (action === 'add_data_source') {
      const state = await readState(ext_data_dir, username);
      const pool = await appendDataPool(ext_data_dir, username, {
        platform: p.platform || 'manual',
        source_url: p.source_url || '',
        title: p.title || '',
        text: p.text || '',
        tags: p.tags || [],
        audience: state.profile?.audience || '',
      });
      return { ok: true, data_pool: pool.items };
    }

    if (action === 'delete_data_source') {
      const pool = await deleteDataPoolItem(ext_data_dir, username, String(p.id || ''));
      return { ok: true, data_pool: pool.items };
    }

    if (action === 'extract_resonance') {
      // 给一段文本, 用 LLM 抽出共鸣点列表
      const state = await readState(ext_data_dir, username);
      const text = trimText(p.text || '', 4000);
      if (!text) return { ok: false, error: 'text 为空' };
      const { apiBase, apiKey, model } = resolveLlmConfig(state);
      const sys = `你是中文情绪洞察助手, 目标人群: ${state.profile?.audience || '中文创作者'}。\n从给定文本中提炼 3-7 个能让该人群产生共鸣的"情绪命中点"。每条 12-28 字, 直接输出 JSON: {"points": ["...","..."]} 不要解释。`;
      try {
        const raw = await chatCompletions({
          apiBase, apiKey, model,
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: text },
          ],
          temperature: 0.4,
          timeoutMs: 18_000,
        });
        const jsonText = (raw.match(/\{[\s\S]*\}/) || [raw])[0];
        const parsed = JSON.parse(jsonText);
        return { ok: true, points: Array.isArray(parsed.points) ? parsed.points.slice(0, 10) : [] };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    return { ok: false, error: `未识别的 action: ${action || '(empty)'}` };
  } catch (e) {
    logger?.error?.('handler failed', { action, error: e.message });
    return { ok: false, error: e.message || String(e) };
  }
};
