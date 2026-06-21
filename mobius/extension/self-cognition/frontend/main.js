import { extCall } from '/extension/_sdk/ext.js';

const labels = {
  statuses: {
    new: '新条目',
    candidate: '候选',
    triaged: '已研判',
    planned: '已计划',
    applied: '已落地',
    archived: '已归档',
  },
  sourceTypes: {
    paper: '论文',
    framework: '框架',
    method: '方法',
    note: '笔记',
    scan: '扫描候选',
  },
  priorities: {
    high: '高',
    medium: '中',
    low: '低',
  },
  directiveStatuses: {
    open: '待处理',
    planned: '已计划',
    done: '已完成',
    archived: '已归档',
  },
  productCategories: {
    'office-agent': '办公智能体',
    'coding-agent': '编码智能体',
    'general-agent': '通用智能体',
    'workflow-agent': '工作流智能体',
    'personal-agent': '个人助理',
    'research-agent': '研究智能体',
    other: '其他',
  },
};

const state = {
  ideas: [],
  total: 0,
  stats: null,
  directives: [],
  scanRuns: [],
  products: [],
  productScanRuns: [],
  constants: {
    default_scan_query: 'all:"Gödel Agent" OR all:"self-improving agents" OR all:"recursive self-improvement"',
    statuses: Object.keys(labels.statuses),
    source_types: Object.keys(labels.sourceTypes),
    product_categories: Object.keys(labels.productCategories),
  },
  selectedId: '',
  tab: 'library',
  filters: {
    q: '',
    status: '',
    source_type: '',
    tag: '',
  },
  loading: false,
};

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function nl2br(value) {
  return escapeHtml(value).replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>');
}

function showToast(message, tone = 'ok') {
  const toast = $('toast');
  toast.textContent = message;
  toast.dataset.tone = tone;
  toast.classList.add('is-visible');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('is-visible'), 2600);
}

async function call(payload) {
  const result = await extCall(payload);
  if (!result.ok) throw new Error(result.error || '调用失败');
  return result;
}

async function loadAll(extra = {}) {
  state.loading = true;
  renderLoading();
  try {
    const data = await call({ action: 'bootstrap', ...state.filters, ...extra });
    state.ideas = data.ideas || [];
    state.total = data.total || 0;
    state.stats = data.stats || null;
    state.directives = data.directives || [];
    state.scanRuns = data.scan_runs || [];
    state.products = data.product_research || [];
    state.productScanRuns = data.product_scan_runs || [];
    state.constants = { ...state.constants, ...(data.constants || {}) };
    if (!state.selectedId || !state.ideas.some((item) => item.id === state.selectedId)) {
      state.selectedId = state.ideas[0]?.id || '';
    }
    render();
  } catch (e) {
    showToast(e.message || '加载失败', 'bad');
    $('ideaDetail').innerHTML = `<div class="detail-empty">加载失败: ${escapeHtml(e.message)}</div>`;
  } finally {
    state.loading = false;
  }
}

function selectedIdea() {
  return state.ideas.find((item) => item.id === state.selectedId) || null;
}

function statusBadge(status) {
  const label = labels.statuses[status] || status || '未知';
  return `<span class="status-badge" data-status="${escapeHtml(status)}">${escapeHtml(label)}</span>`;
}

function typeBadge(type) {
  return `<span class="type-badge">${escapeHtml(labels.sourceTypes[type] || type || '未知')}</span>`;
}

function relevanceDots(value) {
  const n = Math.max(1, Math.min(5, Number(value) || 3));
  return Array.from({ length: 5 }, (_, index) => `<span class="${index < n ? 'on' : ''}"></span>`).join('');
}

function renderLoading() {
  $('ideaList').innerHTML = '<div class="skeleton-list"><span></span><span></span><span></span></div>';
}

function render() {
  renderMetrics();
  renderFilterOptions();
  renderList();
  renderDetail();
  renderRoadmap();
  renderScanRuns();
  renderProducts();
  renderDirectives();
  setTab(state.tab);
}

function renderMetrics() {
  const stats = state.stats || {};
  const byStatus = stats.by_status || {};
  const bySource = stats.by_source_type || {};
  const items = [
    ['研究条目', stats.total || 0, '已入库'],
    ['已研判', (byStatus.triaged || 0) + (byStatus.planned || 0) + (byStatus.applied || 0), '可进入路线图'],
    ['扫描候选', byStatus.candidate || 0, '待提炼'],
    ['开发指示', stats.directive_open || 0, '开放'],
    ['相似产品', stats.product_total || 0, `${stats.product_triaged || 0} 已研判`],
  ];
  $('metrics').innerHTML = items.map(([label, value, suffix]) => `
    <div class="metric">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      <em>${escapeHtml(suffix)}</em>
    </div>
  `).join('');
}

function renderFilterOptions() {
  const statusValue = state.filters.status;
  const typeValue = state.filters.source_type;
  const tagValue = state.filters.tag;
  $('statusFilter').innerHTML = [
    '<option value="">全部状态</option>',
    ...state.constants.statuses.map((status) => `<option value="${escapeHtml(status)}">${escapeHtml(labels.statuses[status] || status)}</option>`),
  ].join('');
  $('typeFilter').innerHTML = [
    '<option value="">全部类型</option>',
    ...state.constants.source_types.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(labels.sourceTypes[type] || type)}</option>`),
  ].join('');
  const tags = state.stats?.by_tag || [];
  $('tagFilter').innerHTML = [
    '<option value="">全部标签</option>',
    ...tags.map((item) => `<option value="${escapeHtml(item.tag)}">${escapeHtml(item.tag)} (${item.count})</option>`),
  ].join('');
  $('statusFilter').value = statusValue;
  $('typeFilter').value = typeValue;
  $('tagFilter').value = tagValue;
  $('searchInput').value = state.filters.q;
}

function renderList() {
  $('listCount').textContent = `${state.total} 条`;
  if (!state.ideas.length) {
    $('ideaList').innerHTML = `
      <div class="empty-list">
        <strong>没有匹配条目</strong>
        <span>调整筛选或新增一条启发。</span>
      </div>
    `;
    return;
  }
  $('ideaList').innerHTML = state.ideas.map((idea) => `
    <button class="idea-row ${idea.id === state.selectedId ? 'is-active' : ''}" type="button" data-id="${escapeHtml(idea.id)}">
      <span class="idea-row-title">${escapeHtml(idea.title)}</span>
      <span class="idea-row-meta">
        ${statusBadge(idea.status)}
        ${typeBadge(idea.source_type)}
        <span class="dots" aria-label="相关度">${relevanceDots(idea.relevance)}</span>
      </span>
      <span class="idea-row-tags">${(idea.tags || []).slice(0, 4).map((tag) => `<em>${escapeHtml(tag)}</em>`).join('')}</span>
    </button>
  `).join('');
}

function renderDetail() {
  const idea = selectedIdea();
  if (!idea) {
    $('ideaDetail').innerHTML = '<div class="detail-empty">选择一条研究启发。</div>';
    return;
  }
  $('ideaDetail').innerHTML = `
    <article class="detail">
      <div class="detail-head">
        <div>
          <div class="detail-badges">
            ${statusBadge(idea.status)}
            ${typeBadge(idea.source_type)}
            ${idea.auto_fetched ? '<span class="type-badge">自动扫描</span>' : ''}
          </div>
          <h2>${escapeHtml(idea.title)}</h2>
          <p class="detail-meta">${escapeHtml(idea.authors || '作者待补充')} · ${escapeHtml(idea.published_at || '日期待补充')} · 相关度 ${escapeHtml(idea.relevance)}/5</p>
        </div>
        <div class="detail-actions">
          <a class="ghost-button" href="${escapeHtml(idea.source_url)}" target="_blank" rel="noopener noreferrer">原文</a>
          <button class="ghost-button" type="button" data-edit-idea="${escapeHtml(idea.id)}">编辑</button>
        </div>
      </div>

      <section class="focus-block">
        <span>关键启发</span>
        <p>${nl2br(idea.key_inspiration || '')}</p>
      </section>

      <div class="detail-grid">
        <section>
          <h3>用于莫比乌斯</h3>
          <p>${nl2br(idea.mobius_use || '待补充')}</p>
        </section>
        <section>
          <h3>限制与风险</h3>
          <p>${nl2br(idea.limitations || '待补充')}</p>
        </section>
      </div>

      <section class="text-section">
        <h3>摘要</h3>
        <p>${nl2br(idea.abstract || '待补充')}</p>
      </section>

      <div class="tag-row">
        ${(idea.tags || []).map((tag) => `<button type="button" data-filter-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`).join('')}
      </div>

      <div class="status-actions">
        ${['candidate', 'triaged', 'planned', 'applied', 'archived'].map((status) => `
          <button type="button" data-set-status="${status}" ${idea.status === status ? 'disabled' : ''}>${escapeHtml(labels.statuses[status])}</button>
        `).join('')}
        <button class="danger-link" type="button" data-delete-idea="${escapeHtml(idea.id)}">删除</button>
      </div>
    </article>
  `;
}

function renderRoadmap() {
  const stats = state.stats?.by_status || {};
  const steps = [
    {
      title: '1. 研究吸收',
      tag: 'Gödel Agent / DGM / Polaris',
      body: '把外部论文压缩成 key_inspiration, 只保留能改变莫比乌斯迭代方式的内容。',
      metric: `${state.stats?.total || 0} 条入库`,
    },
    {
      title: '2. 经验抽象',
      tag: 'failure_pattern / repair_rule',
      body: '把失败日志提炼成可复用策略, 对重复失败生成最小补丁。',
      metric: `${stats.triaged || 0} 条已研判`,
    },
    {
      title: '3. 候选档案',
      tag: 'archive / lineage',
      body: '保留成功、失败和被放弃的方案, 形成可回放的演化树。',
      metric: `${stats.candidate || 0} 条候选`,
    },
    {
      title: '4. 适应度评估',
      tag: 'tests / review / rollback',
      body: '每次自改动都绑定验证命令、用户收益、风险等级和回滚条件。',
      metric: `${stats.planned || 0} 条已计划`,
    },
    {
      title: '5. 反向闭环',
      tag: 'idea -> issue -> patch',
      body: '把高价值启发转成自迭代 issue, 完成后回写 applied 和效果证据。',
      metric: `${stats.applied || 0} 条已落地`,
    },
  ];
  $('roadmap').innerHTML = steps.map((step) => `
    <div class="roadmap-item">
      <span>${escapeHtml(step.tag)}</span>
      <h2>${escapeHtml(step.title)}</h2>
      <p>${escapeHtml(step.body)}</p>
      <strong>${escapeHtml(step.metric)}</strong>
    </div>
  `).join('');
}

function renderScanRuns() {
  const runs = state.scanRuns || [];
  $('scanQuery').value = $('scanQuery').value || state.constants.default_scan_query || '';
  if (!runs.length) {
    $('scanRuns').innerHTML = '<div class="quiet-empty">暂无扫描记录</div>';
    return;
  }
  $('scanRuns').innerHTML = runs.map((run) => `
    <div class="run-row" data-status="${escapeHtml(run.status)}">
      <div>
        <strong>${escapeHtml(run.status === 'ok' ? '完成' : '失败')}</strong>
        <span>${escapeHtml(run.created_at)}</span>
      </div>
      <p>${escapeHtml(run.query)}</p>
      <em>新增 ${escapeHtml(run.inserted)} · 跳过 ${escapeHtml(run.skipped)}${run.error ? ` · ${escapeHtml(run.error)}` : ''}</em>
    </div>
  `).join('');
}

function renderProducts() {
  const products = state.products || [];
  if (!products.length) {
    $('productList').innerHTML = '<div class="quiet-empty">暂无相似产品调研</div>';
  } else {
    $('productList').innerHTML = products.map((item) => `
      <article class="product-card" data-status="${escapeHtml(item.status)}">
        <div class="product-card-head">
          <div>
            <span>${escapeHtml(labels.productCategories[item.category] || item.category || '其他')} · ${escapeHtml(labels.statuses[item.status] || item.status || '候选')} · 相关度 ${escapeHtml(item.relevance)}/5</span>
            <h2>${escapeHtml(item.name)}</h2>
          </div>
          <a class="ghost-button" href="${escapeHtml(item.source_url)}" target="_blank" rel="noopener noreferrer">来源</a>
        </div>
        <p class="product-positioning">${nl2br(item.positioning || item.fetched_description || '待补充定位')}</p>
        <div class="product-sections">
          <section>
            <h3>能力观察</h3>
            <p>${nl2br(item.observed_capabilities || '待补充')}</p>
          </section>
          <section>
            <h3>关键启发</h3>
            <p>${nl2br(item.key_inspiration || '待提炼')}</p>
          </section>
          <section>
            <h3>用于莫比乌斯</h3>
            <p>${nl2br(item.mobius_use || '待补充')}</p>
          </section>
          <section>
            <h3>风险/不该学的点</h3>
            <p>${nl2br(item.risks || '待补充')}</p>
          </section>
        </div>
        <div class="tag-row">
          ${(item.tags || []).map((tag) => `<span>${escapeHtml(tag)}</span>`).join('')}
        </div>
        <div class="status-actions">
          ${['candidate', 'triaged', 'planned', 'applied', 'archived'].map((status) => `
            <button type="button" data-product-status="${status}" data-id="${escapeHtml(item.id)}" ${item.status === status ? 'disabled' : ''}>${escapeHtml(labels.statuses[status])}</button>
          `).join('')}
          <button class="danger-link" type="button" data-delete-product="${escapeHtml(item.id)}">删除</button>
        </div>
      </article>
    `).join('');
  }

  const runs = state.productScanRuns || [];
  if (!runs.length) {
    $('productScanRuns').innerHTML = '<div class="quiet-empty">暂无产品抓取记录</div>';
  } else {
    $('productScanRuns').innerHTML = runs.map((run) => `
      <div class="run-row" data-status="${escapeHtml(run.status)}">
        <div>
          <strong>${escapeHtml(run.status === 'ok' ? '完成' : '失败')}</strong>
          <span>${escapeHtml(run.created_at)}</span>
        </div>
        <p>${escapeHtml(run.source_url)}</p>
        <em>${run.error ? escapeHtml(run.error) : '已入库'}</em>
      </div>
    `).join('');
  }
}

function renderDirectives() {
  const list = state.directives || [];
  if (!list.length) {
    $('directiveList').innerHTML = '<div class="quiet-empty">暂无开发者指示</div>';
    return;
  }
  $('directiveList').innerHTML = list.map((item) => `
    <article class="directive-row" data-priority="${escapeHtml(item.priority)}">
      <div>
        <span>${escapeHtml(labels.priorities[item.priority] || item.priority)}优先级 · ${escapeHtml(labels.directiveStatuses[item.status] || item.status)}</span>
        <h2>${escapeHtml(item.title)}</h2>
        <p>${nl2br(item.body)}</p>
        <em>${escapeHtml(item.created_by)} · ${escapeHtml(item.created_at)}</em>
      </div>
      <div class="mini-actions">
        ${['open', 'planned', 'done', 'archived'].map((status) => `
          <button type="button" data-directive-status="${status}" data-id="${escapeHtml(item.id)}" ${item.status === status ? 'disabled' : ''}>
            ${escapeHtml(labels.directiveStatuses[status])}
          </button>
        `).join('')}
        <button class="danger-link" type="button" data-delete-directive="${escapeHtml(item.id)}">删除</button>
      </div>
    </article>
  `).join('');
}

function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.tab === tab);
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('is-active', panel.id === `panel-${tab}`);
  });
  const sidebar = $('librarySidebar');
  const workspace = document.querySelector('.workspace');
  sidebar.hidden = tab !== 'library';
  workspace.classList.toggle('is-full', tab !== 'library');
}

function openIdeaModal(idea = null) {
  $('modalTitle').textContent = idea ? '编辑启发' : '新增启发';
  $('ideaId').value = idea?.id || '';
  $('ideaTitle').value = idea?.title || '';
  $('ideaUrl').value = idea?.source_url || '';
  $('ideaType').value = idea?.source_type || 'note';
  $('ideaStatus').value = idea?.status || 'new';
  $('ideaRelevance').value = idea?.relevance || 3;
  $('ideaPublishedAt').value = idea?.published_at || '';
  $('ideaAuthors').value = idea?.authors || '';
  $('ideaTags').value = (idea?.tags || []).join(', ');
  $('ideaKey').value = idea?.key_inspiration || '';
  $('ideaUse').value = idea?.mobius_use || '';
  $('ideaAbstract').value = idea?.abstract || '';
  $('ideaLimitations').value = idea?.limitations || '';
  const modal = $('ideaModal');
  modal.classList.add('is-open');
  modal.setAttribute('aria-hidden', 'false');
  $('ideaTitle').focus();
}

function closeIdeaModal() {
  const modal = $('ideaModal');
  modal.classList.remove('is-open');
  modal.setAttribute('aria-hidden', 'true');
}

function ideaPayloadFromForm() {
  return {
    id: $('ideaId').value,
    title: $('ideaTitle').value,
    source_url: $('ideaUrl').value,
    source_type: $('ideaType').value,
    status: $('ideaStatus').value,
    relevance: Number($('ideaRelevance').value || 3),
    published_at: $('ideaPublishedAt').value,
    authors: $('ideaAuthors').value,
    tags: $('ideaTags').value,
    key_inspiration: $('ideaKey').value,
    mobius_use: $('ideaUse').value,
    abstract: $('ideaAbstract').value,
    limitations: $('ideaLimitations').value,
  };
}

async function saveIdea(event) {
  event.preventDefault();
  const payload = ideaPayloadFromForm();
  const action = payload.id ? 'update' : 'create';
  try {
    const result = await call({ action, ...payload });
    const idea = result.idea;
    state.selectedId = idea.id;
    closeIdeaModal();
    showToast('已保存启发');
    await loadAll();
  } catch (e) {
    showToast(e.message || '保存失败', 'bad');
  }
}

async function setIdeaStatus(status) {
  const idea = selectedIdea();
  if (!idea) return;
  try {
    const result = await call({ action: 'set_status', id: idea.id, status });
    const index = state.ideas.findIndex((item) => item.id === idea.id);
    if (index >= 0) state.ideas[index] = result.idea;
    state.stats = result.stats || state.stats;
    render();
    showToast(`状态已更新为 ${labels.statuses[status] || status}`);
  } catch (e) {
    showToast(e.message || '状态更新失败', 'bad');
  }
}

async function deleteSelectedIdea(id) {
  const idea = state.ideas.find((item) => item.id === id);
  if (!idea) return;
  if (!confirm(`删除「${idea.title}」？`)) return;
  try {
    await call({ action: 'delete', id });
    state.selectedId = '';
    showToast('已删除');
    await loadAll();
  } catch (e) {
    showToast(e.message || '删除失败', 'bad');
  }
}

async function runScan(event) {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  button.textContent = '扫描中...';
  try {
    const result = await call({
      action: 'scan_arxiv',
      query: $('scanQuery').value,
      max_results: Number($('scanMax').value || 8),
    });
    state.ideas = result.ideas || state.ideas;
    state.total = result.total || state.total;
    state.stats = result.stats || state.stats;
    state.scanRuns = result.scan_runs || state.scanRuns;
    if (!state.selectedId && state.ideas[0]) state.selectedId = state.ideas[0].id;
    render();
    showToast(`扫描完成: 新增 ${result.scan.inserted}, 跳过 ${result.scan.skipped}`);
  } catch (e) {
    showToast(e.message || '扫描失败', 'bad');
  } finally {
    button.disabled = false;
    button.innerHTML = '<span>⌕</span> 扫描并入库';
  }
}

async function refreshProducts() {
  try {
    const result = await call({ action: 'list_products' });
    state.products = result.products || [];
    state.productScanRuns = result.product_scan_runs || state.productScanRuns;
    state.stats = result.stats || state.stats;
    render();
    showToast('产品调研已刷新');
  } catch (e) {
    showToast(e.message || '刷新失败', 'bad');
  }
}

async function runProductScan(event) {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  button.textContent = '抓取中...';
  try {
    const result = await call({
      action: 'scan_product_url',
      source_url: $('productUrl').value,
      name: $('productName').value,
      category: $('productCategory').value,
      relevance: Number($('productRelevance').value || 3),
    });
    state.products = result.products || state.products;
    state.productScanRuns = result.product_scan_runs || state.productScanRuns;
    state.stats = result.stats || state.stats;
    $('productUrl').value = '';
    $('productName').value = '';
    render();
    showToast(`已入库: ${result.product_scan.product.name}`);
  } catch (e) {
    showToast(e.message || '抓取失败', 'bad');
  } finally {
    button.disabled = false;
    button.innerHTML = '<span>⌕</span> 抓取并入库';
  }
}

async function updateProductStatus(id, status) {
  try {
    const result = await call({ action: 'update_product', id, status });
    state.products = result.products || state.products;
    state.stats = result.stats || state.stats;
    render();
    showToast(`产品状态已更新为 ${labels.statuses[status] || status}`);
  } catch (e) {
    showToast(e.message || '更新失败', 'bad');
  }
}

async function deleteProduct(id) {
  const product = state.products.find((item) => item.id === id);
  if (!product) return;
  if (!confirm(`删除「${product.name}」？`)) return;
  try {
    const result = await call({ action: 'delete_product', id });
    state.products = result.products || state.products;
    state.stats = result.stats || state.stats;
    render();
    showToast('已删除产品调研');
  } catch (e) {
    showToast(e.message || '删除失败', 'bad');
  }
}

async function saveDirective(event) {
  event.preventDefault();
  try {
    const result = await call({
      action: 'create_directive',
      title: $('directiveTitle').value,
      body: $('directiveBody').value,
      priority: $('directivePriority').value,
      status: $('directiveStatus').value,
    });
    state.directives = result.directives || state.directives;
    state.stats = result.stats || state.stats;
    $('directiveTitle').value = '';
    $('directiveBody').value = '';
    render();
    showToast('已保存指示');
  } catch (e) {
    showToast(e.message || '保存失败', 'bad');
  }
}

async function updateDirectiveStatus(id, status) {
  try {
    const result = await call({ action: 'update_directive', id, status });
    state.directives = result.directives || state.directives;
    state.stats = result.stats || state.stats;
    render();
    showToast('指示状态已更新');
  } catch (e) {
    showToast(e.message || '更新失败', 'bad');
  }
}

async function deleteDirective(id) {
  if (!confirm('删除这条开发者指示？')) return;
  try {
    const result = await call({ action: 'delete_directive', id });
    state.directives = result.directives || state.directives;
    state.stats = result.stats || state.stats;
    render();
    showToast('已删除指示');
  } catch (e) {
    showToast(e.message || '删除失败', 'bad');
  }
}

function bindEvents() {
  $('refreshBtn').addEventListener('click', () => loadAll());
  $('newIdeaBtn').addEventListener('click', () => openIdeaModal());
  $('ideaForm').addEventListener('submit', saveIdea);
  $('scanForm').addEventListener('submit', runScan);
  $('productScanForm').addEventListener('submit', runProductScan);
  $('refreshProductsBtn').addEventListener('click', refreshProducts);
  $('directiveForm').addEventListener('submit', saveDirective);

  document.querySelectorAll('[data-close-modal]').forEach((node) => {
    node.addEventListener('click', closeIdeaModal);
  });
  document.querySelectorAll('.tab').forEach((button) => {
    button.addEventListener('click', () => setTab(button.dataset.tab));
  });

  let searchTimer = 0;
  $('searchInput').addEventListener('input', (event) => {
    state.filters.q = event.target.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadAll(), 220);
  });
  $('statusFilter').addEventListener('change', (event) => {
    state.filters.status = event.target.value;
    loadAll();
  });
  $('typeFilter').addEventListener('change', (event) => {
    state.filters.source_type = event.target.value;
    loadAll();
  });
  $('tagFilter').addEventListener('change', (event) => {
    state.filters.tag = event.target.value;
    loadAll();
  });
  $('clearFiltersBtn').addEventListener('click', () => {
    state.filters = { q: '', status: '', source_type: '', tag: '' };
    loadAll();
  });

  $('ideaList').addEventListener('click', (event) => {
    const row = event.target.closest('[data-id]');
    if (!row) return;
    state.selectedId = row.dataset.id;
    renderList();
    renderDetail();
  });

  $('ideaDetail').addEventListener('click', (event) => {
    const editId = event.target.closest('[data-edit-idea]')?.dataset.editIdea;
    if (editId) {
      openIdeaModal(state.ideas.find((item) => item.id === editId));
      return;
    }
    const status = event.target.closest('[data-set-status]')?.dataset.setStatus;
    if (status) {
      setIdeaStatus(status);
      return;
    }
    const deleteId = event.target.closest('[data-delete-idea]')?.dataset.deleteIdea;
    if (deleteId) {
      deleteSelectedIdea(deleteId);
      return;
    }
    const tag = event.target.closest('[data-filter-tag]')?.dataset.filterTag;
    if (tag) {
      state.filters.tag = tag;
      loadAll();
    }
  });

  $('directiveList').addEventListener('click', (event) => {
    const statusButton = event.target.closest('[data-directive-status]');
    if (statusButton) {
      updateDirectiveStatus(statusButton.dataset.id, statusButton.dataset.directiveStatus);
      return;
    }
    const deleteButton = event.target.closest('[data-delete-directive]');
    if (deleteButton) deleteDirective(deleteButton.dataset.deleteDirective);
  });

  $('productList').addEventListener('click', (event) => {
    const statusButton = event.target.closest('[data-product-status]');
    if (statusButton) {
      updateProductStatus(statusButton.dataset.id, statusButton.dataset.productStatus);
      return;
    }
    const deleteButton = event.target.closest('[data-delete-product]');
    if (deleteButton) deleteProduct(deleteButton.dataset.deleteProduct);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeIdeaModal();
  });
}

bindEvents();
loadAll();
