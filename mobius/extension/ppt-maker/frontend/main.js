import { extCall, extUpload } from '/extension/_sdk/ext.js';

const THEME_KEY = 'ppt-maker:theme';
const ROUTES = ['compose', 'templates', 'history', 'http'];
const MAX_TEXT_SOURCE_BYTES = 3 * 1024 * 1024;
const TEXT_SOURCE_LIMIT_LABEL = '3 MB';

const els = {
  app: document.getElementById('app'),
  skillStatus: document.getElementById('skillStatus'),
  refreshBtn: document.getElementById('refreshBtn'),
  refreshStatus: document.getElementById('refreshStatus'),
  themeToggleBtn: document.getElementById('themeToggleBtn'),
  globalSearch: document.getElementById('globalSearch'),
  toast: document.getElementById('toast'),
};

const state = {
  route: routeFromHash(),
  theme: localStorage.getItem(THEME_KEY) || 'light',
  search: '',
  templates: [],
  templateAssets: {
    featured: [],
    decks: [],
    layouts: [],
    brands: [],
    icons: [],
    charts: [],
  },
  uploads: [],
  projects: [],
  selectedUploadIds: new Set(),
  selectedTemplateId: 'free',
  form: {
    topic: '',
    sourceInput: '',
    format: 'ppt169',
    pageCount: 4,
    notes: '',
  },
  skill: null,
  busy: false,
  progress: {
    label: '等待输入',
    active: false,
  },
  lastOutput: null,
  error: '',
  live: null,
};

function routeFromHash() {
  const value = window.location.hash.replace(/^#\/?/, '').trim();
  return ROUTES.includes(value) ? value : 'compose';
}

function navigate(route) {
  state.route = ROUTES.includes(route) ? route : 'compose';
  window.location.hash = state.route;
  render();
}

function toast(message, tone = 'ok') {
  els.toast.textContent = message;
  els.toast.dataset.tone = tone;
  els.toast.classList.add('show');
  window.clearTimeout(toast.timer);
  toast.timer = window.setTimeout(() => els.toast.classList.remove('show'), 2600);
}

function setBusy(value, label = '') {
  state.busy = value;
  if (label) state.progress.label = label;
  state.progress.active = value;
  if (!value && !label) {
    state.progress.label = state.live?.status === 'running' ? 'agent 正在生成 PPTX' : '等待输入';
  }
  els.refreshBtn.disabled = value;
  const generateBtn = document.getElementById('generateBtn');
  const pickFileBtn = document.getElementById('pickFileBtn');
  if (generateBtn) generateBtn.disabled = value;
  if (pickFileBtn) pickFileBtn.disabled = value;
  document.querySelectorAll([
    '[data-action="clear-uploads"]',
    '[data-action="delete-upload"]',
    '[data-action="unselect-upload"]',
    '#uploadList input[type="checkbox"]',
  ].join(',')).forEach((control) => {
    control.disabled = value;
  });
  document.getElementById('dropZone')?.classList.toggle('is-disabled', value);
  updateShell();
}

function setProgress(label, active = state.busy) {
  state.progress = {
    label,
    active,
  };
  renderTopState();
  const progressText = document.getElementById('progressText');
  if (progressText) progressText.textContent = label;
}

function renderTopState() {
  document.documentElement.dataset.theme = state.theme;
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  els.themeToggleBtn.textContent = state.theme === 'dark' ? '浅色' : '深色';
  els.themeToggleBtn.setAttribute('aria-pressed', state.theme === 'dark' ? 'true' : 'false');
}

function updateShell() {
  applyTheme();
  document.querySelectorAll('.nav-btn').forEach((button) => {
    button.classList.toggle('active', button.dataset.route === state.route);
  });
  const ready = state.skill?.ok || state.skill?.user?.exists || state.skill?.shared?.exists;
  els.skillStatus.textContent = ready
    ? '从材料到演示文稿 · ppt-maker 技能套件已就绪'
    : state.error || '从材料到演示文稿 · 正在连接 ppt-maker';
  els.refreshStatus.textContent = state.busy
    ? '处理中'
    : ready
      ? `${state.projects.length} 个项目`
      : '待连接';
  els.globalSearch.value = state.search;
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

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#096;');
}

function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function textByteLength(value) {
  return new TextEncoder().encode(String(value || '')).length;
}

const SOURCE_URL_RE = /https?:\/\/[^\s<>"'`)\]]+/gi;

function normalizeSourceUrl(url) {
  return String(url || '').trim().replace(/[),.;，。；、）]+$/g, '');
}

function urlsFromUrlOnlyLine(line) {
  const candidate = String(line || '')
    .trim()
    .replace(/^([-*+]\s+|\d+[.)]\s+)/, '')
    .trim();
  if (!candidate) return [];
  SOURCE_URL_RE.lastIndex = 0;
  const urls = (candidate.match(SOURCE_URL_RE) || []).map(normalizeSourceUrl).filter(Boolean);
  if (!urls.length) return [];
  const remainder = candidate
    .replace(SOURCE_URL_RE, '')
    .replace(/[\s,，;；、|]+/g, '')
    .trim();
  return remainder ? [] : urls;
}

function urlsFromLine(line) {
  SOURCE_URL_RE.lastIndex = 0;
  return (String(line || '').match(SOURCE_URL_RE) || []).map(normalizeSourceUrl).filter(Boolean);
}

function splitSourceInput(value) {
  const urls = [];
  const seen = new Set();
  const markdownLines = [];
  for (const line of String(value || '').split(/\r?\n/)) {
    const allLineUrls = urlsFromLine(line);
    if (allLineUrls.length) {
      for (const url of allLineUrls) {
        if (seen.has(url)) continue;
        seen.add(url);
        urls.push(url);
      }
    }
    if (urlsFromUrlOnlyLine(line).length) {
      continue;
    }
    markdownLines.push(line);
  }
  return {
    urls,
    markdown: markdownLines.join('\n').trim(),
  };
}

function formatDate(value) {
  if (!value) return '未知时间';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function tokenParam() {
  const token = localStorage.getItem('cc-token') || '';
  return token ? `&token=${encodeURIComponent(token)}` : '';
}

function downloadUrl(url) {
  if (!url) return '';
  return url.includes('?') ? `${url}${tokenParam()}` : url;
}

function shortPath(path) {
  const text = String(path || '');
  if (!text) return '';
  const marker = '/protected_data/extension/ppt-maker/';
  const idx = text.indexOf(marker);
  return idx >= 0 ? `...${text.slice(idx + marker.length - 1)}` : text;
}

function normalizeTemplate(item) {
  return {
    id: item.id || item.name || 'free',
    raw_id: item.raw_id || item.id || '',
    name: item.name || item.id || '自由设计',
    kind: item.kind || 'template',
    kind_label: item.kind_label || (item.kind === 'free' ? '自由设计' : '内置模板'),
    summary: item.summary || '',
    source_summary: item.source_summary || '',
    template_path: item.template_path || '',
    template_rel_path: item.template_rel_path || '',
    primary_color: item.primary_color || item.color || '',
    page_count: item.page_count || null,
    canvas_format: item.canvas_format || '',
    preview_url: item.preview_url || item.cover_url || '',
    asset_count: item.asset_count || null,
  };
}

function selectedTemplate() {
  return state.templates.find((item) => item.id === state.selectedTemplateId)
    || state.templateAssets.featured.find((item) => item.id === state.selectedTemplateId)
    || state.templates[0]
    || { id: 'free', name: '自由设计', kind: 'free', kind_label: '自由设计', summary: '不绑定模板，由 ppt-maker 自动生成视觉方向。' };
}

function allTemplateCards() {
  const featured = state.templateAssets.featured || [];
  const pool = [
    ...featured,
    ...(state.templateAssets.decks || []),
    ...(state.templateAssets.layouts || []),
    ...(state.templateAssets.brands || []),
  ].map(normalizeTemplate);
  const seen = new Set();
  const out = [];
  for (const item of pool) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function filteredProjects() {
  const query = state.search.trim().toLowerCase();
  if (!query) return state.projects;
  return state.projects.filter((project) => {
    const haystack = [
      project.id,
      project.name,
      project.topic,
      project.template,
      project.source_kind,
      project.output_path,
      project.created_at,
      project.hidden_from_main ? '已隐藏 从主界面隐藏' : '主界面显示',
    ].join(' ').toLowerCase();
    return haystack.includes(query);
  });
}

function mainVisibleProjects() {
  return state.projects.filter((project) => !project.hidden_from_main);
}

function filteredTemplates() {
  const query = state.search.trim().toLowerCase();
  const cards = allTemplateCards();
  if (!query) return cards;
  return cards.filter((item) => {
    const haystack = [item.id, item.name, item.kind, item.summary].join(' ').toLowerCase();
    return haystack.includes(query);
  });
}

function renderCompose() {
  const tpl = selectedTemplate();
  const visibleProjects = mainVisibleProjects();
  return `
    <div class="compose-page">
      <section class="hero-band">
        <div class="hero-copy">
          <span class="eyebrow"><i></i> PPT Maker 工作流</span>
          <h2>把散落材料变成<span class="gradient-text">可交付演示文稿</span></h2>
          <p>粘贴网页、上传文档、选择模板，交给完整 ppt-maker 技能流程生成 PPTX；实时进度、关键产物和历史记录都在同一个工作台里。</p>
          <div class="hero-actions">
            <button class="primary-btn" type="button" data-action="focus-topic">开始填写</button>
            <button class="secondary-btn" type="button" data-route="templates">浏览模板</button>
          </div>
        </div>
        <div class="hero-visual" aria-label="PPT Maker 生成流程">
          <div class="deck-stage">
            <div class="deck-card deck-card-1">
              <span></span><strong></strong><i></i>
            </div>
            <div class="deck-card deck-card-2">
              <span></span><strong></strong><i></i>
            </div>
            <div class="deck-card deck-card-3">
              <span></span><strong></strong><i></i>
            </div>
          </div>
          <div class="pipeline-strip">
            <span>材料</span>
            <span>策略</span>
            <span>设计</span>
            <span>PPTX</span>
          </div>
        </div>
        <div class="hero-stats" aria-label="生成状态">
          <div><strong>${state.uploads.length}</strong><span>源文件</span></div>
          <div><strong>${state.templates.length}</strong><span>模板</span></div>
          <div><strong>${state.projects.length}</strong><span>项目</span></div>
        </div>
      </section>

      <section class="compose-grid">
        <div class="panel compose-card">
          <div class="panel-head">
            <div>
              <h2>生成台</h2>
              <p>按源材料、模板、生成过程、结果下载四段完成一次演示文稿生成。</p>
            </div>
            <span class="badge"><i></i> 自动生成</span>
          </div>

          <div class="studio-layout">
            <section class="studio-column">
              <div class="section-title">
                <span>01</span>
                <div>
                  <h3>源文件与主题</h3>
                  <p>支持 PDF、DOCX、MD、文本内容和网页 URL。</p>
                </div>
              </div>

              <label class="field full">
                <span>主题</span>
                <input id="topicInput" type="text" placeholder="例如：Mobius AI 系统介绍" value="${escapeAttr(state.form.topic)}">
              </label>

              <label class="field full">
                <div class="field-label-row"><span>源材料输入</span><small>可混合粘贴 URL、Markdown、普通文本；最多 ${TEXT_SOURCE_LIMIT_LABEL}</small></div>
                <textarea id="sourceInput" rows="12" placeholder="可以粘贴多行 URL、Markdown 或普通文本。单独一行的 URL 会归档到 source-urls.md，其余内容会归档到 inline-source.md；大量材料建议保存为 .md/.txt 后上传。">${escapeHtml(state.form.sourceInput)}</textarea>
              </label>

              <div id="dropZone" class="drop-zone">
                <input id="fileInput" type="file" multiple accept=".pdf,.doc,.docx,.md,.txt,.ppt,.pptx,.csv,.tsv,.html,.htm,.json">
                <div>
                  <strong>拖入或选择源文件</strong>
                  <span>PDF、DOCX、MD、PPTX、CSV 等，单文件最大 50MB。</span>
                </div>
                <button id="pickFileBtn" class="secondary-btn" type="button" ${state.busy ? 'disabled' : ''}>选择文件</button>
              </div>

              <div id="uploadList" class="upload-list">
                ${renderUploads()}
              </div>
            </section>

            <aside class="studio-column side-settings">
              <div class="section-title">
                <span>02</span>
                <div>
                  <h3>模板与输出</h3>
                  <p>选择自由设计，或选择一个中文概括名的内置模板。</p>
                </div>
              </div>

              <label class="field">
                <span>模板</span>
                <select id="templateSelect">
                  ${renderTemplateOptions()}
                </select>
              </label>

              <div class="selected-template">
                <div class="template-swatch" style="--swatch:${escapeAttr(tpl.primary_color || '#fb923c')}"></div>
                <div>
                  <strong>${escapeHtml(tpl.name)}</strong>
                  <p>${escapeHtml(tpl.summary || '适合通用汇报，由策略阶段自动决定页面结构。')}</p>
                </div>
              </div>

              <div class="settings-grid">
                <label class="field">
                  <span>格式</span>
                  <select id="formatSelect">
                    <option value="ppt169" ${state.form.format === 'ppt169' ? 'selected' : ''}>16:9 宽屏</option>
                    <option value="ppt43" ${state.form.format === 'ppt43' ? 'selected' : ''}>4:3 标准</option>
                  </select>
                </label>

                <label class="field">
                  <span>页数</span>
                  <input id="pageCountInput" type="number" min="1" max="20" value="${escapeAttr(state.form.pageCount)}">
                </label>
              </div>

              <label class="field full">
                <span>补充要求</span>
                <textarea id="notesInput" rows="5" placeholder="例如：偏管理层汇报、少文字、多图表、保留中文术语。">${escapeHtml(state.form.notes)}</textarea>
              </label>

              <div class="workflow-card">
                <div><span class="step-dot active"></span>上传材料</div>
                <div><span class="step-dot"></span>规划结构与视觉</div>
                <div><span class="step-dot"></span>下载 PPTX</div>
              </div>
            </aside>
          </div>

          <section class="studio-section progress-section">
            <div class="section-title">
              <span>03</span>
              <div>
                <h3>生成进度</h3>
                <p>生成时实时显示智能体输出、工具调用和关键步骤文本。</p>
              </div>
            </div>
            <div class="progress-controls">
              <button id="generateBtn" class="primary-btn" type="button" ${state.busy ? 'disabled' : ''}>生成 PPTX</button>
              <div class="progress-wrap text-progress">
                <span>当前状态</span>
                <strong id="progressText">${escapeHtml(state.progress.label)}</strong>
              </div>
            </div>

            ${renderLiveProgress()}
          </section>
        </div>

        <aside class="panel output-panel">
          <div class="panel-head compact">
            <div>
              <h2>04 生成结果</h2>
              <p>优先展示 PPTX、关键文档、讲稿和图片素材。</p>
            </div>
          </div>
          <div id="outputList" class="output-list">
            ${renderOutputs(visibleProjects.slice(0, 4), { compact: true, scope: 'main' })}
          </div>
        </aside>
      </section>
    </div>
  `;
}

function renderUploads() {
  if (!state.uploads.length) {
    return `
      <div class="upload-groups">
        <section class="upload-group current-source">
          <div class="upload-group-head">
            <div>
              <strong>本次将使用的源文件</strong>
              <span>新上传的文件会自动加入本次生成。</span>
            </div>
          </div>
          <div class="empty-strip">尚未上传文件</div>
        </section>
      </div>`;
  }
  const selected = selectedUploads();
  return `
    <div class="upload-groups">
      <section class="upload-group current-source">
        <div class="upload-group-head">
          <div>
            <strong>本次将使用的源文件</strong>
            <span>${selected.length ? `已选择 ${selected.length} 个文件` : '仅手动勾选的历史文件会参与生成。'}</span>
          </div>
        </div>
        <div class="upload-selected-list">
          ${selected.length
            ? selected.map(renderSelectedUpload).join('')
            : '<div class="empty-strip">本次未选择上传文件</div>'}
        </div>
      </section>

      <section class="upload-group history-source">
        <div class="upload-group-head">
          <div>
            <strong>历史上传</strong>
            <span>可手动勾选复用，也可删除记录。</span>
          </div>
          <button class="text-btn danger-text" type="button" data-action="clear-uploads" ${state.busy ? 'disabled' : ''}>清空历史</button>
        </div>
        <div class="upload-history-list">
          ${state.uploads.map(renderHistoryUpload).join('')}
        </div>
      </section>
    </div>`;
}

function selectedUploads() {
  return state.uploads.filter((upload) => state.selectedUploadIds.has(String(upload.id)));
}

function renderSelectedUpload(upload) {
  return `
    <div class="selected-source-item">
      <div class="upload-main">
        <span class="file-chip">${escapeHtml(upload.name)}</span>
        <span class="upload-meta">${formatSize(upload.size)}</span>
      </div>
      <button class="text-btn" type="button" data-action="unselect-upload" data-upload-id="${escapeAttr(upload.id)}" ${state.busy ? 'disabled' : ''}>移除本次选择</button>
    </div>`;
}

function renderHistoryUpload(upload) {
  const checked = state.selectedUploadIds.has(String(upload.id)) ? 'checked' : '';
  return `
    <div class="upload-item">
      <label class="upload-check">
        <input type="checkbox" data-upload-id="${escapeAttr(upload.id)}" ${checked} ${state.busy ? 'disabled' : ''}>
        <span class="file-chip">${escapeHtml(upload.name)}</span>
        <span class="upload-meta">${formatSize(upload.size)}</span>
      </label>
      <button class="text-btn danger-text" type="button" data-action="delete-upload" data-upload-id="${escapeAttr(upload.id)}" ${state.busy ? 'disabled' : ''}>删除</button>
    </div>`;
}

function renderTemplateOptions() {
  const options = state.templates.length
    ? state.templates.map(normalizeTemplate)
    : [{ id: 'free', name: '自由设计', kind: 'free', kind_label: '自由设计' }];
  return options.map((item) => {
    const label = item.kind && item.kind !== 'free' ? `${item.name}（${item.kind_label || '内置模板'}）` : item.name;
    return `<option value="${escapeAttr(item.id)}" ${state.selectedTemplateId === item.id ? 'selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');
}

function resolvedProjectStatus(project) {
  if (project.artifacts?.output || project.output_url || project.download_url) return 'completed';
  if (project.status === 'session_failed') return 'session_failed';
  if (project.status === 'failed' || project.status === 'error') return 'failed';
  if (project.status === 'processing') return 'processing';
  return project.status || 'unknown';
}

function statusBadgeHtml(status) {
  return {
    processing: '<span class="status-pill processing">生成中</span>',
    session_failed: '<span class="status-pill error">启动失败</span>',
    failed: '<span class="status-pill error">生成失败</span>',
    completed: '<span class="status-pill done">已完成</span>',
    unknown: '<span class="status-pill neutral">未完成</span>',
  }[status] || '';
}

function artifactDownloadUrl(item) {
  return downloadUrl(item?.download_url || item?.url || '');
}

function artifactTitle(item) {
  return item?.display_name || item?.name || item?.rel_path || '文件';
}

function renderOutputs(projects, { compact = false, scope = 'main' } = {}) {
  if (!projects.length) {
    return '<div class="empty-state">暂无输出</div>';
  }
  return projects.map((project) => renderProjectCard(project, { compact, scope })).join('');
}

function renderArtifactActions(project, item, { canPreview = true, primary = false } = {}) {
  if (!item) return '';
  const url = artifactDownloadUrl(item);
  const previewKind = item.preview_kind || '';
  const preview = canPreview && previewKind
    ? `<button class="secondary-btn small" type="button" data-action="preview-artifact" data-project-id="${escapeAttr(project.id)}" data-rel-path="${escapeAttr(item.rel_path)}" data-artifact-title="${escapeAttr(artifactTitle(item))}" data-preview-kind="${escapeAttr(previewKind)}">预览</button>`
    : '';
  const download = url
    ? `<a class="${primary ? 'primary-btn' : 'secondary-btn'} small" href="${escapeAttr(url)}" download>下载</a>`
    : '';
  return `<div class="artifact-actions">${preview}${download}</div>`;
}

function renderOutputHero(project, status) {
  const output = project.artifacts?.output || null;
  const outputUrl = artifactDownloadUrl(output) || downloadUrl(project.output_url || project.download_url);
  const canDownload = !!outputUrl;
  const pageText = project.page_count ? `${project.page_count} 页` : 'PPTX';
  const sizeText = canDownload ? formatSize(project.output_size || output?.size || 0) : (status === 'processing' ? '等待产物' : '无 PPTX');
  const previewBtn = canDownload
    ? `<button class="secondary-btn small" type="button" data-action="preview-project" data-project-id="${escapeAttr(project.id)}" data-project-title="${escapeAttr(project.name || project.topic || project.id || '预览')}">预览</button>`
    : '';
  const downloadBtn = canDownload
    ? `<a class="primary-btn small" href="${escapeAttr(outputUrl)}" download>下载 PPTX</a>`
    : `<span class="muted small">${status === 'processing' ? 'agent 正在生成...' : '未生成 PPTX'}</span>`;
  return `
    <div class="output-hero ${canDownload ? '' : 'is-empty'}">
      <div class="output-file-mark">
        <span>PPTX</span>
        <strong>${escapeHtml(status === 'processing' ? '生成中' : pageText)}</strong>
      </div>
      <div class="output-hero-body">
        <strong>output.pptx</strong>
        <span>${escapeHtml(sizeText)}</span>
        <div class="project-actions">${downloadBtn}${previewBtn}</div>
      </div>
    </div>
  `;
}

function renderDocArtifact(project, item) {
  return `
    <div class="doc-artifact">
      <div>
        <strong>${escapeHtml(artifactTitle(item))}</strong>
        <span>${escapeHtml(item.label || item.rel_path || '')} · ${escapeHtml(formatSize(item.size || 0))}</span>
      </div>
      ${renderArtifactActions(project, item)}
    </div>
  `;
}

function renderArtifactGroup(project, title, items, { empty = '', limit = 3 } = {}) {
  const list = (items || []).filter(Boolean);
  if (!list.length) {
    return empty ? `<div class="artifact-group"><h4>${escapeHtml(title)}</h4><div class="empty-strip">${escapeHtml(empty)}</div></div>` : '';
  }
  const visible = list.slice(0, limit);
  const hidden = list.slice(limit);
  return `
    <div class="artifact-group">
      <h4>${escapeHtml(title)}</h4>
      <div class="artifact-list">
        ${visible.map((item) => renderDocArtifact(project, item)).join('')}
      </div>
      ${hidden.length ? `
        <details class="artifact-more">
          <summary>展开其余 ${hidden.length} 个文件</summary>
          <div class="artifact-list">
            ${hidden.map((item) => renderDocArtifact(project, item)).join('')}
          </div>
        </details>` : ''}
    </div>
  `;
}

function renderImageArtifacts(project, images) {
  const list = (images || []).filter(Boolean);
  if (!list.length) return '';
  const visible = list.slice(0, 6);
  const hidden = list.slice(6);
  const renderImage = (item) => {
    const src = artifactDownloadUrl(item);
    const meta = item.purpose || item.credit || item.source_url || item.rel_path || '';
    return `
      <div class="image-artifact">
        <button type="button" data-action="preview-artifact" data-project-id="${escapeAttr(project.id)}" data-rel-path="${escapeAttr(item.rel_path)}" data-artifact-title="${escapeAttr(artifactTitle(item))}" data-preview-kind="image">
          ${src ? `<img src="${escapeAttr(src)}" alt="${escapeAttr(artifactTitle(item))}">` : '<span>IMG</span>'}
        </button>
        <div>
          <strong>${escapeHtml(artifactTitle(item))}</strong>
          <span>${escapeHtml(meta)}</span>
          ${src ? `<a class="text-btn" href="${escapeAttr(src)}" download>下载</a>` : ''}
        </div>
      </div>
    `;
  };
  return `
    <div class="artifact-group">
      <h4>图片素材</h4>
      <div class="image-artifact-grid">
        ${visible.map(renderImage).join('')}
      </div>
      ${hidden.length ? `
        <details class="artifact-more">
          <summary>展开其余 ${hidden.length} 张图片</summary>
          <div class="image-artifact-grid">
            ${hidden.map(renderImage).join('')}
          </div>
        </details>` : ''}
    </div>
  `;
}

function renderAdvancedFiles(project, moreRows) {
  const advanced = project.artifacts?.advanced || [];
  const fileRows = advanced.map((item) => renderDocArtifact(project, item)).join('');
  const infoRows = moreRows.map(([label, value]) => `<div><strong>${escapeHtml(label)}</strong><span>${escapeHtml(value)}</span></div>`).join('');
  const sessionLink = project.session_url
    ? `<a class="text-btn" href="${escapeAttr(project.session_url)}" target="_blank" rel="noreferrer">打开 Session 日志</a>`
    : '';
  if (!fileRows && !infoRows && !sessionLink) return '';
  return `
    <details class="project-more">
      <summary>更多信息 / 高级文件</summary>
      ${infoRows ? `<div class="project-more-grid">${infoRows}</div>` : ''}
      ${fileRows ? `<div class="artifact-list advanced-list">${fileRows}</div>` : ''}
      <div class="project-more-actions">
        ${project.output_url || project.download_url ? `<button class="text-btn" type="button" data-action="copy-link" data-url="${escapeAttr(downloadUrl(project.output_url || project.download_url))}">复制 PPTX 下载链接</button>` : ''}
        ${sessionLink}
      </div>
    </details>
  `;
}

function renderProjectCard(project, { compact = false, scope = 'history' } = {}) {
  const title = project.name || project.topic || project.id || '未命名演示文稿';
  const status = resolvedProjectStatus(project);
  const isProcessing = status === 'processing';
  const isFailed = status === 'session_failed' || status === 'failed';
  const statusBadge = statusBadgeHtml(status);
  const isHidden = Boolean(project.hidden_from_main);
  const visibilityBadge = scope === 'history'
    ? `<span class="visibility-pill ${isHidden ? 'hidden' : 'visible'}">${isHidden ? '主界面已隐藏' : '主界面显示中'}</span>`
    : '';
  const visibilityAction = scope === 'main'
    ? `<button class="text-btn visibility-action" type="button" data-action="hide-project-main" data-project-id="${escapeAttr(project.id)}">从主界面移除</button>`
    : isHidden
      ? `<button class="secondary-btn small visibility-action" type="button" data-action="show-project-main" data-project-id="${escapeAttr(project.id)}">恢复到主界面</button>`
      : '';
  const progressButton = (isProcessing && project.session_id)
    ? `<button class="secondary-btn small" type="button" data-action="open-live" data-project-id="${escapeAttr(project.id)}">查看实时进度</button>`
    : '';
  const errorText = isFailed && project.error ? `<div class="project-error">${escapeHtml(project.error)}</div>` : '';
  const formatText = project.format === 'ppt43' ? '4:3 标准' : project.format === 'ppt169' ? '16:9 宽屏' : (project.format || '默认格式');
  const sourceText = project.source_count
    ? `${project.page_count || '-'} 页 / ${project.source_count} 个来源`
    : `${project.page_count || '-'} 页`;
  const moreRows = [
    ['模板', project.template_name || project.template || '自由设计'],
    ['模板路径', project.template_rel_path || project.template_path || '无'],
    ['项目目录', shortPath(project.project_dir || '')],
    ['输出路径', shortPath(project.output_path || '')],
    ['Session', project.session_id || '未创建'],
    ['来源', project.source_kind || `${project.source_count || 0} 个来源`],
  ].filter(([, value]) => value);
  const artifacts = project.artifacts || {};
  const designItems = artifacts.design_spec ? [artifacts.design_spec] : [];
  return `
    <article class="project-card ${compact ? 'compact' : ''} ${isProcessing ? 'is-processing' : ''}">
      <div class="project-body">
        <div class="project-card-head">
          <div class="project-title-wrap">
            <div class="project-title">${escapeHtml(title)} ${statusBadge} ${visibilityBadge}</div>
          </div>
          ${visibilityAction ? `<div class="project-head-actions">${visibilityAction}</div>` : ''}
        </div>
        <div class="project-meta">
          <span>${escapeHtml(formatText)}</span>
          <span>${escapeHtml(sourceText)}</span>
          <span>${escapeHtml(formatDate(project.created_at || project.updated_at))}</span>
        </div>
        ${errorText}
        ${renderOutputHero(project, status)}
        ${progressButton ? `<div class="project-actions">${progressButton}</div>` : ''}
        ${renderArtifactGroup(project, '源材料整理', artifacts.sources || [], { empty: isProcessing ? '生成后显示整理后的 Markdown' : '', limit: compact ? 2 : 4 })}
        ${renderArtifactGroup(project, '设计方案 / 大纲', designItems, { limit: 1 })}
        ${renderArtifactGroup(project, '讲稿 / 备注', artifacts.notes || [], { limit: compact ? 2 : 4 })}
        ${renderImageArtifacts(project, artifacts.images || [])}
        ${renderAdvancedFiles(project, moreRows)}
      </div>
    </article>
  `;
}

function renderTemplatesPage() {
  const cards = filteredTemplates();
  const icons = (state.templateAssets.icons || []).slice(0, 24);
  const charts = (state.templateAssets.charts || []).slice(0, 18);
  return `
    <div class="library-page">
      <section class="page-head">
        <div>
	          <span class="eyebrow"><i></i> 模板库</span>
	          <h2>模板库</h2>
	          <p>内置模板使用中文概括名展示，提交时会映射到真实模板目录。</p>
        </div>
        <button class="primary-btn" type="button" data-route="compose">返回创作台</button>
      </section>

      <section class="featured-grid">
        ${cards.slice(0, 12).map(renderTemplateCard).join('')}
      </section>

      <section class="asset-grid-wrap">
        <div class="asset-section">
          <div class="section-title">
            <span>icons</span>
            <div>
              <h3>图标资产</h3>
	              <p>可在完整生成流程中用于页面视觉强化。</p>
            </div>
          </div>
          <div class="icon-grid">
            ${icons.map(renderAssetIcon).join('')}
          </div>
        </div>
        <div class="asset-section">
          <div class="section-title">
            <span>charts</span>
            <div>
              <h3>图表资产</h3>
              <p>来自 templates/charts，可用于流程图、矩阵、时间线等页面。</p>
            </div>
          </div>
          <div class="chart-grid">
            ${charts.map(renderAssetIcon).join('')}
          </div>
        </div>
      </section>
    </div>
  `;
}

function renderTemplateCard(item) {
  const active = item.id === state.selectedTemplateId ? 'active' : '';
  const preview = item.preview_url
    ? `<img src="${escapeAttr(item.preview_url)}" alt="">`
    : `<div class="template-preview-fallback" style="--swatch:${escapeAttr(item.primary_color || '#fb923c')}"><span></span><i></i><b></b></div>`;
  return `
    <button class="template-card ${active}" type="button" data-action="select-template" data-template-id="${escapeAttr(item.id)}">
      <div class="template-preview">${preview}</div>
	      <div class="template-info">
	        <div>
	          <strong>${escapeHtml(item.name)}</strong>
	          <span>${escapeHtml(item.kind_label || '内置模板')}</span>
	        </div>
	        <p>${escapeHtml(item.summary || '可作为 ppt-maker 生成流程的视觉约束。')}</p>
	        <div class="template-meta">
	          <span>${escapeHtml(item.kind_label || '内置模板')}</span>
	          <span>${item.page_count ? `${item.page_count} 页` : '自适应'}</span>
	        </div>
      </div>
    </button>
  `;
}

function renderAssetIcon(asset) {
  const src = asset.url || asset.preview_url;
  return `
    <div class="asset-card" title="${escapeAttr(asset.name || asset.id || '')}">
      ${src ? `<img src="${escapeAttr(src)}" alt="">` : '<span></span>'}
      <strong>${escapeHtml(asset.name || asset.id || 'asset')}</strong>
    </div>
  `;
}

function renderHistoryPage() {
  const projects = filteredProjects();
  return `
    <div class="history-page">
      <section class="page-head">
        <div>
          <span class="eyebrow"><i></i> 历史项目</span>
          <h2>历史项目</h2>
          <p>查看已生成的 PPTX、关键文档、讲稿和图片素材，可重新预览或下载交付文件。</p>
        </div>
        <div class="toolbar-actions">
          <button class="secondary-btn" type="button" data-action="refresh-history">刷新历史</button>
          <button class="primary-btn" type="button" data-route="compose">新建 PPT</button>
        </div>
      </section>
      ${renderLiveProgress()}
      <section class="history-grid">
        ${projects.length ? projects.map((project) => renderProjectCard(project, { scope: 'history' })).join('') : '<div class="empty-state large">没有匹配的历史项目</div>'}
      </section>
    </div>
  `;
}

function renderHttpPage() {
  const token = localStorage.getItem('cc-token') || '<YOUR_MOBIUS_TOKEN>';
  const curl = `curl -X POST "$MOBIUS_URL/api/ext" \\
  -H "Authorization: Bearer ${token ? '<YOUR_MOBIUS_TOKEN>' : '<YOUR_MOBIUS_TOKEN>'}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "extension_name": "ppt-maker",
    "ext_main_payload": {
	      "action": "start_generation",
	      "topic": "Mobius AI 系统介绍",
	      "template": "academic_defense",
	      "source_input": "https://example.com/source\\n# 核心材料\\n这里粘贴 Markdown 或普通文本。",
	      "page_count": 4,
	      "notes": "偏管理层汇报，少文字，多图表"
    }
  }'`;
  const python = `import requests

resp = requests.post(
    f"{MOBIUS_URL}/api/ext",
    headers={"Authorization": f"Bearer {TOKEN}"},
    json={
        "extension_name": "ppt-maker",
        "ext_main_payload": {
	            "action": "start_generation",
	            "topic": "Mobius AI 系统介绍",
	            "template": "academic_defense",
	            "source_input": "https://example.com/source\\n# 核心材料\\n这里粘贴 Markdown 或普通文本。",
	            "page_count": 4,
	            "notes": "偏管理层汇报，少文字，多图表",
        },
    },
    timeout=30,
)
print(resp.json())`;
  const js = `const res = await fetch('/api/ext', {
  method: 'POST',
  credentials: 'include',
  headers: {
    'content-type': 'application/json',
    authorization: 'Bearer <YOUR_MOBIUS_TOKEN>',
  },
  body: JSON.stringify({
    extension_name: 'ppt-maker',
    ext_main_payload: {
	      action: 'start_generation',
	      topic: 'Mobius AI 系统介绍',
	      template: 'academic_defense',
	      source_input: 'https://example.com/source\\n# 核心材料\\n这里粘贴 Markdown 或普通文本。',
	      page_count: 4,
	      notes: '偏管理层汇报，少文字，多图表',
    },
  }),
});
console.log(await res.json());`;
  return `
    <div class="http-page">
      <section class="page-head">
        <div>
	          <span class="eyebrow"><i></i> HTTP 接入</span>
	          <h2>HTTP 接入</h2>
	          <p>外部系统可创建生成项目；后端会自动创建并启动完整流程 Session。</p>
        </div>
        <button class="secondary-btn" type="button" data-action="copy-token">复制 token 占位</button>
      </section>

      <section class="contract-grid">
        <article class="contract-card">
	          <h3>1. 创建生成任务</h3>
	          <p>调用 <code>POST /api/ext</code>，传入 <code>extension_name=ppt-maker</code> 与 <code>action=start_generation</code>，返回生成 Session、后端启动结果和后续下载信息。</p>
          ${renderCodeBlock(curl, 'cURL')}
        </article>

        <article class="contract-card">
          <h3>2. Python 示例</h3>
          <p>适合后端任务系统把 URL、Markdown 或已经上传后的文件路径塞进 PPT Maker。</p>
          ${renderCodeBlock(python, 'Python')}
        </article>

        <article class="contract-card">
          <h3>3. JavaScript 示例</h3>
	          <p>适合 Web 前端或内部工具调用；生成完成后历史项目里会出现 <code>output.download_url</code>。</p>
          ${renderCodeBlock(js, 'JavaScript')}
        </article>

        <article class="contract-card">
	          <h3>4. 启动完整流程</h3>
	          <p><code>start_generation</code> 会在后端自动启动完整 ppt-maker 流程；调用方只需要保存 <code>session.session_id</code> 并等待输出。</p>
	          <div class="endpoint-list">
	            <div><strong>handler action</strong><span>start_generation / upload_source / list_templates / list_user_projects</span></div>
	            <div><strong>backend start</strong><span>内部复用 Session 消息启动服务，无需浏览器二次 POST</span></div>
            <div><strong>output</strong><span>protected_data/extension/ppt-maker/users/&lt;user&gt;/projects/&lt;project&gt;/output.pptx</span></div>
          </div>
        </article>
      </section>
    </div>
  `;
}

function renderCodeBlock(code, label) {
  return `
    <div class="code-card">
      <div><span>${escapeHtml(label)}</span><button class="text-btn" type="button" data-action="copy-code" data-code="${escapeAttr(code)}">复制</button></div>
      <pre>${escapeHtml(code)}</pre>
    </div>
  `;
}

const previewState = { projectId: '', title: '', pages: [], index: 0 };
const artifactPreviewState = {
  projectId: '',
  title: '',
  relPath: '',
  previewKind: '',
  content: '',
  downloadUrl: '',
  size: 0,
  truncated: false,
  mimeType: '',
};

function renderPreviewModal() {
  if (!previewState.pages.length) return '';
  const page = previewState.pages[previewState.index];
  const total = previewState.pages.length;
  const hasPrev = previewState.index > 0;
  const hasNext = previewState.index < total - 1;
  return `
    <div class="preview-overlay" data-action="close-preview">
      <div class="preview-modal" role="dialog" aria-modal="true" aria-label="PPT 预览">
        <div class="preview-toolbar">
          <div class="preview-titles">
            <strong>${escapeHtml(previewState.title || '预览')}</strong>
            <span>${escapeHtml(page.name)} · ${previewState.index + 1} / ${total}</span>
          </div>
          <button class="text-btn" type="button" data-action="close-preview" aria-label="关闭">✕ 关闭</button>
        </div>
        <div class="preview-stage">
          ${hasPrev ? '<button class="preview-nav prev" type="button" data-action="preview-prev" aria-label="上一页">‹</button>' : ''}
          <img class="preview-image" src="${escapeAttr(page.data_url)}" alt="${escapeAttr(page.name)}">
          ${hasNext ? '<button class="preview-nav next" type="button" data-action="preview-next" aria-label="下一页">›</button>' : ''}
        </div>
        <div class="preview-footbar">
          <button class="secondary-btn small" type="button" data-action="preview-prev" ${hasPrev ? '' : 'disabled'}>‹ 上一页</button>
          <span class="preview-counter">${previewState.index + 1} / ${total}</span>
          <button class="secondary-btn small" type="button" data-action="preview-next" ${hasNext ? '' : 'disabled'}>下一页 ›</button>
        </div>
      </div>
    </div>
  `;
}

function renderArtifactPreviewModal() {
  if (!artifactPreviewState.relPath) return '';
  const url = artifactDownloadUrl({
    download_url: artifactPreviewState.downloadUrl,
  });
  const meta = [
    artifactPreviewState.relPath,
    artifactPreviewState.size ? formatSize(artifactPreviewState.size) : '',
    artifactPreviewState.truncated ? '已截断预览' : '',
  ].filter(Boolean).join(' · ');
  const body = artifactPreviewState.previewKind === 'image'
    ? `<div class="artifact-preview-stage image"><img src="${escapeAttr(url)}" alt="${escapeAttr(artifactPreviewState.title)}"></div>`
    : `<pre class="artifact-preview-text">${escapeHtml(artifactPreviewState.content || '')}</pre>`;
  return `
    <div class="preview-overlay" data-action="close-artifact-preview">
      <div class="preview-modal artifact-modal" role="dialog" aria-modal="true" aria-label="文件预览">
        <div class="preview-toolbar">
          <div class="preview-titles">
            <strong>${escapeHtml(artifactPreviewState.title || '文件预览')}</strong>
            <span>${escapeHtml(meta)}</span>
          </div>
          <div class="live-head-actions">
            ${url ? `<a class="secondary-btn small" href="${escapeAttr(url)}" download>下载</a>` : ''}
            <button class="text-btn" type="button" data-action="close-artifact-preview" aria-label="关闭">✕ 关闭</button>
          </div>
        </div>
        ${body}
      </div>
    </div>
  `;
}

async function openPreview(projectId, title) {
  if (!projectId) return;
  closePreview();
  setBusy(true, '加载预览');
  try {
    const data = await extCall({ action: 'get_project_preview', project_id: projectId });
    if (!data.ok) throw new Error(data.error || data.message || '预览失败');
    if (!data.available) {
      toast(data.message || '该项目没有可预览的源文件', 'warn');
      return;
    }
    previewState.projectId = projectId;
    previewState.title = title;
    previewState.pages = data.pages || [];
    previewState.index = 0;
    document.body.insertAdjacentHTML('beforeend', renderPreviewModal());
  } finally {
    setBusy(false);
  }
}

async function openArtifactPreview(projectId, relPath, title, previewKind) {
  if (!projectId || !relPath) return;
  closeArtifactPreview();
  setBusy(true, '加载文件预览');
  try {
    const data = await extCall({ action: 'get_artifact_preview', project_id: projectId, rel_path: relPath });
    if (!data.ok) throw new Error(data.error || data.message || '预览失败');
    artifactPreviewState.projectId = projectId;
    artifactPreviewState.title = title || data.name || relPath;
    artifactPreviewState.relPath = data.rel_path || relPath;
    artifactPreviewState.previewKind = data.preview_kind || previewKind || '';
    artifactPreviewState.content = data.content || '';
    artifactPreviewState.downloadUrl = data.download_url || '';
    artifactPreviewState.size = data.size || 0;
    artifactPreviewState.truncated = !!data.truncated;
    artifactPreviewState.mimeType = data.mime_type || '';
    document.body.insertAdjacentHTML('beforeend', renderArtifactPreviewModal());
  } finally {
    setBusy(false);
  }
}

function closePreview() {
  document.querySelector('.preview-overlay[data-action="close-preview"]')?.remove();
  previewState.projectId = '';
  previewState.title = '';
  previewState.pages = [];
  previewState.index = 0;
}

function closeArtifactPreview() {
  document.querySelector('.preview-overlay[data-action="close-artifact-preview"]')?.remove();
  artifactPreviewState.projectId = '';
  artifactPreviewState.title = '';
  artifactPreviewState.relPath = '';
  artifactPreviewState.previewKind = '';
  artifactPreviewState.content = '';
  artifactPreviewState.downloadUrl = '';
  artifactPreviewState.size = 0;
  artifactPreviewState.truncated = false;
  artifactPreviewState.mimeType = '';
}

function navigatePreview(delta) {
  if (!previewState.pages.length) return;
  const next = previewState.index + delta;
  if (next < 0 || next >= previewState.pages.length) return;
  previewState.index = next;
  const overlay = document.querySelector('.preview-overlay');
  if (!overlay) return;
  overlay.outerHTML = renderPreviewModal();
}

document.addEventListener('keydown', (event) => {
  if (!document.querySelector('.preview-overlay')) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    if (artifactPreviewState.relPath) closeArtifactPreview();
    else closePreview();
    return;
  }
  if (artifactPreviewState.relPath) {
    return;
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    navigatePreview(-1);
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    navigatePreview(1);
  }
});

function render() {
  updateShell();
  if (state.route === 'templates') els.app.innerHTML = renderTemplatesPage();
  else if (state.route === 'history') els.app.innerHTML = renderHistoryPage();
  else if (state.route === 'http') els.app.innerHTML = renderHttpPage();
  else els.app.innerHTML = renderCompose();
}

function collectForm() {
  const topic = document.getElementById('topicInput');
  const sourceInput = document.getElementById('sourceInput');
  const format = document.getElementById('formatSelect');
  const pageCount = document.getElementById('pageCountInput');
  const notes = document.getElementById('notesInput');
  const template = document.getElementById('templateSelect');
  if (topic) state.form.topic = topic.value;
  if (sourceInput) state.form.sourceInput = sourceInput.value;
  if (format) state.form.format = format.value;
  if (pageCount) state.form.pageCount = Math.max(1, Math.min(20, Number(pageCount.value) || 4));
  if (notes) state.form.notes = notes.value;
  if (template) state.selectedTemplateId = template.value || 'free';
}

function mergeProject(project) {
  if (!project) return;
  state.projects = [project, ...state.projects.filter((item) => item.id !== project.id)];
}

function replaceProjects(projects) {
  if (Array.isArray(projects)) state.projects = projects;
}

async function setProjectMainVisibility(projectId, hidden) {
  const id = String(projectId || '').trim();
  if (!id) return;
  const previousProjects = state.projects;
  state.projects = state.projects.map((project) => (
    String(project.id) === id
      ? {
          ...project,
          hidden_from_main: hidden,
          hidden_at: hidden ? new Date().toISOString() : '',
        }
      : project
  ));
  render();
  try {
    const data = await extCall({
      action: hidden ? 'hide_project_from_main' : 'show_project_on_main',
      project_id: id,
    });
    if (!data.ok) throw new Error(data.error || '更新显示状态失败');
    replaceProjects(data.projects);
    if (data.project && !Array.isArray(data.projects)) mergeProject(data.project);
    render();
    toast(hidden ? '已从主界面移除，历史记录仍保留' : '已恢复到主界面');
  } catch (error) {
    state.projects = previousProjects;
    render();
    toast(error.message || '更新显示状态失败', 'error');
  }
}

function ingestState(data) {
  state.skill = data.skill || state.skill;
  state.templates = (data.templates || state.templates || []).map(normalizeTemplate);
  if (!state.templates.some((item) => item.id === 'free')) {
    state.templates.unshift({ id: 'free', name: '自由设计', kind: 'free', kind_label: '自由设计', summary: '不绑定模板，由 ppt-maker 自动决定视觉方向。' });
  }
  if (!state.templates.some((item) => item.id === state.selectedTemplateId)) {
    state.selectedTemplateId = state.templates[0]?.id || 'free';
  }
  state.uploads = data.uploads || state.uploads || [];
  const liveUploadIds = new Set(state.uploads.map((upload) => String(upload.id)));
  state.selectedUploadIds = new Set(
    Array.from(state.selectedUploadIds).map(String).filter((id) => liveUploadIds.has(id)),
  );
  if (Array.isArray(data.projects)) state.projects = data.projects;
}

async function loadTemplates() {
  try {
    const data = await extCall({ action: 'list_templates' });
    if (data.ok) {
      state.templates = (data.templates || state.templates || []).map(normalizeTemplate);
      state.templateAssets = {
        ...state.templateAssets,
        ...(data.assets || {}),
        featured: (data.featured || data.assets?.featured || state.templateAssets.featured || []).map(normalizeTemplate),
      };
      if (!state.templates.some((item) => item.id === 'free')) {
        state.templates.unshift({ id: 'free', name: '自由设计', kind: 'free', kind_label: '自由设计', summary: '不绑定模板，由 ppt-maker 自动决定视觉方向。' });
      }
    }
  } catch (error) {
    state.error = error.message || '模板加载失败';
  }
}

async function loadHistory() {
  try {
    const data = await extCall({ action: 'list_user_projects' });
    if (data.ok && Array.isArray(data.projects)) {
      state.projects = data.projects;
      return;
    }
  } catch {
    const fallback = await extCall({ action: 'list_projects' });
    if (fallback.ok && Array.isArray(fallback.projects)) state.projects = fallback.projects;
  }
}

async function loadState() {
  setBusy(true, '加载 PPT Maker 状态');
  try {
    const data = await extCall({ action: 'get_state' });
    if (!data.ok) throw new Error(data.error || '加载失败');
    ingestState(data);
    await Promise.all([loadTemplates(), loadHistory()]);
    state.error = '';
    setProgress('已连接', false);
    render();
  } catch (error) {
    state.error = error.message || '初始化失败';
    setProgress('连接失败', false);
    render();
    toast(state.error, 'error');
  } finally {
    setBusy(false);
  }
}

async function uploadFiles(files) {
  const list = Array.from(files || []);
  if (!list.length) return;
  collectForm();
  setBusy(true, `上传 ${list.length} 个文件`);
  try {
    let done = 0;
    for (const file of list) {
      setProgress(`上传：${file.name}`, true);
      const uploaded = await extUpload(file);
      const registered = await extCall({ action: 'upload_source', file: uploaded.file });
      if (!registered.ok) throw new Error(registered.error || '登记上传失败');
      state.uploads = registered.uploads || state.uploads;
      if (registered.upload?.id) state.selectedUploadIds.add(String(registered.upload.id));
      done += 1;
    }
    setProgress('上传完成', false);
    toast('文件已上传');
    render();
  } finally {
    setBusy(false);
  }
}

async function generate() {
  collectForm();
  const topic = state.form.topic.trim();
  const { urls, markdown } = splitSourceInput(state.form.sourceInput);
  const uploadIds = Array.from(state.selectedUploadIds);
  if (!topic && !markdown && !urls.length && !uploadIds.length) {
    toast('请先提供主题、文本、URL 或源文件', 'warn');
    return;
  }
  const markdownBytes = textByteLength(markdown);
  if (markdownBytes > MAX_TEXT_SOURCE_BYTES) {
    toast(`Markdown/文本超过 ${TEXT_SOURCE_LIMIT_LABEL}，请保存为 .md/.txt 后通过源文件上传`, 'warn');
    return;
  }
  setBusy(true, '启动完整生成流程');
  setProgress('准备材料并创建生成会话', true);
  render();
  try {
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    setProgress('创建 PPT Maker 生成项目', true);
    const data = await extCall({
      action: 'start_generation',
      topic,
      markdown,
      source_urls: urls,
      source_input: state.form.sourceInput,
      upload_ids: uploadIds,
      template: state.selectedTemplateId,
      format: state.form.format,
      page_count: state.form.pageCount,
      notes: state.form.notes.trim(),
    });
    if (!data.ok) throw new Error(data.error || '生成失败');
    if (data.error) throw new Error(data.error);
    if (data.project) {
      mergeProject(data.project);
      state.lastOutput = data.output || data.project;
    }
    state.selectedUploadIds.clear();
    if (data.session && data.session.session_id) {
      const project = state.projects.find((p) => p.id === data.project.id) || data.project;
      const live = ensureLive(project, data.session);
      appendLiveLine(live, '已创建生成 Session，后端正在启动完整 ppt-maker 流程。', 'event');
      openLiveSse(data.session.session_id, project.id);
      const startResult = data.backend_start || data.session.start_result || null;
      if (startResult && startResult.ok === false) {
        throw new Error(startResult.error || data.error || '后端启动生成 Session 失败');
      }
      appendLiveLine(live, 'agent 已由后端启动，正在按完整 ppt-maker 流程生成。', 'event');
      setProgress('agent 正在生成 PPTX', true);
      toast('生成已启动，可在此页面查看实时过程');
      render();
      return;
    }
    if (data.output) {
      setProgress('生成完成，可下载 PPTX', false);
      toast('PPTX 已生成');
      render();
      return;
    }
    setProgress('已提交', false);
    render();
  } catch (error) {
    setProgress('启动失败', false);
    if (state.live) {
      state.live.status = 'error';
      state.live.error = error.message || '启动失败';
      appendLiveLine(state.live, state.live.error, 'error');
    }
    toast(error.message || '启动失败', 'error');
    render();
  } finally {
    setBusy(false);
  }
}

async function deleteUpload(uploadId) {
  const id = String(uploadId || '').trim();
  if (!id) return;
  const upload = state.uploads.find((item) => String(item.id) === id);
  const name = upload?.name || '该文件';
  if (!window.confirm(`删除上传记录「${name}」？历史生成项目里的 sources 文件不会删除。`)) return;
  collectForm();
  setBusy(true, '删除上传记录');
  try {
    const data = await extCall({ action: 'delete_upload', upload_id: id });
    if (!data.ok) throw new Error(data.error || '删除上传记录失败');
    state.uploads = data.uploads || state.uploads.filter((item) => String(item.id) !== id);
    state.selectedUploadIds.delete(id);
    toast('上传记录已删除');
    render();
  } finally {
    setBusy(false);
  }
}

async function clearUploads() {
  if (!state.uploads.length) return;
  if (!window.confirm('清空全部上传历史？历史生成项目里的 sources 文件不会删除。')) return;
  collectForm();
  setBusy(true, '清空上传历史');
  try {
    const data = await extCall({ action: 'clear_uploads' });
    if (!data.ok) throw new Error(data.error || '清空上传历史失败');
    state.uploads = data.uploads || [];
    state.selectedUploadIds.clear();
    toast('上传历史已清空');
    render();
  } finally {
    setBusy(false);
  }
}

async function copyText(text, label = '已复制') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
  } catch {
    toast('复制失败，请手动复制', 'warn');
  }
}

function clipText(text, max = 260) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function liveTime(ts = Date.now()) {
  const date = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function stripStepTokens(text) {
  return String(text || '').replace(STEP_REGEX, '').trim();
}

function parseFunctionCallArguments(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function functionCallCommand(payload) {
  const args = parseFunctionCallArguments(payload?.arguments);
  const cmd = args?.cmd ?? args?.command ?? args?.input?.cmd ?? args?.input?.command;
  return typeof cmd === 'string' && cmd.trim() ? cmd.trim() : '';
}

function functionOutputBody(output) {
  const text = String(output ?? '');
  const marker = 'Output:';
  const idx = text.indexOf(marker);
  return (idx >= 0 ? text.slice(idx + marker.length) : text).trim();
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

function summarizeJsonlEntry(entry) {
  if (!entry || typeof entry !== 'object') return '';
  if (entry.type === 'event_msg') {
    const payload = entry.payload || {};
    if (payload.type === 'task_complete') return '本轮任务完成，正在检查输出文件。';
    if (payload.type === 'agent_message' && payload.message) return `系统事件：${clipText(payload.message)}`;
    if (payload.type === 'token_count') return '';
    return payload.type ? `事件：${payload.type}` : '';
  }
  if (entry.type === 'response_item') {
    const payload = entry.payload || {};
    if (payload.type === 'message' && payload.role === 'assistant') {
      const text = stripStepTokens(contentBlocksText(payload.content));
      return text ? `模型输出：${clipText(text)}` : '';
    }
    if (payload.type === 'function_call') {
      const command = functionCallCommand(payload);
      if (command) return `运行命令：${clipText(command, 220)}`;
      return `调用工具：${clipText(payload.name || 'function_call', 120)}`;
    }
    if (payload.type === 'function_call_output') {
      const body = functionOutputBody(payload.output);
      return body ? `工具返回：${clipText(body, 220)}` : '工具返回完成。';
    }
    if (payload.type === 'reasoning') return '模型正在整理生成步骤。';
    if ((payload.type === 'output_text' || payload.type === 'text') && payload.text) {
      const text = stripStepTokens(payload.text);
      return text ? `模型输出：${clipText(text)}` : '';
    }
  }
  if (entry.type === 'assistant') {
    const message = entry.message || {};
    const text = stripStepTokens(contentBlocksText(message.content));
    if (text) return `模型输出：${clipText(text)}`;
    if (Array.isArray(message.content)) {
      const tool = message.content.find((block) => block?.type === 'tool_use');
      if (tool) {
        const command = tool.name === 'Bash' ? tool.input?.command : '';
        return command ? `运行命令：${clipText(command, 220)}` : `调用工具：${clipText(tool.name || 'tool_use', 120)}`;
      }
    }
  }
  if (entry.type === 'user') return '已提交生成请求。';
  if (entry.type === 'session_meta') return '生成会话已启动。';
  return '';
}

function appendLiveLine(live, text, tone = 'info', ts = Date.now()) {
  const body = clipText(text, 360);
  if (!live || !body) return;
  const last = live.logs[live.logs.length - 1];
  if (last && last.text === body) return;
  live.logs.push({ ts, time: liveTime(ts), text: body, tone });
  live.logs = live.logs.slice(-120);
  live.lastMessage = body;
}

const STEP_REGEX = /<<<STEP:([a-z0-9-]+)(?::([^>]*))?>>>/gi;

const STEP_PLAN = [
  { key: 'reading-skill', label: '读取 SKILL.md 技能说明' },
  { key: 'reading-sources', label: '读取源材料' },
  { key: 'project-init', label: '初始化项目目录' },
  { key: 'design-spec', label: '生成策略文档 design_spec.md' },
  { key: 'spec-lock', label: '确认设计稿 spec_lock.md' },
  { key: 'svg-generation', label: '逐页生成 SVG 幻灯片' },
  { key: 'quality-check', label: 'SVG 质量检查' },
  { key: 'post-process', label: 'SVG 后处理' },
  { key: 'export-pptx', label: '导出 PPTX' },
  { key: 'done', label: '生成完成' },
];

const STEP_LABEL = STEP_PLAN.reduce((acc, s) => {
  acc[s.key] = s.label;
  return acc;
}, {});

function stepLabelFromKey(key) {
  if (!key) return '处理中';
  if (STEP_LABEL[key]) return STEP_LABEL[key];
  return key;
}

function parseStepTokens(text) {
  if (!text) return [];
  const tokens = [];
  let match;
  STEP_REGEX.lastIndex = 0;
  while ((match = STEP_REGEX.exec(text)) !== null) {
    tokens.push({ key: match[1], detail: match[2] || '' });
  }
  return tokens;
}

function ensureLive(project, session) {
  if (!state.live || state.live.projectId !== project.id) {
    state.live = {
      projectId: project.id,
      topic: project.topic || project.name || '',
      sessionId: session?.session_id || '',
      sessionUrl: session?.session_url || project.session_url || '',
      startedAt: Date.now(),
      steps: STEP_PLAN.map((s) => ({ key: s.key, label: s.label, status: 'pending', detail: '', ts: 0 })),
      stepIndex: new Map(STEP_PLAN.map((s, i) => [s.key, i])),
	      current: null,
	      lastMessage: '',
	      logs: [],
	      seenEntries: new Set(),
	      error: '',
	      status: 'running',
	      source: null,
    };
  }
  return state.live;
}

function applyStepToken(live, token) {
  if (!live) return;
  if (token.key === 'error') {
    live.status = 'error';
    live.error = token.detail || '生成失败';
    live.current = null;
    appendLiveLine(live, live.error, 'error');
    return;
  }
  const idx = live.stepIndex.get(token.key);
  if (idx === undefined) return;
  const step = live.steps[idx];
  const isStepDone = token.key === 'done' || token.detail === 'done';
  step.status = isStepDone ? 'done' : 'active';
  step.detail = token.detail;
  step.ts = Date.now();
  if (token.key === 'done') {
    live.status = 'done';
    live.current = null;
    appendLiveLine(live, '生成完成，正在刷新 PPTX 结果。', 'done');
  } else {
    live.status = 'running';
    live.current = step.key;
    appendLiveLine(live, `${step.label}${token.detail ? `：${token.detail}` : ''}`, 'step');
  }
  for (let i = 0; i < idx; i += 1) {
    if (live.steps[i].status === 'pending' || live.steps[i].status === 'active') {
      live.steps[i].status = 'skipped';
    }
  }
  for (let i = idx + 1; i < live.steps.length; i += 1) {
    if (live.steps[i].status === 'active') live.steps[i].status = 'skipped';
  }
}

function extractTextFromJsonlEntry(entry) {
  if (!entry || typeof entry !== 'object') return '';
  let blocks = null;
  if (entry.type === 'assistant') {
    const message = entry.message || {};
    if (message.role && message.role !== 'assistant') return '';
    blocks = Array.isArray(message.content) ? message.content : null;
  } else if (entry.type === 'response_item') {
    const payload = entry.payload || {};
    if (payload.type === 'message' && payload.role === 'assistant') {
      blocks = Array.isArray(payload.content) ? payload.content : null;
    } else if ((payload.type === 'output_text' || payload.type === 'text') && typeof payload.text === 'string') {
      return payload.text;
    }
  } else if (entry.role === 'assistant' && typeof entry.content === 'string') {
    return entry.content;
  }
  if (!blocks) return '';
  return blocks
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      if (block.type && block.type !== 'text' && block.type !== 'output_text') return '';
      if (typeof block.text === 'string') return block.text;
      if (typeof block.output_text === 'string') return block.output_text;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function closeLiveSse() {
  if (state.live?.source) {
    try { state.live.source.close(); } catch { /* noop */ }
  }
  state.live = state.live ? { ...state.live, source: null } : null;
}

function liveEntryKey(entry, summary) {
  return [
    entry?.uuid || entry?.id || '',
    entry?.timestamp || '',
    entry?.type || '',
    summary || '',
  ].join('|');
}

function ingestLiveEntry(projectId, entry) {
  if (!state.live || state.live.projectId !== projectId || !entry) return;
  const summary = summarizeJsonlEntry(entry);
  const key = liveEntryKey(entry, summary);
  if (state.live.seenEntries?.has(key)) return;
  state.live.seenEntries?.add(key);

  const text = extractTextFromJsonlEntry(entry);
  const tokens = parseStepTokens(text);
  if (tokens.length) {
    for (const token of tokens) applyStepToken(state.live, token);
  }
  if (summary) appendLiveLine(state.live, summary, entry.type === 'event_msg' ? 'event' : 'info', Date.parse(entry.timestamp || '') || Date.now());
  if (state.live.status === 'done') onLiveDone(projectId);
}

function ingestLiveEntries(projectId, entries) {
  for (const entry of Array.isArray(entries) ? entries : []) ingestLiveEntry(projectId, entry);
}

function openLiveSse(sessionId, projectId) {
  if (!sessionId) return;
  const token = localStorage.getItem('cc-token') || '';
  if (!token) {
    if (state.live) state.live.error = '缺少 cc-token，无法订阅进度';
    return;
  }
  if (state.live?.source) {
    try { state.live.source.close(); } catch { /* noop */ }
  }
  const url = `/api/sessions/${encodeURIComponent(sessionId)}/events?token=${encodeURIComponent(token)}`;
  const es = new EventSource(url);
  state.live.source = es;
  es.addEventListener('jsonl_history', (ev) => {
    if (!state.live || state.live.projectId !== projectId) return;
    let payload;
    try { payload = JSON.parse(ev.data); } catch { return; }
    ingestLiveEntries(projectId, payload?.entries || []);
    render();
  });
  es.addEventListener('jsonl_entry', (ev) => {
    if (!state.live || state.live.projectId !== projectId) return;
    let payload;
    try { payload = JSON.parse(ev.data); } catch { return; }
    ingestLiveEntry(projectId, payload?.entry);
    render();
  });
  es.addEventListener('error', () => {
    if (!state.live) return;
    if (state.live.status === 'done' || state.live.status === 'error') return;
    if (es.readyState === EventSource.CLOSED) {
      state.live.error = state.live.error || '进度流已断开（agent 已停止）';
      render();
    }
  });
  es.addEventListener('typing', () => { /* ignore */ });
}

async function onLiveDone(projectId) {
  closeLiveSse();
  try {
    const data = await extCall({ action: 'get_project_preview', project_id: projectId });
    if (data && data.available) {
      const project = state.projects.find((p) => p.id === projectId);
      if (project) project.status = 'completed';
    }
  } catch { /* preview may not be ready yet */ }
  try {
    const refreshed = await extCall({ action: 'list_user_projects' });
    if (refreshed.ok && Array.isArray(refreshed.projects)) {
      state.projects = refreshed.projects;
    }
  } catch (e) {
    /* fallback: keep current state */
  }
  render();
  toast('PPT 已生成完成，可在历史项目查看预览', 'ok');
}

function renderLiveProgress() {
  const live = state.live;
  if (!live) {
    return `
      <section class="live-panel" aria-live="polite">
        <header class="live-head">
          <div class="live-head-info">
            <span class="live-title">实时生成进度</span>
            <span class="live-topic">等待生成任务启动</span>
          </div>
        </header>
        <p class="live-status">点击“生成 PPTX”后，这里会显示 agent 的实时输出、工具调用和导出结果。</p>
        <div class="live-log empty">暂无生成过程文本</div>
      </section>
    `;
  }
  const steps = live.steps.map((step) => {
    const isCurrent = live.current === step.key;
    const cls = `live-step live-step-${step.status}${isCurrent ? ' live-step-current' : ''}`;
    let icon = '·';
    if (step.status === 'done') icon = '✓';
    else if (step.status === 'active' || isCurrent) icon = '◐';
    else if (step.status === 'error') icon = '✕';
    else if (step.status === 'skipped') icon = '–';
    let detail = '';
    if (step.detail) {
      if (step.key === 'svg-generation' && step.detail.startsWith('page:')) {
        const [_, i, total] = step.detail.split(':');
        detail = `<span class="live-step-detail">第 ${i} / ${total} 页</span>`;
      } else if (step.key === 'svg-generation' && step.detail.startsWith('start:total=')) {
        detail = `<span class="live-step-detail">共 ${step.detail.replace('start:total=', '')} 页</span>`;
      } else if (step.key === 'reading-sources' && step.detail.startsWith('file:')) {
        detail = `<span class="live-step-detail">${escapeHtml(step.detail.replace(/^file:/, ''))}</span>`;
      } else if (step.key === 'reading-sources' && step.detail === 'start') {
        detail = '<span class="live-step-detail">开始</span>';
      } else if (step.key === 'reading-sources' && step.detail === 'done') {
        detail = '<span class="live-step-detail">完成</span>';
      } else {
        detail = `<span class="live-step-detail">${escapeHtml(step.detail)}</span>`;
      }
    }
    return `<li class="${cls}" data-step="${escapeAttr(step.key)}"><span class="live-step-icon">${icon}</span><span class="live-step-label">${escapeHtml(step.label)}</span>${detail}</li>`;
  }).join('');
  const statusText = {
    running: 'agent 正在按 ppt-maker 工作流生成…',
    done: '生成完成 ✓',
    error: '生成失败',
  }[live.status] || '';
  const sessionLink = live.sessionUrl
    ? `<a class="text-btn" href="${escapeAttr(live.sessionUrl)}" target="_blank" rel="noreferrer">查看 Session 日志 ↗</a>`
    : '';
  const lastMessage = live.lastMessage
    ? `<div class="live-tail">${escapeHtml(live.lastMessage)}</div>`
    : '';
  const logs = live.logs && live.logs.length
    ? `<div class="live-log">${live.logs.map((line) => `
        <div class="live-log-line" data-tone="${escapeAttr(line.tone || 'info')}">
          <time>${escapeHtml(line.time || '')}</time>
          <span>${escapeHtml(line.text || '')}</span>
        </div>`).join('')}</div>`
    : '<div class="live-log empty">等待 agent 输出...</div>';
  const errorBlock = live.error
    ? `<div class="live-error">${escapeHtml(live.error)}</div>`
    : '';
  const closeBtn = (live.status === 'done' || live.status === 'error')
    ? `<button class="text-btn" type="button" data-action="close-live">收起</button>`
    : '';
  const isActive = live.status === 'running';
  return `
    <section class="live-panel ${isActive ? 'is-active' : ''}" aria-live="polite">
      <header class="live-head">
        <div class="live-head-info">
          <span class="live-title">实时生成进度</span>
          <span class="live-topic">${escapeHtml(live.topic || '')}</span>
        </div>
        <div class="live-head-actions">
          ${sessionLink}
          ${closeBtn}
        </div>
      </header>
      <p class="live-status">${escapeHtml(statusText)}</p>
      <ol class="live-steps">${steps}</ol>
      ${logs}
      ${lastMessage}
      ${errorBlock}
    </section>
  `;
}

document.addEventListener('click', (event) => {
  const routeButton = event.target.closest('[data-route]');
  if (routeButton) {
    collectForm();
    navigate(routeButton.dataset.route || 'compose');
    return;
  }

  const actionEl = event.target.closest('[data-action]');
  if (!actionEl) return;
  const action = actionEl.dataset.action;
  if (action === 'select-template') {
    state.selectedTemplateId = actionEl.dataset.templateId || 'free';
    const selected = selectedTemplate();
    toast(`已选择模板：${selected.name || '自由设计'}`);
    navigate('compose');
  } else if (action === 'copy-link') {
    copyText(actionEl.dataset.url || '', '下载链接已复制');
  } else if (action === 'copy-code') {
    copyText(actionEl.dataset.code || '', '示例代码已复制');
  } else if (action === 'copy-token') {
    copyText('<YOUR_MOBIUS_TOKEN>', 'token 占位已复制');
  } else if (action === 'focus-topic') {
    document.getElementById('topicInput')?.focus();
  } else if (action === 'refresh-history') {
    loadHistory().then(() => {
      toast('历史项目已刷新');
      render();
    }).catch((error) => toast(error.message, 'error'));
  } else if (action === 'hide-project-main') {
    setProjectMainVisibility(actionEl.dataset.projectId || '', true);
  } else if (action === 'show-project-main') {
    setProjectMainVisibility(actionEl.dataset.projectId || '', false);
  } else if (action === 'unselect-upload') {
    collectForm();
    state.selectedUploadIds.delete(String(actionEl.dataset.uploadId || ''));
    render();
  } else if (action === 'delete-upload') {
    deleteUpload(actionEl.dataset.uploadId || '').catch((error) => toast(error.message, 'error'));
  } else if (action === 'clear-uploads') {
    clearUploads().catch((error) => toast(error.message, 'error'));
  } else if (action === 'preview-project') {
    openPreview(actionEl.dataset.projectId || '', actionEl.dataset.projectTitle || '').catch((error) => toast(error.message, 'error'));
  } else if (action === 'preview-artifact') {
    openArtifactPreview(
      actionEl.dataset.projectId || '',
      actionEl.dataset.relPath || '',
      actionEl.dataset.artifactTitle || '',
      actionEl.dataset.previewKind || '',
    ).catch((error) => toast(error.message, 'error'));
  } else if (action === 'close-preview') {
    if (actionEl.classList.contains('preview-overlay') && event.target !== actionEl) return;
    closePreview();
  } else if (action === 'close-artifact-preview') {
    if (actionEl.classList.contains('preview-overlay') && event.target !== actionEl) return;
    closeArtifactPreview();
  } else if (action === 'preview-prev' || action === 'preview-next') {
    navigatePreview(action === 'preview-next' ? 1 : -1);
  } else if (action === 'close-live') {
    closeLiveSse();
    state.live = null;
    render();
  } else if (action === 'open-live') {
    const project = state.projects.find((p) => p.id === actionEl.dataset.projectId);
    if (project && project.session_id) {
      const live = ensureLive(project, { session_id: project.session_id, session_url: project.session_url });
      openLiveSse(project.session_id, project.id);
      render();
    }
  }
});

document.addEventListener('input', (event) => {
  if (['topicInput', 'sourceInput', 'pageCountInput', 'notesInput'].includes(event.target.id)) {
    collectForm();
  }
});

document.addEventListener('change', (event) => {
  if (event.target.id === 'templateSelect' || event.target.id === 'formatSelect') {
    collectForm();
    render();
    return;
  }
  const uploadId = event.target?.dataset?.uploadId;
  if (uploadId) {
    collectForm();
    if (event.target.checked) state.selectedUploadIds.add(String(uploadId));
    else state.selectedUploadIds.delete(String(uploadId));
    render();
  }
});

document.addEventListener('dragover', (event) => {
  const dropZone = event.target.closest?.('#dropZone');
  if (!dropZone) return;
  event.preventDefault();
  dropZone.classList.add('dragging');
});

document.addEventListener('dragleave', (event) => {
  const dropZone = event.target.closest?.('#dropZone');
  if (dropZone) dropZone.classList.remove('dragging');
});

document.addEventListener('drop', (event) => {
  const dropZone = event.target.closest?.('#dropZone');
  if (!dropZone) return;
  event.preventDefault();
  dropZone.classList.remove('dragging');
  uploadFiles(event.dataTransfer.files).catch((error) => toast(error.message, 'error'));
});

document.addEventListener('click', (event) => {
  if (event.target.id === 'pickFileBtn') {
    document.getElementById('fileInput')?.click();
  } else if (event.target.id === 'generateBtn') {
    generate().catch((error) => toast(error.message, 'error'));
  }
});

document.addEventListener('change', (event) => {
  if (event.target.id === 'fileInput') {
    uploadFiles(event.target.files).catch((error) => toast(error.message, 'error'));
  }
});

els.globalSearch.addEventListener('input', (event) => {
  state.search = event.target.value;
  if (!['history', 'templates'].includes(state.route)) {
    state.route = 'history';
    window.location.hash = state.route;
  }
  render();
});

els.refreshBtn.addEventListener('click', () => {
  loadState().catch((error) => toast(error.message, 'error'));
});

els.themeToggleBtn.addEventListener('click', () => {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, state.theme);
  applyTheme();
  toast(state.theme === 'dark' ? '已切换深色主题' : '已切换浅色主题');
});

window.addEventListener('hashchange', () => {
  collectForm();
  state.route = routeFromHash();
  render();
});

render();
loadState().catch((error) => toast(error.message || '初始化失败', 'error'));
