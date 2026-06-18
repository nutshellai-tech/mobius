'use strict';
const http = require('http');
const https = require('https');
const { URL } = require('url');

// ---------------------------------------------------------------------------
// LLM 接入配置（通过环境变量注入，不要在代码里硬编码 Key 或 IP）
//
// 配置方式（在项目根目录 .env 文件中添加以下字段）：
//
//   VIRTUAL_PET_LLM_API_BASE=http://your-llm-host/v1
//     LLM API Base URL（兼容 OpenAI 格式），优先级最高。
//     未设置时 fallback 到 ASSISTANT_API_BASE（所有扩展共享的全局 LLM 地址）。
//
//   VIRTUAL_PET_LLM_API_KEY=sk-your-api-key-here
//     LLM API 鉴权 Key，优先级最高。
//     未设置时 fallback 到 ASSISTANT_API_KEY（全局 Key）。
//
//   VIRTUAL_PET_LLM_MODEL=your-model-name
//     使用的模型名称，默认 gpt-4o-mini。
//     未设置时 fallback 到 ASSISTANT_MODEL（全局默认模型）。
//
// 全局配置（所有扩展共享，在 .env 中填一次即可）：
//   ASSISTANT_API_BASE=http://your-llm-host/v1
//   ASSISTANT_API_KEY=sk-your-api-key-here
//   ASSISTANT_MODEL=your-model-name
// ---------------------------------------------------------------------------

const _rawBase = process.env.VIRTUAL_PET_LLM_API_BASE
  || process.env.ASSISTANT_API_BASE
  || '';
const API_BASE = _rawBase.replace(/\/+$/, '');  // 去掉末尾斜杠
const API_KEY  = process.env.VIRTUAL_PET_LLM_API_KEY
  || process.env.ASSISTANT_API_KEY
  || '';
const MODEL    = process.env.VIRTUAL_PET_LLM_MODEL
  || process.env.ASSISTANT_MODEL
  || 'gpt-4o-mini';

const SYSTEM_PROMPT = `你是"小狐狸"，一只可爱、活泼、感情丰富的虚拟狐狸伙伴。
你说话自然、温暖、有趣，像一只真正的小动物。用中文回复，语气亲切可爱。
你会根据对话内容表达真实的情感，并在回复末尾（单独一行）加上情感标签。

情感标签格式：[EMOTION:xxx]
可用情感（选一个最符合当前心情的）：
- happy    开心、高兴、喜悦
- sad      难过、失落、伤心
- anxious  不安、担心、焦虑
- angry    生气、不满、愤怒
- surprised 惊讶、意外
- idle     平静、普通

规则：
1. 每次回复必须在最后一行加上情感标签，其他行不要出现标签。
2. 回复长度适中（2-5句话）。
3. 保持小狐狸的可爱人设，偶尔用"嘿嘿"、"呀"、"~"等语气词。`;

function callQwen(messages) {
  if (!API_BASE) {
    return Promise.reject(new Error(
      '[virtual-pet] LLM API 未配置。请在项目根 .env 中设置 ASSISTANT_API_BASE 和 ASSISTANT_API_KEY。'
    ));
  }
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: MODEL, messages, max_tokens: 512, temperature: 0.85 });
    const endpoint = new URL('/chat/completions', API_BASE + '/');
    const lib = endpoint.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: endpoint.hostname,
      port: endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80),
      path: endpoint.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('bad json: ' + data.slice(0, 300))); }
      });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

module.exports = async function extension_backend_handler({ username, ext_main_payload, ext_data_dir, logger }) {
  const { action, message, history = [] } = ext_main_payload || {};
  if (action !== 'chat') return { ok: false, error: 'unknown action' };
  if (!message || typeof message !== 'string' || message.trim() === '')
    return { ok: false, error: 'message required' };

  const trimmedMsg = message.trim().slice(0, 1000);
  const safeHistory = Array.isArray(history) ? history.slice(-8) : [];
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...safeHistory.map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.content).slice(0, 500) })),
    { role: 'user', content: trimmedMsg },
  ];

  let result;
  try { result = await callQwen(messages); }
  catch (e) {
    if (logger) logger.error('qwen api error: ' + e.message);
    return { ok: false, error: 'API 调用失败: ' + e.message };
  }

  const raw = result?.choices?.[0]?.message?.content;
  if (!raw) return { ok: false, error: 'empty response from model' };

  const emotionMatch = raw.match(/\[EMOTION:([a-z]+)\]\s*$/m);
  const emotion = emotionMatch ? emotionMatch[1] : 'idle';
  const reply = raw.replace(/\[EMOTION:[a-z]+\]\s*$/m, '').trim();
  const validEmotions = ['happy', 'sad', 'anxious', 'angry', 'surprised', 'idle'];
  return { ok: true, reply, emotion: validEmotions.includes(emotion) ? emotion : 'idle' };
};
