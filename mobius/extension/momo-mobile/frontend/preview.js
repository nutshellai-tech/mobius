const state = {
  token: localStorage.getItem('momo-preview-token') || localStorage.getItem('cc-token') || '',
  user: null,
  passwordRequired: false,
  screen: 'login',
  username: '',
  password: '',
  messages: [
    { id: 'hello', author: 'momo', text: '你好呀，我是小莫。有什么可以帮你的吗？', time: '10:23' },
  ],
  sessions: [],
  activeSessionId: '',
  activeTitle: '我的主小莫',
  workspace: null,
  input: '',
  inputMode: 'text',
  attachments: [],
  typing: false,
  sending: false,
  toast: '',
  menuOpen: false,
  cloneSheet: false,
  cloneTitle: '分身小莫 #1',
  cloneDescription: '',
  cloneModel: 'codex',
  cloneModelOptions: [
    { key: 'codex', label: 'GPT-5.5 (Codex)', sub: '默认代码任务模型', backend: 'tmux-codex' },
    { key: 'opus', label: 'Opus', sub: 'Claude Code 高能力模型', backend: 'tmux-claude-code' },
  ],
  eventSource: null,
  ttsEnabled: localStorage.getItem('momo-preview-tts-enabled') !== 'false',
  themeMode: MomoComposerState.normalizeThemeMode(localStorage.getItem('momo-preview-theme-mode')),
  themePalette: localStorage.getItem('momo-preview-theme-palette') || 'default',
  ttsSpeakingId: '',
  lastSpokenAssistantId: '',
  pendingVoiceOnlyText: '',
  replayVisibleIds: new Set(),
  voiceRecording: false,
  voiceTranscribing: false,
  voiceCanceling: false,
  voiceTranscript: '',
  voiceVolume: 0,
  speechDenied: false,
};

const themePalettes = [
  { key: 'default', label: '默认蓝紫', a: '#5b6cff', b: '#7c57f4' },
  { key: 'aurora', label: '极光', a: '#38bdf8', b: '#c4b5fd' },
  { key: 'mint', label: '薄荷', a: '#22d3ee', b: '#86efac' },
  { key: 'coral', label: '珊瑚', a: '#fb7185', b: '#f0abfc' },
  { key: 'gold', label: '金色', a: '#f59e0b', b: '#2563eb' },
];

const root = document.getElementById('root');
let speechRecognition = null;
let voiceRecorder = null;
let voiceStream = null;
let voiceChunks = [];
let voiceTimeout = null;
let voiceCommitTimer = null;
let voiceVolumeTimer = null;
let pendingVoiceCommit = false;
let voiceStartY = 0;
let autoSpeakArmed = false;
let voiceGlobalPointerActive = false;
let composerInputComposing = false;
let composerRenderPending = false;
const systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');

function nowShortTime() {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatMessageTime(raw) {
  if (!raw) return '';
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return '';
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))}分钟前`;
  if (diff < 86_400_000) return `${Math.max(1, Math.floor(diff / 3_600_000))}小时前`;
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function attachmentKindOf(file) {
  return file.type?.startsWith('image/') ? 'image' : 'file';
}

function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.token) headers.set('Authorization', `Bearer ${state.token}`);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const res = await fetch(path, { ...options, headers });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401) logout('登录已过期，请重新登录');
    throw new Error(data?.error || data?.message || `HTTP ${res.status}`);
  }
  return data;
}

function setToast(message) {
  state.toast = message || '';
  render();
  if (message) setTimeout(() => {
    if (state.toast === message) {
      state.toast = '';
      render();
    }
  }, 2600);
}

async function uploadAttachmentFile(file) {
  const form = new FormData();
  form.append('file', file, file.name);
  const res = await fetch('/api/upload', {
    method: 'POST',
    headers: state.token ? { Authorization: `Bearer ${state.token}` } : undefined,
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `上传失败 (HTTP ${res.status})`);
  return {
    path: data.path,
    name: data.name || file.name,
    size: data.size || file.size,
  };
}

async function addAttachments(fileList) {
  const remaining = Math.max(0, 6 - state.attachments.length);
  const selected = Array.from(fileList || []).filter(Boolean);
  const files = selected.slice(0, remaining);
  if (selected.length > remaining) setToast('最多添加 6 个附件');
  if (!files.length) return;
  const next = files.map((file) => ({
    id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    file,
    name: file.name || '未命名文件',
    size: file.size || 0,
    mime_type: file.type || '',
    type: attachmentKindOf(file),
    previewUrl: attachmentKindOf(file) === 'image' ? URL.createObjectURL(file) : '',
    status: 'uploading',
    path: '',
    error: '',
  }));
  state.attachments = MomoComposerState.limitAttachments(state.attachments, next, 6);
  render();

  for (const item of next) {
    try {
      const uploaded = await uploadAttachmentFile(item.file);
      const current = state.attachments.find((att) => att.id === item.id);
      if (current) {
        Object.assign(current, {
          ...uploaded,
          status: 'done',
          error: '',
        });
      }
    } catch (e) {
      const current = state.attachments.find((att) => att.id === item.id);
      if (current) {
        current.status = 'error';
        current.error = e.message || '上传失败';
      }
      setToast(e.message || '上传失败');
    }
    render();
  }
}

function removeAttachment(id) {
  const item = state.attachments.find((att) => att.id === id);
  if (item?.previewUrl) {
    try { URL.revokeObjectURL(item.previewUrl); } catch {}
  }
  state.attachments = state.attachments.filter((att) => att.id !== id);
  render();
}

function clearAttachments() {
  state.attachments.forEach((att) => {
    if (att.previewUrl) {
      try { URL.revokeObjectURL(att.previewUrl); } catch {}
    }
  });
  state.attachments = [];
}

function speechRecognitionFactory() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function speechSupported() {
  return !!speechRecognitionFactory();
}

function ttsSupported() {
  return 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
}

function stopTts() {
  if (ttsSupported()) window.speechSynthesis.cancel();
  state.ttsSpeakingId = '';
}

function speakText(text, id = '') {
  const content = String(text || '').trim();
  if (!content) return;
  if (!ttsSupported()) {
    setToast('当前浏览器不支持语音播报');
    return;
  }
  stopTts();
  const utterance = new SpeechSynthesisUtterance(content);
  utterance.lang = 'zh-CN';
  utterance.rate = 1;
  utterance.pitch = 1;
  state.ttsSpeakingId = id;
  utterance.onend = () => {
    if (state.ttsSpeakingId === id) {
      state.ttsSpeakingId = '';
      render();
    }
  };
  utterance.onerror = () => {
    if (state.ttsSpeakingId === id) state.ttsSpeakingId = '';
    setToast('语音播报失败');
    render();
  };
  window.speechSynthesis.speak(utterance);
  render();
}

function maybeAutoSpeakLatestAssistant() {
  if (!autoSpeakArmed || !state.ttsEnabled || state.typing || state.voiceRecording) return;
  const pendingVoice = state.pendingVoiceOnlyText;
  if (pendingVoice) {
    state.pendingVoiceOnlyText = '';
    const syntheticId = `voice-only-${Date.now()}`;
    state.lastSpokenAssistantId = syntheticId;
    speakText(pendingVoice, '');
    return;
  }
  const msg = [...state.messages].reverse().find((item) => item.author === 'momo' && (item.text || item.voiceText));
  if (!msg || msg.id === state.lastSpokenAssistantId) return;
  state.lastSpokenAssistantId = msg.id;
  speakText(msg.voiceText || msg.text, msg.id);
}

function replayMessage(id) {
  const msg = state.messages.find((item) => item.id === id);
  if (!msg || msg.author !== 'momo') return;
  speakText(msg.voiceText || msg.text, msg.id);
}

function preferredVoiceMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  return candidates.find((type) => window.MediaRecorder?.isTypeSupported?.(type)) || '';
}

function voiceFileName(mimeType) {
  if (mimeType.includes('mp4')) return 'momo-voice.m4a';
  if (mimeType.includes('ogg')) return 'momo-voice.ogg';
  return 'momo-voice.webm';
}

async function transcribeVoiceBlob(blob) {
  const form = new FormData();
  form.append('audio', blob, voiceFileName(blob.type || 'audio/webm'));
  const res = await fetch('/api/assistant/transcribe', {
    method: 'POST',
    headers: state.token ? { Authorization: `Bearer ${state.token}` } : undefined,
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || data?.message || `语音识别失败 (HTTP ${res.status})`);
  return String(data?.text || '').trim();
}

async function beginVoiceInput() {
  if (state.voiceRecording) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    setToast('当前浏览器不支持录音');
    return;
  }
  stopTts();
  clearTimeout(voiceTimeout);
  clearTimeout(voiceCommitTimer);
  clearInterval(voiceVolumeTimer);
  pendingVoiceCommit = false;
  state.voiceRecording = true;
  state.voiceTranscribing = false;
  state.voiceCanceling = false;
  state.voiceTranscript = '';
  state.voiceVolume = 1;
  attachVoiceGlobalPointerHandlers();
  render();

  try {
    voiceStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    if (!state.voiceRecording) {
      stopVoiceStream();
      return;
    }
    const mimeType = preferredVoiceMimeType();
    voiceChunks = [];
    voiceRecorder = new MediaRecorder(voiceStream, mimeType ? { mimeType } : undefined);
    voiceRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) voiceChunks.push(event.data);
    };
    voiceRecorder.onerror = () => {
      if (pendingVoiceCommit && state.voiceTranscript.trim()) {
        commitVoiceTranscript();
        return;
      }
      resetVoiceState();
      setToast('录音失败，请重新录制');
    };
    voiceRecorder.onstop = async () => {
      stopVoiceStream();
      clearInterval(voiceVolumeTimer);
      if (!pendingVoiceCommit) return;
      const blob = new Blob(voiceChunks, { type: voiceRecorder?.mimeType || mimeType || 'audio/webm' });
      voiceChunks = [];
      if (!blob.size) {
        resetVoiceState();
        setToast('录音内容为空，请重新录制');
        return;
      }
      state.voiceTranscribing = true;
      state.voiceTranscript = '';
      state.voiceVolume = 0;
      render();
      try {
        const text = await transcribeVoiceBlob(blob);
        state.voiceTranscript = text;
        commitVoiceTranscript();
      } catch (error) {
        resetVoiceState();
        setToast(error?.message || '语音识别失败，请重新录制');
      }
    };
    voiceRecorder.start(250);
    voiceVolumeTimer = setInterval(() => {
      if (!state.voiceRecording || state.voiceTranscribing) return;
      state.voiceVolume = Math.min(5, Math.max(1, state.voiceVolume + (state.voiceVolume >= 5 ? -2 : 1)));
      render();
    }, 220);
  } catch (error) {
    const denied = error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError';
    state.speechDenied = denied;
    resetVoiceState();
    setToast(denied ? '麦克风权限未开启，仍可文字输入' : '录音启动失败');
    return;
  }
  voiceTimeout = setTimeout(() => finishVoiceInput(true), 60_000);
}

function stopVoiceStream() {
  voiceStream?.getTracks?.().forEach((track) => track.stop());
  voiceStream = null;
}

function resetVoiceState() {
  clearTimeout(voiceTimeout);
  clearTimeout(voiceCommitTimer);
  clearInterval(voiceVolumeTimer);
  detachVoiceGlobalPointerHandlers();
  pendingVoiceCommit = false;
  state.voiceRecording = false;
  state.voiceTranscribing = false;
  state.voiceCanceling = false;
  state.voiceTranscript = '';
  state.voiceVolume = 0;
  if (voiceRecorder && voiceRecorder.state !== 'inactive') {
    try { voiceRecorder.stop(); } catch {}
  }
  voiceRecorder = null;
  voiceChunks = [];
  stopVoiceStream();
  if (speechRecognition) {
    try { speechRecognition.abort(); } catch {}
  }
  speechRecognition = null;
  render();
}

function finishVoiceInput(forceCommit = false) {
  if (!state.voiceRecording) return;
  clearTimeout(voiceTimeout);
  clearTimeout(voiceCommitTimer);
  detachVoiceGlobalPointerHandlers();
  if (state.voiceCanceling && !forceCommit) {
    resetVoiceState();
    setToast('已取消语音输入');
    return;
  }
  pendingVoiceCommit = true;
  state.voiceTranscribing = true;
  state.voiceVolume = 0;
  render();
  try {
    if (voiceRecorder && voiceRecorder.state !== 'inactive') {
      voiceRecorder.stop();
    } else {
      commitVoiceTranscript();
    }
  } catch {
    commitVoiceTranscript();
  }
  voiceCommitTimer = setTimeout(() => {
    if (pendingVoiceCommit && state.voiceTranscribing) {
      resetVoiceState();
      setToast('语音识别超时，请稍后重试');
    }
  }, 30_000);
}

function commitVoiceTranscript() {
  if (!pendingVoiceCommit && !state.voiceRecording) return;
  const text = state.voiceTranscript.trim();
  pendingVoiceCommit = false;
  detachVoiceGlobalPointerHandlers();
  clearTimeout(voiceTimeout);
  clearTimeout(voiceCommitTimer);
  clearInterval(voiceVolumeTimer);
  state.voiceRecording = false;
  state.voiceTranscribing = false;
  state.voiceCanceling = false;
  state.voiceTranscript = '';
  state.voiceVolume = 0;
  voiceRecorder = null;
  voiceChunks = [];
  stopVoiceStream();
  if (text) {
    sendMessage(text);
  } else {
    setToast('没有识别到语音');
    render();
  }
}

function updateVoiceMove(clientY) {
  if (!state.voiceRecording) return;
  state.voiceCanceling = (clientY - voiceStartY) < -72;
  state.voiceVolume = state.voiceTranscript ? Math.max(2, state.voiceVolume) : 1;
  render();
}

function attachVoiceGlobalPointerHandlers() {
  if (voiceGlobalPointerActive) return;
  voiceGlobalPointerActive = true;
  window.addEventListener('pointermove', handleVoiceGlobalPointerMove);
  window.addEventListener('pointerup', handleVoiceGlobalPointerUp);
  window.addEventListener('pointercancel', handleVoiceGlobalPointerCancel);
}

function detachVoiceGlobalPointerHandlers() {
  if (!voiceGlobalPointerActive) return;
  voiceGlobalPointerActive = false;
  window.removeEventListener('pointermove', handleVoiceGlobalPointerMove);
  window.removeEventListener('pointerup', handleVoiceGlobalPointerUp);
  window.removeEventListener('pointercancel', handleVoiceGlobalPointerCancel);
}

function handleVoiceGlobalPointerMove(event) {
  updateVoiceMove(event.clientY);
}

function handleVoiceGlobalPointerUp() {
  finishVoiceInput(false);
}

function handleVoiceGlobalPointerCancel() {
  resetVoiceState();
}

function saveToken(token) {
  state.token = token || '';
  if (state.token) {
    localStorage.setItem('momo-preview-token', state.token);
    localStorage.setItem('cc-token', state.token);
  }
}

function logout(message = '') {
  if (state.eventSource) state.eventSource.close();
  stopTts();
  resetVoiceState();
  state.eventSource = null;
  state.token = '';
  state.user = null;
  localStorage.removeItem('momo-preview-token');
  state.screen = 'login';
  state.password = '';
  state.toast = message;
  render();
}

async function boot() {
  try {
    const config = await api('/api/auth/config');
    state.passwordRequired = !!config.password_required;
  } catch {
    state.passwordRequired = false;
  }
  if (!state.token) return render();
  try {
    state.user = await api('/api/auth/me');
    state.screen = 'home';
    await loadHomeData();
  } catch {
    state.token = '';
    localStorage.removeItem('momo-preview-token');
  }
  render();
}

async function login() {
  const username = state.username.trim();
  if (!username) return setToast('请输入用户名');
  if (state.passwordRequired && !state.password) return setToast('请输入密码');
  try {
    setToast('登录中...');
    const result = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(state.passwordRequired ? { username, password: state.password } : { username }),
    });
    saveToken(result.token);
    state.user = result.user;
    state.screen = 'home';
    state.password = '';
    await loadHomeData();
    setToast('');
  } catch (e) {
    setToast(e.message || '登录失败');
  }
}

async function loadHomeData() {
  const [workspaceResult, modelResult] = await Promise.allSettled([
    api('/api/assistant/workspace'),
    api('/api/sessions/model-options'),
  ]);
  if (workspaceResult.status === 'fulfilled') state.workspace = workspaceResult.value;
  else setToast(workspaceResult.reason?.message || '读取小莫工作区失败');
  if (modelResult.status === 'fulfilled' && Array.isArray(modelResult.value) && modelResult.value.length) {
    state.cloneModelOptions = modelResult.value
      .filter((option) => option && option.key)
      .map((option) => ({
        key: String(option.key),
        label: String(option.label || option.title || option.key),
        sub: String(option.sub || ''),
        backend: String(option.backend || ''),
      }));
    if (!state.cloneModelOptions.some((option) => option.key === state.cloneModel)) {
      state.cloneModel = state.cloneModelOptions[0]?.key || 'codex';
    }
  }
  await refreshSessions(false);
}

async function refreshSessions(showToast = true) {
  try {
    const data = await api('/api/assistant/sessions?limit=80');
    const snapshots = Array.isArray(data?.sessions) ? data.sessions : [];
    state.sessions = snapshots.map(normalizeSnapshot).filter((snapshot) => snapshot.session.session_id);
    const current = state.sessions.find((snapshot) => snapshot.session.session_id === state.activeSessionId)
      || state.sessions.find((snapshot) => snapshot.session.assistant_role === 'main')
      || state.sessions[0];
    if (current) applySnapshot(current);
    const nextNumber = Math.max(1, state.sessions.filter((snapshot) => String(snapshot.session.name || '').startsWith('分身小莫')).length + 1);
    state.cloneTitle = `分身小莫 #${nextNumber}`;
    if (showToast) setToast('');
  } catch (e) {
    if (showToast) setToast(e.message || '读取分身失败');
  }
}

function normalizeSnapshot(raw) {
  const session = raw?.session || raw || {};
  return {
    ...raw,
    session: {
      session_id: session.session_id || session.sessionId || '',
      name: session.name || '小莫 Session',
      description: session.description || '',
      assistant_role: session.assistant_role || '',
      model: session.model || '',
      created_at: session.created_at || '',
      last_active: session.last_active || '',
      agent_status: session.agent_status || raw?.status?.agent_status || '',
    },
    messages: Array.isArray(raw?.messages) ? raw.messages : [],
    status: raw?.status || {},
  };
}

function snapshotMessages(snapshot) {
  return (snapshot?.messages || []).map((m, index) => ({
    id: m.id || `snapshot-${index}`,
    author: String(m.role || m.type || '').includes('user') ? 'user' : 'momo',
    text: m.content || m.text || '',
    time: formatMessageTime(m.created_at) || nowShortTime(),
  })).filter((m) => m.text);
}

function applySnapshot(snapshot) {
  const normalized = normalizeSnapshot(snapshot);
  if (!normalized.session.session_id) return false;
  const previousSessionId = state.activeSessionId;
  const previousTitle = state.activeTitle;
  const previousSignature = MomoComposerState.chatRenderSignature(state.messages, state.typing);
  state.activeSessionId = normalized.session.session_id;
  state.activeTitle = normalized.session.name || '小莫 Session';
  const messages = snapshotMessages(normalized);
  if (messages.length) state.messages = messages.slice(-200);
  state.typing = !!normalized.status?.working;
  if (!state.typing) maybeAutoSpeakLatestAssistant();
  return previousSessionId !== state.activeSessionId
    || previousTitle !== state.activeTitle
    || previousSignature !== MomoComposerState.chatRenderSignature(state.messages, state.typing);
}

function connectStream(sessionId) {
  if (!sessionId || !state.token) return;
  if (state.eventSource) state.eventSource.close();
  const url = `/api/sessions/${encodeURIComponent(sessionId)}/events?token=${encodeURIComponent(state.token)}`;
  const es = new EventSource(url);
  state.eventSource = es;
  es.addEventListener('history', (event) => {
    try {
      if (state.activeSessionId === sessionId && state.messages.some((m) => m.author === 'momo')) return;
      const data = JSON.parse(event.data);
      const msgs = (data.messages || []).map((m, index) => ({
        id: m.id || `history-${index}`,
        author: String(m.role || m.type || '').includes('user') ? 'user' : 'momo',
        text: m.content || m.text || '',
        time: formatMessageTime(m.created_at) || nowShortTime(),
      })).filter((m) => m.text && m.author !== 'user');
      if (msgs.length) state.messages = mergeMessages(state.messages.slice(0, 1), msgs);
      render();
    } catch {}
  });
  es.addEventListener('jsonl_entry', (event) => {
    try {
      const data = JSON.parse(event.data);
      const msg = parseJsonlEntry(data.entry);
      if (msg) {
        if (msg.author === 'user') return;
        if (!msg.text && msg.voiceText) {
          state.pendingVoiceOnlyText = state.pendingVoiceOnlyText
            ? `${state.pendingVoiceOnlyText}\n${msg.voiceText}`
            : msg.voiceText;
        } else if (msg.text) {
          state.messages = mergeMessages(state.messages, [msg]);
          scrollChatBottom();
        }
        render();
        if (!state.typing) maybeAutoSpeakLatestAssistant();
      }
    } catch {}
  });
  es.addEventListener('typing', (event) => {
    try {
      const data = JSON.parse(event.data);
      const nextTyping = !!data.active;
      if (state.typing !== nextTyping) {
        state.typing = nextTyping;
        render();
      }
      if (!state.typing) maybeAutoSpeakLatestAssistant();
    } catch {}
  });
  es.addEventListener('server_error', (event) => {
    try {
      const data = JSON.parse(event.data);
      setToast(data.message || '服务端错误');
    } catch {
      setToast('服务端错误');
    }
  });
}

const PROCESS_ONLY_TYPES = new Set([
  'thinking', 'thought', 'reasoning', 'reasoning_summary',
  'tool_use', 'tool_call', 'tool_result', 'tool_output',
  'function_call', 'function_call_output',
  'web_search_call', 'file_search_call',
  'computer_call', 'computer_call_output',
  'image_generation_call', 'code_interpreter_call',
  'local_shell_call', 'mcp_call', 'custom_tool_call', 'redacted_thinking',
]);

const VOICE_MARKER_RE = /PushVoiceToUser\s*\(\s*(["'])([\s\S]*?)(?<!\\)\1\s*\)/g;
const VOICE_MARKER_LINE_RE = /^[ \t]*PushVoiceToUser\s*\(\s*(["'])([\s\S]*?)(?<!\\)\1\s*\)[ \t]*;?[ \t]*$/gm;

function decodeVoiceMarkerString(raw) {
  return raw
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\(["'\\])/g, '$1');
}

function splitVoiceMarker(raw) {
  const text = String(raw || '');
  const matches = [...text.matchAll(VOICE_MARKER_RE)];
  if (matches.length === 0) return { text, voiceText: '' };
  const voiceText = matches
    .map((m) => decodeVoiceMarkerString(m[2] || '').trim())
    .filter(Boolean)
    .join('\n');
  const cleaned = text
    .replace(VOICE_MARKER_RE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: cleaned, voiceText };
}

function parseJsonlEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const rawText = findText(entry);
  if (!rawText) return null;
  const role = String(entry.role || entry.type || entry.kind || entry.message?.role || entry.payload?.role || '');
  const type = String(entry.type || entry.kind || entry.message?.type || entry.payload?.type || '').toLowerCase();
  if (PROCESS_ONLY_TYPES.has(type) || PROCESS_ONLY_TYPES.has(role.toLowerCase())) return null;
  const isUser = role.includes('user') || type === 'user_input' || type === 'user';
  if (isUser) {
    return {
      id: entry.id || entry.uuid || `evt-${Date.now()}-${rawText.length}`,
      author: 'user',
      text: rawText,
      time: formatMessageTime(entry.timestamp || entry.created_at || entry.payload?.timestamp) || nowShortTime(),
    };
  }
  const { text: cleaned, voiceText } = splitVoiceMarker(rawText);
  if (!cleaned && !voiceText) return null;
  return {
    id: entry.id || entry.uuid || `evt-${Date.now()}-${rawText.length}`,
    author: 'momo',
    text: cleaned,
    voiceText: voiceText || '',
    time: formatMessageTime(entry.timestamp || entry.created_at || entry.payload?.timestamp) || nowShortTime(),
  };
}

function findText(obj) {
  const direct = obj.content || obj.text;
  if (typeof direct === 'string' && direct.trim()) return direct;
  const msg = obj.message;
  if (typeof msg === 'string' && msg.trim()) return msg;
  if (msg && typeof msg === 'object') return contentText(msg.content) || msg.text || '';
  const payload = obj.payload;
  if (payload && typeof payload === 'object') return payload.text || payload.output_text || contentText(payload.content) || '';
  return '';
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((block) => {
    if (!block || typeof block !== 'object') return String(block || '');
    if (block.type && block.type !== 'text' && block.type !== 'output_text') return '';
    return block.text || block.output_text || '';
  }).filter(Boolean).join('\n');
}

function mergeMessages(left, right) {
  const seen = new Set();
  const out = [];
  for (const m of [...left, ...right]) {
    const key = `${m.author}:${m.text}:${m.time}`;
    if (!m.text || seen.has(m.id) || seen.has(key)) continue;
    seen.add(m.id);
    seen.add(key);
    out.push(m);
  }
  return out.slice(-120);
}

async function sendMessage(contentOverride = '') {
  const content = (contentOverride || state.input).trim();
  const doneAttachments = state.attachments.filter((att) => att.status === 'done' && att.path);
  const uploadingCount = state.attachments.filter((att) => att.status === 'uploading').length;
  if (uploadingCount > 0) return setToast('附件还在上传，请稍候');
  if (!content && doneAttachments.length === 0) return;
  if (state.sending) return;
  autoSpeakArmed = true;
  stopTts();
  state.sending = true;
  state.input = '';
  const attachmentsForSend = doneAttachments.map((att) => ({
    path: att.path,
    name: att.name,
    size: att.size,
    type: att.type,
    mime_type: att.mime_type,
  }));
  const attachmentLabel = attachmentsForSend.length
    ? `\n${attachmentsForSend.map((att) => `附件：${att.name}`).join('\n')}`
    : '';
  const visibleContent = content || '请查看我上传的附件。';
  const localUserId = `local-${Date.now()}`;
  state.messages = mergeMessages(state.messages, [{
    id: localUserId,
    author: 'user',
    text: `${visibleContent}${attachmentLabel}`,
    time: nowShortTime(),
  }]);
  clearAttachments();
  render();
  scrollChatBottom();
  try {
    let sessionId = state.activeSessionId;
    const active = state.sessions.find((snapshot) => snapshot.session.session_id === sessionId);
    if (active && active.session.assistant_role !== 'main' && attachmentsForSend.length === 0) {
      await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content, input_text: content, request_id: `momo-preview-${Date.now()}` }),
      });
    } else {
      if (active && active.session.assistant_role !== 'main' && attachmentsForSend.length > 0) {
        setToast('附件消息已转给主小莫处理');
      }
      const result = await api('/api/assistant/messages', {
        method: 'POST',
        body: JSON.stringify({
          content: visibleContent,
          input_text: visibleContent,
          attachments: attachmentsForSend,
          route: '/mobile-preview',
          client_context: { source: 'momo-mobile-web-preview', route: '/mobile-preview' },
        }),
      });
      sessionId = result.session_id || result.task_id || result.session?.session_id || result.session?.sessionId || '';
    }
    if (sessionId) {
      state.activeSessionId = sessionId;
      connectStream(sessionId);
      pollSnapshot(sessionId);
    }
    state.sending = false;
    render();
  } catch (e) {
    state.sending = false;
    state.typing = false;
    state.messages = state.messages.filter((item) => item.id !== localUserId);
    setToast(e.message || '发送失败');
  }
}

async function pollSnapshot(sessionId) {
  for (let i = 0; i < 36; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    if (state.screen === 'login' || state.activeSessionId !== sessionId) return;
    try {
      const snapshot = normalizeSnapshot(await api(`/api/assistant/sessions/${encodeURIComponent(sessionId)}`));
      upsertSnapshot(snapshot);
      const messages = snapshotMessages(snapshot);
      if (messages.length) {
        const nextMessages = messages.slice(-200);
        const nextTyping = !!snapshot.status?.working;
        const previousSignature = MomoComposerState.chatRenderSignature(state.messages, state.typing);
        const nextSignature = MomoComposerState.chatRenderSignature(nextMessages, nextTyping);
        if (previousSignature !== nextSignature) {
          state.messages = nextMessages;
          state.typing = nextTyping;
          render();
        }
      }
      if (!snapshot.status?.working) maybeAutoSpeakLatestAssistant();
      if (!snapshot.status?.working && hasAssistantAfterLatestUser(messages)) return;
    } catch {}
  }
}

function hasAssistantAfterLatestUser(messages) {
  const latestUser = messages.map((m, index) => [m, index]).filter(([m]) => m.author === 'user').pop();
  if (!latestUser) return messages.some((m) => m.author === 'momo');
  return messages.slice(latestUser[1] + 1).some((m) => m.author === 'momo');
}

function upsertSnapshot(snapshot) {
  const normalized = normalizeSnapshot(snapshot);
  const index = state.sessions.findIndex((item) => item.session.session_id === normalized.session.session_id);
  if (index >= 0) state.sessions.splice(index, 1, normalized);
  else state.sessions.push(normalized);
}

async function createClone() {
  const issueId = state.workspace?.issue?.id || '';
  if (!issueId) return setToast('未找到小莫任务单');
  if (!state.cloneTitle.trim() || !state.cloneDescription.trim()) return setToast('请填写分身名称和任务描述');
  try {
    setToast('创建中...');
    const session = await api(`/api/issues/${encodeURIComponent(issueId)}/sessions/`, {
      method: 'POST',
      body: JSON.stringify({
        name: state.cloneTitle.trim(),
        description: state.cloneDescription.trim(),
        model: state.cloneModel,
        language: 'zh',
        excluded_skill_ids: [],
        excluded_memory_ids: [],
      }),
    });
    const sessionId = session.session_id || session.sessionId || '';
    if (sessionId) {
      await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: state.cloneDescription.trim(), input_text: state.cloneDescription.trim() }),
      });
    }
    state.cloneSheet = false;
    state.cloneDescription = '';
    await refreshSessions(false);
    setToast('分身已创建');
    render();
  } catch (e) {
    setToast(e.message || '创建分身失败');
  }
}

function scrollChatBottom() {
  const el = document.querySelector('.chat');
  if (el) el.scrollTop = el.scrollHeight;
}

function applyTheme() {
  const dark = MomoComposerState.resolveDarkTheme(state.themeMode, systemThemeQuery.matches);
  const resolved = dark ? 'dark' : 'light';
  document.documentElement.dataset.theme = resolved;
  document.body.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}

function render() {
  applyTheme();
  document.body.dataset.palette = state.themePalette;
  if (state.user && state.screen === 'home' && composerInputComposing) {
    composerRenderPending = true;
    return;
  }
  if (!state.user || state.screen === 'login') return renderLogin();
  if (state.screen === 'clones') return renderClones();
  if (state.screen === 'settings') return renderSettings();
  return renderHome();
}

function toastHtml() {
  return state.toast ? `<div class="toast">${escapeHtml(state.toast)}</div>` : '';
}

function momoAvatarHtml(size = 'sm', active = true, label = '小莫') {
  const particleCount = size === 'lg' ? 18 : 10;
  const particles = Array.from(
    { length: particleCount },
    (_, index) => `<span class="momo-orb__particle momo-orb__particle--${index + 1}"></span>`,
  ).join('');
  return `
    <span class="momo-orb momo-orb--${size}${active ? ' is-active' : ''}" role="img" aria-label="${escapeHtml(label)}">
      <span class="momo-orb__field"></span>
      <span class="momo-orb__ring momo-orb__ring--outer"></span>
      <span class="momo-orb__ring momo-orb__ring--inner"></span>
      <span class="momo-orb__core"></span>
      ${particles}
    </span>
  `;
}

function renderLogin() {
  root.innerHTML = `
    <section class="login">
      ${toastHtml()}
      ${momoAvatarHtml('lg', true)}
      <h1>小莫助理</h1>
      <p class="sub">登录后与你的 AI 项目助理对话</p>
      <div class="form">
        <input class="field" id="username" autocomplete="username" placeholder="请输入用户名" value="${escapeHtml(state.username)}" />
        ${state.passwordRequired ? `<input class="field" id="password" type="password" autocomplete="current-password" placeholder="请输入密码" value="${escapeHtml(state.password)}" />` : ''}
        <button class="primary" id="loginBtn">登 录</button>
        <div class="error" id="error"></div>
      </div>
      <p class="hint" style="margin-top:28px">忘记密码？请联系管理员</p>
      <div style="flex:1"></div>
      <p class="hint">更多登录方式 ›</p>
    </section>
  `;
  document.getElementById('username').addEventListener('input', (e) => { state.username = e.target.value; });
  const password = document.getElementById('password');
  if (password) password.addEventListener('input', (e) => { state.password = e.target.value; });
  document.getElementById('loginBtn').addEventListener('click', login);
}

function topbar(title, left = '', right = '☰') {
  return `
    <header class="topbar">
      <button class="icon-btn" id="topLeft">${left}</button>
      <div class="topbar-title">${escapeHtml(title)}</div>
      <button class="icon-btn" id="topRight">${right}</button>
    </header>
  `;
}

function messageHtml(message) {
  const isUser = message.author === 'user';
  const canReplay = !isUser && Boolean(message.text || message.voiceText);
  const replayVisible = canReplay && state.replayVisibleIds.has(message.id);
  return `
    <div class="row ${isUser ? 'user' : 'momo'}">
      ${isUser ? '' : momoAvatarHtml('sm', true)}
      <div class="bubble-wrap">
        <div class="bubble-line">
          <div class="bubble" ${canReplay ? `data-bubble-id="${escapeHtml(message.id)}"` : ''}>${escapeHtml(message.text)}</div>
          ${replayVisible ? `<button class="speaker-btn ${state.ttsSpeakingId === message.id ? 'speaking' : ''}" data-speak-id="${escapeHtml(message.id)}" aria-label="重播这条回复"><span class="icon icon-speaker"></span></button>` : ''}
        </div>
        <div class="time">${escapeHtml(message.time)}</div>
      </div>
      ${isUser ? `<div class="avatar user">${escapeHtml((state.user?.id || 'Z')[0].toUpperCase())}</div>` : ''}
    </div>
  `;
}

function voiceHoldButtonHtml() {
  if (state.voiceRecording) {
    const label = state.voiceCanceling
      ? '松手取消'
      : (state.voiceTranscribing ? '正在识别...' : (state.voiceTranscript || '正在听...'));
    const bars = Array.from({ length: 5 }, (_, index) => `<span class="${index < state.voiceVolume ? 'active' : ''}"></span>`).join('');
    return `
      <button class="voice-hold recording ${state.voiceCanceling ? 'canceling' : ''}" id="voiceHoldBtn" aria-label="正在语音输入">
        <span class="voice-text">${escapeHtml(label)}</span>
        <span class="voice-meter">${bars}</span>
      </button>
    `;
  }
  if (state.voiceTranscribing) {
    return `
      <button class="voice-hold transcribing" id="voiceHoldBtn" disabled aria-label="正在识别">
        <span class="loading-ring loading-ring--dark"></span>
        <span>正在识别...</span>
      </button>
    `;
  }
  return `<button class="voice-hold ${state.speechDenied ? 'denied' : ''}" id="voiceHoldBtn" aria-label="按住说话">按住说话</button>`;
}

function keyboardIconHtml() {
  return `<span class="icon icon-keyboard-grid">${Array.from({ length: 9 }, () => '<i></i>').join('')}</span>`;
}

function attachmentTrayHtml() {
  if (!state.attachments.length) return '';
  return `
    <div class="attachment-tray">
      ${state.attachments.map((att) => `
        <div class="attachment-chip ${att.status === 'error' ? 'error' : ''}">
          <span class="attachment-preview ${att.type === 'image' && att.previewUrl ? 'image' : ''}">
            ${att.type === 'image' && att.previewUrl ? `<img src="${escapeHtml(att.previewUrl)}" alt="" />` : 'FILE'}
          </span>
          <span class="attachment-meta">
            <strong>${escapeHtml(att.name)}</strong>
            <small>${att.status === 'uploading' ? '上传中...' : att.status === 'error' ? escapeHtml(att.error || '上传失败') : formatFileSize(att.size)}</small>
          </span>
          <button class="attachment-remove" data-remove-attachment="${escapeHtml(att.id)}" aria-label="移除附件">×</button>
        </div>
      `).join('')}
    </div>
  `;
}

function textComposerHtml() {
  const canSend = MomoComposerState.composerCanSend(state);
  const voiceMode = state.inputMode === 'voice';
  return `
    <footer class="composer">
      ${attachmentTrayHtml()}
      <div class="composer-pill">
        <button class="tool-btn upload-btn" id="fileBtn" aria-label="添加附件"><span class="icon icon-plus"></span></button>
        <input class="file-input" id="fileInput" type="file" multiple />
        ${voiceMode
          ? voiceHoldButtonHtml()
          : `<textarea class="message-input" id="messageInput" rows="1" placeholder="说点什么...">${escapeHtml(state.input)}</textarea>`}
        <button class="mode-switch" id="modeSwitchBtn" aria-label="${voiceMode ? '切换到键盘输入' : '切换到语音输入'}">
          ${voiceMode ? keyboardIconHtml() : '<span class="icon icon-voice"></span>'}
        </button>
        ${voiceMode ? '' : `<button class="send ${canSend ? 'ready' : ''}" id="sendBtn" aria-label="发送" ${canSend ? '' : 'disabled'}>${state.sending ? '<span class="loading-ring"></span>' : '<span class="icon icon-send"></span>'}</button>`}
      </div>
    </footer>
  `;
}

function toggleComposerMode() {
  if (state.voiceRecording || state.voiceTranscribing) return;
  state.inputMode = MomoComposerState.toggleInputMode(state.inputMode);
  render();
}

function renderHome() {
  const scrollSnapshot = MomoComposerState.captureChatScroll(document.querySelector('.chat'));
  const inputSnapshot = MomoComposerState.captureInputSelection(
    document.getElementById('messageInput'),
    document.activeElement,
  );
  root.innerHTML = `
    ${toastHtml()}
    ${topbar(state.activeTitle || '我的主小莫')}
    <section class="chat">
      ${state.messages.map(messageHtml).join('')}
      ${state.typing ? `
        <div class="row momo">
          ${momoAvatarHtml('sm', true, '小莫正在输入')}
          <div class="bubble"><span class="typing"><span></span><span></span><span></span></span></div>
        </div>` : ''}
    </section>
    ${textComposerHtml()}
    ${state.menuOpen ? `
      <nav class="menu">
        <button data-nav="clones">分身列表</button>
        <button data-nav="settings">设置</button>
        <button data-nav="about">关于</button>
      </nav>` : ''}
  `;
  document.getElementById('topLeft').style.visibility = 'hidden';
  document.getElementById('topRight').addEventListener('click', () => { state.menuOpen = !state.menuOpen; render(); });
  document.querySelectorAll('[data-nav]').forEach((btn) => btn.addEventListener('click', () => {
    const nav = btn.getAttribute('data-nav');
    state.menuOpen = false;
    if (nav === 'about') return setToast('小莫助理移动端调试版');
    state.screen = nav;
    if (nav === 'clones') refreshSessions(false).then(render);
    else render();
  }));
  document.querySelectorAll('[data-speak-id]').forEach((btn) => btn.addEventListener('click', () => {
    const id = btn.getAttribute('data-speak-id');
    replayMessage(id);
    state.replayVisibleIds.delete(id);
    render();
  }));
  document.querySelectorAll('[data-bubble-id]').forEach((bubble) => {
    let pressTimer = null;
    bubble.addEventListener('pointerdown', () => {
      if (pressTimer) clearTimeout(pressTimer);
      pressTimer = setTimeout(() => {
        pressTimer = null;
        const id = bubble.getAttribute('data-bubble-id');
        if (state.replayVisibleIds.has(id)) state.replayVisibleIds.delete(id);
        else state.replayVisibleIds.add(id);
        render();
      }, 450);
    });
    const cancel = () => { if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; } };
    bubble.addEventListener('pointerup', cancel);
    bubble.addEventListener('pointerleave', cancel);
    bubble.addEventListener('pointercancel', cancel);
    bubble.addEventListener('contextmenu', (e) => e.preventDefault());
  });
  document.querySelectorAll('[data-remove-attachment]').forEach((btn) => {
    btn.addEventListener('click', () => removeAttachment(btn.getAttribute('data-remove-attachment')));
  });
  const fileBtn = document.getElementById('fileBtn');
  const fileInput = document.getElementById('fileInput');
  fileBtn?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', (event) => {
    addAttachments(event.target.files);
    event.target.value = '';
  });
  document.getElementById('modeSwitchBtn')?.addEventListener('click', toggleComposerMode);
  const voiceHoldBtn = document.getElementById('voiceHoldBtn');
  if (voiceHoldBtn && !voiceHoldBtn.disabled) {
    voiceHoldBtn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      voiceStartY = e.clientY;
      voiceHoldBtn.setPointerCapture?.(e.pointerId);
      beginVoiceInput();
    });
    voiceHoldBtn.addEventListener('pointermove', (e) => updateVoiceMove(e.clientY));
    voiceHoldBtn.addEventListener('pointerup', (e) => {
      e.preventDefault();
      finishVoiceInput(false);
    });
    voiceHoldBtn.addEventListener('pointercancel', () => resetVoiceState());
    voiceHoldBtn.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  const input = document.getElementById('messageInput');
  if (input) {
    input.addEventListener('compositionstart', () => {
      composerInputComposing = true;
    });
    input.addEventListener('compositionend', () => {
      composerInputComposing = false;
      state.input = input.value;
      if (composerRenderPending) {
        composerRenderPending = false;
        render();
      } else {
        syncComposerState();
      }
    });
    input.addEventListener('input', (e) => {
      state.input = e.target.value;
      e.target.style.height = 'auto';
      e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
      syncComposerState();
    });
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || composerInputComposing) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
  }
  document.getElementById('sendBtn')?.addEventListener('click', () => sendMessage());
  MomoComposerState.restoreChatScroll(document.querySelector('.chat'), scrollSnapshot);
  MomoComposerState.restoreInputSelection(document.getElementById('messageInput'), inputSnapshot);
}

function syncComposerState() {
  const canSend = MomoComposerState.composerCanSend(state);
  const send = document.getElementById('sendBtn');
  if (send) {
    send.disabled = !canSend;
    send.classList.toggle('ready', canSend);
  }
}

function renderClones() {
  root.innerHTML = `
    ${toastHtml()}
    ${topbar('分身列表', '‹', '')}
    <section class="list">
      ${state.sessions.map((snapshot, index) => {
        const s = snapshot.session;
        const isMain = s.assistant_role === 'main';
        return `
        <div class="session-item" data-session-id="${escapeHtml(s.session_id)}">
          ${isMain ? momoAvatarHtml('sm', true) : `<div class="avatar user">${String(index)}</div>`}
          <div>
            <div class="session-title">${escapeHtml(s.name || '小莫 Session')}${isMain ? '<span class="badge">主体</span>' : ''}</div>
            <div class="session-sub">${escapeHtml(s.description || '你好呀，我是小莫...')}</div>
          </div>
          <div class="time">${escapeHtml(formatMessageTime(s.last_active || s.created_at) || nowShortTime())}</div>
        </div>
      `;
      }).join('') || `<div class="hint" style="padding:42px 16px">暂无分身</div>`}
    </section>
    <footer class="footer-action"><button class="primary" id="openClone" style="width:100%">＋ 开分身</button></footer>
    ${state.cloneSheet ? cloneSheetHtml() : ''}
  `;
  document.getElementById('topLeft').addEventListener('click', () => { state.screen = 'home'; render(); });
  document.getElementById('topRight').style.visibility = 'hidden';
  document.querySelectorAll('[data-session-id]').forEach((item) => item.addEventListener('click', () => openSession(item.getAttribute('data-session-id'))));
  document.getElementById('openClone').addEventListener('click', () => { state.cloneSheet = true; render(); });
  bindCloneSheet();
}

async function openSession(sessionId) {
  if (!sessionId) return;
  const snapshot = state.sessions.find((item) => item.session.session_id === sessionId);
  if (snapshot) applySnapshot(snapshot);
  state.screen = 'home';
  render();
  scrollChatBottom();
  connectStream(sessionId);
  try {
    const fresh = normalizeSnapshot(await api(`/api/assistant/sessions/${encodeURIComponent(sessionId)}`));
    upsertSnapshot(fresh);
    applySnapshot(fresh);
    render();
    scrollChatBottom();
  } catch (e) {
    setToast(e.message || '打开小莫会话失败');
  }
}

function cloneSheetHtml() {
  const options = state.cloneModelOptions.length ? state.cloneModelOptions : [
    { key: 'codex', label: 'GPT-5.5 (Codex)', sub: '默认代码任务模型' },
  ];
  return `
    <div class="sheet-backdrop" id="sheetBackdrop">
      <section class="sheet">
        <h2>开一个分身小莫</h2>
        <input id="cloneTitle" value="${escapeHtml(state.cloneTitle)}" placeholder="分身名称" />
        <textarea id="cloneDesc" placeholder="输入任务描述，支持中文输入和粘贴">${escapeHtml(state.cloneDescription)}</textarea>
        <div class="sheet-label">选择模型</div>
        <div class="clone-model-options" role="radiogroup" aria-label="分身模型">
          ${options.map((option) => `
            <button
              type="button"
              class="clone-model-option ${state.cloneModel === option.key ? 'selected' : ''}"
              data-clone-model="${escapeHtml(option.key)}"
              role="radio"
              aria-checked="${state.cloneModel === option.key ? 'true' : 'false'}"
            >
              <span>
                <strong>${escapeHtml(option.label || option.key)}</strong>
                <small>${escapeHtml(option.sub || option.backend || '')}</small>
              </span>
              <i>${state.cloneModel === option.key ? '✓' : ''}</i>
            </button>
          `).join('')}
        </div>
        <button class="primary" id="createClone" style="width:100%">＋ 创建并启动</button>
      </section>
    </div>
  `;
}

function bindCloneSheet() {
  const backdrop = document.getElementById('sheetBackdrop');
  if (!backdrop) return;
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) {
      state.cloneSheet = false;
      render();
    }
  });
  document.getElementById('cloneTitle').addEventListener('input', (e) => { state.cloneTitle = e.target.value; });
  document.getElementById('cloneDesc').addEventListener('input', (e) => { state.cloneDescription = e.target.value; });
  document.querySelectorAll('[data-clone-model]').forEach((button) => {
    button.addEventListener('click', () => {
      state.cloneModel = button.getAttribute('data-clone-model') || 'codex';
      render();
    });
  });
  document.getElementById('createClone').addEventListener('click', createClone);
}

function renderSettings() {
  const darkEnabled = MomoComposerState.resolveDarkTheme(state.themeMode, systemThemeQuery.matches);
  const themeModeLabel = state.themeMode === 'system'
    ? `跟随系统 · ${darkEnabled ? '暗色' : '亮色'}`
    : (darkEnabled ? '已开启' : '已关闭');
  root.innerHTML = `
    ${toastHtml()}
    ${topbar('设置', '‹', '')}
    <section class="settings">
      <div class="setting-row"><span>账号</span><strong>${escapeHtml(state.user?.display_name || state.user?.id || '')}</strong></div>
      <button class="setting-row" id="themeToggle"><span>暗色模式</span><span>${themeModeLabel}</span></button>
      <div class="setting-row"><span>消息推送</span><span>未开启</span></div>
      <button class="setting-row" id="ttsToggle"><span>自动播报</span><span>${state.ttsEnabled ? '已开启' : '已关闭'}</span></button>
      <div class="settings-title">主题风格</div>
      <div class="palette-list">
        ${themePalettes.map((item) => `
          <button class="palette-row ${state.themePalette === item.key ? 'selected' : ''}" data-palette="${item.key}">
            <span class="swatches"><i style="background:${item.a}"></i><i style="background:${item.b}"></i></span>
            <span>${item.label}</span>
            <strong>${state.themePalette === item.key ? '✓' : ''}</strong>
          </button>
        `).join('')}
      </div>
      <button class="setting-row danger" id="logoutBtn">退出登录</button>
    </section>
  `;
  document.getElementById('topLeft').addEventListener('click', () => { state.screen = 'home'; render(); });
  document.getElementById('topRight').style.visibility = 'hidden';
  document.getElementById('themeToggle').addEventListener('click', () => {
    state.themeMode = MomoComposerState.toggleThemeMode(state.themeMode, systemThemeQuery.matches);
    localStorage.setItem('momo-preview-theme-mode', state.themeMode);
    render();
  });
  document.getElementById('ttsToggle').addEventListener('click', () => {
    state.ttsEnabled = !state.ttsEnabled;
    localStorage.setItem('momo-preview-tts-enabled', String(state.ttsEnabled));
    if (!state.ttsEnabled) stopTts();
    render();
  });
  document.querySelectorAll('[data-palette]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.themePalette = btn.getAttribute('data-palette') || 'default';
      localStorage.setItem('momo-preview-theme-palette', state.themePalette);
      render();
    });
  });
  document.getElementById('logoutBtn').addEventListener('click', () => logout());
}

systemThemeQuery.addEventListener?.('change', () => {
  if (state.themeMode === 'system') render();
});

boot();
