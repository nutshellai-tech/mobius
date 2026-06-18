import { extCall } from '/extension/_sdk/ext.js';
import './style.css';

const PRESETS = [
  {
    key: 'vla',
    name: 'VLA',
    title: 'Vision-Language-Action',
    query: 'cat:cs.RO AND ("vision-language-action" OR VLA OR "robot foundation model")',
    interval: 360,
    tone: 'red',
  },
  {
    key: 'world',
    name: '世界生成',
    title: 'World Models & Generative Simulation',
    query: 'cat:cs.LG AND ("world model" OR "generative simulation" OR "video generation")',
    interval: 360,
    tone: 'blue',
  },
  {
    key: 'online-rl',
    name: '在线RL',
    title: 'Online Reinforcement Learning',
    query: 'cat:cs.LG AND ("online reinforcement learning" OR "continual reinforcement learning" OR "adaptive RL")',
    interval: 240,
    tone: 'amber',
  },
  {
    key: 'agent',
    name: 'Agent',
    title: 'Agentic Systems',
    query: 'cat:cs.AI AND ("LLM agent" OR "autonomous agent" OR "tool use")',
    interval: 240,
    tone: 'green',
  },
];

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'today', label: '今日' },
  { key: 'saved', label: '收藏' },
];

const state = {
  topics: [],
  currentTopicId: null,
  papers: [],
  saved: new Set(loadSaved()),
  filter: 'all',
  status: { text: '', kind: '' },
  formOpen: true,
  loadingTopics: true,
  loadingPapers: false,
  refreshing: false,
};

const app = document.getElementById('app');

function loadSaved() {
  try {
    const raw = localStorage.getItem('arxiv-extension-saved-papers');
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistSaved() {
  localStorage.setItem('arxiv-extension-saved-papers', JSON.stringify([...state.saved]));
}

function setStatus(text, kind = '') {
  state.status = { text, kind };
  render();
}

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function attr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isToday(value) {
  const date = parseDate(value);
  if (!date) return false;
  const now = new Date();
  return date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
}

function fmtTime(value) {
  const date = parseDate(value);
  if (!date) return '从未更新';
  const diff = Math.max(0, (Date.now() - date.getTime()) / 1000);
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function fmtPaperDate(value) {
  const date = parseDate(value);
  if (!date) return value || '日期未知';
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function normalizeAuthors(authors) {
  if (!Array.isArray(authors) || authors.length === 0) return '作者未知';
  if (authors.length > 4) return `${authors.slice(0, 4).join(', ')} 等 ${authors.length} 人`;
  return authors.join(', ');
}

function currentTopic() {
  return state.topics.find((topic) => topic.id === state.currentTopicId) || null;
}

function visiblePapers() {
  if (state.filter === 'today') {
    return state.papers.filter((paper) => isToday(paper.published_at || paper.updated_at));
  }
  if (state.filter === 'saved') {
    return state.papers.filter((paper) => state.saved.has(paper.arxiv_id));
  }
  return state.papers;
}

function topicStatus(topic) {
  if (topic.last_status === 'error') {
    return {
      className: 'error',
      label: '异常',
      detail: topic.last_error || '上次拉取失败',
    };
  }
  if (topic.last_fetched_at) {
    return {
      className: 'ok',
      label: '已同步',
      detail: fmtTime(topic.last_fetched_at),
    };
  }
  return {
    className: 'idle',
    label: '未拉取',
    detail: `每 ${topic.interval_minutes || 60} 分钟`,
  };
}

function render() {
  const topic = currentTopic();
  const papers = visiblePapers();
  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <span class="brand-mark">arXiv</span>
          <span class="brand-rule"></span>
          <span class="brand-subtitle">research feed</span>
        </div>
        <div class="topbar-actions">
          <div id="status" class="statusline ${attr(state.status.kind)}" role="status">${escapeHtml(state.status.text)}</div>
          <button id="theme-toggle" class="icon-button" type="button" aria-label="切换主题" title="切换主题">
            ${document.documentElement.dataset.theme === 'light' ? moonIcon() : sunIcon()}
          </button>
        </div>
      </header>

      <main class="layout">
        <aside class="sidebar">
          <section class="preset-block" aria-labelledby="preset-title">
            <div class="section-heading">
              <div>
                <p class="eyebrow">presets</p>
                <h2 id="preset-title">研究模块</h2>
              </div>
              <span class="mini-count">4</span>
            </div>
            <div class="preset-grid">
              ${PRESETS.map(renderPreset).join('')}
            </div>
          </section>

          <section class="compose-block" aria-labelledby="compose-title">
            <button id="form-toggle" class="fold-button" type="button" aria-expanded="${state.formOpen ? 'true' : 'false'}">
              <span id="compose-title">添加主题</span>
              <span>${state.formOpen ? '−' : '+'}</span>
            </button>
            <form id="topic-form" class="topic-form ${state.formOpen ? '' : 'is-hidden'}">
              <label>
                <span>名称</span>
                <input id="f-name" name="name" maxlength="100" placeholder="例如：LLM 推理">
              </label>
              <label>
                <span>查询</span>
                <textarea id="f-query" name="query" maxlength="500" rows="4" placeholder='cat:cs.CL AND (LLM OR reasoning)'></textarea>
              </label>
              <label>
                <span>间隔（分钟）</span>
                <input id="f-interval" name="interval" type="number" min="5" max="10080" value="60">
              </label>
              <button id="f-submit" class="primary-button" type="submit">添加</button>
            </form>
          </section>

          <section class="topics-block" aria-labelledby="topics-title">
            <div class="section-heading compact">
              <div>
                <p class="eyebrow">watchlist</p>
                <h2 id="topics-title">我的主题</h2>
              </div>
              <span class="mini-count">${state.topics.length}</span>
            </div>
            <div id="topic-list" class="topic-list">
              ${renderTopics()}
            </div>
          </section>
        </aside>

        <section class="stream" aria-labelledby="stream-title">
          <div class="stream-head">
            <div>
              <p class="eyebrow">paper stream</p>
              <h1 id="stream-title">${topic ? escapeHtml(topic.name) : '选择一个主题'}</h1>
              <p class="stream-query">${topic ? escapeHtml(topic.query) : '从左栏添加或选择研究主题后开始抓取论文。'}</p>
            </div>
            <div class="stream-actions">
              <span class="paper-count">${state.loadingPapers ? '读取中' : `${papers.length}/${state.papers.length} 篇`}</span>
              <button id="refresh-topic" class="secondary-button" type="button" ${topic && !state.refreshing ? '' : 'disabled'}>
                ${refreshIcon()}
                <span>${state.refreshing ? '抓取中' : '立即刷新'}</span>
              </button>
            </div>
          </div>

          <div class="filter-bar" role="tablist" aria-label="论文筛选">
            ${FILTERS.map((filter) => `
              <button class="chip ${state.filter === filter.key ? 'active' : ''}" type="button" data-filter="${filter.key}" role="tab" aria-selected="${state.filter === filter.key ? 'true' : 'false'}">
                ${escapeHtml(filter.label)}
              </button>
            `).join('')}
          </div>

          <div id="papers-list" class="paper-list">
            ${renderPapers(papers, topic)}
          </div>
        </section>
      </main>
    </div>
  `;
  bindEvents();
}

function renderPreset(preset) {
  return `
    <button class="preset-card ${attr(preset.tone)}" type="button" data-preset="${attr(preset.key)}">
      <span class="preset-name">${escapeHtml(preset.name)}</span>
      <span class="preset-title">${escapeHtml(preset.title)}</span>
    </button>
  `;
}

function renderTopics() {
  if (state.loadingTopics) {
    return '<div class="empty-state small">正在读取主题...</div>';
  }
  if (!state.topics.length) {
    return '<div class="empty-state small">还没有主题。先点一个研究模块，或填写自己的 arXiv 查询。</div>';
  }
  return state.topics.map((topic) => {
    const status = topicStatus(topic);
    const active = state.currentTopicId === topic.id ? 'active' : '';
    return `
      <article class="topic-item ${active}" data-topic="${attr(topic.id)}">
        <button class="topic-main" type="button" data-select-topic="${attr(topic.id)}">
          <span class="status-dot ${attr(status.className)}"></span>
          <span class="topic-copy">
            <span class="topic-name">${escapeHtml(topic.name)}</span>
            <code>${escapeHtml(topic.query)}</code>
            <span class="topic-meta">${escapeHtml(status.label)} · ${escapeHtml(status.detail)}</span>
          </span>
        </button>
        <button class="delete-button" type="button" data-delete-topic="${attr(topic.id)}" aria-label="删除 ${attr(topic.name)}" title="删除">
          ${trashIcon()}
        </button>
      </article>
    `;
  }).join('');
}

function renderPapers(papers, topic) {
  if (!topic) {
    return `
      <div class="empty-state hero-empty">
        <span class="empty-kicker">arXiv client</span>
        <h2>把固定检索变成可扫读的论文流。</h2>
      </div>
    `;
  }
  if (state.loadingPapers) {
    return Array.from({ length: 4 }, (_, index) => `
      <article class="paper-card skeleton" style="--delay:${index * 80}ms">
        <div class="sk-line short"></div>
        <div class="sk-line title"></div>
        <div class="sk-line"></div>
        <div class="sk-line"></div>
      </article>
    `).join('');
  }
  if (!state.papers.length) {
    return '<div class="empty-state">还没有论文。点“立即刷新”拉取这个主题的最新结果。</div>';
  }
  if (!papers.length) {
    const label = state.filter === 'today' ? '今日没有匹配论文。' : '还没有收藏论文。';
    return `<div class="empty-state">${label}</div>`;
  }
  return papers.map(renderPaper).join('');
}

function renderPaper(paper) {
  const arxivId = paper.arxiv_id || 'unknown';
  const saved = state.saved.has(arxivId);
  const authors = normalizeAuthors(paper.authors);
  const webResults = Array.isArray(paper.web_results) ? paper.web_results : [];
  const primaryUrl = paper.url || `https://arxiv.org/abs/${encodeURIComponent(arxivId)}`;
  const abstract = paper.abstract || paper.summary || '';
  return `
    <article class="paper-card">
      <div class="fold" aria-hidden="true">${foldSvg()}</div>
      <div class="paper-topline">
        <a class="arxiv-id" href="${attr(primaryUrl)}" target="_blank" rel="noopener">arXiv:${escapeHtml(arxivId)}</a>
        <button class="save-button ${saved ? 'saved' : ''}" type="button" data-save-paper="${attr(arxivId)}" aria-label="${saved ? '取消收藏' : '收藏'}" title="${saved ? '取消收藏' : '收藏'}">
          ${starIcon(saved)}
        </button>
      </div>
      <h2 class="paper-title">
        <a href="${attr(primaryUrl)}" target="_blank" rel="noopener">${escapeHtml(paper.title || '(Untitled)')}</a>
      </h2>
      <div class="paper-meta">
        <span>${escapeHtml(authors)}</span>
        <span>${escapeHtml(fmtPaperDate(paper.published_at))}</span>
      </div>
      <p class="paper-summary">${escapeHtml(paper.summary || '(无摘要)')}</p>
      <div class="paper-links">
        <a href="${attr(primaryUrl)}" target="_blank" rel="noopener">abs</a>
        <a href="https://arxiv.org/pdf/${attr(arxivId)}" target="_blank" rel="noopener">pdf</a>
        ${webResults.slice(0, 3).map((item) => `
          <a href="${attr(item.url || '#')}" target="_blank" rel="noopener">${escapeHtml(item.title || 'web')}</a>
        `).join('')}
      </div>
      ${abstract ? `
        <details class="abstract-block">
          <summary>原文摘要</summary>
          <p>${escapeHtml(abstract)}</p>
        </details>
      ` : ''}
    </article>
  `;
}

function bindEvents() {
  document.getElementById('theme-toggle')?.addEventListener('click', toggleTheme);
  document.getElementById('form-toggle')?.addEventListener('click', () => {
    state.formOpen = !state.formOpen;
    render();
  });
  document.getElementById('topic-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    addTopic();
  });
  document.querySelectorAll('[data-preset]').forEach((button) => {
    button.addEventListener('click', () => fillPreset(button.dataset.preset));
  });
  document.querySelectorAll('[data-select-topic]').forEach((button) => {
    button.addEventListener('click', () => selectTopic(button.dataset.selectTopic));
  });
  document.querySelectorAll('[data-delete-topic]').forEach((button) => {
    button.addEventListener('click', () => deleteTopic(button.dataset.deleteTopic));
  });
  document.querySelectorAll('[data-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      state.filter = button.dataset.filter;
      render();
    });
  });
  document.querySelectorAll('[data-save-paper]').forEach((button) => {
    button.addEventListener('click', () => toggleSaved(button.dataset.savePaper));
  });
  document.getElementById('refresh-topic')?.addEventListener('click', refreshTopic);
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('arxiv-extension-theme', next);
  render();
}

function fillPreset(key) {
  const preset = PRESETS.find((item) => item.key === key);
  if (!preset) return;
  state.formOpen = true;
  state.status = { text: `已填入 ${preset.name} 研究模块`, kind: 'ok' };
  render();
  document.getElementById('f-name').value = preset.name;
  document.getElementById('f-query').value = preset.query;
  document.getElementById('f-interval').value = preset.interval;
  document.getElementById('f-name').focus();
}

function toggleSaved(arxivId) {
  if (!arxivId) return;
  if (state.saved.has(arxivId)) {
    state.saved.delete(arxivId);
  } else {
    state.saved.add(arxivId);
  }
  persistSaved();
  render();
}

async function loadTopics() {
  state.loadingTopics = true;
  render();
  try {
    const data = await extCall({ action: 'list_topics' });
    if (!data.ok) throw new Error(data.error || 'unknown');
    state.topics = Array.isArray(data.topics) ? data.topics : [];
    if (state.currentTopicId && !state.topics.some((topic) => topic.id === state.currentTopicId)) {
      state.currentTopicId = null;
      state.papers = [];
    }
    state.loadingTopics = false;
    state.status = { text: `已加载 ${state.topics.length} 个主题`, kind: 'ok' };
    render();
  } catch (error) {
    state.loadingTopics = false;
    setStatus(`加载主题失败: ${error.message}`, 'err');
  }
}

async function selectTopic(id) {
  if (!id) return;
  state.currentTopicId = id;
  state.papers = [];
  state.loadingPapers = true;
  state.filter = 'all';
  state.status = { text: '加载论文...', kind: '' };
  render();
  try {
    const data = await extCall({ action: 'list_papers', topic_id: id, limit: 50 });
    if (!data.ok) throw new Error(data.error || 'unknown');
    state.papers = Array.isArray(data.papers) ? data.papers : [];
    state.loadingPapers = false;
    setStatus(`已加载 ${state.papers.length} 篇论文`, 'ok');
  } catch (error) {
    state.loadingPapers = false;
    setStatus(`加载论文失败: ${error.message}`, 'err');
  }
}

async function addTopic() {
  const name = document.getElementById('f-name').value.trim();
  const query = document.getElementById('f-query').value.trim();
  const interval = Number(document.getElementById('f-interval').value) || 60;
  if (!name || !query) {
    setStatus('名称和查询都不能为空', 'err');
    return;
  }
  const submit = document.getElementById('f-submit');
  submit.disabled = true;
  try {
    const data = await extCall({
      action: 'add_topic',
      name,
      query,
      interval_minutes: interval,
    });
    if (!data.ok) throw new Error(data.error || 'unknown');
    state.formOpen = false;
    setStatus(`已添加主题: ${data.topic?.name || name}`, 'ok');
    await loadTopics();
    if (data.topic?.id) await selectTopic(data.topic.id);
  } catch (error) {
    setStatus(`添加失败: ${error.message}`, 'err');
  } finally {
    const nextSubmit = document.getElementById('f-submit');
    if (nextSubmit) nextSubmit.disabled = false;
  }
}

async function deleteTopic(id) {
  const topic = state.topics.find((item) => item.id === id);
  if (!topic) return;
  if (!confirm(`删除主题「${topic.name}」及其所有论文?`)) return;
  try {
    const data = await extCall({ action: 'delete_topic', topic_id: id });
    if (!data.ok) throw new Error(data.error || 'unknown');
    if (state.currentTopicId === id) {
      state.currentTopicId = null;
      state.papers = [];
    }
    setStatus(`已删除主题 (${data.removed?.papers || 0} 篇论文)`, 'ok');
    await loadTopics();
  } catch (error) {
    setStatus(`删除失败: ${error.message}`, 'err');
  }
}

async function refreshTopic() {
  if (!state.currentTopicId || state.refreshing) return;
  state.refreshing = true;
  state.status = { text: '抓取中... 这可能需要 5-15 秒', kind: '' };
  render();
  try {
    const data = await extCall({ action: 'refresh_topic', topic_id: state.currentTopicId });
    if (!data.ok) throw new Error(data.error || 'unknown');
    state.refreshing = false;
    setStatus(`抓取完成: ${data.inserted || 0}/${data.fetched || 0} 新论文`, 'ok');
    await loadTopics();
    await selectTopic(state.currentTopicId);
  } catch (error) {
    state.refreshing = false;
    setStatus(`抓取失败: ${error.message}`, 'err');
  }
}

function sunIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"></path></svg>';
}

function moonIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"></path></svg>';
}

function refreshIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 0 1-15.5 6.25M3 12A9 9 0 0 1 18.5 5.75"></path><path d="M18 2v4h4M6 22v-4H2"></path></svg>';
}

function trashIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"></path></svg>';
}

function starIcon(saved) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" class="${saved ? 'filled' : ''}"><path d="m12 3 2.7 5.47 6.03.88-4.36 4.25 1.03 6-5.4-2.84-5.4 2.84 1.03-6-4.36-4.25 6.03-.88L12 3Z"></path></svg>`;
}

function foldSvg() {
  return '<svg viewBox="0 0 44 44" aria-hidden="true"><path d="M0 0h44L0 44V0Z"></path><path d="M9 8h18M9 15h12"></path></svg>';
}

render();
loadTopics();
