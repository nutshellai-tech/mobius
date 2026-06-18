/**
 * 人类共鸣计划 · 共鸣内容 Agent · 前端工作台
 *
 * 整体心智:
 *   - 状态 state.* 是真理源, 任何 mutation 调 render() 局部刷新
 *   - 与后端通过 extCall({action,...}) 单一接口对话
 *   - 流式输出走双通道: send_message 同步执行 (后台缓写 chunks) + 平行 poll_turn 每 380ms 轮询拼字
 *   - INTENT/STEP/RESONANCE 三类标记由后端解析并以结构化 meta 返回; 前端展示成胶囊
 */

import { extCall } from '/extension/_sdk/ext.js';

const POLL_INTERVAL_MS = 380;

const state = {
  username: '',
  display_name: '',
  profile: {
    project_name: '', audience: '', goal: '', tone: '', do_list: [], dont_list: [],
  },
  settings: { llm_api_base: '', llm_api_key: '', llm_model: '', auto_save_drafts: true },
  conversations: [],
  current_conv_id: '',
  messages: [],
  sources: [],
  templates: [],
  drafts: [],
  platforms: [],
  data_pool: [],
  template_filter: '',
  applied_template: null,
  streaming: false,
  poll_handle: null,
  current_turn: null,         // {id, partial, status, intents, resonance, steps}
  resonance_running: [],      // 当前对话维持的命中共鸣点
  generating_kind: '',
  editing_template_id: '',
  editing_draft_id: '',
  toast_timer: null,
};

// ---------------- 工具 ----------------
const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function escapeAttr(value) { return escapeHtml(value).replace(/`/g, '&#096;'); }

function fmtTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toast(msg, tone = 'ok') {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.dataset.tone = tone;
  el.classList.add('show');
  clearTimeout(state.toast_timer);
  state.toast_timer = setTimeout(() => el.classList.remove('show'), 2400);
}

function setComposerStatus(text, tone = '') {
  const el = $('composerStatus');
  if (!el) return;
  el.textContent = text;
  el.classList.remove('busy', 'done');
  if (tone) el.classList.add(tone);
}

async function call(action, payload = {}) {
  try {
    const data = await extCall({ action, ...payload });
    if (data && data.ok === false) {
      throw new Error(data.error || `${action} 失败`);
    }
    return data;
  } catch (e) {
    toast(e.message || `${action} 失败`, 'error');
    throw e;
  }
}

// ---------------- 初始化 ----------------
async function bootstrap() {
  try {
    const data = await call('get_state');
    ingestState(data);
    if (!state.current_conv_id && state.conversations.length) {
      state.current_conv_id = state.conversations[0].id;
    }
    if (state.current_conv_id) {
      await loadConversation(state.current_conv_id);
    }
    render();
  } catch (e) {
    render();
  }
}

function ingestState(data) {
  if (!data) return;
  state.username = data.username || '';
  state.display_name = data.display_name || '';
  if (data.state) {
    state.profile = { ...state.profile, ...(data.state.profile || {}) };
    state.settings = { ...state.settings, ...(data.state.settings || {}) };
    if (data.state.current_conv_id) state.current_conv_id = data.state.current_conv_id;
  }
  if (Array.isArray(data.conversations)) state.conversations = data.conversations;
  if (Array.isArray(data.templates)) state.templates = data.templates;
  if (Array.isArray(data.drafts)) state.drafts = data.drafts;
  if (Array.isArray(data.platforms)) state.platforms = data.platforms;
  if (Array.isArray(data.data_pool)) state.data_pool = data.data_pool;
}

async function loadConversation(cid) {
  if (!cid) return;
  state.current_conv_id = cid;
  state.resonance_running = [];
  try {
    const data = await call('get_conversation', { conversation_id: cid });
    state.messages = Array.isArray(data.messages) ? data.messages : [];
    // 把历史消息里的 resonance 全部收集起来
    for (const m of state.messages) {
      if (m.role === 'assistant' && m.meta && Array.isArray(m.meta.resonance)) {
        for (const r of m.meta.resonance) {
          if (r && !state.resonance_running.includes(r)) state.resonance_running.push(r);
        }
      }
    }
    state.sources = []; // sources 来自后端单独的 sources.json, 这里先空着, 下次有需要再拉
  } catch {
    state.messages = [];
  }
}

// ---------------- 渲染 ----------------
function render() {
  renderConvList();
  renderConvHeader();
  renderTemplates();
  renderDataPool();
  renderDrafts();
  renderResonance();
  renderMessages();
  renderAppliedTemplate();
  renderPlatformSelect();
}

function renderConvList() {
  const root = $('convList');
  const count = $('convCount');
  if (!root) return;
  count.textContent = String(state.conversations.length || 0);
  if (!state.conversations.length) {
    root.innerHTML = '<div class="empty-strip">还没有对话, 点右上"+ 新对话"开始</div>';
    return;
  }
  root.innerHTML = state.conversations.map((c) => `
    <div class="conv-item ${c.id === state.current_conv_id ? 'active' : ''}" data-conv-id="${escapeAttr(c.id)}">
      <strong>${escapeHtml(c.title || '未命名对话')}</strong>
      <small><span>${escapeHtml(c.audience || '未指定人群')}</span><span>${escapeHtml(fmtTime(c.updated_at))}</span></small>
    </div>
  `).join('');
}

function renderConvHeader() {
  const titleEl = $('convTitle');
  const audEl = $('convAudience');
  const renameBtn = $('renameConvBtn');
  const delBtn = $('deleteConvBtn');
  const cur = state.conversations.find((c) => c.id === state.current_conv_id);
  if (!cur) {
    titleEl.textContent = '开始一个新的共鸣研究';
    audEl.textContent = state.profile.audience
      ? `项目档案目标人群: ${state.profile.audience}`
      : '目标人群: 还没填, 在右上角"项目档案"里描述目标人群';
    renameBtn.disabled = true;
    delBtn.disabled = true;
    return;
  }
  titleEl.textContent = cur.title || '未命名对话';
  audEl.textContent = `目标人群: ${cur.audience || state.profile.audience || '未指定 — 可在重命名或项目档案中补充'}`;
  renameBtn.disabled = false;
  delBtn.disabled = false;
}

function renderTemplates() {
  const root = $('templateList');
  if (!root) return;
  const filter = state.template_filter;
  const list = filter ? state.templates.filter((t) => t.kind === filter) : state.templates;
  document.querySelectorAll('#templateTabs .tab-btn').forEach((btn) => {
    btn.classList.toggle('active', (btn.dataset.kind || '') === filter);
  });
  if (!list.length) {
    root.innerHTML = '<div class="empty-strip">暂无模板</div>';
    return;
  }
  root.innerHTML = list.map((t) => {
    const kindLabel = ({ copy: '文案', story: '剧情', song: '歌词', video: '视频' })[t.kind] || t.kind;
    return `
      <div class="template-card">
        <div class="template-card-head">
          <strong>${escapeHtml(t.name)}</strong>
          <span class="template-kind-tag">${escapeHtml(kindLabel)}</span>
        </div>
        <span>${escapeHtml(t.summary || '')}</span>
        <div class="template-actions">
          <button class="text-btn" data-action="apply-template" data-template-id="${escapeAttr(t.id)}">应用到下一轮</button>
          ${t.builtin ? '' : `<button class="text-btn" data-action="edit-template" data-template-id="${escapeAttr(t.id)}">编辑</button>`}
          ${t.builtin ? '' : `<button class="text-btn" data-action="delete-template" data-template-id="${escapeAttr(t.id)}" style="color:var(--danger)">删除</button>`}
        </div>
      </div>
    `;
  }).join('');
}

function renderDataPool() {
  const root = $('dataPool');
  if (!root) return;
  if (!state.data_pool.length) {
    root.innerHTML = '<div class="empty-strip">还没有素材, 让 Agent 抓取或手动导入</div>';
    return;
  }
  root.innerHTML = state.data_pool.slice(0, 20).map((item) => `
    <div class="data-pool-item">
      <strong>${escapeHtml(item.title || '(无标题)')}</strong>
      <small>${escapeHtml(item.platform || 'manual')} · ${escapeHtml(fmtTime(item.created_at))}</small>
      <p>${escapeHtml(item.text || '')}</p>
      <div class="row-actions">
        ${item.source_url ? `<a class="text-btn" href="${escapeAttr(item.source_url)}" target="_blank" rel="noreferrer">查看来源 ↗</a>` : '<span></span>'}
        <button class="text-btn" data-action="delete-data" data-data-id="${escapeAttr(item.id)}" style="color:var(--danger)">删除</button>
      </div>
    </div>
  `).join('');
}

function renderDrafts() {
  const root = $('draftList');
  const count = $('draftCount');
  if (!root) return;
  count.textContent = String(state.drafts.length || 0);
  if (!state.drafts.length) {
    root.innerHTML = '<div class="empty-strip">还没有保存的草稿</div>';
    return;
  }
  root.innerHTML = state.drafts.slice(0, 30).map((d) => {
    const kindLabel = ({ copy: '文案', story: '剧情', song: '歌词', video: '视频' })[d.kind] || d.kind;
    return `
      <div class="draft-card" data-action="open-draft" data-draft-id="${escapeAttr(d.id)}">
        <div class="draft-card-head">
          <strong>${escapeHtml(d.title || '未命名草稿')}</strong>
          <span class="draft-tag">${escapeHtml(kindLabel)}</span>
        </div>
        <small>${escapeHtml(d.audience || '')} · ${escapeHtml(fmtTime(d.updated_at))}</small>
      </div>
    `;
  }).join('');
}

function renderResonance() {
  const root = $('resonanceList');
  const count = $('resonanceCount');
  if (!root) return;
  count.textContent = String(state.resonance_running.length || 0);
  if (!state.resonance_running.length) {
    root.innerHTML = '<div class="empty-strip">Agent 在分析时会把命中的共鸣点钉在这里</div>';
    return;
  }
  root.innerHTML = state.resonance_running.slice().reverse().map((r) => `
    <div class="resonance-item">
      <span>${escapeHtml(r)}</span>
      <button class="text-btn" data-action="copy-resonance" data-text="${escapeAttr(r)}">复制</button>
    </div>
  `).join('');
}

function renderAppliedTemplate() {
  const el = $('appliedTemplate');
  const name = $('appliedTemplateName');
  if (!el || !name) return;
  if (state.applied_template) {
    el.classList.remove('hidden');
    name.textContent = state.applied_template.name;
  } else {
    el.classList.add('hidden');
    name.textContent = '';
  }
}

function renderPlatformSelect() {
  const sel = $('fetchPlatform');
  if (!sel) return;
  sel.innerHTML = state.platforms.map((p) => `<option value="${escapeAttr(p.id)}">${escapeHtml(p.name)} — ${escapeHtml(p.hint)}</option>`).join('');
}

function welcomeCardHtml() {
  const chips = [
    '帮我研究 25 岁刚搬到上海的女性的孤独感',
    '我要为新品咖啡写一个共情文案, 目标是熬夜的研究生',
    '设计一个 90 秒短剧, 讲职场里的 35 岁焦虑',
    '为深夜便利店写一首小调式中文流行歌',
  ];
  return `
    <div class="welcome-card">
      <h4>欢迎使用人类共鸣计划工作台</h4>
      <div>这是一份给中文创作者用的"共鸣点研究 + 内容生成"流水线:</div>
      <ol>
        <li>在 <b>右上"项目档案"</b> 描述目标人群; Agent 会持续基于这份画像工作。</li>
        <li>在对话里直接告诉 Agent 你想做什么; 它会主动抓取、引用、提炼共鸣点。</li>
        <li>右侧"生成草稿"四个按钮可以基于当前对话出最终成稿 — 文案 / 剧情 / 歌词 / 视频方案。</li>
        <li>所有抓取到的素材会进入左下"数据池", 跨对话沉淀。</li>
      </ol>
      <div class="quick-row">
        ${chips.map((c) => `<button class="quick-chip" data-action="quick-prompt" data-text="${escapeAttr(c)}">${escapeHtml(c)}</button>`).join('')}
      </div>
    </div>
  `;
}

function renderMessages() {
  const root = $('messageList');
  if (!root) return;
  if (!state.current_conv_id) {
    root.innerHTML = welcomeCardHtml();
    return;
  }
  if (!state.messages.length && !state.current_turn) {
    root.innerHTML = welcomeCardHtml() + `
      <div class="welcome-card" style="margin-top: 12px;">
        当前对话还没有消息, 写下你的第一个研究方向吧。
      </div>
    `;
    return;
  }
  const items = [];
  for (const m of state.messages) items.push(renderMessage(m));
  if (state.current_turn) items.push(renderStreamingMessage(state.current_turn));
  root.innerHTML = items.join('');
  root.scrollTop = root.scrollHeight;
}

function renderMessage(m) {
  const isUser = m.role === 'user';
  const avatar = isUser ? '你' : 'A';
  const stepsHtml = (!isUser && m.meta && Array.isArray(m.meta.steps) && m.meta.steps.length)
    ? `<div class="steps-line">${m.meta.steps.map((s) => `<span class="step-chip">${escapeHtml(s.name)}${s.detail ? ': ' + escapeHtml(s.detail) : ''}</span>`).join('')}</div>`
    : '';
  const intentsHtml = (!isUser && m.meta && Array.isArray(m.meta.intents) && m.meta.intents.length)
    ? `<div class="intents-line">${m.meta.intents.map((it) => intentPill(it)).join('')}</div>`
    : '';
  const resonance = (!isUser && m.meta && Array.isArray(m.meta.resonance) && m.meta.resonance.length)
    ? `<div class="steps-line">共鸣点: ${m.meta.resonance.map((r) => `<span class="step-chip" style="background:var(--highlight)">${escapeHtml(r)}</span>`).join('')}</div>`
    : '';
  const actions = !isUser ? `
    <div class="msg-meta">
      <span>${escapeHtml(fmtTime(m.ts))}</span>
      <button data-action="copy-msg" data-msg-id="${escapeAttr(m.id)}">复制</button>
      <button data-action="quick-save-draft" data-msg-id="${escapeAttr(m.id)}">保存为草稿</button>
    </div>` : `<div class="msg-meta"><span>${escapeHtml(fmtTime(m.ts))}</span></div>`;
  return `
    <div class="msg ${isUser ? 'user' : 'assistant'}" data-msg-id="${escapeAttr(m.id)}">
      <div class="msg-avatar">${escapeHtml(avatar)}</div>
      <div>
        <div class="msg-body">${escapeHtml(m.content)}</div>
        ${stepsHtml}
        ${resonance}
        ${intentsHtml}
        ${actions}
      </div>
    </div>
  `;
}

function intentPill(it) {
  const ok = it.ok !== false;
  const label = ({
    fetch: it.platform ? `抓取 ${it.platform}: ${it.query || ''}` : '抓取',
    fetch_url: '抓取 URL',
    save_draft: it.title ? `保存草稿: ${it.title}` : '保存草稿',
    save_data: '保存到数据池',
    apply_template: '应用模板',
    generate: '准备生成',
  })[it.kind] || it.kind;
  return `<span class="intent-pill ${ok ? '' : 'error'}">${escapeHtml(label)}${ok ? '' : ' ✕'}</span>`;
}

function renderStreamingMessage(turn) {
  const stepsHtml = turn.steps && turn.steps.length
    ? `<div class="steps-line">${turn.steps.map((s) => `<span class="step-chip">${escapeHtml(s.name)}${s.detail ? ': ' + escapeHtml(s.detail) : ''}</span>`).join('')}</div>`
    : '';
  const intentsHtml = turn.intents && turn.intents.length
    ? `<div class="intents-line">${turn.intents.map((it) => intentPill(it)).join('')}</div>`
    : '';
  const resonance = turn.resonance && turn.resonance.length
    ? `<div class="steps-line">共鸣点: ${turn.resonance.map((r) => `<span class="step-chip" style="background:var(--highlight)">${escapeHtml(r)}</span>`).join('')}</div>`
    : '';
  const partial = stripMarks(turn.partial || '');
  return `
    <div class="msg assistant">
      <div class="msg-avatar">A</div>
      <div>
        <div class="msg-body streaming-cursor">${escapeHtml(partial) || '<em style="color:var(--text-muted)">Agent 正在思考...</em>'}</div>
        ${stepsHtml}
        ${resonance}
        ${intentsHtml}
      </div>
    </div>
  `;
}

function stripMarks(text) {
  return String(text || '')
    .replace(/<<<INTENT:[^>]+>>>\s*/g, '')
    .replace(/<<<STEP:[^>]+>>>\s*/g, '')
    .replace(/<<<RESONANCE:[^>]+>>>\s*/g, '');
}

// ---------------- 发送消息 + 流式轮询 ----------------
async function ensureConversation() {
  if (state.current_conv_id) return state.current_conv_id;
  const data = await call('create_conversation', { title: '', audience: state.profile.audience || '' });
  state.conversations = [data.conversation, ...state.conversations];
  state.current_conv_id = data.conversation.id;
  state.messages = [];
  return state.current_conv_id;
}

async function sendMessage() {
  if (state.streaming) {
    toast('上一轮还在生成中, 请稍候', 'warn');
    return;
  }
  const input = $('composerInput');
  const text = (input?.value || '').trim();
  if (!text) {
    toast('请输入内容', 'warn');
    return;
  }
  const cid = await ensureConversation();
  // optimistic 显示用户消息
  state.messages = state.messages.concat([{ id: 'u-' + Date.now(), role: 'user', content: text, ts: new Date().toISOString() }]);
  state.current_turn = { id: '', partial: '', status: 'starting', intents: [], resonance: [], steps: [] };
  state.streaming = true;
  input.value = '';
  setComposerStatus('发送中…', 'busy');
  render();

  // 启动轮询前先发出 send_message, 但要并发: send_message 自己会等 LLM 返回 (可能 25s)
  // 在 send_message 落地之前, 我们不知道 turn_id; 所以等第一次返回后再启动 polling? 不, 那就没意义。
  // 用 short id 探测: 我们让 send_message 同步执行, 但 sendMessage 不 await 它, 而是在它解析后立刻把 turn_id 接进来
  const appliedTplId = state.applied_template?.id || '';
  const sendPromise = (async () => {
    try {
      const data = await extCall({
        action: 'send_message',
        conversation_id: cid,
        content: text,
        apply_template_id: appliedTplId,
      });
      return data;
    } catch (e) {
      return { ok: false, error: e.message || '发送失败' };
    }
  })();

  // 平行: 在等待 send_message 的同时, 通过 list 同对话最新 chunks 文件来探测 turn_id
  // 简化方案: 等 send_message 返回 turn_id 立刻接入完整 final_text, 不再轮询
  // 但用户体验上要看到 streaming — 于是同时轮询 conversation 最新的 turn 文件
  // 这里采用更轻量的"事后接管"方案: 我们在 send_message resolve 之前, 用 poll_turn(latest=true) 模式探测
  // 为了避免后端复杂化, 加一个 list_active_turn 的 action; 这里直接用 send_message 返回值 + 周期性 poll(turn_id) 即可
  // → 实际上, 一旦 sendPromise resolve 拿到 turn_id, 立刻去 poll_turn 拿全量 chunks (此时 chunks 已写满)
  // → 但用户感受不到 streaming. 折衷: 在 sendPromise resolve 前, 我们用 250ms 一次的"占位动画"
  // 真正的 streaming 由这次后端调用结束时, 把 final_text 一次性铺到 partial 即可 — 配合 streaming-cursor 闪烁

  // 更好的方案: 立刻发起一个 list_pending_turn 探测当前活动 turn, 拿到 turn_id 后开始 poll
  // 这里实现"轻量乐观": 每 380ms 调 poll_latest_turn(conversation_id) 拿 turn_id + chunks 增量
  // 后端 send_message 在写 chunks 同时, poll 端就能看到增量
  startPollLatest(cid);

  const sendResult = await sendPromise;
  stopPolling();
  state.streaming = false;
  if (!sendResult || sendResult.ok === false) {
    setComposerStatus('发送失败', '');
    toast(sendResult?.error || '发送失败', 'error');
    state.current_turn = null;
    // 撤销 optimistic 用户消息? 留着提示更合适
    render();
    return;
  }
  // 把最终消息写入 messages
  await refreshConversationAfterTurn(cid);
  state.current_turn = null;
  setComposerStatus(sendResult.intents && sendResult.intents.length ? `已完成 (含 ${sendResult.intents.length} 个意图)` : '已完成', 'done');
  // 抓取后可能更新了 data_pool / drafts — 拉一次
  refreshSidePanels().catch(() => {});
  render();
}

// 轮询活动 turn: 不知道 turn_id 时, 用 find_active_turn 扫描 mtime 最新的 running 文件
async function startPollLatest(cid) {
  stopPolling();
  let cursor = 0;
  let knownTurnId = '';
  const tick = async () => {
    if (!state.current_turn) return;
    try {
      let data;
      if (!knownTurnId) {
        data = await extCall({ action: 'find_active_turn', conversation_id: cid });
        if (data && data.turn_id) {
          knownTurnId = data.turn_id;
          // 立刻把已存的 chunks 拼出来
          const partial = (data.chunks || []).map((c) => c.delta).join('');
          state.current_turn.partial = partial;
          state.current_turn.id = knownTurnId;
          if (Array.isArray(data.steps)) state.current_turn.steps = data.steps;
          cursor = data.cursor || (data.chunks || []).length;
        }
      } else {
        data = await extCall({ action: 'poll_turn', conversation_id: cid, turn_id: knownTurnId, cursor });
        if (data && data.ok) {
          if (Array.isArray(data.chunks) && data.chunks.length) {
            state.current_turn.partial += data.chunks.map((c) => c.delta).join('');
            cursor = data.cursor;
          }
          if (Array.isArray(data.steps)) state.current_turn.steps = data.steps;
          if (data.status === 'done' && data.final_text) {
            state.current_turn.partial = data.final_text;
          }
        }
      }
      // 简短 pulse: 若一直没拿到 turn, 给个动态省略号
      if (!knownTurnId && state.current_turn.partial.length < 4) {
        const dots = ((state.current_turn.partial.match(/·/g) || []).length + 1) % 4;
        state.current_turn.partial = '·'.repeat(dots);
      }
      render();
    } catch { /* poll 失败容忍 */ }
  };
  state.poll_handle = setInterval(tick, POLL_INTERVAL_MS);
  tick(); // 立即先跑一次
}

function stopPolling() {
  if (state.poll_handle) {
    clearInterval(state.poll_handle);
    state.poll_handle = null;
  }
}

async function refreshConversationAfterTurn(cid) {
  try {
    const data = await call('get_conversation', { conversation_id: cid });
    state.messages = Array.isArray(data.messages) ? data.messages : state.messages;
    state.resonance_running = [];
    for (const m of state.messages) {
      if (m.role === 'assistant' && m.meta && Array.isArray(m.meta.resonance)) {
        for (const r of m.meta.resonance) if (r && !state.resonance_running.includes(r)) state.resonance_running.push(r);
      }
    }
    // 同步对话列表
    const convs = await call('list_conversations');
    if (Array.isArray(convs.conversations)) state.conversations = convs.conversations;
  } catch {}
  // 应用过模板后自动清除
  state.applied_template = null;
}

async function refreshSidePanels() {
  try {
    const data = await call('get_state');
    if (Array.isArray(data.drafts)) state.drafts = data.drafts;
    if (Array.isArray(data.data_pool)) state.data_pool = data.data_pool;
  } catch {}
}

// ---------------- 草稿生成 ----------------
async function generateArtifact(kind) {
  if (state.generating_kind) {
    toast('上一份草稿还在生成中', 'warn');
    return;
  }
  if (!state.current_conv_id && !state.profile.audience) {
    toast('先开始一个对话, 或在项目档案里填目标人群', 'warn');
    return;
  }
  state.generating_kind = kind;
  const statusEl = $('generateStatus');
  if (statusEl) statusEl.textContent = `正在生成 ${kindLabel(kind)}…`;
  document.querySelectorAll('.generate-btn').forEach((b) => { b.disabled = true; });
  try {
    const data = await call('generate_artifact', {
      kind,
      conversation_id: state.current_conv_id || '',
      title: '',
      brief: '',
    });
    state.drafts = [data.draft, ...state.drafts.filter((d) => d.id !== data.draft.id)];
    if (statusEl) statusEl.textContent = `已生成: ${data.draft.title}`;
    toast(`已生成 ${kindLabel(kind)}, 在右下草稿库可查看`);
    render();
    // 立刻打开
    openDraftModal(data.draft.id);
  } catch (e) {
    if (statusEl) statusEl.textContent = '生成失败';
  } finally {
    state.generating_kind = '';
    document.querySelectorAll('.generate-btn').forEach((b) => { b.disabled = false; });
  }
}

function kindLabel(k) { return ({ copy: '文案', story: '剧情', song: '歌词', video: '视频方案' })[k] || k; }

// ---------------- 模态框: 项目档案 / 设置 / 新对话 / 模板 / 抓取 / 草稿 / 加数据 ----------------
function openModal(id) {
  document.querySelectorAll('.modal').forEach((m) => m.classList.add('hidden'));
  const el = $(id);
  if (el) el.classList.remove('hidden');
}

function closeModals() {
  document.querySelectorAll('.modal').forEach((m) => m.classList.add('hidden'));
}

function openProfileModal() {
  $('pfProjectName').value = state.profile.project_name || '';
  $('pfAudience').value = state.profile.audience || '';
  $('pfGoal').value = state.profile.goal || '';
  $('pfTone').value = state.profile.tone || '';
  $('pfDoList').value = (state.profile.do_list || []).join(', ');
  $('pfDontList').value = (state.profile.dont_list || []).join(', ');
  openModal('profileModal');
}

async function saveProfile() {
  const profile = {
    project_name: $('pfProjectName').value,
    audience: $('pfAudience').value,
    goal: $('pfGoal').value,
    tone: $('pfTone').value,
    do_list: $('pfDoList').value.split(/[,, ]+/).map((s) => s.trim()).filter(Boolean),
    dont_list: $('pfDontList').value.split(/[,, ]+/).map((s) => s.trim()).filter(Boolean),
  };
  try {
    const data = await call('update_profile', { profile });
    state.profile = { ...state.profile, ...(data.state.profile || {}) };
    closeModals();
    toast('已保存项目档案');
    render();
  } catch {}
}

function openSettingsModal() {
  $('stApiBase').value = state.settings.llm_api_base || '';
  $('stApiKey').value = state.settings.llm_api_key || '';
  $('stModel').value = state.settings.llm_model || '';
  openModal('settingsModal');
}

async function saveSettings() {
  const settings = {
    llm_api_base: $('stApiBase').value.trim(),
    llm_api_key: $('stApiKey').value.trim(),
    llm_model: $('stModel').value.trim(),
  };
  try {
    const data = await call('update_settings', { settings });
    state.settings = { ...state.settings, ...(data.state.settings || {}) };
    closeModals();
    toast('已保存 API 设置');
  } catch {}
}

function openNewConvModal() {
  $('ncTitle').value = '';
  $('ncAudience').value = '';
  openModal('newConvModal');
}

async function confirmNewConv() {
  try {
    const data = await call('create_conversation', {
      title: $('ncTitle').value.trim(),
      audience: $('ncAudience').value.trim(),
    });
    state.conversations = [data.conversation, ...state.conversations];
    state.current_conv_id = data.conversation.id;
    state.messages = [];
    state.resonance_running = [];
    closeModals();
    render();
    $('composerInput').focus();
  } catch {}
}

async function renameCurrentConv() {
  const cur = state.conversations.find((c) => c.id === state.current_conv_id);
  if (!cur) return;
  const t = window.prompt('新标题', cur.title || '');
  if (t === null) return;
  const a = window.prompt('新人群描述 (可留空)', cur.audience || '');
  if (a === null) return;
  try {
    const data = await call('rename_conversation', { conversation_id: cur.id, title: t, audience: a });
    state.conversations = state.conversations.map((c) => (c.id === cur.id ? data.conversation : c));
    render();
  } catch {}
}

async function deleteCurrentConv() {
  if (!state.current_conv_id) return;
  const cur = state.conversations.find((c) => c.id === state.current_conv_id);
  if (!window.confirm(`删除对话「${cur?.title || state.current_conv_id}」? 不可恢复。`)) return;
  try {
    await call('delete_conversation', { conversation_id: state.current_conv_id });
    state.conversations = state.conversations.filter((c) => c.id !== state.current_conv_id);
    state.current_conv_id = state.conversations[0]?.id || '';
    if (state.current_conv_id) await loadConversation(state.current_conv_id);
    else { state.messages = []; state.resonance_running = []; }
    render();
    toast('对话已删除');
  } catch {}
}

function openTemplateModalForNew() {
  state.editing_template_id = '';
  $('templateModalTitle').textContent = '新建模板';
  $('tplKind').value = 'copy';
  $('tplName').value = '';
  $('tplAudience').value = state.profile.audience || '';
  $('tplSummary').value = '';
  $('tplStructure').value = '';
  $('tplSample').value = '';
  openModal('templateModal');
}

function openTemplateModalForEdit(id) {
  const tpl = state.templates.find((t) => t.id === id);
  if (!tpl || tpl.builtin) { toast('内置模板不可编辑', 'warn'); return; }
  state.editing_template_id = id;
  $('templateModalTitle').textContent = '编辑模板';
  $('tplKind').value = tpl.kind;
  $('tplName').value = tpl.name;
  $('tplAudience').value = tpl.audience || '';
  $('tplSummary').value = tpl.summary || '';
  $('tplStructure').value = (tpl.structure || []).join('\n');
  $('tplSample').value = tpl.sample || '';
  openModal('templateModal');
}

async function saveTemplate() {
  const tpl = {
    id: state.editing_template_id || '',
    kind: $('tplKind').value,
    name: $('tplName').value.trim(),
    audience: $('tplAudience').value.trim(),
    summary: $('tplSummary').value.trim(),
    structure: $('tplStructure').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    sample: $('tplSample').value.trim(),
  };
  if (!tpl.name) { toast('请填模板名', 'warn'); return; }
  try {
    const data = await call('save_template', { template: tpl });
    if (Array.isArray(data.templates)) state.templates = data.templates;
    closeModals();
    toast('已保存模板');
    render();
  } catch {}
}

async function deleteTemplate(id) {
  if (!window.confirm('删除这个模板?')) return;
  try {
    const data = await call('delete_template', { template_id: id });
    if (Array.isArray(data.templates)) state.templates = data.templates;
    render();
    toast('模板已删除');
  } catch {}
}

function applyTemplateForNextTurn(id) {
  const tpl = state.templates.find((t) => t.id === id);
  if (!tpl) return;
  state.applied_template = tpl;
  toast(`下一轮将应用模板: ${tpl.name}`);
  renderAppliedTemplate();
}

function openFetchModal() {
  $('fetchQuery').value = '';
  if (state.platforms.length && !$('fetchPlatform').value) $('fetchPlatform').value = state.platforms[0].id;
  openModal('fetchModal');
}

async function confirmFetch() {
  const platform = $('fetchPlatform').value;
  const query = $('fetchQuery').value.trim();
  if (!query) { toast('请输入关键词或 URL', 'warn'); return; }
  closeModals();
  setComposerStatus(`抓取 ${platform}: ${query} …`, 'busy');
  try {
    const data = await call('fetch_platform_data', { platform, query });
    if (Array.isArray(data.data_pool)) state.data_pool = data.data_pool;
    setComposerStatus(`已抓取 ${platform}`, 'done');
    toast(`已抓取: ${data.result?.title || query}`);
    render();
  } catch {
    setComposerStatus('抓取失败', '');
  }
}

async function openDraftModal(did) {
  state.editing_draft_id = did;
  try {
    const data = await call('get_draft', { draft_id: did });
    if (!data || !data.meta) return;
    $('draftModalTitle').textContent = data.meta.title || '草稿';
    $('draftTitle').value = data.meta.title || '';
    $('draftKind').value = data.meta.kind || 'copy';
    $('draftAudience').value = data.meta.audience || '';
    $('draftContent').value = data.content || '';
    openModal('draftModal');
  } catch {}
}

async function saveDraftFromModal() {
  if (!state.editing_draft_id) return;
  const payload = {
    draft: {
      id: state.editing_draft_id,
      title: $('draftTitle').value.trim(),
      kind: $('draftKind').value,
      audience: $('draftAudience').value.trim(),
      content: $('draftContent').value,
    },
  };
  try {
    const data = await call('save_draft', payload);
    if (Array.isArray(data.drafts)) state.drafts = data.drafts;
    toast('已保存草稿');
    render();
  } catch {}
}

async function deleteDraftFromModal() {
  if (!state.editing_draft_id) return;
  if (!window.confirm('删除这个草稿?')) return;
  try {
    const data = await call('delete_draft', { draft_id: state.editing_draft_id });
    if (Array.isArray(data.drafts)) state.drafts = data.drafts;
    state.editing_draft_id = '';
    closeModals();
    toast('草稿已删除');
    render();
  } catch {}
}

async function copyDraftToClipboard() {
  const text = $('draftContent').value || '';
  try { await navigator.clipboard.writeText(text); toast('已复制到剪贴板'); }
  catch { toast('复制失败, 请手动复制', 'warn'); }
}

function openAddDataModal() {
  $('adTitle').value = '';
  $('adPlatform').value = '';
  $('adUrl').value = '';
  $('adText').value = '';
  $('adTags').value = '';
  openModal('addDataModal');
}

async function confirmAddData() {
  const payload = {
    title: $('adTitle').value.trim(),
    platform: $('adPlatform').value.trim() || 'manual',
    source_url: $('adUrl').value.trim(),
    text: $('adText').value.trim(),
    tags: $('adTags').value.split(/[,, ]+/).map((s) => s.trim()).filter(Boolean),
  };
  if (!payload.text && !payload.source_url) { toast('请填正文或来源 URL', 'warn'); return; }
  try {
    const data = await call('add_data_source', payload);
    if (Array.isArray(data.data_pool)) state.data_pool = data.data_pool;
    closeModals();
    toast('已加入数据池');
    render();
  } catch {}
}

async function deleteDataItem(id) {
  if (!window.confirm('从数据池删除这条?')) return;
  try {
    const data = await call('delete_data_source', { id });
    if (Array.isArray(data.data_pool)) state.data_pool = data.data_pool;
    render();
  } catch {}
}

async function copyMessageById(id) {
  const m = state.messages.find((x) => x.id === id);
  if (!m) return;
  try { await navigator.clipboard.writeText(m.content || ''); toast('已复制'); }
  catch { toast('复制失败', 'warn'); }
}

async function quickSaveAsDraft(id) {
  const m = state.messages.find((x) => x.id === id);
  if (!m) return;
  const title = window.prompt('草稿标题', m.content.split(/\r?\n/)[0].slice(0, 40) || '快速草稿');
  if (!title) return;
  try {
    const data = await call('save_draft', {
      draft: {
        title,
        kind: 'copy',
        audience: state.profile.audience || '',
        ref_conv_id: state.current_conv_id,
        content: m.content || '',
      },
    });
    if (Array.isArray(data.drafts)) state.drafts = data.drafts;
    toast('已保存草稿');
    render();
  } catch {}
}

// ---------------- 事件绑定 ----------------
function bindEvents() {
  $('profileBtn').addEventListener('click', openProfileModal);
  $('settingsBtn').addEventListener('click', openSettingsModal);
  $('newConvBtn').addEventListener('click', openNewConvModal);
  $('saveProfileBtn').addEventListener('click', saveProfile);
  $('saveSettingsBtn').addEventListener('click', saveSettings);
  $('confirmNewConvBtn').addEventListener('click', confirmNewConv);
  $('renameConvBtn').addEventListener('click', renameCurrentConv);
  $('deleteConvBtn').addEventListener('click', deleteCurrentConv);
  $('sendBtn').addEventListener('click', sendMessage);
  $('fetchHintBtn').addEventListener('click', openFetchModal);
  $('confirmFetchBtn').addEventListener('click', confirmFetch);
  $('confirmAddDataBtn').addEventListener('click', confirmAddData);
  $('saveTemplateBtn').addEventListener('click', saveTemplate);
  $('saveDraftBtn').addEventListener('click', saveDraftFromModal);
  $('deleteDraftBtn').addEventListener('click', deleteDraftFromModal);
  $('copyDraftBtn').addEventListener('click', copyDraftToClipboard);

  $('composerInput').addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
      ev.preventDefault();
      sendMessage();
    }
  });

  document.addEventListener('click', (ev) => {
    // 模态关闭
    const closer = ev.target.closest('[data-action="close-modal"]');
    if (closer) { closeModals(); return; }
    if (ev.target.classList && ev.target.classList.contains('modal')) {
      closeModals();
      return;
    }
    // 切换对话
    const convItem = ev.target.closest('[data-conv-id]');
    if (convItem && convItem.classList.contains('conv-item')) {
      const id = convItem.dataset.convId;
      if (id !== state.current_conv_id) {
        loadConversation(id).then(render);
      }
      return;
    }
    // 模板 tab
    const tab = ev.target.closest('#templateTabs .tab-btn');
    if (tab) {
      state.template_filter = tab.dataset.kind || '';
      renderTemplates();
      return;
    }
    // 各种 data-action
    const actionEl = ev.target.closest('[data-action]');
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    if (action === 'new-template') openTemplateModalForNew();
    else if (action === 'edit-template') openTemplateModalForEdit(actionEl.dataset.templateId);
    else if (action === 'delete-template') deleteTemplate(actionEl.dataset.templateId);
    else if (action === 'apply-template') applyTemplateForNextTurn(actionEl.dataset.templateId);
    else if (action === 'clear-applied-template') { state.applied_template = null; renderAppliedTemplate(); }
    else if (action === 'add-data-source') openAddDataModal();
    else if (action === 'delete-data') deleteDataItem(actionEl.dataset.dataId);
    else if (action === 'open-draft') openDraftModal(actionEl.dataset.draftId);
    else if (action === 'quick-prompt') {
      $('composerInput').value = actionEl.dataset.text || '';
      $('composerInput').focus();
    }
    else if (action === 'copy-resonance') {
      navigator.clipboard.writeText(actionEl.dataset.text || '').then(() => toast('已复制')).catch(() => toast('复制失败', 'warn'));
    }
    else if (action === 'copy-msg') copyMessageById(actionEl.dataset.msgId);
    else if (action === 'quick-save-draft') quickSaveAsDraft(actionEl.dataset.msgId);
  });

  // generate buttons
  document.querySelectorAll('.generate-btn').forEach((btn) => {
    btn.addEventListener('click', () => generateArtifact(btn.dataset.kind));
  });
}

bindEvents();
bootstrap();
