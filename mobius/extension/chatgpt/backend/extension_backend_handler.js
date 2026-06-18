const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const agents = require('../../../backend/agents');
const modelRegistry = require('../../../backend/services/model-registry');
const { createExtensionAnalysisSession } = require('../../../backend/services/extension-agent-bridge');
const { Sessions } = require('../../../backend/repositories/sessions');
const { Messages } = require('../../../backend/repositories/messages');
const { transcribeAudioFile, AsrError } = require('../../../backend/services/doubao-asr');

const STATE_FILE = 'state.json';
const MAX_CONVERSATIONS = 200;
const MAX_MESSAGE_CHARS = 12000;
const MAX_ATTACHMENTS = 6;
const DEFAULT_MODEL = 'codex';
const EXTENSION_DISPLAY_NAME = 'ChatGPT 纯对话';
const SYSTEM_PROMPT = [
  '你是一个纯对话助手。',
  '请直接回答用户问题，不展示工具调用、token 统计、event 元数据或内部执行细节。',
  '如果用户要求代码、表格或结构化内容，可以正常使用 Markdown。',
  '除非用户明确要求操作本机项目，否则不要主动编辑文件、运行命令或创建项目任务。',
].join('\n');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function safeUserSegment(value) {
  return String(value || 'unknown').replace(/[^A-Za-z0-9_.@-]/g, '_').slice(0, 120) || 'unknown';
}

function cleanConversationId(value) {
  const raw = String(value || '').trim();
  if (/^[A-Za-z0-9_-]{1,80}$/.test(raw)) return raw;
  return crypto.randomBytes(8).toString('hex');
}

function cleanText(value, max = MAX_MESSAGE_CHARS) {
  return String(value || '').replace(/\r\n/g, '\n').trim().slice(0, max);
}

function isPathInside(root, target) {
  const base = path.resolve(root);
  const abs = path.resolve(target);
  return abs === base || abs.startsWith(base + path.sep);
}

function cleanAttachmentName(value, fallback = '附件') {
  const base = path.basename(String(value || fallback)).replace(/[^\w\u4e00-\u9fff .@()+,-]/g, '_').trim();
  return (base || fallback).slice(0, 180);
}

function normalizeUploadedFile(file, extDataDir, username) {
  if (!file || typeof file !== 'object') return null;
  const rawPath = typeof file.path === 'string' ? file.path.trim() : '';
  if (!rawPath || !path.isAbsolute(rawPath)) return null;
  const absPath = path.resolve(rawPath);
  const uploadRoot = path.resolve(extDataDir, 'users', safeUserSegment(username), 'uploads');
  if (!isPathInside(uploadRoot, absPath)) return null;
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  return {
    path: absPath,
    name: cleanAttachmentName(file.name || file.original_name || path.basename(absPath)),
    size: Number(file.size || stat.size || 0),
    mime_type: typeof file.mime_type === 'string' ? file.mime_type : '',
  };
}

function normalizeAttachments(raw, extDataDir, username) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (out.length >= MAX_ATTACHMENTS) break;
    const file = normalizeUploadedFile(item, extDataDir, username);
    if (!file || seen.has(file.path)) continue;
    const requestedType = item?.type === 'image' ? 'image' : 'file';
    const ext = path.extname(file.path).toLowerCase();
    const imageByExt = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']).has(ext);
    out.push({
      ...file,
      type: imageByExt || requestedType === 'image' ? 'image' : 'file',
    });
    seen.add(file.path);
  }
  return out;
}

function attachmentPromptBlock(attachments) {
  const files = Array.isArray(attachments) ? attachments.filter((item) => item?.path) : [];
  if (!files.length) return '';
  return [
    '用户随本轮消息上传了以下附件。你可以直接读取这些本机绝对路径来理解内容；图片需要向用户展示时可使用 `display_images <图片路径>`。',
    ...files.map((file, index) => {
      const kind = file.type === 'image' ? '图片' : '文件';
      const label = file.name ? ` (${file.name})` : '';
      return `${index + 1}. [${kind}] ${file.path}${label}`;
    }),
  ].join('\n');
}

function userStatePath(extDataDir, username) {
  return path.join(extDataDir, 'users', safeUserSegment(username), STATE_FILE);
}

function readState(extDataDir, username) {
  const file = userStatePath(extDataDir, username);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : { conversations: {} };
  } catch {
    return { conversations: {} };
  }
}

function writeState(extDataDir, username, state) {
  const file = userStatePath(extDataDir, username);
  ensureDir(path.dirname(file));
  const conversations = state.conversations && typeof state.conversations === 'object'
    ? state.conversations
    : {};
  const entries = Object.entries(conversations)
    .sort((a, b) => String(b[1]?.updated_at || '').localeCompare(String(a[1]?.updated_at || '')))
    .slice(0, MAX_CONVERSATIONS);
  fs.writeFileSync(file, `${JSON.stringify({ conversations: Object.fromEntries(entries) }, null, 2)}\n`, 'utf8');
}

function contentBlocksText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (!block || typeof block !== 'object') return String(block ?? '');
    if (block.type && block.type !== 'text' && block.type !== 'output_text') return '';
    if (typeof block.text === 'string') return block.text;
    if (typeof block.output_text === 'string') return block.output_text;
    return '';
  }).filter(Boolean).join('\n');
}

function assistantTextsFromEntry(entry) {
  if (!entry || typeof entry !== 'object') return [];
  if (entry.type === 'assistant') {
    const message = entry.message || {};
    if (message.role && message.role !== 'assistant') return [];
    const text = contentBlocksText(message.content).trim();
    return text ? [text] : [];
  }
  if (entry.type === 'response_item') {
    const payload = entry.payload || {};
    if (payload.type === 'message' && payload.role === 'assistant') {
      const text = contentBlocksText(payload.content).trim();
      return text ? [text] : [];
    }
    if ((payload.type === 'output_text' || payload.type === 'text') && typeof payload.text === 'string') {
      const text = payload.text.trim();
      return text ? [text] : [];
    }
  }
  if (entry.role === 'assistant' && typeof entry.content === 'string') {
    const text = entry.content.trim();
    return text ? [text] : [];
  }
  return [];
}

function extractAssistantResponses(entries) {
  const responses = [];
  let previous = '';
  for (const entry of Array.isArray(entries) ? entries : []) {
    for (const text of assistantTextsFromEntry(entry)) {
      const normalized = text.replace(/\s+/g, ' ').trim();
      if (!normalized || normalized === previous) continue;
      previous = normalized;
      responses.push({
        content: text,
        created_at: entry?.timestamp || entry?.created_at || entry?.payload?.timestamp || null,
      });
    }
  }
  return responses;
}

function modelOptions() {
  const options = modelRegistry.listSessionModelOptions();
  if (options.length) return options;
  return [{
    key: DEFAULT_MODEL,
    value: DEFAULT_MODEL,
    label: 'GPT-5.5 (Codex)',
    title: 'GPT-5.5',
    sub: 'Codex',
    backend: 'tmux-codex',
    imported: false,
  }];
}

function resolveModelKey(model) {
  const raw = String(model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const resolved = modelRegistry.resolveSessionModelForCreate(raw) || modelRegistry.resolveSessionModelForCreate(DEFAULT_MODEL);
  if (!resolved) throw new Error(`模型未配置或配置文件缺失: ${raw}`);
  return resolved.key || raw;
}

function publicStatus(backend, sessionId) {
  let alive = false;
  let working = false;
  let failed = false;
  try { alive = !!backend.isAlive(sessionId); } catch {}
  try { working = alive && !!backend.isWorking(sessionId); } catch {}
  try { failed = !!backend.isFailed(sessionId); } catch {}
  return { alive, working, failed };
}

function backendForConversation(conversation) {
  if (!conversation?.session_id) return null;
  try {
    const launch = modelRegistry.launchOptionsForSession({ model: conversation.model || DEFAULT_MODEL });
    return agents.get(launch.backend);
  } catch {
    return null;
  }
}

function responseCountForConversation(conversation) {
  const backend = backendForConversation(conversation);
  if (!backend || !conversation?.session_id) return 0;
  try {
    const history = backend.getHistory(conversation.session_id, { tailCount: 160 }) || {};
    return extractAssistantResponses(history.entries || []).length;
  } catch {
    return 0;
  }
}

function shapeConversation(conversation, backend = null) {
  if (!conversation) return null;
  const status = backend && conversation.session_id
    ? publicStatus(backend, conversation.session_id)
    : { alive: false, working: false, failed: false };
  return {
    id: conversation.id,
    session_id: conversation.session_id || '',
    issue_id: conversation.issue_id || '',
    project_id: conversation.project_id || '',
    title: conversation.title || '新对话',
    model: conversation.model || DEFAULT_MODEL,
    model_label: modelRegistry.labelForSessionModel(conversation.model) || conversation.model || '',
    created_at: conversation.created_at || null,
    updated_at: conversation.updated_at || null,
    status,
  };
}

function getConversation({ extDataDir, username, conversationId, model }) {
  const state = readState(extDataDir, username);
  const id = cleanConversationId(conversationId);
  let conversation = state.conversations[id];
  if (!conversation) {
    const now = new Date().toISOString();
    conversation = {
      id,
      title: '新对话',
      model: resolveModelKey(model || DEFAULT_MODEL),
      session_id: '',
      issue_id: '',
      project_id: '',
      created_at: now,
      updated_at: now,
    };
    state.conversations[id] = conversation;
    writeState(extDataDir, username, state);
  }
  return { state, conversation };
}

function buildPrompt({ message, history, firstTurn, attachments = [] }) {
  const safeHistory = Array.isArray(history) ? history.slice(-20) : [];
  const historyText = safeHistory
    .filter((item) => item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string')
    .map((item) => `${item.role === 'user' ? '用户' : '助手'}: ${item.content.slice(0, MAX_MESSAGE_CHARS)}`)
    .join('\n\n');
  const parts = [];
  if (firstTurn) parts.push(SYSTEM_PROMPT);
  if (historyText) {
    parts.push('以下是浏览器本地保存的近期对话上下文，仅用于补全当前轮语境：');
    parts.push(historyText);
  }
  const attachmentBlock = attachmentPromptBlock(attachments);
  if (attachmentBlock) parts.push(attachmentBlock);
  parts.push('请只回复下面这一轮用户消息：');
  parts.push(message);
  return parts.join('\n\n');
}

function ensureMobiusSession({ username, conversation }) {
  if (conversation.session_id) return null;
  const created = createExtensionAnalysisSession({
    userId: username,
    extensionName: 'chatgpt',
    extensionDisplayName: EXTENSION_DISPLAY_NAME,
    projectDescription: 'ChatGPT 纯对话拓展的后台会话工作区。',
    issueTitle: 'ChatGPT 纯对话',
    issueDescription: '由 chatgpt 拓展自动创建，用于承载纯对话模型调用。',
    sessionName: `ChatGPT 对话：${conversation.title || conversation.id}`,
    sessionDescription: SYSTEM_PROMPT,
    model: conversation.model || DEFAULT_MODEL,
    language: 'zh',
    excludedSkillIds: [],
    excludedMemoryIds: [],
  });
  conversation.project_id = created.project?.id || '';
  conversation.issue_id = created.issue?.id || '';
  conversation.session_id = created.session?.session_id || '';
  return created;
}

function sendMessage({ extDataDir, username, payload }) {
  const message = cleanText(payload.message);
  const attachments = normalizeAttachments(payload.attachments, extDataDir, username);
  if (!message && attachments.length === 0) return { ok: false, error: '消息不能为空' };

  const { state, conversation } = getConversation({
    extDataDir,
    username,
    conversationId: payload.conversation_id,
    model: payload.model,
  });
  const requestedModel = resolveModelKey(payload.model || conversation.model || DEFAULT_MODEL);
  if (conversation.session_id && requestedModel !== conversation.model) {
    return { ok: false, error: '当前对话已经绑定模型。请新建对话后切换模型。' };
  }
  conversation.model = requestedModel;
  if (conversation.title === '新对话') {
    conversation.title = message.replace(/\s+/g, ' ').slice(0, 40) || attachments[0]?.name || '新对话';
  }

  const beforeResponseCount = responseCountForConversation(conversation);
  const created = ensureMobiusSession({ username, conversation });
  conversation.updated_at = new Date().toISOString();
  state.conversations[conversation.id] = conversation;
  writeState(extDataDir, username, state);

  const prompt = buildPrompt({
    message,
    history: payload.history,
    firstTurn: !!created,
    attachments,
  });

  return {
    ok: true,
    __mobius_post_actions: [{
      type: 'session_message',
      session_id: conversation.session_id,
      content: prompt,
      input_text: message,
      request_id: String(payload.request_id || `chatgpt-${Date.now()}`),
      source: 'extension.chatgpt.send_message',
      result_key: 'backend_start',
    }],
    conversation: shapeConversation(conversation),
    created_session: created || null,
    backend_start: null,
    before_response_count: beforeResponseCount,
    attachments,
  };
}

async function stopGeneration({ extDataDir, username, payload }) {
  const { conversation } = getConversation({
    extDataDir,
    username,
    conversationId: payload.conversation_id,
    model: payload.model,
  });
  if (!conversation.session_id) return { ok: true, stopped: false, message: '当前对话还没有后台会话。' };
  const backend = backendForConversation(conversation);
  if (!backend) return { ok: false, error: '当前模型后端不可用' };
  let wasAlive = false;
  let wasWorking = false;
  try { wasAlive = !!backend.isAlive(conversation.session_id); } catch {}
  try { wasWorking = wasAlive && !!backend.isWorking(conversation.session_id); } catch {}
  try {
    await backend.pauseCurrentAndResumeFromSession({
      sessionId: conversation.session_id,
      prompt: '',
    });
  } catch (e) {
    return { ok: false, error: e.message || '停止失败' };
  }
  try { Sessions.setIdle(conversation.session_id, username); } catch {}
  try { Messages.insertSystem(conversation.session_id, '已从 chatgpt 拓展发出停止请求。', null, '终止执行'); } catch {}
  return {
    ok: true,
    stopped: true,
    conversation: shapeConversation(conversation),
    status: { alive: wasAlive, working: wasWorking, failed: false },
  };
}

async function transcribeUploadedAudio({ extDataDir, username, payload }) {
  const file = normalizeUploadedFile(payload.file, extDataDir, username);
  if (!file) return { ok: false, error: '录音文件不可用，请重新录制。' };
  try {
    const result = await transcribeAudioFile(file.path, { user: { id: username } });
    return {
      ok: true,
      text: result.text,
      alternatives: result.alternatives || [],
      request_id: result.request_id,
      ...(result.provider_log_id ? { provider_log_id: result.provider_log_id } : {}),
    };
  } catch (error) {
    const status = error instanceof AsrError ? error.status || 500 : 500;
    return {
      ok: false,
      code: error.code || 'ASR_FAILED',
      status,
      error: error.publicMessage || error.message || '语音识别失败，请稍后重试。',
      ...(error.provider_log_id ? { provider_log_id: error.provider_log_id } : {}),
    };
  }
}

function pollConversation({ extDataDir, username, payload }) {
  const { conversation } = getConversation({
    extDataDir,
    username,
    conversationId: payload.conversation_id,
    model: payload.model,
  });
  if (!conversation.session_id) {
    return {
      ok: true,
      conversation: shapeConversation(conversation),
      latest_response: null,
      responses: [],
      response_count: 0,
      status: { alive: false, working: false, failed: false },
      jsonl: { total: 0, truncated: false },
    };
  }
  const backend = backendForConversation(conversation);
  if (!backend) {
    return {
      ok: true,
      conversation: shapeConversation(conversation),
      latest_response: null,
      responses: [],
      response_count: 0,
      status: { alive: false, working: false, failed: true },
      jsonl: { total: 0, truncated: false },
    };
  }
  const history = backend.getHistory(conversation.session_id, { tailCount: 120 }) || {};
  const responses = extractAssistantResponses(history.entries || []);
  const status = publicStatus(backend, conversation.session_id);
  return {
    ok: true,
    conversation: shapeConversation(conversation, backend),
    latest_response: responses.length ? responses[responses.length - 1] : null,
    responses,
    response_count: responses.length,
    status,
    jsonl: {
      total: history.total || 0,
      truncated: !!history.truncated,
    },
  };
}

function listConversations({ extDataDir, username }) {
  const state = readState(extDataDir, username);
  const conversations = Object.values(state.conversations || {})
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    .map((conversation) => shapeConversation(conversation));
  return { ok: true, conversations };
}

function resetConversation({ extDataDir, username, payload }) {
  const id = cleanConversationId(payload.conversation_id);
  const state = readState(extDataDir, username);
  delete state.conversations[id];
  writeState(extDataDir, username, state);
  return { ok: true, removed_id: id };
}

module.exports = async function chatgptExtensionHandler({
  username,
  display_name,
  ext_main_payload,
  extension_name,
  ext_data_dir,
}) {
  const payload = ext_main_payload && typeof ext_main_payload === 'object' ? ext_main_payload : {};
  const action = String(payload.action || 'health');

  if (action === 'health') {
    return { ok: true, extension_name, username, display_name };
  }

  if (action === 'model_options' || action === 'list_models') {
    return {
      ok: true,
      default_model: DEFAULT_MODEL,
      models: modelOptions(),
    };
  }

  if (action === 'list_conversations') {
    return listConversations({ extDataDir: ext_data_dir, username });
  }

  if (action === 'send_message') {
    return sendMessage({ extDataDir: ext_data_dir, username, payload });
  }

  if (action === 'stop_generation') {
    return stopGeneration({ extDataDir: ext_data_dir, username, payload });
  }

  if (action === 'transcribe_audio') {
    return transcribeUploadedAudio({ extDataDir: ext_data_dir, username, payload });
  }

  if (action === 'poll') {
    return pollConversation({ extDataDir: ext_data_dir, username, payload });
  }

  if (action === 'reset_conversation') {
    return resetConversation({ extDataDir: ext_data_dir, username, payload });
  }

  return { ok: false, error: '未知操作' };
};
