/**
 * llm-wiki/backend/extension_backend_handler.js
 *
 * 吸收 nashsu/llm_wiki (Karpathy LLM Wiki 模式) 的设计:
 *   三层架构 raw → wiki → schema, 三个核心操作 ingest / query / lint,
 *   YAML frontmatter, [[wikilinks]], index.md + log.md + overview.md.
 *
 * 输入源: 莫比乌斯项目内的 projects + issues (via 后端 DB repository).
 *
 * 设计取舍: handler 在 worker_thread 里跑, 30s 上限, 无外网/LLM 凭据.
 * v0.1 走"确定性 ingest": 用规则从 project/issue 字段抽取实体 + 关系,
 * 直接生成有结构的 wiki 页面. 真正的 LLM 两步 CoT 留作 v0.2 (经
 * post_action session_message 触发 mobius 内部 agent).
 *
 * stateless: 每次调用新 worker, 顶层禁止持有连接/缓存. 所有持久化落 ext_data_dir.
 */
const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');

// ===== 莫比乌斯内部 repository (worker 可 require, 路径相对于本文件) =====
const { Users } = require('../../../backend/repositories/users');
const { Projects } = require('../../../backend/repositories/projects');
const { Issues } = require('../../../backend/repositories/issues');
const {
  canReadProject,
  canReadIssue,
} = require('../../../backend/services/access-control');

// ===== 常量 =====
const RAW_PROJECTS_DIR = 'raw/projects';
const RAW_ISSUES_DIR = 'raw/issues';
const WIKI_DIR = 'wiki';
const WIKI_PROJECTS_DIR = 'wiki/projects';
const WIKI_ISSUES_DIR = 'wiki/issues';
const WIKI_ENTITIES_DIR = 'wiki/entities';
const STATE_FILE = '_state.json';
const SCHEMA_FILE = 'schema.md';
const PURPOSE_FILE = 'purpose.md';

const MAX_SEARCH_RESULTS = 50;
const MAX_BODY_BYTES = 200_000; // 单页正文上限, 防止把整本 issue description 写爆

// ===== 工具 =====
function assertString(v, max = 10_000) {
  if (typeof v !== 'string') return '';
  return v.length > max ? v.slice(0, max) : v;
}

function slugify(input, max = 40) {
  const s = String(input || '').trim().toLowerCase();
  const compact = s
    .replace(/[\s_\/\\]+/g, '-')
    .replace(/[^a-z0-9一-鿿\-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  const trimmed = compact.slice(0, max).replace(/-+$/, '');
  return trimmed || 'untitled';
}

function shortId(id) {
  const s = String(id || '').trim();
  return s.length > 8 ? s.slice(0, 8) : s;
}

function projectSlug(p) {
  return `${slugify(p.name) || 'project'}-${shortId(p.id)}`;
}

function issueSlug(i) {
  return `${slugify(i.title) || 'issue'}-${shortId(i.id)}`;
}

function entitySlug(kind, name) {
  return `${kind}-${slugify(name)}`;
}

function safeJoin(root, ...parts) {
  const abs = path.resolve(root, ...parts);
  const base = path.resolve(root);
  if (abs !== base && !abs.startsWith(base + path.sep)) return null;
  return abs;
}

async function readFileSafe(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function readJsonSafe(file, fallback) {
  const raw = await readFileSafe(file);
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function canonicalJson(obj) {
  // 稳定序列化: key 排序, 用于内容哈希
  try {
    return JSON.stringify(obj, Object.keys(obj).sort());
  } catch {
    return JSON.stringify(obj);
  }
}

function fmtDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
  } catch {
    return String(iso);
  }
}

// YAML frontmatter 序列化 (简单 k:v, 字符串自动加引号)
function yamlFrontmatter(meta) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(meta)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${yamlScalar(item)}`);
    } else if (typeof v === 'object') {
      lines.push(`${k}: ${JSON.stringify(v)}`);
    } else {
      lines.push(`${k}: ${yamlScalar(v)}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

function yamlScalar(v) {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  if (/^[\w\-./: ]+$/.test(s) && !/:\s/.test(s) && !s.includes('"')) return s;
  return JSON.stringify(s);
}

// 从 markdown 文本里抓 [[wikilinks]]
function extractWikilinks(md) {
  if (!md) return [];
  const out = [];
  const re = /\[\[([^\]\n]+)\]\]/g;
  let m;
  while ((m = re.exec(md))) {
    const target = m[1].trim();
    if (target) out.push(target);
  }
  return out;
}

// 把任意 markdown 里的 [[x]] 转成 HTML <a href> (前端解析后再渲染)
// 这里只做"剥离 + 索引", 渲染交给前端.

// ===== 主入口 =====
module.exports = async function extensionBackendHandler({
  username,
  display_name,
  ext_main_payload,
  ext_data_dir,
  extension_name,
  logger,
}) {
  const payload = (ext_main_payload && typeof ext_main_payload === 'object') ? ext_main_payload : {};
  const action = String(payload.action || '').trim();

  try {
    switch (action) {
      case 'whoami':
        return { ok: true, username, display_name, extension_name };

      case 'ingest':
        return await doIngest({ ext_data_dir, username, logger, force: !!payload.force });

      case 'status':
        return await doGetStatus({ ext_data_dir });

      case 'tree':
        return await doGetTree({ ext_data_dir });

      case 'read':
        return await doRead({ ext_data_dir, relPath: String(payload.path || '') });

      case 'search':
        return await doSearch({ ext_data_dir, query: String(payload.query || ''), limit: payload.limit });

      case 'graph':
        return await doGetGraph({ ext_data_dir });

      case 'lint':
        return await doLint({ ext_data_dir });

      case 'reset':
        return await doReset({ ext_data_dir });

      default:
        return { ok: true, message: 'Hello from llm-wiki', action: action || null };
    }
  } catch (e) {
    logger && logger.error && logger.error('handler_error', { action, message: e.message });
    return { ok: false, error: (e && e.message) ? e.message.slice(0, 200) : 'handler error' };
  }
};

// ===== 拉取可见的 projects + issues =====
function loadReadableSources(username) {
  const user = Users.findAuthById(username);
  if (!user) {
    const err = new Error('user not found: ' + username);
    err.code = 'USER_NOT_FOUND';
    throw err;
  }

  const allProjects = Projects.listAll(user.id).filter((p) => canReadProject(user, p));
  const projects = allProjects.filter((p) => p.kind !== 'extension');

  // 每个 project 拉它下面的 issues, 并按 canReadIssue 过滤
  const issuesByProject = new Map();
  const allIssues = [];
  for (const p of projects) {
    const list = Issues.listForProject(p.id, null, user.id).filter((i) => canReadIssue(user, i));
    issuesByProject.set(p.id, list);
    for (const i of list) allIssues.push(i);
  }

  return { user, projects, issuesByProject, allIssues };
}

// ===== 写 raw 源 (不可变快照) =====
function buildProjectRawMarkdown(p, issues) {
  const fm = yamlFrontmatter({
    type: 'project',
    id: p.id,
    title: p.name,
    visibility: p.visibility,
    kind: p.kind,
    bind_path: p.bind_path || '',
    git_repos: Array.isArray(p.git_repos) ? p.git_repos : [],
    default_model: p.default_model || '',
    research_enabled: p.research_enabled ? true : false,
    created_at: p.created_at || '',
    last_active: p.last_active || '',
    issue_count: issues.length,
  });
  const desc = (p.description || '').trim();
  const body = [
    fm,
    '',
    `# ${p.name}`,
    '',
    desc ? desc : '_(无描述)_',
    '',
    '## Issues',
    '',
    issues.length
      ? issues.map((i) => `- [${i.title}](${issueSlug(i)}) · \`${i.status || 'active'}\``).join('\n')
      : '_(暂无 issue)_',
    '',
  ].join('\n');
  return body;
}

function buildIssueRawMarkdown(i, project) {
  const fm = yamlFrontmatter({
    type: 'issue',
    id: i.id,
    title: i.title,
    project_id: i.project_id,
    project_name: project ? project.name : '',
    status: i.status || 'active',
    visibility: i.visibility || 'inherit',
    use_worktree: i.use_worktree ? true : false,
    worktree_branch: i.worktree_branch || '',
    created_at: i.created_at || '',
    last_active: i.last_active || '',
    message_count: i.message_count || 0,
  });
  const desc = (i.description || '').trim();
  const body = [
    fm,
    '',
    `# ${i.title}`,
    '',
    desc ? desc : '_(无描述)_',
    '',
  ].join('\n');
  return body;
}

// ===== 写 wiki 页面 (LLM-style, 当前确定性版本) =====
function buildProjectWikiPage(p, issues, opts) {
  const slug = projectSlug(p);
  const related = (opts && opts.relatedByRepo && opts.relatedByRepo[p.id]) || [];
  const fm = yamlFrontmatter({
    type: 'project',
    title: p.name,
    sources: [`raw/projects/${p.id}.md`],
    slug,
    visibility: p.visibility,
    kind: p.kind,
    bind_path: p.bind_path || '',
    git_repos: Array.isArray(p.git_repos) ? p.git_repos : [],
    issue_count: issues.length,
    last_active: p.last_active || '',
    generated_at: new Date().toISOString(),
  });
  const lines = [
    fm,
    '',
    `# ${p.name}`,
    '',
    `> 项目 · \`${p.visibility}\` 可见性 · ${issues.length} 个 issue`,
    '',
    '## 概述',
    '',
    (p.description || '').trim() || '_(暂无项目描述)_',
    '',
    '## 关键属性',
    '',
    `- 项目 ID: \`${p.id}\``,
    `- 绑定路径: \`${p.bind_path || '(无)'}\``,
    `- 默认模型: \`${p.default_model || '(跟随系统)'}\``,
    `- Research: ${p.research_enabled ? '开启' : '关闭'}`,
    `- 最后活跃: ${fmtDate(p.last_active)}`,
    '',
    '## Issues',
    '',
    issues.length
      ? issues
          .slice(0, 200)
          .map((i) => `- [[issues/${issueSlug(i)}|${i.title}]] · \`${i.status || 'active'}\``)
          .join('\n')
      : '_(暂无 issue)_',
    '',
  ];

  if (related.length) {
    lines.push('## 共享仓库的关联项目', '');
    lines.push(
      ...related.slice(0, 30).map((rp) => `- [[projects/${projectSlug(rp)}|${rp.name}]]`),
    );
    lines.push('');
  }

  lines.push('## 反向链接', '');
  lines.push('- 该项目的所有 issue 都自动反向链接到这里.');
  lines.push('');

  return { slug, body: lines.join('\n') };
}

function buildIssueWikiPage(i, project) {
  const slug = issueSlug(i);
  const fm = yamlFrontmatter({
    type: 'issue',
    title: i.title,
    sources: [`raw/issues/${i.id}.md`],
    slug,
    project: project ? project.name : '',
    status: i.status || 'active',
    visibility: i.visibility || 'inherit',
    use_worktree: i.use_worktree ? true : false,
    message_count: i.message_count || 0,
    last_active: i.last_active || '',
    generated_at: new Date().toISOString(),
  });
  const desc = (i.description || '').trim();
  const lines = [
    fm,
    '',
    `# ${i.title}`,
    '',
    `> Issue · 状态 \`${i.status || 'active'}\` · ${i.message_count || 0} 条消息 · 最后活跃 ${fmtDate(i.last_active)}`,
    '',
    '## 所属项目',
    '',
    project ? `- [[projects/${projectSlug(project)}|${project.name}]]` : '- _(项目缺失)_',
    '',
    '## 描述',
    '',
    desc ? desc.slice(0, MAX_BODY_BYTES) : '_(无描述)_',
    '',
    '## 元数据',
    '',
    `- Issue ID: \`${i.id}\``,
    `- Worktree: ${i.use_worktree ? `是 (\`${i.worktree_branch || '?'}\`)` : '否'}`,
    `- 创建时间: ${fmtDate(i.created_at)}`,
    '',
  ];
  return { slug, body: lines.join('\n') };
}

function buildRepoEntityPage(repo, projects) {
  const slug = entitySlug('repo', repo);
  const fm = yamlFrontmatter({
    type: 'entity',
    entity_kind: 'repository',
    title: repo,
    sources: projects.map((p) => `raw/projects/${p.id}.md`),
    slug,
    project_count: projects.length,
    generated_at: new Date().toISOString(),
  });
  const lines = [
    fm,
    '',
    `# 仓库: \`${repo}\``,
    '',
    `> 实体 · 被 ${projects.length} 个项目引用`,
    '',
    '## 关联项目',
    '',
    ...projects.slice(0, 100).map((p) => `- [[projects/${projectSlug(p)}|${p.name}]]`),
    '',
  ];
  return { slug, body: lines.join('\n'), kind: 'repo' };
}

function buildIndexPage(stats, sections) {
  const fm = yamlFrontmatter({
    type: 'index',
    title: 'Mobius 知识库 · 目录',
    generated_at: new Date().toISOString(),
    counts: stats,
  });
  const lines = [
    fm,
    '',
    '# Mobius 知识库 · 目录',
    '',
    '本知识库由 `llm-wiki` 拓展自动维护, 数据源是莫比乌斯的 projects + issues.',
    '',
    '## 概览',
    '',
    `- 项目页: ${stats.projects}`,
    `- Issue 页: ${stats.issues}`,
    `- 实体页: ${stats.entities}`,
    `- 原始源文件: ${stats.raw_files}`,
    `- 最后 ingest: ${stats.generated_at}`,
    '',
    '## 项目',
    '',
    ...sections.projects,
    '',
    '## Issues',
    '',
    ...sections.issues,
    '',
    '## 实体 (仓库)',
    '',
    ...sections.entities,
    '',
  ];
  return lines.join('\n');
}

function buildOverviewPage(stats, projects, issues) {
  const fm = yamlFrontmatter({
    type: 'overview',
    title: 'Mobius 知识库 · 全景',
    generated_at: new Date().toISOString(),
  });
  const activeIssues = issues.filter((i) => (i.status || 'active') === 'active').length;
  const completedIssues = issues.length - activeIssues;
  const topProjects = projects
    .slice()
    .sort((a, b) => (b.last_active || '').localeCompare(a.last_active || ''))
    .slice(0, 10);
  const lines = [
    fm,
    '',
    '# Mobius 知识库 · 全景',
    '',
    `> 自动生成于 ${fmtDate(new Date().toISOString())}`,
    '',
    '## 状态',
    '',
    `- 项目: **${projects.length}**`,
    `- Issue: **${issues.length}** (活跃 ${activeIssues} · 已完成 ${completedIssues})`,
    '',
    '## 最近活跃项目',
    '',
    ...topProjects.map((p) => `- [[projects/${projectSlug(p)}|${p.name}]] · ${fmtDate(p.last_active)}`),
    '',
  ];
  return lines.join('\n');
}

function buildLogPage(events) {
  const fm = yamlFrontmatter({
    type: 'log',
    title: '操作日志',
  });
  const lines = [
    fm,
    '',
    '# 操作日志',
    '',
    '每次 ingest / lint / reset 会追加一行, 格式可机读.',
    '',
    ...events.map((e) => `- \`${e.ts}\` · **${e.action}** · ${e.summary}`),
    '',
  ];
  return lines.join('\n');
}

function buildSchemaMd() {
  return [
    '# Schema · 知识库结构规则',
    '',
    '## 三层',
    '- `raw/`: 不可变源数据快照 (projects / issues), 每次 ingest 覆盖.',
    '- `wiki/`: 自动生成的页面, 带 YAML frontmatter, 含 [[wikilinks]].',
    '- 根目录: `schema.md` (本文件), `purpose.md`, `_state.json` (ingest 状态).',
    '',
    '## 页面类型 (frontmatter.type)',
    '- `project`: 每个 mobius project 一页, 链接其下 issue.',
    '- `issue`: 每个 issue 一页, 反向链接所属 project.',
    '- `entity`: 跨项目共享的实体 (当前仅 `repo`).',
    '- `index` / `overview` / `log`: 知识库级导航.',
    '',
    '## 链接语法',
    '- `[[projects/<slug>]]` 或 `[[projects/<slug>|显示文本]]` → 项目页',
    '- `[[issues/<slug>]]` 或 `[[issues/<slug>|显示文本]]` → Issue 页',
    '- `[[entities/<slug>]]` → 实体页',
    '',
    '## 命名 (slug)',
    '- 项目: `<name-slug>-<id前8位>`',
    '- Issue: `<title-slug>-<id前8位>`',
    '- 实体: `<kind>-<name-slug>`',
    '',
    '## Lint 规则',
    '- 指向不存在页面的 wikilink 视为 dead link',
    `- 单页正文上限 ${MAX_BODY_BYTES} 字节`,
    '',
  ].join('\n');
}

function buildPurposeMd(user) {
  return [
    '# Purpose · 这个 Wiki 为什么存在',
    '',
    '## 目标',
    '把莫比乌斯里的 "项目 ↔ Issue" 大规模关系网压成一个**可浏览、可搜索、可链接**的知识库.',
    '从每一次 issue 描述、每一个项目描述里挤出可复用的结构化信息, 而不是让它们在数据库里沉睡.',
    '',
    '## 当前阶段',
    '- v0.1: 确定性 ingest. 用规则抽取项目/issue/仓库的关系, 不调 LLM.',
    '- v0.2 (规划): 接入莫比乌斯 agent 走 post_action session_message, 做"两步 CoT" ingest,',
    '  让 LLM 真正产出实体页/概念页/合成页.',
    '',
    '## 角色',
    '- 人 (curator): 决定可见性 / 修描述 / 标星.',
    `- 当前用户: ${user ? user.id : '(unknown)'}`,
    '- 系统 (maintainer): 本拓展, 自动 ingest + lint.',
    '',
  ].join('\n');
}

// ===== ingest 主体 =====
async function doIngest({ ext_data_dir, username, logger, force }) {
  const t0 = Date.now();
  const { user, projects, issuesByProject, allIssues } = loadReadableSources(username);

  // 1) 计算每个源的哈希, 与 _state.json 对比, 跳过未变的 raw 写入
  const prevState = (await readJsonSafe(path.join(ext_data_dir, STATE_FILE), {})) || {};
  const prevHashes = (prevState && prevState.hashes) || {};

  const newHashes = {};
  for (const p of projects) {
    const canon = canonicalJson({
      id: p.id, name: p.name, description: p.description || '', bind_path: p.bind_path || '',
      git_repos: p.git_repos || [], visibility: p.visibility, kind: p.kind,
      default_model: p.default_model || '', research_enabled: !!p.research_enabled,
      last_active: p.last_active || '',
    });
    newHashes[`project:${p.id}`] = sha256(canon);
  }
  for (const i of allIssues) {
    const canon = canonicalJson({
      id: i.id, project_id: i.project_id, title: i.title, description: i.description || '',
      status: i.status, visibility: i.visibility, message_count: i.message_count || 0,
      last_active: i.last_active || '',
    });
    newHashes[`issue:${i.id}`] = sha256(canon);
  }

  // 即使 raw 没变, wiki 页面仍重生成 (规则可能更新)
  // —— 但如果完全没源 + 不是 force, 就跳过, 减少 IO
  const noChange = !force
    && Object.keys(newHashes).length === Object.keys(prevHashes).length
    && Object.entries(newHashes).every(([k, v]) => prevHashes[k] === v);

  // 2) 建目录
  await ensureDir(path.join(ext_data_dir, RAW_PROJECTS_DIR));
  await ensureDir(path.join(ext_data_dir, RAW_ISSUES_DIR));
  await ensureDir(path.join(ext_data_dir, WIKI_PROJECTS_DIR));
  await ensureDir(path.join(ext_data_dir, WIKI_ISSUES_DIR));
  await ensureDir(path.join(ext_data_dir, WIKI_ENTITIES_DIR));

  // 3) 仓库 → 项目索引 (跨项目共享仓库)
  const repoToProjects = new Map();
  for (const p of projects) {
    const repos = Array.isArray(p.git_repos) ? p.git_repos : [];
    for (const r of repos) {
      const key = String(r || '').trim();
      if (!key) continue;
      if (!repoToProjects.has(key)) repoToProjects.set(key, []);
      repoToProjects.get(key).push(p);
    }
  }
  const relatedByRepo = {}; // projectId -> [projects sharing any repo]
  for (const [repo, plist] of repoToProjects.entries()) {
    if (plist.length < 2) continue;
    for (const p of plist) {
      if (!relatedByRepo[p.id]) relatedByRepo[p.id] = [];
      for (const rp of plist) {
        if (rp.id !== p.id && !relatedByRepo[p.id].some((x) => x.id === rp.id)) {
          relatedByRepo[p.id].push(rp);
        }
      }
    }
  }

  // 4) 写 raw 源 (按 hash 决定是否跳过 IO)
  let rawWritten = 0;
  let rawSkipped = 0;
  for (const p of projects) {
    const issues = issuesByProject.get(p.id) || [];
    const key = `project:${p.id}`;
    if (!force && prevHashes[key] === newHashes[key]) { rawSkipped++; continue; }
    const md = buildProjectRawMarkdown(p, issues);
    await fs.writeFile(path.join(ext_data_dir, RAW_PROJECTS_DIR, `${p.id}.md`), md);
    rawWritten++;
  }
  for (const i of allIssues) {
    const key = `issue:${i.id}`;
    if (!force && prevHashes[key] === newHashes[key]) { rawSkipped++; continue; }
    const project = projects.find((p) => p.id === i.project_id);
    const md = buildIssueRawMarkdown(i, project);
    await fs.writeFile(path.join(ext_data_dir, RAW_ISSUES_DIR, `${i.id}.md`), md);
    rawWritten++;
  }

  // 5) 写 wiki 页面 (总是重写, 因为规则会变)
  // 先清旧 wiki/projects, wiki/issues, wiki/entities 内容, 避免残留被删源
  await clearDir(path.join(ext_data_dir, WIKI_PROJECTS_DIR));
  await clearDir(path.join(ext_data_dir, WIKI_ISSUES_DIR));
  await clearDir(path.join(ext_data_dir, WIKI_ENTITIES_DIR));

  const indexSections = { projects: [], issues: [], entities: [] };

  for (const p of projects) {
    const issues = issuesByProject.get(p.id) || [];
    const { slug, body } = buildProjectWikiPage(p, issues, { relatedByRepo });
    await fs.writeFile(path.join(ext_data_dir, WIKI_PROJECTS_DIR, `${slug}.md`), body);
    indexSections.projects.push(`- [[projects/${slug}|${p.name}]] · ${issues.length} issue`);
  }

  for (const i of allIssues) {
    const project = projects.find((p) => p.id === i.project_id);
    const { slug, body } = buildIssueWikiPage(i, project);
    await fs.writeFile(path.join(ext_data_dir, WIKI_ISSUES_DIR, `${slug}.md`), body);
    const projLabel = project ? project.name : '(孤儿)';
    indexSections.issues.push(`- [[issues/${slug}|${i.title}]] · _${projLabel}_`);
  }

  // 实体页 (仅当仓库被多个项目引用)
  const entityRepos = [...repoToProjects.entries()].filter(([, plist]) => plist.length >= 2);
  for (const [repo, plist] of entityRepos) {
    const { slug, body } = buildRepoEntityPage(repo, plist);
    await fs.writeFile(path.join(ext_data_dir, WIKI_ENTITIES_DIR, `${slug}.md`), body);
    indexSections.entities.push(`- [[entities/${slug}|${repo}]] · ${plist.length} 项目`);
  }

  // 6) 知识库级页面
  const stats = {
    projects: projects.length,
    issues: allIssues.length,
    entities: entityRepos.length,
    raw_files: projects.length + allIssues.length,
    generated_at: new Date().toISOString(),
  };
  await fs.writeFile(
    path.join(ext_data_dir, WIKI_DIR, 'index.md'),
    buildIndexPage(stats, indexSections),
  );
  await fs.writeFile(
    path.join(ext_data_dir, WIKI_DIR, 'overview.md'),
    buildOverviewPage(stats, projects, allIssues),
  );

  // 7) schema / purpose (首次写, 之后不覆盖以便用户编辑)
  const schemaPath = path.join(ext_data_dir, SCHEMA_FILE);
  if (!(await readFileSafe(schemaPath))) {
    await fs.writeFile(schemaPath, buildSchemaMd());
  }
  const purposePath = path.join(ext_data_dir, PURPOSE_FILE);
  if (!(await readFileSafe(purposePath))) {
    await fs.writeFile(purposePath, buildPurposeMd(user));
  }

  // 8) 操作日志 (追加)
  const logPath = path.join(ext_data_dir, WIKI_DIR, 'log.md');
  const prevLog = (await readFileSafe(logPath)) || '';
  const newEvent = {
    ts: new Date().toISOString(),
    action: 'ingest',
    summary: `user=${username} projects=${projects.length} issues=${allIssues.length} raw_written=${rawWritten} raw_skipped=${rawSkipped} entities=${entityRepos.length} elapsed_ms=${Date.now() - t0}`,
  };
  // 把日志主体重写: frontmatter 保留, 列表重排, 最多保留 100 条
  const allEvents = parseLogEvents(prevLog);
  allEvents.unshift(newEvent);
  await fs.writeFile(logPath, buildLogPage(allEvents.slice(0, 100)));

  // 9) _state.json
  const newState = {
    last_ingest_at: newEvent.ts,
    last_ingest_user: username,
    hashes: newHashes,
    counts: stats,
    schema_version: 1,
  };
  await fs.writeFile(path.join(ext_data_dir, STATE_FILE), JSON.stringify(newState, null, 2));

  logger && logger.info && logger.info('ingest_done', newEvent.summary);

  return {
    ok: true,
    elapsed_ms: Date.now() - t0,
    no_change: noChange,
    counts: stats,
    raw_written: rawWritten,
    raw_skipped: rawSkipped,
    entities: entityRepos.length,
    log_event: newEvent,
  };
}

function parseLogEvents(md) {
  if (!md) return [];
  const out = [];
  const re = /`([^`]+)`\s*·\s*\*\*(\w+)\*\*\s*·\s*(.+)/g;
  let m;
  while ((m = re.exec(md))) {
    out.push({ ts: m[1], action: m[2], summary: m[3].trim() });
  }
  return out;
}

async function clearDir(dir) {
  let entries = [];
  try { entries = await fs.readdir(dir); } catch { return; }
  for (const name of entries) {
    const p = path.join(dir, name);
    try {
      const st = await fs.stat(p);
      if (st.isFile()) await fs.unlink(p);
    } catch { /* noop */ }
  }
}

// ===== status / tree / read / search / graph / lint =====
async function doGetStatus({ ext_data_dir }) {
  const state = await readJsonSafe(path.join(ext_data_dir, STATE_FILE), null);
  if (!state) {
    return { ok: true, initialized: false, message: '尚未 ingest, 请先点击 同步' };
  }
  return {
    ok: true,
    initialized: true,
    last_ingest_at: state.last_ingest_at || '',
    last_ingest_user: state.last_ingest_user || '',
    counts: state.counts || {},
    schema_version: state.schema_version || 1,
  };
}

async function walkMarkdown(root) {
  const out = [];
  let stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try { entries = await fs.readdir(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        const rel = path.relative(root, full).split(path.sep).join('/');
        out.push(rel);
      }
    }
  }
  return out.sort();
}

async function doGetTree({ ext_data_dir }) {
  const wikiRoot = path.join(ext_data_dir, WIKI_DIR);
  const files = await walkMarkdown(wikiRoot);
  // 把 'projects/foo.md' 转成 { dir:'projects', name:'foo.md', path:'projects/foo.md' }
  const grouped = {};
  for (const rel of files) {
    const idx = rel.indexOf('/');
    const dir = idx >= 0 ? rel.slice(0, idx) : '.';
    const name = idx >= 0 ? rel.slice(idx + 1) : rel;
    if (!grouped[dir]) grouped[dir] = [];
    grouped[dir].push({ path: rel, name });
  }
  // raw 树也带一份, 方便前端切换
  const rawProjectFiles = await walkMarkdown(path.join(ext_data_dir, RAW_PROJECTS_DIR));
  const rawIssueFiles = await walkMarkdown(path.join(ext_data_dir, RAW_ISSUES_DIR));
  const rootFiles = (await readRootMdFiles(ext_data_dir)).map((f) => ({ path: f, name: path.basename(f) }));

  return {
    ok: true,
    wiki: grouped,
    raw: {
      projects: rawProjectFiles.map((p) => ({ path: 'raw/projects/' + p, name: p })),
      issues: rawIssueFiles.map((p) => ({ path: 'raw/issues/' + p, name: p })),
    },
    root: rootFiles,
  };
}

async function readRootMdFiles(ext_data_dir) {
  const out = [];
  for (const name of [SCHEMA_FILE, PURPOSE_FILE]) {
    try {
      const st = await fs.stat(path.join(ext_data_dir, name));
      if (st.isFile()) out.push(name);
    } catch { /* noop */ }
  }
  return out;
}

async function doRead({ ext_data_dir, relPath }) {
  const raw = String(relPath || '').trim();
  if (!raw) return { ok: false, error: 'path 必填' };

  // 允许 'wiki/...' / 'raw/...' / 'schema.md' / 'purpose.md'
  // 不允许 .. 与绝对路径
  if (raw.includes('..')) return { ok: false, error: '禁止的路径' };

  // 默认前缀 = wiki/
  let target = raw;
  if (!target.startsWith('wiki/') && !target.startsWith('raw/') && target !== SCHEMA_FILE && target !== PURPOSE_FILE) {
    target = 'wiki/' + target;
  }
  // 去 .md 后缀的写法也兼容 (跟 SPA 路由保持一致)
  if (!target.endsWith('.md')) {
    // 尝试两个: 加 .md 或目录下加 index.md
    const asMd = target + '.md';
    const abs1 = safeJoin(ext_data_dir, asMd);
    if (abs1 && (await fileExists(abs1))) {
      const body = await fs.readFile(abs1, 'utf8');
      return { ok: true, path: asMd, body, meta: parseFrontmatter(body) };
    }
    return { ok: false, error: '页面不存在: ' + raw };
  }
  const abs = safeJoin(ext_data_dir, target);
  if (!abs || !(await fileExists(abs))) {
    return { ok: false, error: '页面不存在: ' + raw };
  }
  const body = await fs.readFile(abs, 'utf8');
  return { ok: true, path: target, body, meta: parseFrontmatter(body) };
}

async function fileExists(p) {
  try { const st = await fs.stat(p); return st.isFile(); } catch { return false; }
}

function parseFrontmatter(md) {
  if (!md || !md.startsWith('---')) return null;
  const end = md.indexOf('\n---', 3);
  if (end < 0) return null;
  const block = md.slice(3, end).trim();
  const meta = {};
  let currentKey = null;
  for (const line of block.split('\n')) {
    if (!line.trim()) continue;
    const kv = /^([A-Za-z_][\w\-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) {
      currentKey = kv[1];
      const val = kv[2].trim();
      if (val === '') {
        meta[currentKey] = [];
      } else {
        meta[currentKey] = parseYamlScalar(val);
      }
    } else if (line.startsWith('  - ') && currentKey) {
      if (!Array.isArray(meta[currentKey])) meta[currentKey] = [];
      meta[currentKey].push(parseYamlScalar(line.slice(4).trim()));
    }
  }
  return meta;
}

function parseYamlScalar(s) {
  if (!s) return '';
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  return s;
}

// 简单分词搜索 (CJK bigram + 英文单词), 返回打分排序
async function doSearch({ ext_data_dir, query, limit }) {
  const q = String(query || '').trim();
  if (!q) return { ok: true, query: q, results: [] };
  const wikiRoot = path.join(ext_data_dir, WIKI_DIR);
  const files = await walkMarkdown(wikiRoot);
  const tokens = tokenize(q);
  if (tokens.length === 0) return { ok: true, query: q, results: [] };

  const cap = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Number(limit) || MAX_SEARCH_RESULTS));
  const results = [];
  for (const rel of files) {
    const abs = path.join(wikiRoot, rel);
    let md = '';
    try { md = await fs.readFile(abs, 'utf8'); } catch { continue; }
    const lower = md.toLowerCase();
    const title = extractTitle(md) || rel;
    let score = 0;
    for (const t of tokens) {
      const hits = countOccurrences(lower, t);
      if (!hits) continue;
      score += hits;
      if (title.toLowerCase().includes(t)) score += 10;
    }
    if (score > 0) {
      results.push({
        path: 'wiki/' + rel,
        title,
        score,
        snippet: makeSnippet(md, tokens[0]),
      });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return { ok: true, query: q, results: results.slice(0, cap) };
}

function tokenize(q) {
  const lower = String(q || '').toLowerCase();
  const tokens = new Set();
  // 英文单词
  for (const w of lower.match(/[a-z0-9_\-]{2,}/g) || []) {
    if (w.length >= 2) tokens.add(w);
  }
  // CJK bigram
  const cjk = lower.replace(/[^一-鿿]/g, ' ');
  for (const chunk of cjk.split(/\s+/)) {
    for (let i = 0; i + 2 <= chunk.length; i++) {
      tokens.add(chunk.slice(i, i + 2));
    }
    if (chunk.length === 1) tokens.add(chunk);
  }
  return [...tokens];
}

function countOccurrences(hay, needle) {
  if (!needle) return 0;
  let count = 0;
  let idx = hay.indexOf(needle);
  while (idx >= 0) { count++; idx = hay.indexOf(needle, idx + needle.length); }
  return count;
}

function extractTitle(md) {
  if (!md) return '';
  const m = /^#\s+(.+)$/m.exec(md);
  return m ? m[1].trim() : '';
}

function makeSnippet(md, token) {
  if (!md) return '';
  const lower = md.toLowerCase();
  const idx = lower.indexOf(token);
  if (idx < 0) {
    // 退而求其次: 拿第二段非空文本
    const lines = md.split('\n').filter((l) => l.trim() && !l.startsWith('---') && !l.startsWith('#'));
    return (lines[0] || '').slice(0, 160);
  }
  const start = Math.max(0, idx - 60);
  const end = Math.min(md.length, idx + 120);
  let sn = md.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) sn = '…' + sn;
  if (end < md.length) sn = sn + '…';
  return sn;
}

async function doGetGraph({ ext_data_dir }) {
  const wikiRoot = path.join(ext_data_dir, WIKI_DIR);
  const files = await walkMarkdown(wikiRoot);
  const nodes = [];
  const edges = [];
  const pathToSlug = {}; // 'wiki/projects/foo.md' -> 'projects/foo'
  for (const rel of files) {
    const abs = path.join(wikiRoot, rel);
    let md = '';
    try { md = await fs.readFile(abs, 'utf8'); } catch { continue; }
    const meta = parseFrontmatter(md);
    const type = (meta && meta.type) || 'page';
    const title = (meta && meta.title) || extractTitle(md) || rel;
    const slug = rel.replace(/\.md$/, '');
    pathToSlug[slug] = rel;
    nodes.push({ id: slug, type, title, path: 'wiki/' + rel });
  }
  // 收边: 解析 [[links]]
  const slugSet = new Set(Object.keys(pathToSlug));
  for (const node of nodes) {
    const abs = path.join(wikiRoot, node.id + '.md');
    let md = '';
    try { md = await fs.readFile(abs, 'utf8'); } catch { continue; }
    for (const target of extractWikilinks(md)) {
      const cleanTarget = target.replace(/\|.+$/, '').trim();
      if (slugSet.has(cleanTarget)) {
        edges.push({ source: node.id, target: cleanTarget });
      }
    }
  }
  return { ok: true, nodes, edges };
}

async function doLint({ ext_data_dir }) {
  const wikiRoot = path.join(ext_data_dir, WIKI_DIR);
  const files = await walkMarkdown(wikiRoot);
  const slugSet = new Set(files.map((rel) => rel.replace(/\.md$/, '')));
  const issues = [];
  const inDegree = new Map();
  for (const rel of files) {
    const abs = path.join(wikiRoot, rel);
    let md = '';
    try { md = await fs.readFile(abs, 'utf8'); } catch { continue; }
    const slug = rel.replace(/\.md$/, '');
    const links = extractWikilinks(md);
    let outgoing = 0;
    for (const target of links) {
      const cleanTarget = target.replace(/\|.+$/, '').trim();
      if (!slugSet.has(cleanTarget)) {
        issues.push({ kind: 'dead_link', path: 'wiki/' + rel, target: cleanTarget });
      } else {
        outgoing++;
        inDegree.set(cleanTarget, (inDegree.get(cleanTarget) || 0) + 1);
      }
    }
    if (links.length === 0 && slug !== 'index' && slug !== 'log' && slug !== 'overview') {
      issues.push({ kind: 'no_outgoing_links', path: 'wiki/' + rel });
    }
    if (md.length > MAX_BODY_BYTES) {
      issues.push({ kind: 'oversize', path: 'wiki/' + rel, size: md.length });
    }
  }
  // 孤儿: 入度 0 且不是 index/overview/log
  for (const rel of files) {
    const slug = rel.replace(/\.md$/, '');
    if (slug === 'index' || slug === 'overview' || slug === 'log') continue;
    if ((inDegree.get(slug) || 0) === 0) {
      issues.push({ kind: 'orphan', path: 'wiki/' + rel });
    }
  }

  // 写一行 lint 日志
  const logPath = path.join(ext_data_dir, WIKI_DIR, 'log.md');
  const prevLog = (await readFileSafe(logPath)) || '';
  const events = parseLogEvents(prevLog);
  events.unshift({
    ts: new Date().toISOString(),
    action: 'lint',
    summary: `pages=${files.length} issues=${issues.length} dead=${issues.filter((i) => i.kind === 'dead_link').length} orphans=${issues.filter((i) => i.kind === 'orphan').length}`,
  });
  await fs.writeFile(logPath, buildLogPage(events.slice(0, 100)));

  return { ok: true, pages: files.length, issues };
}

async function doReset({ ext_data_dir }) {
  // 删 raw + wiki + state, 保留 schema/purpose
  for (const sub of [WIKI_DIR, RAW_PROJECTS_DIR, RAW_ISSUES_DIR, STATE_FILE]) {
    const abs = path.join(ext_data_dir, sub);
    try {
      const st = await fs.stat(abs);
      if (st.isDirectory()) await fs.rm(abs, { recursive: true, force: true });
      else await fs.unlink(abs);
    } catch { /* noop */ }
  }
  return { ok: true };
}
