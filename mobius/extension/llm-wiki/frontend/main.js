import { extCall, extName } from '/extension/_sdk/ext.js';

// ============================================================
// 状态
// ============================================================
const state = {
  tree: null,
  currentPath: '',
  history: [],
  historyIdx: -1,
  knownSlugs: new Set(),
  showRaw: false,
};

// ============================================================
// 工具
// ============================================================
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (kind ? ' ' + kind : '');
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 4500 : 2200);
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function basename(p) {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

function stripMd(p) {
  return p.endsWith('.md') ? p.slice(0, -3) : p;
}

// ============================================================
// 极简 Markdown 渲染器 (GFM 子集 + [[wikilinks]])
// 不引外部依赖, 单文件够用
// ============================================================
function renderMarkdown(md) {
  if (!md) return '';

  // 1) 剥掉 frontmatter (单独展示)
  let body = md;
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3);
    if (end >= 0) body = body.slice(end + 4).replace(/^\s*\n/, '');
  }

  // 2) 先抽取代码块占位, 防止被其它规则污染
  const codeBlocks = [];
  body = body.replace(/```([\w-]*)\n([\s\S]*?)```/g, (m, lang, code) => {
    const placeholder = `CODEBLOCK${codeBlocks.length}`;
    codeBlocks.push(`<pre><code>${escapeHtml(code)}</code></pre>`);
    return placeholder;
  });

  // 3) 行内代码占位
  const inlineCodes = [];
  body = body.replace(/`([^`\n]+)`/g, (m, code) => {
    const placeholder = `INLINE${inlineCodes.length}`;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return placeholder;
  });

  // 4) 表格 (GFM 简易: 一行 | a | b | + 分隔行 |---|---|)
  body = renderTables(body);

  // 5) 按行处理: 标题 / 列表 / 引用 / 水平线 / 段落
  const lines = body.split('\n');
  const out = [];
  let i = 0;
  let inUl = false;
  let inOl = false;

  function closeLists() {
    if (inUl) { out.push('</ul>'); inUl = false; }
    if (inOl) { out.push('</ol>'); inOl = false; }
  }

  while (i < lines.length) {
    const line = lines[i];

    // 空行
    if (!line.trim()) { closeLists(); i++; continue; }

    // 标题
    const h = /^(#{1,6})\s+(.+)$/.exec(line);
    if (h) {
      closeLists();
      const level = h[1].length;
      out.push(`<h${level}>${renderInline(h[2])}</h${level}>`);
      i++; continue;
    }

    // 水平线
    if (/^---+\s*$/.test(line) || /^\*\*\*+\s*$/.test(line)) {
      closeLists();
      out.push('<hr>');
      i++; continue;
    }

    // 引用
    if (/^>\s?/.test(line)) {
      closeLists();
      const text = line.replace(/^>\s?/, '');
      out.push(`<blockquote>${renderInline(text)}</blockquote>`);
      i++; continue;
    }

    // 无序列表
    if (/^[-*+]\s+/.test(line)) {
      if (inOl) { out.push('</ol>'); inOl = false; }
      if (!inUl) { out.push('<ul>'); inUl = true; }
      out.push(`<li>${renderInline(line.replace(/^[-*+]\s+/, ''))}</li>`);
      i++; continue;
    }

    // 有序列表
    if (/^\d+\.\s+/.test(line)) {
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (!inOl) { out.push('<ol>'); inOl = true; }
      out.push(`<li>${renderInline(line.replace(/^\d+\.\s+/, ''))}</li>`);
      i++; continue;
    }

    // 段落 (合并连续非空非特殊行)
    closeLists();
    const paraLines = [];
    while (
      i < lines.length
      && lines[i].trim()
      && !/^(#{1,6}\s|[-*+]\s|\d+\.\s|>\s?|---+\s*$|\*\*\*+\s*$)/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length) {
      out.push(`<p>${renderInline(paraLines.join(' '))}</p>`);
    }
  }
  closeLists();

  let html = out.join('\n');

  // 6) 还原占位
  html = html.replace(/INLINE(\d+)/g, (m, idx) => inlineCodes[Number(idx)]);
  html = html.replace(/CODEBLOCK(\d+)/g, (m, idx) => codeBlocks[Number(idx)]);

  return html;
}

function renderTables(body) {
  // 匹配连续的表格行块
  return body.replace(/(^\|[^\n]*\|\s*\n(?:\|[\s\-:|]+\|\s*\n)?(?:\|[^\n]*\|\s*(\n|$))+)/gm, (block) => {
    const rows = block.trim().split('\n').filter(Boolean);
    if (rows.length < 2) return block;
    // 跳过分隔行
    const dataRows = rows.filter((r) => !/^\|[\s\-:|]+\|\s*$/.test(r));
    if (dataRows.length === 0) return block;
    const parseRow = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const head = parseRow(dataRows[0]);
    const bodyRows = dataRows.slice(1);
    const ths = head.map((c) => `<th>${renderInline(c)}</th>`).join('');
    const trs = bodyRows.map((r) => {
      const cells = parseRow(r);
      return `<tr>${cells.map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`;
    }).join('');
    return `<table><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>\n`;
  });
}

function renderInline(text) {
  // 顺序很重要: 先 [[wikilink]], 再 link, 再粗斜体, 否则 anchor 的 href 会被错处理
  let s = escapeHtml(text);

  // [[path|text]] 或 [[path]]
  s = s.replace(/\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g, (m, target, label) => {
    const t = target.trim();
    const lbl = (label || target).trim();
    const broken = state.knownSlugs.size > 0 && !state.knownSlugs.has(t);
    const cls = 'wikilink' + (broken ? ' broken' : '');
    const href = '#wiki/' + encodeURIComponent(t);
    return `<a class="${cls}" data-wikilink="${escapeHtml(t)}" href="${href}">${lbl}</a>`;
  });

  // [text](url)  — 注意要避开已被替换的 wikilink 内部
  s = s.replace(/(?<!!)\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, txt, url) => {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${txt}</a>`;
  });

  // 粗体
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  // 斜体
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  // 删除线
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  return s;
}

// ============================================================
// Frontmatter 渲染
// ============================================================
function renderFrontmatter(md) {
  if (!md || !md.startsWith('---')) return null;
  const end = md.indexOf('\n---', 3);
  if (end < 0) return null;
  const block = md.slice(3, end).trim();
  const lines = block.split('\n');
  const out = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) {
      const key = kv[1];
      const val = kv[2].trim();
      out.push(`<span class="fm-key">${escapeHtml(key)}</span>: <span class="fm-val">${renderFmVal(val)}</span>`);
    } else if (line.startsWith('  - ')) {
      out[out.length - 1] += ` <span class="fm-val">${renderFmVal(line.slice(4).trim())}</span>`;
    }
  }
  return out.length ? out.join('<br>') : null;
}

function renderFmVal(val) {
  if (val === '') return '<span class="fm-bool">(empty)</span>';
  if (val === 'true' || val === 'false') return `<span class="fm-bool">${val}</span>`;
  if (/^-?\d+$/.test(val)) return `<span class="fm-num">${val}</span>`;
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return `<span class="fm-str">${escapeHtml(val)}</span>`;
  }
  return escapeHtml(val);
}

// ============================================================
// 树渲染
// ============================================================
async function refreshTree() {
  try {
    const data = await extCall({ action: 'tree' });
    if (!data.ok) throw new Error(data.error || 'tree 失败');
    state.tree = data;
    // 把 wiki 下的所有 slug 收进 knownSlugs, 用于 wikilink 失效检测
    state.knownSlugs = new Set();
    if (data.wiki) {
      for (const dir of Object.keys(data.wiki)) {
        for (const f of data.wiki[dir]) {
          state.knownSlugs.add(`${dir}/${f.name.replace(/\.md$/, '')}`);
        }
      }
    }
    renderTree();
  } catch (e) {
    toast(e.message || 'tree 失败', 'error');
  }
}

const TREE_ICONS = {
  'index.md': '📚',
  'overview.md': '🌍',
  'log.md': '📜',
};

function renderTree() {
  const root = $('#tree-root');
  if (!state.tree) { root.innerHTML = '<div class="empty-meta">尚未同步</div>'; return; }
  const t = state.tree;
  const html = [];

  // 根级 schema/purpose
  if (t.root && t.root.length) {
    html.push('<div class="tree-group">');
    html.push('<div class="tree-group-title">规则</div>');
    for (const f of t.root) {
      const p = f.path;
      const icon = TREE_ICONS[f.name] || '📄';
      html.push(treeItem(p, icon, f.name));
    }
    html.push('</div>');
  }

  // wiki/<dir>/<file>
  if (t.wiki) {
    const dirLabels = {
      '.': '顶层',
      projects: '项目',
      issues: 'Issues',
      entities: '实体',
    };
    // 按固定顺序展示
    const order = ['.', 'projects', 'issues', 'entities'];
    for (const dir of order) {
      const list = t.wiki[dir];
      if (!list || !list.length) continue;
      html.push('<div class="tree-group">');
      html.push(`<div class="tree-group-title">${dirLabels[dir] || dir}</div>`);
      for (const f of list) {
        const p = 'wiki/' + f.path;
        const icon = dir === 'projects' ? '📁' : dir === 'issues' ? '🐞' : dir === 'entities' ? '🔗' : '📄';
        const display = stripMd(f.name);
        html.push(treeItem(p, icon, display));
      }
      html.push('</div>');
    }
  }

  // raw
  if (state.showRaw && t.raw) {
    html.push('<div class="tree-group">');
    html.push('<div class="tree-group-title">Raw · Projects</div>');
    for (const f of (t.raw.projects || [])) {
      html.push(treeItem(f.path, '🌱', stripMd(f.name)));
    }
    html.push('<div class="tree-group-title" style="margin-top:12px;">Raw · Issues</div>');
    for (const f of (t.raw.issues || [])) {
      html.push(treeItem(f.path, '🌱', stripMd(f.name)));
    }
    html.push('</div>');
  }

  root.innerHTML = html.join('') || '<div class="empty-meta">空</div>';

  // 绑点击
  $$('#tree-root .tree-item').forEach((el) => {
    el.addEventListener('click', () => {
      const p = el.getAttribute('data-path');
      if (p) navigate(p, { pushHistory: true });
    });
  });

  highlightActiveTree();
}

function treeItem(path, icon, name) {
  return `<div class="tree-item" data-path="${escapeHtml(path)}">
    <span class="icon">${icon}</span>
    <span class="name">${escapeHtml(name)}</span>
  </div>`;
}

function highlightActiveTree() {
  $$('#tree-root .tree-item').forEach((el) => {
    el.classList.toggle('active', el.getAttribute('data-path') === state.currentPath);
  });
}

// ============================================================
// 读取并渲染页面
// ============================================================
async function navigate(rawPath, opts = {}) {
  const path = String(rawPath || '').trim();
  if (!path) return;
  const content = $('#content');

  try {
    const r = await extCall({ action: 'read', path });
    if (!r.ok) {
      // 如果带 .md 失败, 不再补
      content.innerHTML = `<div class="empty">
        <p class="empty-title">读不到这个页面</p>
        <p class="empty-sub">${escapeHtml(r.error || '未知错误')}</p>
        <p class="empty-meta">${escapeHtml(path)}</p>
      </div>`;
      $('#frontmatter').hidden = true;
      $('#current-path').textContent = path;
      return;
    }

    state.currentPath = r.path;
    if (opts.pushHistory) {
      state.history = state.history.slice(0, state.historyIdx + 1);
      state.history.push(r.path);
      state.historyIdx = state.history.length - 1;
    }

    $('#current-path').textContent = r.path;
    // frontmatter
    const fm = renderFrontmatter(r.body);
    if (fm) {
      $('#frontmatter').innerHTML = fm;
      $('#frontmatter').hidden = false;
    } else {
      $('#frontmatter').hidden = true;
    }
    // body
    content.innerHTML = renderMarkdown(r.body);

    // 给所有 wikilink 绑点击
    $$('#content a[data-wikilink]').forEach((el) => {
      el.addEventListener('click', (ev) => {
        ev.preventDefault();
        const target = el.getAttribute('data-wikilink');
        navigate(target, { pushHistory: true });
      });
    });

    highlightActiveTree();
    // 滚回顶
    document.querySelector('.pane-view .pane-body').scrollTop = 0;
  } catch (e) {
    toast(e.message || '读取失败', 'error');
  }
}

// ============================================================
// 顶部按钮
// ============================================================
async function syncFromMobius() {
  const btn = $('#syncBtn');
  btn.disabled = true;
  btn.textContent = '同步中…';
  toast('正在从 mobius 拉 projects + issues…');
  try {
    const t0 = Date.now();
    const r = await extCall({ action: 'ingest' });
    if (!r.ok) throw new Error(r.error || 'ingest 失败');
    const c = r.counts || {};
    toast(
      `同步完成 · ${c.projects} 项目 / ${c.issues} issue / ${c.entities} 实体 · ${(r.elapsed_ms / 1000).toFixed(1)}s`,
      'success',
    );
    await refreshStatus();
    await refreshTree();
    // 默认打开 overview
    if (!state.currentPath) navigate('wiki/overview.md', { pushHistory: true });
  } catch (e) {
    toast(e.message || 'ingest 失败', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '从 Mobius 同步';
  }
}

async function refreshStatus() {
  try {
    const r = await extCall({ action: 'status' });
    const pill = $('#status-pill');
    if (!r.ok || !r.initialized) {
      pill.textContent = '尚未同步';
      return;
    }
    const c = r.counts || {};
    const ts = r.last_ingest_at ? new Date(r.last_ingest_at).toLocaleString('zh-CN', { hour12: false }) : '';
    pill.textContent = `${c.projects || 0} 项目 / ${c.issues || 0} issue · ${ts}`;
  } catch { /* ignore */ }
}

async function runLint() {
  const btn = $('#lintBtn');
  btn.disabled = true;
  btn.textContent = '检查中…';
  try {
    const r = await extCall({ action: 'lint' });
    if (!r.ok) throw new Error(r.error || 'lint 失败');
    showSidePanel('lint');
    const list = $('#lint-list');
    if (!r.issues || !r.issues.length) {
      list.innerHTML = `<li class="result-item"><span class="ri-title" style="color:var(--success)">✓ 全部健康</span><span class="ri-path">${r.pages} 页 · 0 问题</span></li>`;
      toast('Lint 通过 · 0 问题', 'success');
      return;
    }
    toast(`发现 ${r.issues.length} 个问题`, '');
    const grouped = {};
    for (const i of r.issues) {
      const k = i.kind;
      if (!grouped[k]) grouped[k] = [];
      grouped[k].push(i);
    }
    const labels = {
      dead_link: ['死链', 'danger'],
      orphan: ['孤儿页', 'warn'],
      no_outgoing_links: ['无出链', 'warn'],
      oversize: ['超大', 'warn'],
    };
    list.innerHTML = Object.entries(grouped).map(([kind, items]) => {
      const [lbl, cls] = labels[kind] || [kind, ''];
      return items.slice(0, 50).map((i) => {
        const target = i.target ? ` → ${escapeHtml(i.target)}` : '';
        const size = i.size ? ` (${i.size}b)` : '';
        return `<li class="result-item" data-path="${escapeHtml(i.path)}">
          <span class="ri-title">${escapeHtml(basename(i.path))}<span class="ri-tag ${cls}">${lbl}</span></span>
          <span class="ri-path">${escapeHtml(i.path)}${target}${size}</span>
        </li>`;
      }).join('');
    }).join('');
    $$('#lint-list .result-item').forEach((el) => {
      el.addEventListener('click', () => navigate(el.getAttribute('data-path'), { pushHistory: true }));
    });
  } catch (e) {
    toast(e.message || 'lint 失败', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Lint';
  }
}

// ============================================================
// 力导向关系图
// ============================================================
const SVG_NS = 'http://www.w3.org/2000/svg';
const GRAPH_W = 280;
const GRAPH_H = 280;
const GRAPH_TOP_N = 28;

const NODE_STYLE = {
  project:  { color: '#0a84ff', r: 6 },
  issue:    { color: '#ff6b6b', r: 4 },
  entity:   { color: '#bf5af2', r: 5 },
  index:    { color: '#34c759', r: 8 },
  overview: { color: '#34c759', r: 8 },
  log:      { color: '#ffd60a', r: 6 },
};

function layoutForceDirected(nodes, edges) {
  // 初始: 圆周分布, 加一点扰动避免共线
  nodes.forEach((n, i) => {
    const ang = (i / nodes.length) * Math.PI * 2;
    const radius = Math.min(GRAPH_W, GRAPH_H) * 0.35;
    n.x = GRAPH_W / 2 + Math.cos(ang) * radius + (Math.random() - 0.5) * 8;
    n.y = GRAPH_H / 2 + Math.sin(ang) * radius + (Math.random() - 0.5) * 8;
    n.vx = 0; n.vy = 0;
  });

  const k_repel = 900;
  const k_spring = 0.035;
  const restLen = 42;
  const k_center = 0.012;

  for (let it = 0; it < 140; it++) {
    // 排斥 (Coulomb-like)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) { dx = (Math.random() - 0.5) * 0.1; dy = (Math.random() - 0.5) * 0.1; d2 = 0.01; }
        const d = Math.sqrt(d2);
        const f = k_repel / d2;
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
    }
    // 弹簧 (Hooke)
    for (const e of edges) {
      const a = e._src, b = e._dst;
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = k_spring * (d - restLen);
      const fx = (dx / d) * f, fy = (dy / d) * f;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    }
    // 中心吸引 + 阻尼 + 边界
    for (const n of nodes) {
      n.vx += (GRAPH_W / 2 - n.x) * k_center;
      n.vy += (GRAPH_H / 2 - n.y) * k_center;
      n.vx *= 0.82; n.vy *= 0.82;
      n.x += n.vx; n.y += n.vy;
      const pad = 14;
      n.x = Math.max(pad, Math.min(GRAPH_W - pad, n.x));
      n.y = Math.max(pad, Math.min(GRAPH_H - pad, n.y));
    }
  }
}

function renderGraphSvg(nodes, edges, id2node) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${GRAPH_W} ${GRAPH_H}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', String(GRAPH_H));
  svg.classList.add('graph-svg');

  // defs: 弱光晕滤镜 (可选, 先省了)

  const edgeGroup = document.createElementNS(SVG_NS, 'g');
  const nodeGroup = document.createElementNS(SVG_NS, 'g');
  svg.appendChild(edgeGroup);
  svg.appendChild(nodeGroup);

  const edgeEls = [];
  for (const e of edges) {
    const a = e._src, b = e._dst;
    if (!a || !b) continue;
    const ln = document.createElementNS(SVG_NS, 'line');
    ln.setAttribute('x1', a.x);
    ln.setAttribute('y1', a.y);
    ln.setAttribute('x2', b.x);
    ln.setAttribute('y2', b.y);
    ln.setAttribute('class', 'graph-edge');
    ln.dataset.source = a.id;
    ln.dataset.target = b.id;
    edgeGroup.appendChild(ln);
    edgeEls.push(ln);
  }

  const nodeEls = [];
  for (const n of nodes) {
    const style = NODE_STYLE[n.type] || { color: '#8b94a3', r: 4 };
    const g = document.createElementNS(SVG_NS, 'g');
    g.classList.add('graph-node-g');
    g.dataset.id = n.id;
    g.style.cursor = 'pointer';

    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', n.x);
    c.setAttribute('cy', n.y);
    c.setAttribute('r', String(style.r));
    c.setAttribute('fill', style.color);
    c.setAttribute('stroke', 'rgba(255,255,255,0.25)');
    c.setAttribute('stroke-width', '1');
    g.appendChild(c);

    // 高入度的节点附标签 (top 5)
    if (n.deg >= 3 || n.type === 'index' || n.type === 'overview') {
      const t = document.createElementNS(SVG_NS, 'text');
      const label = (n.title || '').slice(0, 10);
      t.setAttribute('x', n.x + style.r + 3);
      t.setAttribute('y', n.y + 3);
      t.setAttribute('class', 'graph-label');
      t.textContent = label;
      g.appendChild(t);
    }

    const title = document.createElementNS(SVG_NS, 'title');
    title.textContent = `${n.title} (${n.type}, 入度 ${n.deg})`;
    g.appendChild(title);

    nodeGroup.appendChild(g);
    nodeEls.push(g);
  }

  function highlight(id) {
    const neighbors = new Set([id]);
    for (const e of edges) {
      if (e._src.id === id) neighbors.add(e._dst.id);
      if (e._dst.id === id) neighbors.add(e._src.id);
    }
    nodeEls.forEach((el) => {
      const isN = neighbors.has(el.dataset.id);
      el.style.opacity = isN ? '1' : '0.15';
      const c = el.querySelector('circle');
      if (c) {
        c.setAttribute('stroke', el.dataset.id === id ? '#fff' : 'rgba(255,255,255,0.25)');
        c.setAttribute('stroke-width', el.dataset.id === id ? '2' : '1');
      }
    });
    edgeEls.forEach((el) => {
      const isE = el.dataset.source === id || el.dataset.target === id;
      el.style.opacity = isE ? '0.9' : '0.05';
    });
  }
  function reset() {
    nodeEls.forEach((el) => {
      el.style.opacity = '1';
      const c = el.querySelector('circle');
      if (c) {
        c.setAttribute('stroke', 'rgba(255,255,255,0.25)');
        c.setAttribute('stroke-width', '1');
      }
    });
    edgeEls.forEach((el) => { el.style.opacity = ''; });
  }

  nodeEls.forEach((el) => {
    el.addEventListener('mouseenter', () => highlight(el.dataset.id));
    el.addEventListener('mouseleave', reset);
    el.addEventListener('click', () => {
      const n = id2node.get(el.dataset.id);
      if (n && n.path) navigate(n.path, { pushHistory: true });
    });
  });

  // 列表 hover 也高亮 SVG
  svg._highlight = highlight;
  svg._reset = reset;
  return svg;
}

async function showGraph() {
  const btn = $('#graphBtn');
  btn.disabled = true;
  btn.textContent = '加载中…';
  try {
    const r = await extCall({ action: 'graph' });
    if (!r.ok) throw new Error(r.error || 'graph 失败');
    showSidePanel('graph');

    // 入度
    const inDeg = new Map();
    for (const e of r.edges) inDeg.set(e.target, (inDeg.get(e.target) || 0) + 1);
    for (const n of r.nodes) n.deg = inDeg.get(n.id) || 0;

    // top N 节点 + 子图
    const topN = r.nodes.slice().sort((a, b) => b.deg - a.deg).slice(0, GRAPH_TOP_N);
    const topIds = new Set(topN.map((n) => n.id));
    const id2node = new Map(topN.map((n) => [n.id, n]));
    const subEdges = r.edges
      .filter((e) => topIds.has(e.source) && topIds.has(e.target))
      .map((e) => ({ _src: id2node.get(e.source), _dst: id2node.get(e.target) }));

    $('#graph-stats').textContent = `top ${topN.length} / ${r.nodes.length} 节点 · 子图 ${subEdges.length} / ${r.edges.length} 边`;

    // 布局
    layoutForceDirected(topN, subEdges);

    // 渲染 SVG
    const wrap = $('#graph-canvas-wrap');
    wrap.innerHTML = '';
    const svg = renderGraphSvg(topN, subEdges, id2node);
    wrap.appendChild(svg);

    // 列表
    const typeIcons = { project: '📁', issue: '🐞', entity: '🔗', index: '📚', overview: '🌍', log: '📜' };
    const list = $('#graph-list');
    list.innerHTML = topN.slice(0, 18).map((n) => {
      const icon = typeIcons[n.type] || '📄';
      return `<li class="result-item" data-path="${escapeHtml(n.path)}" data-id="${escapeHtml(n.id)}">
        <span class="ri-title">${icon} ${escapeHtml(n.title)}<span class="ri-tag">入度 ${n.deg}</span></span>
        <span class="ri-path">${escapeHtml(n.path)}</span>
      </li>`;
    }).join('');
    $$('#graph-list .result-item').forEach((el) => {
      el.addEventListener('click', () => navigate(el.getAttribute('data-path'), { pushHistory: true }));
      el.addEventListener('mouseenter', () => svg._highlight && svg._highlight(el.dataset.id));
      el.addEventListener('mouseleave', () => svg._reset && svg._reset());
    });
  } catch (e) {
    toast(e.message || 'graph 失败', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '关系图';
  }
}

async function doSearch(query) {
  const q = String(query || '').trim();
  if (!q) {
    showSidePanel('welcome');
    return;
  }
  try {
    const r = await extCall({ action: 'search', query: q, limit: 30 });
    if (!r.ok) throw new Error(r.error || 'search 失败');
    showSidePanel('search');
    const list = $('#search-list');
    if (!r.results || !r.results.length) {
      list.innerHTML = `<li class="result-item"><span class="ri-title" style="color:var(--text-2)">未匹配</span><span class="ri-path">查询: ${escapeHtml(q)}</span></li>`;
      return;
    }
    list.innerHTML = r.results.map((item) => {
      const snip = item.snippet ? `<div class="ri-snippet">${escapeHtml(item.snippet)}</div>` : '';
      return `<li class="result-item" data-path="${escapeHtml(item.path)}">
        <span class="ri-title">${escapeHtml(item.title)}<span class="ri-tag">分 ${item.score}</span></span>
        <span class="ri-path">${escapeHtml(item.path)}</span>
        ${snip}
      </li>`;
    }).join('');
    $$('#search-list .result-item').forEach((el) => {
      el.addEventListener('click', () => navigate(el.getAttribute('data-path'), { pushHistory: true }));
    });
  } catch (e) {
    toast(e.message || 'search 失败', 'error');
  }
}

async function doReset() {
  if (!confirm('确认重置? 会删除 raw / wiki / _state.json, 但保留 schema.md 与 purpose.md.')) return;
  try {
    const r = await extCall({ action: 'reset' });
    if (!r.ok) throw new Error(r.error || 'reset 失败');
    toast('已重置', 'success');
    state.currentPath = '';
    state.history = [];
    state.historyIdx = -1;
    $('#content').innerHTML = `<div class="empty">
      <p class="empty-title">已重置</p>
      <p class="empty-sub">点击 <strong>从 Mobius 同步</strong> 重新生成 wiki.</p>
    </div>`;
    $('#frontmatter').hidden = true;
    $('#current-path').textContent = '—';
    await refreshStatus();
    await refreshTree();
  } catch (e) {
    toast(e.message || 'reset 失败', 'error');
  }
}

function showSidePanel(which) {
  for (const el of ['#side-search', '#side-lint', '#side-graph', '#side-welcome']) {
    $(el).hidden = (el !== '#side-' + which);
  }
}

// ============================================================
// 绑定
// ============================================================
function bind() {
  $('#syncBtn').addEventListener('click', syncFromMobius);
  $('#lintBtn').addEventListener('click', runLint);
  $('#graphBtn').addEventListener('click', showGraph);
  $('#resetBtn').addEventListener('click', doReset);
  $('#showRaw').addEventListener('change', (e) => {
    state.showRaw = e.target.checked;
    renderTree();
  });
  $('#backBtn').addEventListener('click', () => {
    if (state.historyIdx <= 0) return;
    state.historyIdx--;
    navigate(state.history[state.historyIdx], { pushHistory: false });
  });
  $('#forwardBtn').addEventListener('click', () => {
    if (state.historyIdx >= state.history.length - 1) return;
    state.historyIdx++;
    navigate(state.history[state.historyIdx], { pushHistory: false });
  });

  const searchInput = $('#searchInput');
  let searchTimer = null;
  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const v = e.target.value;
    searchTimer = setTimeout(() => {
      if (!v.trim()) { showSidePanel('welcome'); return; }
      doSearch(v);
    }, 280);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(searchTimer);
      doSearch(e.target.value);
    }
  });
}

// ============================================================
// 启动
// ============================================================
async function boot() {
  bind();
  await refreshStatus();
  await refreshTree();
  // 默认尝试打开 overview (如果已 ingest)
  const st = await extCall({ action: 'status' }).catch(() => null);
  if (st && st.ok && st.initialized) {
    navigate('wiki/overview.md', { pushHistory: true });
  }
}

boot();
