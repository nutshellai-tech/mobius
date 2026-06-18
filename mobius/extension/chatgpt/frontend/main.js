import { extCall, extUpload } from '/extension/_sdk/ext.js';

const STORAGE_KEY = 'mobius-ext-chatgpt-state-v1';
const POLL_INTERVAL_MS = 1800;
const POLL_TIMEOUT_MS = 180000;
const MAX_ATTACHMENTS = 6;
const VOICE_RECORDING_MAX_MS = 60000;

const els = {
  newChatBtn: document.getElementById('newChatBtn'),
  conversationList: document.getElementById('conversationList'),
  chatTitle: document.getElementById('chatTitle'),
  chatMeta: document.getElementById('chatMeta'),
  modelSelect: document.getElementById('modelSelect'),
  clearBtn: document.getElementById('clearBtn'),
  messages: document.getElementById('messages'),
  composer: document.getElementById('composer'),
  attachmentList: document.getElementById('attachmentList'),
  fileInput: document.getElementById('fileInput'),
  attachBtn: document.getElementById('attachBtn'),
  voiceBtn: document.getElementById('voiceBtn'),
  messageInput: document.getElementById('messageInput'),
  sendBtn: document.getElementById('sendBtn'),
  toast: document.getElementById('toast'),
};

let state = loadState();
let models = [];
let defaultModel = 'codex';
let sending = false;
let pollTimer = null;
let attachments = [];
let voiceState = 'idle';
let mediaRecorder = null;
let voiceChunks = [];
let voiceStopTimer = null;
let voiceStream = null;

function newId(prefix = 'c') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (parsed && typeof parsed === 'object') {
      return {
        activeId: parsed.activeId || '',
        conversations: parsed.conversations && typeof parsed.conversations === 'object' ? parsed.conversations : {},
      };
    }
  } catch {}
  return { activeId: '', conversations: {} };
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function activeConversation() {
  if (!state.activeId || !state.conversations[state.activeId]) {
    createConversation();
  }
  return state.conversations[state.activeId];
}

function createConversation() {
  stopPolling();
  sending = false;
  clearAttachments();
  const id = newId();
  state.activeId = id;
  state.conversations[id] = {
    id,
    title: '新对话',
    model: els.modelSelect.value || defaultModel,
    messages: [],
    responseCount: 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  saveState();
  render();
}

function showToast(message, error = false) {
  els.toast.textContent = message;
  els.toast.classList.toggle('error', error);
  els.toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => els.toast.classList.remove('show'), 2600);
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function formatDate(value) {
  const d = value ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatSize(bytes) {
  const size = Number(bytes || 0);
  if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)} MB`;
  if (size >= 1024) return `${Math.round(size / 1024)} KB`;
  return `${size || 0} B`;
}

function modelLabel(key) {
  const found = models.find((item) => item.key === key || item.value === key || item.model === key);
  return found?.label || found?.title || key || '';
}

function renderModelOptions() {
  els.modelSelect.innerHTML = models.map((model) => {
    const value = model.key || model.value || model.model;
    const label = model.title || model.label || value;
    const sub = model.sub ? ` · ${model.sub}` : '';
    return `<option value="${escapeHtml(value)}">${escapeHtml(label + sub)}</option>`;
  }).join('');
  if (!els.modelSelect.value && defaultModel) els.modelSelect.value = defaultModel;
}

function renderConversationList() {
  const items = Object.values(state.conversations)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  if (!items.length) {
    els.conversationList.innerHTML = '<div class="conversation-item"><strong>暂无对话</strong><span>点击新对话开始</span></div>';
    return;
  }
  els.conversationList.innerHTML = items.map((item) => `
    <button class="conversation-item${item.id === state.activeId ? ' active' : ''}" type="button" data-id="${escapeHtml(item.id)}">
      <strong>${escapeHtml(item.title || '新对话')}</strong>
      <span>${escapeHtml(modelLabel(item.model))}${item.updatedAt ? ` · ${escapeHtml(formatDate(item.updatedAt))}` : ''}</span>
    </button>
  `).join('');
}

function renderAttachmentSummary(list = []) {
  if (!Array.isArray(list) || list.length === 0) return '';
  return `
    <div class="message-attachments">
      ${list.map((item) => `
        <div class="message-attachment">
          ${item.type === 'image' && item.previewUrl ? `<img src="${escapeHtml(item.previewUrl)}" alt="">` : '<span class="message-attachment-icon">file</span>'}
          <span>${escapeHtml(item.name || '附件')}</span>
        </div>
      `).join('')}
    </div>
  `;
}

function renderMessages() {
  const conversation = activeConversation();
  if (!conversation.messages.length) {
    els.messages.innerHTML = '<div class="empty-state">开始一段纯对话。这里不会展示工具调用、token 统计或事件元数据。</div>';
    return;
  }
  els.messages.innerHTML = conversation.messages.map((message) => `
    <div class="message-row ${message.role}${message.pending ? ' pending' : ''}">
      <div class="bubble">
        ${renderAttachmentSummary(message.attachments)}
        ${message.content ? `<div>${escapeHtml(message.content)}</div>` : ''}
      </div>
    </div>
  `).join('');
  els.messages.scrollTop = els.messages.scrollHeight;
}

function attachmentStatusText(item) {
  if (item.status === 'uploading') return '上传中';
  if (item.status === 'error') return item.error || '上传失败';
  return formatSize(item.size);
}

function renderAttachments() {
  if (!attachments.length) {
    els.attachmentList.innerHTML = '';
    els.attachmentList.hidden = true;
    return;
  }
  els.attachmentList.hidden = false;
  els.attachmentList.innerHTML = attachments.map((item) => `
    <div class="attachment-chip ${item.status === 'error' ? 'error' : ''}" data-id="${escapeHtml(item.id)}">
      <div class="attachment-preview">
        ${item.type === 'image' && item.previewUrl ? `<img src="${escapeHtml(item.previewUrl)}" alt="">` : '<span>file</span>'}
      </div>
      <div class="attachment-meta">
        <strong>${escapeHtml(item.name)}</strong>
        <span>${escapeHtml(attachmentStatusText(item))}</span>
      </div>
      <button type="button" class="attachment-remove" data-remove-attachment="${escapeHtml(item.id)}" aria-label="移除附件">x</button>
    </div>
  `).join('');
}

function canSend() {
  const text = els.messageInput.value.trim();
  const hasUploading = attachments.some((item) => item.status === 'uploading');
  const hasReadyAttachment = attachments.some((item) => item.status === 'done' && item.remotePath);
  return !sending && !hasUploading && voiceState !== 'transcribing' && (text || hasReadyAttachment);
}

function render() {
  const conversation = activeConversation();
  els.chatTitle.textContent = conversation.title || '新对话';
  els.chatMeta.textContent = `${modelLabel(conversation.model)} · ${conversation.messages.length} 条本地消息`;
  if (conversation.model && els.modelSelect.value !== conversation.model) {
    els.modelSelect.value = conversation.model;
  }
  els.modelSelect.disabled = conversation.messages.length > 0 || sending;
  els.clearBtn.disabled = sending;
  els.attachBtn.disabled = sending || attachments.length >= MAX_ATTACHMENTS;
  els.voiceBtn.disabled = sending || voiceState === 'transcribing';
  els.voiceBtn.textContent = voiceState === 'recording' ? '停止录音' : voiceState === 'transcribing' ? '识别中' : '语音';
  els.voiceBtn.classList.toggle('recording', voiceState === 'recording');
  els.sendBtn.disabled = sending ? false : !canSend();
  els.sendBtn.textContent = sending ? '停止' : '发送';
  els.sendBtn.classList.toggle('stop', sending);
  renderConversationList();
  renderMessages();
  renderAttachments();
}

function appendMessage(role, content, extra = {}) {
  const conversation = activeConversation();
  conversation.messages.push({
    id: `${role}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    role,
    content,
    createdAt: nowIso(),
    ...extra,
  });
  conversation.updatedAt = nowIso();
  if (role === 'user' && conversation.title === '新对话') {
    const firstAttachment = Array.isArray(extra.attachments) ? extra.attachments[0] : null;
    conversation.title = content.replace(/\s+/g, ' ').slice(0, 40) || firstAttachment?.name || '新对话';
  }
  saveState();
  render();
}

function replacePendingAssistant(content) {
  const conversation = activeConversation();
  const pending = [...conversation.messages].reverse().find((message) => message.role === 'assistant' && message.pending);
  if (pending) {
    pending.content = content;
    pending.pending = false;
    pending.createdAt = nowIso();
  } else {
    appendMessage('assistant', content);
  }
  conversation.updatedAt = nowIso();
  saveState();
  render();
}

function removePendingAssistant(replacement = '') {
  const conversation = activeConversation();
  const pending = [...conversation.messages].reverse().find((message) => message.role === 'assistant' && message.pending);
  if (pending && replacement) {
    pending.content = replacement;
    pending.pending = false;
  } else {
    conversation.messages = conversation.messages.filter((message) => !(message.role === 'assistant' && message.pending));
  }
  saveState();
  render();
}

function autosizeTextarea() {
  els.messageInput.style.height = 'auto';
  els.messageInput.style.height = `${Math.min(180, els.messageInput.scrollHeight)}px`;
}

async function loadModels() {
  try {
    let data;
    try {
      data = await extCall({ action: 'model_options' });
    } catch (error) {
      data = await extCall({ action: 'list_models' });
    }
    models = Array.isArray(data.models) ? data.models : [];
    defaultModel = data.default_model || 'codex';
    if (!models.length) models = [{ key: defaultModel, label: defaultModel, title: defaultModel }];
    renderModelOptions();
  } catch (error) {
    models = [{ key: 'codex', label: 'GPT-5.5 (Codex)', title: 'GPT-5.5 (Codex)' }];
    defaultModel = 'codex';
    renderModelOptions();
    showToast(error.message || '模型列表加载失败', true);
  }
}

async function syncServerConversations() {
  try {
    await extCall({ action: 'list_conversations' });
  } catch {
    // 本地历史可独立工作，后台列表同步失败不阻断页面。
  }
}

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
}

function startPolling(conversationId, baselineCount, startedAt) {
  stopPolling();
  const tick = async () => {
    if (state.activeId !== conversationId) return;
    try {
      const conversation = activeConversation();
      const data = await extCall({
        action: 'poll',
        conversation_id: conversation.id,
        model: conversation.model,
      });
      const latest = data.latest_response;
      const count = Number(data.response_count || 0);
      if (latest?.content && count > baselineCount) {
        conversation.responseCount = count;
        replacePendingAssistant(latest.content);
        sending = false;
        render();
        return;
      }
      if (data.status?.failed) {
        removePendingAssistant();
        sending = false;
        showToast('模型调用失败，请稍后重试', true);
        render();
        return;
      }
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        removePendingAssistant();
        sending = false;
        showToast('等待回复超时，可稍后刷新或重试', true);
        render();
        return;
      }
      pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
    } catch (error) {
      if (Date.now() - startedAt > POLL_TIMEOUT_MS) {
        removePendingAssistant();
        sending = false;
        showToast(error.message || '轮询失败', true);
        render();
      } else {
        pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
      }
    }
  };
  pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
}

function readyAttachmentsForPayload() {
  return attachments
    .filter((item) => item.status === 'done' && item.remotePath)
    .map((item) => ({
      type: item.type === 'image' ? 'image' : 'file',
      path: item.remotePath,
      name: item.name,
      size: item.size,
      mime_type: item.mimeType || '',
    }));
}

function attachmentsForMessage() {
  return attachments
    .filter((item) => item.status === 'done' && item.remotePath)
    .map((item) => ({
      type: item.type,
      name: item.name,
      size: item.size,
      previewUrl: item.previewUrl || '',
    }));
}

async function sendCurrentMessage(event) {
  event?.preventDefault?.();
  if (sending) {
    await stopCurrentGeneration();
    return;
  }
  if (!canSend()) return;

  const text = els.messageInput.value.trim();
  const promptAttachments = readyAttachmentsForPayload();
  const displayAttachments = attachmentsForMessage();
  const conversation = activeConversation();
  conversation.model = els.modelSelect.value || conversation.model || defaultModel;
  let baselineCount = Number(conversation.responseCount || 0);
  appendMessage('user', text, { attachments: displayAttachments });
  appendMessage('assistant', '正在思考...', { pending: true });
  els.messageInput.value = '';
  autosizeTextarea();
  clearAttachments();
  sending = true;
  render();

  try {
    const payloadHistory = conversation.messages
      .filter((message) => !message.pending)
      .slice(-20)
      .map((message) => ({ role: message.role, content: message.content }));
    const data = await extCall({
      action: 'send_message',
      conversation_id: conversation.id,
      model: conversation.model,
      message: text,
      attachments: promptAttachments,
      history: payloadHistory,
      request_id: `chatgpt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    });
    if (!data.ok) throw new Error(data.error || '发送失败');
    if (data.backend_start && data.backend_start.ok === false) {
      throw new Error(data.backend_start.error || '模型启动失败');
    }
    baselineCount = Number.isFinite(Number(data.before_response_count))
      ? Number(data.before_response_count)
      : baselineCount;
    startPolling(conversation.id, baselineCount, Date.now());
  } catch (error) {
    removePendingAssistant();
    sending = false;
    showToast(error.message || '发送失败', true);
    render();
  }
}

async function stopCurrentGeneration() {
  const conversation = activeConversation();
  stopPolling();
  try {
    const data = await extCall({
      action: 'stop_generation',
      conversation_id: conversation.id,
      model: conversation.model,
    });
    if (!data.ok) throw new Error(data.error || '停止失败');
    removePendingAssistant('已停止本轮生成。');
    showToast('已发送停止请求');
  } catch (error) {
    showToast(error.message || '停止失败', true);
  } finally {
    sending = false;
    render();
  }
}

function clearCurrentConversation() {
  stopPolling();
  const conversation = activeConversation();
  const id = conversation.id;
  delete state.conversations[id];
  state.activeId = '';
  saveState();
  extCall({ action: 'reset_conversation', conversation_id: id }).catch(() => null);
  createConversation();
}

function clearAttachments() {
  for (const item of attachments) {
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  }
  attachments = [];
  renderAttachments();
}

async function uploadAttachment(item) {
  try {
    const uploaded = await extUpload(item.file);
    item.status = 'done';
    item.remotePath = uploaded.file?.path || '';
    item.storedName = uploaded.file?.stored_name || '';
    item.mimeType = uploaded.file?.mime_type || item.mimeType || '';
    item.size = uploaded.file?.size || item.size;
  } catch (error) {
    item.status = 'error';
    item.error = error.message || '上传失败';
  } finally {
    delete item.file;
    render();
  }
}

function addFiles(fileList) {
  const files = Array.from(fileList || []);
  const slots = Math.max(0, MAX_ATTACHMENTS - attachments.length);
  if (files.length > slots) showToast(`最多同时添加 ${MAX_ATTACHMENTS} 个附件`, true);
  for (const file of files.slice(0, slots)) {
    const type = file.type && file.type.startsWith('image/') ? 'image' : 'file';
    const item = {
      id: newId('att'),
      file,
      name: file.name || '附件',
      size: file.size || 0,
      mimeType: file.type || '',
      type,
      previewUrl: type === 'image' ? URL.createObjectURL(file) : '',
      status: 'uploading',
      remotePath: '',
    };
    attachments.push(item);
    uploadAttachment(item);
  }
  render();
}

function removeAttachment(id) {
  const item = attachments.find((entry) => entry.id === id);
  if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
  attachments = attachments.filter((entry) => entry.id !== id);
  render();
}

function supportedVoiceMimeType() {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return '';
  return [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ].find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

function recordingFileExtension(mimeType) {
  const lower = String(mimeType || '').toLowerCase();
  if (lower.includes('ogg')) return 'ogg';
  if (lower.includes('mp4') || lower.includes('aac')) return 'm4a';
  if (lower.includes('wav')) return 'wav';
  return 'webm';
}

function permissionErrorMessage(error) {
  const name = error?.name || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return '麦克风权限被拒绝，请在浏览器里允许语音输入使用麦克风。';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return '没有找到可用麦克风，请检查输入设备。';
  return error?.message || '无法启动麦克风录音。';
}

function cleanupVoiceStream() {
  clearTimeout(voiceStopTimer);
  voiceStopTimer = null;
  if (voiceStream) {
    for (const track of voiceStream.getTracks()) track.stop();
  }
  voiceStream = null;
}

async function toggleVoiceRecording() {
  if (voiceState === 'recording') {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    return;
  }
  if (voiceState === 'transcribing' || sending) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    showToast('当前浏览器不支持语音输入', true);
    return;
  }
  try {
    const mimeType = supportedVoiceMimeType();
    voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    voiceChunks = [];
    mediaRecorder = new MediaRecorder(voiceStream, mimeType ? { mimeType } : undefined);
    mediaRecorder.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size > 0) voiceChunks.push(event.data);
    });
    mediaRecorder.addEventListener('stop', () => {
      transcribeVoice(mimeType).catch((error) => showToast(error.message || '语音识别失败', true));
    }, { once: true });
    mediaRecorder.start();
    voiceState = 'recording';
    voiceStopTimer = setTimeout(() => {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    }, VOICE_RECORDING_MAX_MS);
    render();
  } catch (error) {
    cleanupVoiceStream();
    voiceState = 'idle';
    showToast(permissionErrorMessage(error), true);
    render();
  }
}

async function transcribeVoice(mimeType) {
  cleanupVoiceStream();
  const blob = new Blob(voiceChunks, { type: mimeType || 'audio/webm' });
  voiceChunks = [];
  if (!blob.size) {
    voiceState = 'idle';
    render();
    showToast('录音内容为空，请重新录制', true);
    return;
  }
  voiceState = 'transcribing';
  render();
  try {
    const ext = recordingFileExtension(mimeType);
    const file = new File([blob], `voice-${Date.now()}.${ext}`, { type: mimeType || 'audio/webm' });
    const uploaded = await extUpload(file);
    const data = await extCall({ action: 'transcribe_audio', file: uploaded.file });
    if (!data.ok) throw new Error(data.error || '语音识别失败');
    const text = String(data.text || '').trim();
    if (!text) throw new Error('没有识别到文字，请重新录制。');
    insertTextAtCursor(text);
    showToast('已转成文字');
  } finally {
    voiceState = 'idle';
    render();
    autosizeTextarea();
  }
}

function insertTextAtCursor(text) {
  const input = els.messageInput;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  const prefix = input.value.slice(0, start);
  const suffix = input.value.slice(end);
  const spacer = prefix && !prefix.endsWith('\n') && !prefix.endsWith(' ') ? ' ' : '';
  input.value = `${prefix}${spacer}${text}${suffix}`;
  const cursor = (prefix + spacer + text).length;
  input.focus();
  input.setSelectionRange(cursor, cursor);
  autosizeTextarea();
  render();
}

function bindEvents() {
  els.newChatBtn.addEventListener('click', () => createConversation());
  els.clearBtn.addEventListener('click', clearCurrentConversation);
  els.composer.addEventListener('submit', sendCurrentMessage);
  els.sendBtn.addEventListener('click', sendCurrentMessage);
  els.attachBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', (event) => {
    addFiles(event.target.files);
    event.target.value = '';
  });
  els.voiceBtn.addEventListener('click', toggleVoiceRecording);
  els.attachmentList.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-remove-attachment]');
    if (!btn) return;
    removeAttachment(btn.dataset.removeAttachment || '');
  });
  els.modelSelect.addEventListener('change', () => {
    const conversation = activeConversation();
    if (!conversation.messages.length) {
      conversation.model = els.modelSelect.value || defaultModel;
      saveState();
      render();
    }
  });
  els.conversationList.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-id]');
    if (!btn || sending) return;
    state.activeId = btn.dataset.id;
    clearAttachments();
    saveState();
    render();
  });
  els.messageInput.addEventListener('input', () => {
    autosizeTextarea();
    render();
  });
  els.messageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendCurrentMessage(event);
    }
  });
  els.composer.addEventListener('dragover', (event) => {
    event.preventDefault();
    els.composer.classList.add('dragging');
  });
  els.composer.addEventListener('dragleave', () => els.composer.classList.remove('dragging'));
  els.composer.addEventListener('drop', (event) => {
    event.preventDefault();
    els.composer.classList.remove('dragging');
    addFiles(event.dataTransfer.files);
  });
}

async function init() {
  bindEvents();
  await loadModels();
  if (!state.activeId || !state.conversations[state.activeId]) createConversation();
  await syncServerConversations();
  render();
  autosizeTextarea();
}

init();
