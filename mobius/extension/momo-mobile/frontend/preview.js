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
  typing: false,
  toast: '',
  menuOpen: false,
  cloneSheet: false,
  cloneTitle: '分身小莫 #1',
  cloneDescription: '',
  cloneModel: 'codex',
  eventSource: null,
};

const root = document.getElementById('root');

function nowShortTime() {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
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

function saveToken(token) {
  state.token = token || '';
  if (state.token) {
    localStorage.setItem('momo-preview-token', state.token);
    localStorage.setItem('cc-token', state.token);
  }
}

function logout(message = '') {
  if (state.eventSource) state.eventSource.close();
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
  try {
    state.workspace = await api('/api/assistant/workspace');
    await refreshSessions(false);
  } catch (e) {
    setToast(e.message || '读取小莫工作区失败');
  }
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
    time: shortTime(m.created_at) || nowShortTime(),
  })).filter((m) => m.text);
}

function applySnapshot(snapshot) {
  const normalized = normalizeSnapshot(snapshot);
  if (!normalized.session.session_id) return;
  state.activeSessionId = normalized.session.session_id;
  state.activeTitle = normalized.session.name || '小莫 Session';
  const messages = snapshotMessages(normalized);
  if (messages.length) state.messages = messages.slice(-200);
  state.typing = !!normalized.status?.working;
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
        time: shortTime(m.created_at) || nowShortTime(),
      })).filter((m) => m.text);
      if (msgs.length) state.messages = mergeMessages(state.messages.slice(0, 1), msgs);
      render();
    } catch {}
  });
  es.addEventListener('jsonl_entry', (event) => {
    try {
      const data = JSON.parse(event.data);
      const msg = parseJsonlEntry(data.entry);
      if (msg) {
        if (msg.author === 'momo' && state.waitingId) {
          state.messages = state.messages.filter((item) => item.id !== state.waitingId);
          state.waitingId = '';
        }
        state.messages = mergeMessages(state.messages, [msg]);
        if (msg.author === 'momo') state.typing = false;
        render();
        scrollChatBottom();
      }
    } catch {}
  });
  es.addEventListener('typing', (event) => {
    try {
      const data = JSON.parse(event.data);
      state.typing = !!data.active;
      render();
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

function shortTime(value) {
  const m = String(value || '').match(/(\d{2}):(\d{2})/);
  return m ? m[0] : '';
}

function parseJsonlEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const text = findText(entry);
  if (!text) return null;
  const role = String(entry.role || entry.type || entry.kind || entry.message?.role || entry.payload?.role || '');
  return {
    id: entry.id || entry.uuid || `evt-${Date.now()}-${text.length}`,
    author: role.includes('user') || role.includes('user_input') ? 'user' : 'momo',
    text,
    time: shortTime(entry.timestamp) || nowShortTime(),
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

async function sendMessage() {
  const content = state.input.trim();
  if (!content) return;
  state.input = '';
  const waitingId = `waiting-${Date.now()}`;
  state.waitingId = waitingId;
  state.messages = mergeMessages(state.messages, [{
    id: `local-${Date.now()}`,
    author: 'user',
    text: content,
    time: nowShortTime(),
  }, {
    id: waitingId,
    author: 'momo',
    text: '小莫正在回复...',
    time: nowShortTime(),
  }]);
  state.typing = true;
  render();
  scrollChatBottom();
  try {
    let sessionId = state.activeSessionId;
    const active = state.sessions.find((snapshot) => snapshot.session.session_id === sessionId);
    if (active && active.session.assistant_role !== 'main') {
      await api(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content, input_text: content, request_id: `momo-preview-${Date.now()}` }),
      });
    } else {
      const result = await api('/api/assistant/messages', {
        method: 'POST',
        body: JSON.stringify({
          content,
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
  } catch (e) {
    state.typing = false;
    state.messages = state.messages.filter((item) => item.id !== waitingId);
    state.waitingId = '';
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
        state.messages = messages.slice(-200);
        state.waitingId = '';
        state.typing = !!snapshot.status?.working;
        render();
        scrollChatBottom();
      }
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
  setTimeout(() => {
    const el = document.querySelector('.chat');
    if (el) el.scrollTop = el.scrollHeight;
  }, 0);
}

function render() {
  document.body.classList.toggle('dark', false);
  if (!state.user || state.screen === 'login') return renderLogin();
  if (state.screen === 'clones') return renderClones();
  if (state.screen === 'settings') return renderSettings();
  return renderHome();
}

function toastHtml() {
  return state.toast ? `<div class="toast">${escapeHtml(state.toast)}</div>` : '';
}

function renderLogin() {
  root.innerHTML = `
    <section class="login">
      ${toastHtml()}
      <div class="logo">莫</div>
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
  return `
    <div class="row ${isUser ? 'user' : 'momo'}">
      ${isUser ? '' : `<div class="avatar momo">莫</div>`}
      <div class="bubble-wrap">
        <div class="bubble">${escapeHtml(message.text)}</div>
        <div class="time">${escapeHtml(message.time)}</div>
      </div>
      ${isUser ? `<div class="avatar user">${escapeHtml((state.user?.id || 'Z')[0].toUpperCase())}</div>` : ''}
    </div>
  `;
}

function renderHome() {
  root.innerHTML = `
    ${toastHtml()}
    ${topbar(state.activeTitle || '我的主小莫')}
    <section class="chat">
      ${state.messages.map(messageHtml).join('')}
      ${state.typing ? `
        <div class="row momo">
          <div class="avatar momo">莫</div>
          <div class="bubble"><span class="typing"><span></span><span></span><span></span></span></div>
        </div>` : ''}
    </section>
    <footer class="composer">
      <button class="icon-btn" id="plusBtn">＋</button>
      <textarea class="message-input" id="messageInput" rows="1" placeholder="说点什么...">${escapeHtml(state.input)}</textarea>
      <button class="send" id="sendBtn">↑</button>
    </footer>
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
  document.getElementById('plusBtn').addEventListener('click', () => setToast('图片/文件入口已预留'));
  const input = document.getElementById('messageInput');
  input.addEventListener('input', (e) => {
    state.input = e.target.value;
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  document.getElementById('sendBtn').addEventListener('click', sendMessage);
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
          <div class="avatar ${isMain ? 'momo' : 'user'}">${isMain ? '主' : String(index)}</div>
          <div>
            <div class="session-title">${escapeHtml(s.name || '小莫 Session')}${isMain ? '<span class="badge">主体</span>' : ''}</div>
            <div class="session-sub">${escapeHtml(s.description || '你好呀，我是小莫...')}</div>
          </div>
          <div class="time">${escapeHtml(shortTime(s.last_active || s.created_at) || nowShortTime())}</div>
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
  return `
    <div class="sheet-backdrop" id="sheetBackdrop">
      <section class="sheet">
        <h2>开一个分身小莫</h2>
        <input id="cloneTitle" value="${escapeHtml(state.cloneTitle)}" placeholder="分身名称" />
        <textarea id="cloneDesc" placeholder="输入任务描述，支持中文输入和粘贴">${escapeHtml(state.cloneDescription)}</textarea>
        <select id="cloneModel">
          <option value="codex" ${state.cloneModel === 'codex' ? 'selected' : ''}>codex</option>
          <option value="opus" ${state.cloneModel === 'opus' ? 'selected' : ''}>opus</option>
          <option value="sonnet" ${state.cloneModel === 'sonnet' ? 'selected' : ''}>sonnet</option>
        </select>
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
  document.getElementById('cloneModel').addEventListener('change', (e) => { state.cloneModel = e.target.value; });
  document.getElementById('createClone').addEventListener('click', createClone);
}

function renderSettings() {
  root.innerHTML = `
    ${toastHtml()}
    ${topbar('设置', '‹', '')}
    <section class="settings">
      <div class="setting-row"><span>账号</span><strong>${escapeHtml(state.user?.display_name || state.user?.id || '')}</strong></div>
      <div class="setting-row"><span>暗色模式</span><span>跟随系统</span></div>
      <div class="setting-row"><span>消息推送</span><span>未开启</span></div>
      <div class="setting-row"><span>声音播报</span><span>未开启</span></div>
      <button class="setting-row danger" id="logoutBtn">退出登录</button>
    </section>
  `;
  document.getElementById('topLeft').addEventListener('click', () => { state.screen = 'home'; render(); });
  document.getElementById('topRight').style.visibility = 'hidden';
  document.getElementById('logoutBtn').addEventListener('click', () => logout());
}

boot();
