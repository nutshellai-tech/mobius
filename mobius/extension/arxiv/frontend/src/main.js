import { extCall } from '/extension/_sdk/ext.js';
import './style.css';

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'today', label: '今日新增' },
  { key: 'saved', label: '阅读清单' },
];

const state = {
  topics: [],
  presets: [],
  currentTopicId: null,
  selectedPaperId: null,
  papers: [],
  saved: new Set(loadSaved()),
  filter: 'all',
  status: { text: '', kind: '' },
  formOpen: false,
  loadingTopics: true,
  loadingPapers: false,
  refreshing: false,
  editingTopicId: null,
};

// 把 server 返回的 preset_key 映射到本地色板, 给预置主题一个轻色调味 (保持视觉延续)
const PRESET_TONE = {
  'vla': 'rose',
  'world': 'blue',
  'online-rl': 'amber',
  'agent': 'teal',
};

function presetToneFor(topic) {
  if (!topic) return '';
  return PRESET_TONE[topic.preset_key] || '';
}

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
  if (!date) return '从未同步';
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
    return state.papers.filter((paper) => isToday(paper.published_at || paper.created_at));
  }
  if (state.filter === 'saved') {
    return state.papers.filter((paper) => state.saved.has(paper.arxiv_id));
  }
  return state.papers;
}

function selectedPaper(papers = visiblePapers()) {
  return papers.find((paper) => String(paper.id) === String(state.selectedPaperId))
    || papers[0]
    || state.papers[0]
    || null;
}

function latestFetchedAt() {
  const dates = state.topics
    .map((topic) => parseDate(topic.last_fetched_at))
    .filter(Boolean)
    .sort((a, b) => b.getTime() - a.getTime());
  return dates[0] || null;
}

function nextRunText() {
  const topic = currentTopic();
  if (!topic?.last_fetched_at) return topic ? `每 ${topic.interval_minutes || 60} 分钟` : '选择主题后显示';
  const last = parseDate(topic.last_fetched_at);
  if (!last) return `每 ${topic.interval_minutes || 60} 分钟`;
  const next = new Date(last.getTime() + (topic.interval_minutes || 60) * 60_000);
  if (next.getTime() <= Date.now()) return '等待调度';
  return next.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function topicStatus(topic) {
  if (topic.last_status === 'error') {
    return {
      className: 'error',
      label: '异常',
      detail: topic.last_error || '上次抓取失败',
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
    label: '待同步',
    detail: `每 ${topic.interval_minutes || 60} 分钟`,
  };
}

function paperScore(paper, index = 0) {
  let score = 58;
  if (isToday(paper.published_at || paper.created_at)) score += 18;
  if (Array.isArray(paper.web_results) && paper.web_results.length) score += Math.min(12, paper.web_results.length * 4);
  if (state.saved.has(paper.arxiv_id)) score += 8;
  score += Math.max(0, 8 - index * 2);
  return Math.max(35, Math.min(98, score));
}

function recommendationReasons(paper, topic) {
  const reasons = [];
  const query = topic?.query || '';
  const catMatch = query.match(/cat:([a-zA-Z.-]+)/);
  if (catMatch) reasons.push(`分类 ${catMatch[1]}`);
  if (isToday(paper.published_at || paper.created_at)) reasons.push('今日新增');
  const webCount = Array.isArray(paper.web_results) ? paper.web_results.length : 0;
  if (webCount) reasons.push(`${webCount} 条外部讨论`);
  if (state.saved.has(paper.arxiv_id)) reasons.push('已加入阅读清单');
  if (!reasons.length) reasons.push('命中当前订阅查询');
  return reasons.slice(0, 3);
}

function statusSummary() {
  const latest = latestFetchedAt();
  if (state.refreshing) return { label: '同步中', detail: '正在拉取 arXiv 与外部讨论', kind: 'syncing' };
  if (state.status.kind === 'err') return { label: '需要处理', detail: state.status.text || '最近一次操作失败', kind: 'error' };
  if (latest) return { label: '已同步', detail: fmtTime(latest.toISOString()), kind: 'ok' };
  return { label: '待配置', detail: '添加主题后开始抓取', kind: 'idle' };
}

function render() {
  const topic = currentTopic();
  const papers = visiblePapers();
  const selected = selectedPaper(papers);
  const errors = state.topics.filter((item) => item.last_status === 'error').length;
  const todayCount = state.papers.filter((paper) => isToday(paper.published_at || paper.created_at)).length;
  const status = statusSummary();

  app.innerHTML = `
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <span class="brand-mark">arXiv</span>
          <span class="brand-title">研究雷达</span>
        </div>
        <div class="top-metrics" aria-label="抓取状态">
          ${renderTopMetric(status.label, status.detail, status.kind)}
          ${renderTopMetric('订阅', `${state.topics.length} 个主题`, '')}
          ${renderTopMetric('今日新增', `${todayCount} 篇`, '')}
          ${renderTopMetric('下一次', nextRunText(), '')}
          ${errors ? renderTopMetric('异常', `${errors} 个主题`, 'error') : ''}
        </div>
        <div class="topbar-actions">
          <div id="status" class="statusline ${attr(state.status.kind)}" role="status">${escapeHtml(state.status.text)}</div>
          <button id="theme-toggle" class="icon-button" type="button" aria-label="切换主题" title="切换主题">
            ${document.documentElement.dataset.theme === 'light' ? moonIcon() : sunIcon()}
          </button>
        </div>
      </header>

      <main class="research-layout">
        <aside class="sidebar" aria-label="订阅主题">
          <section class="panel compose-block" aria-labelledby="compose-title">
            <button id="form-toggle" class="fold-button" type="button" aria-expanded="${state.formOpen ? 'true' : 'false'}">
              <span id="compose-title">添加研究主题</span>
              <span>${state.formOpen ? '收起' : '新建'}</span>
            </button>
            <form id="topic-form" class="topic-form ${state.formOpen ? '' : 'is-hidden'}">
              <label>
                <span>主题名称</span>
                <input id="f-name" name="name" maxlength="100" placeholder="例如：LLM 推理">
              </label>
              <label>
                <span>arXiv 查询</span>
                <textarea id="f-query" name="query" maxlength="500" rows="4" placeholder='cat:cs.CL AND (LLM OR reasoning)'></textarea>
              </label>
              <label>
                <span>抓取间隔（分钟）</span>
                <input id="f-interval" name="interval" type="number" min="5" max="10080" value="60">
              </label>
              ${renderPresetLibrary()}
              <button id="f-submit" class="primary-button" type="submit">添加主题</button>
            </form>
          </section>

          <section class="panel topics-block" aria-labelledby="topics-title">
            <div class="section-heading compact">
              <div>
                <p class="eyebrow">Watchlist</p>
                <h2 id="topics-title">订阅主题</h2>
              </div>
              <span class="mini-count">${state.topics.length}</span>
            </div>
            <div id="topic-list" class="topic-list">
              ${renderTopics()}
            </div>
          </section>
        </aside>

        <section class="stream" aria-labelledby="stream-title">
          <div class="stream-head panel">
            <div class="stream-copy">
              <p class="eyebrow">Paper stream</p>
              <h1 id="stream-title">${topic ? escapeHtml(topic.name) : '选择一个研究主题'}</h1>
              <p class="stream-query">${topic ? escapeHtml(topic.query) : '从左侧添加订阅主题，或选择一个预设模块。抓取完成后，这里会变成按时间和相关度整理的论文流。'}</p>
            </div>
            <div class="stream-actions">
              <span class="paper-count">${state.loadingPapers ? '读取中' : `${papers.length}/${state.papers.length} 篇`}</span>
              <button id="refresh-topic" class="secondary-button" type="button" ${topic && !state.refreshing ? '' : 'disabled'}>
                ${refreshIcon()}
                <span>${state.refreshing ? '抓取中' : '立即同步'}</span>
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

        <aside class="insight panel" aria-label="论文洞察">
          ${renderInsightPanel({ selected, topic, papers })}
        </aside>
      </main>
    </div>
  `;
  bindEvents();
}

function renderTopMetric(label, detail, kind) {
  return `
    <div class="top-metric ${attr(kind)}">
      <span class="metric-dot" aria-hidden="true"></span>
      <span>
        <strong>${escapeHtml(label)}</strong>
        <small>${escapeHtml(detail)}</small>
      </span>
    </div>
  `;
}

function renderPresetLibrary() {
  // 列出"用户已删的"预置, 让用户可以从预置模板再添加回来
  const topicsWithKey = new Set(state.topics.filter((t) => t.preset_key).map((t) => t.preset_key));
  const available = state.presets.filter((p) => !topicsWithKey.has(p.key));
  if (!state.presets.length || !available.length) {
    return '<p class="preset-library-empty">没有可用的预置模板，全部已添加。</p>';
  }
  return `
    <div class="preset-library">
      <span class="preset-library-label">或从预置添加</span>
      <div class="preset-library-row">
        <select id="f-preset-key" name="preset_key" class="preset-select">
          ${available.map((p) => `<option value="${attr(p.key)}">${escapeHtml(p.name)} · ${escapeHtml(p.title)}</option>`).join('')}
        </select>
        <button type="button" id="f-preset-fill" class="ghost-button" aria-label="把选中预置填入表单">填入</button>
      </div>
    </div>
  `;
}

function renderTopics() {
  if (state.loadingTopics) {
    return '<div class="empty-state small">正在读取订阅主题...</div>';
  }
  if (!state.topics.length) {
    return `
      <div class="empty-state small">
        <strong>先添加一个研究主题</strong>
        <span>可以选择预设模块，也可以用关键词和 arXiv 分类创建自己的订阅。</span>
      </div>
    `;
  }
  return state.topics.map((topic) => {
    const status = topicStatus(topic);
    const active = state.currentTopicId === topic.id ? 'active' : '';
    const isEditing = state.editingTopicId === topic.id;
    if (isEditing) {
      return `
        <article class="topic-item editing ${active}" data-topic="${attr(topic.id)}">
          <form class="topic-edit-form" data-edit-form="${attr(topic.id)}">
            <label>
              <span>主题名称</span>
              <input name="name" maxlength="100" value="${attr(topic.name)}" required>
            </label>
            <label>
              <span>arXiv 查询</span>
              <textarea name="query" maxlength="500" rows="3" required>${escapeHtml(topic.query)}</textarea>
            </label>
            <label>
              <span>间隔（分钟）</span>
              <input name="interval_minutes" type="number" min="5" max="10080" value="${attr(topic.interval_minutes || 60)}">
            </label>
            <div class="topic-edit-actions">
              <button type="button" class="secondary-button" data-cancel-edit="${attr(topic.id)}">取消</button>
              <button type="submit" class="primary-button">保存</button>
            </div>
          </form>
        </article>
      `;
    }
    return `
      <article class="topic-item ${active} ${topic.is_preset ? 'is-preset ' + attr(presetToneFor(topic)) : ''}" data-topic="${attr(topic.id)}">
        <button class="topic-main" type="button" data-select-topic="${attr(topic.id)}">
          <span class="status-dot ${attr(status.className)}"></span>
          <span class="topic-copy">
            <span class="topic-name">${escapeHtml(topic.name)}${topic.is_preset ? '<span class="preset-tag" title="内置预置, 可编辑/删除">预置</span>' : ''}</span>
            <code>${escapeHtml(topic.query)}</code>
            <span class="topic-meta">${escapeHtml(status.label)} · ${escapeHtml(status.detail)}</span>
          </span>
        </button>
        <div class="topic-actions">
          <button class="edit-button" type="button" data-edit-topic="${attr(topic.id)}" aria-label="编辑 ${attr(topic.name)}" title="编辑">
            ${pencilIcon()}
          </button>
          <button class="delete-button" type="button" data-delete-topic="${attr(topic.id)}" aria-label="删除 ${attr(topic.name)}" title="删除">
            ${trashIcon()}
          </button>
        </div>
      </article>
    `;
  }).join('');
}

function renderPapers(papers, topic) {
  if (!topic) {
    return `
      <div class="empty-state hero-empty">
        <span class="empty-kicker">Research radar</span>
        <h2>把固定检索变成可跟进的论文情报台。</h2>
        <p>订阅关键词或 arXiv 分类，后台定时抓取摘要，并把外部讨论放到同一个阅读流里。</p>
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
    return `
      <div class="empty-state">
        <strong>这个主题还没有论文</strong>
        <span>点击“立即同步”拉取最新结果。若持续为空，可以放宽关键词或检查 arXiv 分类。</span>
      </div>
    `;
  }
  if (!papers.length) {
    const label = state.filter === 'today' ? '今日没有匹配论文。' : '阅读清单里还没有当前主题的论文。';
    return `
      <div class="empty-state">
        <strong>${escapeHtml(label)}</strong>
        <span>${state.filter === 'saved' ? '在论文卡片上点星标后，它会出现在这里。' : '可以切回全部，或稍后等待下一次自动抓取。'}</span>
      </div>
    `;
  }
  return papers.map((paper, index) => renderPaper(paper, index, topic)).join('');
}

function renderPaper(paper, index, topic) {
  const arxivId = paper.arxiv_id || 'unknown';
  const saved = state.saved.has(arxivId);
  const authors = normalizeAuthors(paper.authors);
  const webResults = Array.isArray(paper.web_results) ? paper.web_results : [];
  const primaryUrl = paper.url || `https://arxiv.org/abs/${encodeURIComponent(arxivId)}`;
  const abstract = paper.abstract || paper.summary || '';
  const score = paperScore(paper, index);
  const reasons = recommendationReasons(paper, topic);
  const featured = index === 0 && state.filter !== 'saved' ? 'featured' : '';
  const selected = String(selectedPaperIdSafe()) === String(paper.id) ? 'selected' : '';
  return `
    <article class="paper-card ${featured} ${selected}">
      <div class="impact-rail" aria-hidden="true" style="--score:${score}%"></div>
      <div class="paper-topline">
        <a class="arxiv-id" href="${attr(primaryUrl)}" target="_blank" rel="noopener">arXiv:${escapeHtml(arxivId)}</a>
        <div class="paper-tools">
          <span class="score-pill">${score}</span>
          <button class="save-button ${saved ? 'saved' : ''}" type="button" data-save-paper="${attr(arxivId)}" aria-label="${saved ? '取消收藏' : '加入阅读清单'}" title="${saved ? '取消收藏' : '加入阅读清单'}">
            ${starIcon(saved)}
          </button>
        </div>
      </div>
      <h2 class="paper-title">
        <a href="${attr(primaryUrl)}" target="_blank" rel="noopener">${escapeHtml(paper.title || '(Untitled)')}</a>
      </h2>
      <div class="paper-meta">
        <span>${escapeHtml(authors)}</span>
        <span>${escapeHtml(fmtPaperDate(paper.published_at))}</span>
      </div>
      <div class="reason-row">
        ${reasons.map((reason) => `<span>${escapeHtml(reason)}</span>`).join('')}
      </div>
      <p class="paper-summary">${escapeHtml(paper.summary || abstract || '(无摘要)')}</p>
      <div class="paper-actions">
        <a class="link-pill primary-link" href="${attr(primaryUrl)}" target="_blank" rel="noopener">打开 arXiv</a>
        <a class="link-pill" href="https://arxiv.org/pdf/${attr(arxivId)}" target="_blank" rel="noopener">PDF</a>
        <button class="link-pill ghost" type="button" data-preview-paper="${attr(paper.id)}">详情</button>
        ${webResults.slice(0, 2).map((item) => `
          <a class="link-pill" href="${attr(item.url || '#')}" target="_blank" rel="noopener">${escapeHtml(item.source || 'web')}</a>
        `).join('')}
      </div>
      ${abstract ? `
        <details class="abstract-block">
          <summary>展开原始摘要</summary>
          <p>${escapeHtml(abstract)}</p>
        </details>
      ` : ''}
    </article>
  `;
}

function selectedPaperIdSafe() {
  return selectedPaper()?.id || null;
}

function renderInsightPanel({ selected, topic, papers }) {
  if (!topic) {
    return `
      <div class="insight-empty">
        <p class="eyebrow">Insight</p>
        <h2>等待研究主题</h2>
        <p>选择左侧主题后，这里会展示今日焦点、外部讨论和当前论文的阅读线索。</p>
      </div>
    `;
  }

  const status = topicStatus(topic);
  if (!selected) {
    return `
      <div class="insight-stack">
        <div class="insight-header">
          <p class="eyebrow">Topic status</p>
          <h2>${escapeHtml(topic.name)}</h2>
          <span class="insight-status ${attr(status.className)}">${escapeHtml(status.label)} · ${escapeHtml(status.detail)}</span>
        </div>
        <div class="empty-state small">同步后会在这里显示重点论文和外部讨论。</div>
      </div>
    `;
  }

  const score = paperScore(selected, Math.max(0, papers.findIndex((paper) => paper.id === selected.id)));
  const webResults = Array.isArray(selected.web_results) ? selected.web_results : [];
  const reasons = recommendationReasons(selected, topic);
  const primaryUrl = selected.url || `https://arxiv.org/abs/${encodeURIComponent(selected.arxiv_id || '')}`;

  return `
    <div class="insight-stack">
      <div class="insight-header">
        <p class="eyebrow">Focused paper</p>
        <h2>${escapeHtml(selected.title || '未命名论文')}</h2>
        <div class="score-block">
          <strong>${score}</strong>
          <span>推荐热度</span>
        </div>
      </div>

      <section class="insight-section">
        <h3>为什么值得看</h3>
        <div class="reason-row vertical">
          ${reasons.map((reason) => `<span>${escapeHtml(reason)}</span>`).join('')}
        </div>
      </section>

      <section class="insight-section">
        <h3>快速摘要</h3>
        <p>${escapeHtml(selected.summary || selected.abstract || '暂无摘要。')}</p>
      </section>

      <section class="insight-section">
        <h3>外部讨论</h3>
        ${webResults.length ? `
          <div class="web-list">
            ${webResults.slice(0, 4).map((item) => `
              <a href="${attr(item.url || '#')}" target="_blank" rel="noopener">
                <strong>${escapeHtml(item.title || item.source || '相关链接')}</strong>
                <span>${escapeHtml(item.snippet || item.source || '外部来源')}</span>
              </a>
            `).join('')}
          </div>
        ` : '<p>当前还没有补充讨论。刷新主题时会尝试抓取相关链接。</p>'}
      </section>

      <section class="insight-actions">
        <a class="primary-button" href="${attr(primaryUrl)}" target="_blank" rel="noopener">打开 arXiv</a>
        <button class="secondary-button" type="button" data-save-paper="${attr(selected.arxiv_id)}">${state.saved.has(selected.arxiv_id) ? '移出阅读清单' : '加入阅读清单'}</button>
      </section>
    </div>
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
  document.getElementById('f-preset-fill')?.addEventListener('click', () => {
    const sel = document.getElementById('f-preset-key');
    if (sel) fillPreset(sel.value);
  });
  document.querySelectorAll('[data-select-topic]').forEach((button) => {
    button.addEventListener('click', () => selectTopic(button.dataset.selectTopic));
  });
  document.querySelectorAll('[data-edit-topic]').forEach((button) => {
    button.addEventListener('click', () => {
      state.editingTopicId = button.dataset.editTopic;
      render();
    });
  });
  document.querySelectorAll('[data-cancel-edit]').forEach((button) => {
    button.addEventListener('click', () => {
      state.editingTopicId = null;
      render();
    });
  });
  document.querySelectorAll('[data-edit-form]').forEach((form) => {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      saveTopicEdit(form.dataset.editForm, form);
    });
  });
  document.querySelectorAll('[data-delete-topic]').forEach((button) => {
    button.addEventListener('click', () => deleteTopic(button.dataset.deleteTopic));
  });
  document.querySelectorAll('[data-filter]').forEach((button) => {
    button.addEventListener('click', () => {
      state.filter = button.dataset.filter;
      state.selectedPaperId = null;
      render();
    });
  });
  document.querySelectorAll('[data-save-paper]').forEach((button) => {
    button.addEventListener('click', () => toggleSaved(button.dataset.savePaper));
  });
  document.querySelectorAll('[data-preview-paper]').forEach((button) => {
    button.addEventListener('click', () => {
      state.selectedPaperId = button.dataset.previewPaper;
      render();
    });
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
  const preset = state.presets.find((item) => item.key === key);
  if (!preset) return;
  state.formOpen = true;
  state.status = { text: `已填入 ${preset.name} 研究模块, 确认或修改后点击"添加主题"`, kind: 'ok' };
  render();
  document.getElementById('f-name').value = preset.name;
  document.getElementById('f-query').value = preset.query;
  document.getElementById('f-interval').value = preset.interval_minutes || preset.interval || 60;
  document.getElementById('f-name').focus();
  document.getElementById('f-name').select();
  document.getElementById('topic-form')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function saveTopicEdit(id, form) {
  const fd = new FormData(form);
  const name = String(fd.get('name') || '').trim();
  const query = String(fd.get('query') || '').trim();
  const interval_minutes = Number(fd.get('interval_minutes')) || 60;
  if (!name || !query) {
    setStatus('名称和查询都不能为空', 'err');
    return;
  }
  const submit = form.querySelector('button[type="submit"]');
  if (submit) submit.disabled = true;
  try {
    const data = await extCall({
      action: 'update_topic',
      topic_id: id,
      name,
      query,
      interval_minutes,
    });
    if (!data.ok) throw new Error(data.error || 'unknown');
    state.editingTopicId = null;
    setStatus(`已更新 ${data.topic?.name || name}`, 'ok');
    await loadTopics();
    // 如果当前正看着这个主题, 切到新 query 重新拉论文
    if (state.currentTopicId === id) {
      await selectTopic(id);
    }
  } catch (error) {
    setStatus(`更新失败: ${error.message}`, 'err');
    if (submit) submit.disabled = false;
  }
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
    const [topicsData, presetsData] = await Promise.all([
      extCall({ action: 'list_topics' }),
      extCall({ action: 'list_presets' }),
    ]);
    if (!topicsData.ok) throw new Error(topicsData.error || 'unknown');
    state.topics = Array.isArray(topicsData.topics) ? topicsData.topics : [];
    if (presetsData.ok) {
      state.presets = Array.isArray(presetsData.presets) ? presetsData.presets : [];
    } else {
      state.presets = [];
    }
    if (state.currentTopicId && !state.topics.some((topic) => topic.id === state.currentTopicId)) {
      state.currentTopicId = null;
      state.selectedPaperId = null;
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
  state.selectedPaperId = null;
  state.papers = [];
  state.loadingPapers = true;
  state.filter = 'all';
  state.status = { text: '加载论文...', kind: '' };
  render();
  try {
    const data = await extCall({ action: 'list_papers', topic_id: id, limit: 80 });
    if (!data.ok) throw new Error(data.error || 'unknown');
    state.papers = Array.isArray(data.papers) ? data.papers : [];
    state.selectedPaperId = state.papers[0]?.id || null;
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
  const presetKey = document.getElementById('f-preset-key')?.value || '';
  if (!name || !query) {
    setStatus('名称和查询都不能为空', 'err');
    return;
  }
  const submit = document.getElementById('f-submit');
  submit.disabled = true;
  try {
    const payload = {
      action: 'add_topic',
      name,
      query,
      interval_minutes: interval,
    };
    if (presetKey) payload.preset_key = presetKey;
    const data = await extCall(payload);
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
      state.selectedPaperId = null;
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
    setStatus(`抓取完成: ${data.inserted || 0}/${data.fetched || 0} 篇新论文`, 'ok');
    const topicId = state.currentTopicId;
    await loadTopics();
    await selectTopic(topicId);
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

function pencilIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.06 4.94 19.06 9.94M4 20l4.5-1 11-11a2.12 2.12 0 0 0-3-3l-11 11L4 20Z"></path></svg>';
}

function starIcon(saved) {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" class="${saved ? 'filled' : ''}"><path d="m12 3 2.7 5.47 6.03.88-4.36 4.25 1.03 6-5.4-2.84-5.4 2.84 1.03-6-4.36-4.25 6.03-.88L12 3Z"></path></svg>`;
}

render();
loadTopics();
