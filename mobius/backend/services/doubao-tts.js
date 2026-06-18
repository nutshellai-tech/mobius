const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Memories } = require('../repositories/memories');

const DEFAULT_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const DEFAULT_RESOURCE_ID = 'seed-tts-2.0';
const DEFAULT_VOICE = 'zh_female_vv_uranus_bigtts';
const DEFAULT_FORMAT = 'mp3';
const DEFAULT_SAMPLE_RATE = 24000;
const MAX_TEXT_CHARS = 1200;
const FETCH_TIMEOUT_MS = 60_000;
const TTS_CACHE_LIMIT = 128;
const ttsAudioCache = new Map();

const DOUBAO_TTS_VOICES = Object.freeze([
  {
    id: 'zh_female_vv_uranus_bigtts',
    label: 'vivi 2.0',
    language: 'zh-CN',
    gender: 'female',
    category: 'general',
    description: '自然清亮的通用女声',
  },
  {
    id: 'zh_female_xiaohe_uranus_bigtts',
    label: '小何',
    language: 'zh-CN',
    gender: 'female',
    category: 'general',
    description: '温和耐听的通用女声',
  },
  {
    id: 'zh_male_m191_uranus_bigtts',
    label: '云舟',
    language: 'zh-CN',
    gender: 'male',
    category: 'general',
    description: '稳重清晰的通用男声',
  },
  {
    id: 'zh_male_taocheng_uranus_bigtts',
    label: '小天',
    language: 'zh-CN',
    gender: 'male',
    category: 'general',
    description: '明快自然的通用男声',
  },
  {
    id: 'saturn_zh_female_cancan_tob',
    label: '知性灿灿',
    language: 'zh-CN',
    gender: 'female',
    category: 'role',
    description: '偏知性表达的角色女声',
  },
  {
    id: 'saturn_zh_female_keainvsheng_tob',
    label: '可爱女生',
    language: 'zh-CN',
    gender: 'female',
    category: 'role',
    description: '轻快活泼的角色女声',
  },
  {
    id: 'saturn_zh_female_tiaopigongzhu_tob',
    label: '调皮公主',
    language: 'zh-CN',
    gender: 'female',
    category: 'role',
    description: '更有角色感的俏皮女声',
  },
  {
    id: 'saturn_zh_male_shuanglangshaonian_tob',
    label: '爽朗少年',
    language: 'zh-CN',
    gender: 'male',
    category: 'role',
    description: '明亮爽朗的少年音色',
  },
  {
    id: 'saturn_zh_male_tiancaitongzhuo_tob',
    label: '天才同桌',
    language: 'zh-CN',
    gender: 'male',
    category: 'role',
    description: '偏年轻化的角色男声',
  },
  {
    id: 'en_male_tim_uranus_bigtts',
    label: 'Tim',
    language: 'en-US',
    gender: 'male',
    category: 'general',
    description: '英文通用男声',
  },
]);
const DOUBAO_TTS_VOICE_IDS = new Set(DOUBAO_TTS_VOICES.map((voice) => voice.id));

class TtsError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'TtsError';
    this.code = opts.code || 'TTS_FAILED';
    this.status = opts.status || 500;
    this.logId = opts.logId || '';
  }
}

function parseEnvFile(file) {
  if (!file) return {};
  const resolved = path.resolve(file.replace(/^~/, os.homedir()));
  if (!fs.existsSync(resolved)) return {};
  const out = {};
  const raw = fs.readFileSync(resolved, 'utf8');
  raw.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) return;
    const key = match[1];
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  });
  return out;
}

function cleanCredentialValue(value) {
  return String(value || '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[，,。;；]+$/g, '')
    .trim();
}

function credentialEnvValue(value) {
  const cleaned = cleanCredentialValue(value);
  if (!cleaned || /^replace-me(?:-|$)/i.test(cleaned) || /^change-me(?:-|$)/i.test(cleaned)) {
    return '';
  }
  return cleaned;
}

function firstCredentialMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    if (!match?.[1]) continue;
    const value = credentialEnvValue(match[1]);
    if (value) return value;
  }
  return '';
}

function extractDoubaoTtsCredentialsFromText(text) {
  const appId = firstCredentialMatch(text, [
    /\bDOUBAO_TTS_APP_ID\s*=\s*([^\s"'`]+)/i,
    /\bVOLC_TTS_APP_ID\s*=\s*([^\s"'`]+)/i,
    /\bAPP\s*ID\s*[:：]\s*([^\s\r\n]+)/i,
    /\bApp\s*Key\s*[:：]\s*([^\s\r\n]+)/i,
  ]);
  const accessToken = firstCredentialMatch(text, [
    /\bDOUBAO_TTS_ACCESS_TOKEN\s*=\s*([^\s"'`]+)/i,
    /\bVOLC_TTS_ACCESS_TOKEN\s*=\s*([^\s"'`]+)/i,
    /\bAccess\s*Token\s*[:：]\s*([^\s\r\n]+)/i,
    /\bAccess\s*Key\s*[:：]\s*([^\s\r\n]+)/i,
  ]);
  if (!appId || !accessToken) return null;
  return {
    appId,
    accessToken,
    resourceId: firstCredentialMatch(text, [
      /\bDOUBAO_TTS_RESOURCE_ID\s*=\s*([^\s"'`]+)/i,
      /\bResource\s*ID\s*[:：]\s*([A-Za-z0-9._-]+)/i,
    ]) || DEFAULT_RESOURCE_ID,
    endpoint: firstCredentialMatch(text, [
      /\bDOUBAO_TTS_ENDPOINT\s*=\s*(https:\/\/[^\s"'`]+)/i,
      /((?:https:\/\/)[^\s"'`]+\/api\/v3\/tts\/unidirectional)\b/i,
    ]) || DEFAULT_ENDPOINT,
  };
}

function resolveCredentialsFromUserMemory(user) {
  const userId = user?.id;
  if (!userId) return null;
  let memories = [];
  try {
    memories = Memories.listForUser(userId);
  } catch {
    return null;
  }
  const candidates = memories.filter((memory) => {
    const haystack = [memory.name, memory.description, memory.body].filter(Boolean).join('\n');
    return /豆包\s*TTS|DOUBAO_TTS|SeedTTS|seed-tts|openspeech/i.test(haystack);
  });
  for (const memory of candidates) {
    const credentials = extractDoubaoTtsCredentialsFromText(memory.body || '');
    if (credentials) return credentials;
  }
  return null;
}

function loadSecretEnv() {
  const files = [
    process.env.DOUBAO_TTS_ENV_FILE,
    path.join(os.homedir(), '.codex', 'secrets', 'doubao-tts.env'),
  ].filter(Boolean);
  return files.reduce((acc, file) => ({ ...acc, ...parseEnvFile(file) }), {});
}

function resolveCredentials(user) {
  const secretEnv = loadSecretEnv();
  const get = (key) => process.env[key] || secretEnv[key] || '';
  const getCredential = (key) => credentialEnvValue(process.env[key]) || credentialEnvValue(secretEnv[key]);
  const appId = getCredential('DOUBAO_TTS_APP_ID') || getCredential('VOLC_TTS_APP_ID');
  const accessToken = getCredential('DOUBAO_TTS_ACCESS_TOKEN') || getCredential('VOLC_TTS_ACCESS_TOKEN');
  if (appId && accessToken) {
    return {
      appId,
      accessToken,
      resourceId: get('DOUBAO_TTS_RESOURCE_ID') || get('VOLC_TTS_RESOURCE_ID') || DEFAULT_RESOURCE_ID,
      endpoint: get('DOUBAO_TTS_ENDPOINT') || DEFAULT_ENDPOINT,
    };
  }

  const memoryCredentials = resolveCredentialsFromUserMemory(user);
  if (memoryCredentials) return memoryCredentials;

  return {
    appId: '',
    accessToken: '',
    resourceId: get('DOUBAO_TTS_RESOURCE_ID') || DEFAULT_RESOURCE_ID,
    endpoint: get('DOUBAO_TTS_ENDPOINT') || DEFAULT_ENDPOINT,
  };
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

function normalizeVoice(voice) {
  const value = String(voice || '').trim();
  if (!value) return DEFAULT_VOICE;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return DEFAULT_VOICE;
  return DOUBAO_TTS_VOICE_IDS.has(value) ? value : DEFAULT_VOICE;
}

function normalizeFormat(format) {
  return String(format || '').trim().toLowerCase() === 'wav' ? 'wav' : DEFAULT_FORMAT;
}

function getTtsVoices() {
  return DOUBAO_TTS_VOICES.map((voice) => ({
    ...voice,
    default: voice.id === DEFAULT_VOICE,
  }));
}

function buildTtsCacheKey({ credentials, text, voice, format }) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({
      version: 1,
      endpoint: credentials.endpoint || DEFAULT_ENDPOINT,
      resourceId: credentials.resourceId || DEFAULT_RESOURCE_ID,
      appId: credentials.appId || '',
      accessToken: credentials.accessToken || '',
      text,
      voice,
      format,
      sampleRate: DEFAULT_SAMPLE_RATE,
    }))
    .digest('hex');
}

function getCachedSpeech(cacheKey) {
  const entry = ttsAudioCache.get(cacheKey);
  if (!entry) return null;
  ttsAudioCache.delete(cacheKey);
  ttsAudioCache.set(cacheKey, entry);
  return {
    ...entry,
    audio: Buffer.from(entry.audio),
  };
}

function setCachedSpeech(cacheKey, entry) {
  if (ttsAudioCache.has(cacheKey)) ttsAudioCache.delete(cacheKey);
  ttsAudioCache.set(cacheKey, {
    ...entry,
    audio: Buffer.from(entry.audio),
  });
  while (ttsAudioCache.size > TTS_CACHE_LIMIT) {
    const oldestKey = ttsAudioCache.keys().next().value;
    if (!oldestKey) break;
    ttsAudioCache.delete(oldestKey);
  }
}

function clearTtsCache() {
  ttsAudioCache.clear();
}

function getTtsCacheStats() {
  return {
    limit: TTS_CACHE_LIMIT,
    size: ttsAudioCache.size,
  };
}

function asTtsError(error, fallbackMessage = '语音合成失败，请稍后重试。', fallbackCode = 'TTS_FAILED') {
  if (error instanceof TtsError) return error;
  const message = String(error?.message || '');
  if (/401|403|auth|access|permission|resource|grant|credential|key|token/i.test(message)) {
    return new TtsError('TTS 鉴权或资源授权失败，请检查后端凭据配置。', {
      code: 'TTS_AUTH_FAILED',
      status: 502,
      logId: error?.logId || '',
    });
  }
  if (/timeout|aborted|超时/i.test(message)) {
    return new TtsError('TTS 服务响应超时，请稍后重试。', {
      code: 'TTS_TIMEOUT',
      status: 504,
      logId: error?.logId || '',
    });
  }
  return new TtsError(fallbackMessage, { code: fallbackCode, status: 500, logId: error?.logId || '' });
}

function parseTtsLine(line, logId = '') {
  try {
    return JSON.parse(line);
  } catch {
    throw new TtsError('TTS 服务返回了无法解析的数据。', {
      code: 'TTS_BAD_RESPONSE',
      status: 502,
      logId,
    });
  }
}

async function synthesizeSpeech({ user, text, voice = DEFAULT_VOICE, format = DEFAULT_FORMAT } = {}) {
  const safeText = normalizeText(text);
  if (!safeText) {
    throw new TtsError('播报文本为空。', { code: 'TTS_TEXT_EMPTY', status: 400 });
  }

  const credentials = resolveCredentials(user);
  if (!credentials.appId || !credentials.accessToken) {
    throw new TtsError('TTS 凭据未配置。', { code: 'TTS_NOT_CONFIGURED', status: 503 });
  }

  const requestId = crypto.randomUUID();
  const safeVoice = normalizeVoice(voice);
  const safeFormat = normalizeFormat(format);
  const cacheKey = buildTtsCacheKey({
    credentials,
    text: safeText,
    voice: safeVoice,
    format: safeFormat,
  });
  const cached = getCachedSpeech(cacheKey);
  if (cached) {
    return {
      ...cached,
      request_id: requestId,
      text: safeText,
      voice: safeVoice,
      cache_hit: true,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(credentials.endpoint || DEFAULT_ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Api-App-Key': credentials.appId,
        'X-Api-Access-Key': credentials.accessToken,
        'X-Api-Resource-Id': credentials.resourceId || DEFAULT_RESOURCE_ID,
        'X-Api-Request-Id': requestId,
      },
      body: JSON.stringify({
        user: {
          uid: `mobius-assistant-tts-${user?.id || 'anonymous'}`,
        },
        req_params: {
          speaker: safeVoice,
          audio_params: {
            format: safeFormat,
            sample_rate: DEFAULT_SAMPLE_RATE,
          },
          text: safeText,
        },
      }),
    });
  } catch (error) {
    clearTimeout(timer);
    throw asTtsError(error);
  }
  clearTimeout(timer);

  const logId = response.headers.get('x-tt-logid') || response.headers.get('x-tt-log-id') || '';
  const raw = await response.text();
  if (!response.ok) {
    throw new TtsError('TTS 服务请求失败。', {
      code: response.status === 401 || response.status === 403 ? 'TTS_AUTH_FAILED' : 'TTS_PROVIDER_FAILED',
      status: response.status === 401 || response.status === 403 ? 502 : 502,
      logId,
    });
  }

  const audioChunks = [];
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) {
    throw new TtsError('TTS 服务没有返回音频数据。', {
      code: 'TTS_EMPTY_AUDIO',
      status: 502,
      logId,
    });
  }

  for (const line of lines) {
    const frame = parseTtsLine(line, logId);
    const code = Number(frame?.code ?? 0);
    if (code === 20000000) continue;
    if (code !== 0) {
      throw new TtsError(frame?.message || 'TTS 服务返回错误。', {
        code: 'TTS_PROVIDER_FAILED',
        status: 502,
        logId,
      });
    }
    if (typeof frame?.data === 'string' && frame.data) {
      audioChunks.push(Buffer.from(frame.data, 'base64'));
    }
  }

  const audio = Buffer.concat(audioChunks);
  if (audio.length === 0) {
    throw new TtsError('TTS 服务没有返回音频数据。', {
      code: 'TTS_EMPTY_AUDIO',
      status: 502,
      logId,
    });
  }

  const result = {
    audio,
    mimeType: safeFormat === 'wav' ? 'audio/wav' : 'audio/mpeg',
    request_id: requestId,
    provider_log_id: logId,
    text: safeText,
    voice: safeVoice,
    cache_hit: false,
  };
  setCachedSpeech(cacheKey, {
    audio: result.audio,
    mimeType: result.mimeType,
    provider_log_id: result.provider_log_id,
  });
  return result;
}

function isDoubaoTtsConfigured() {
  const { appId, accessToken } = resolveCredentials();
  return !!(appId && accessToken);
}

module.exports = {
  DEFAULT_VOICE,
  TTS_CACHE_LIMIT,
  TtsError,
  asTtsError,
  clearTtsCache,
  getTtsCacheStats,
  getTtsVoices,
  isDoubaoTtsConfigured,
  synthesizeSpeech,
};
