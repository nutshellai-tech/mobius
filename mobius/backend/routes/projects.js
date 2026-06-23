const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const { auth } = require('../middleware/auth');
const { Projects } = require('../repositories/projects');
const { ProjectTodos } = require('../repositories/project-todos');
const { Issues } = require('../repositories/issues');
const { Skills } = require('../repositories/skills');
const { Memories } = require('../repositories/memories');
const { Users } = require('../repositories/users');
const {
  buildIssueContextPreview,
  buildIssueSelectionDefaults,
  buildProjectIssueContextPreview,
  buildProjectIssueSelectionDefaults,
} = require('../services/session-context');
const { ensureGuidedDemoAssets } = require('../services/guided-demo-assets');
const { defaultCodeServerWorkspace } = require('../services/code-server-workspace');
const {
  canReadProject,
  canManageProject,
  canCreateIssue,
  isHidden,
  normalizeProjectVisibility,
  projectAllowsReaderWrite,
  projectAccessPayload,
  setHidden,
  setProjectAccess,
  uniqStringList,
} = require('../services/access-control');
const {
  UserProjectView,
  filterProjectListForUser,
  normalizeProjectSearch,
} = require('../services/user-project-view');
const { recordAdminAuditIfCrossUser } = require('../services/admin-audit');
const modelRegistry = require('../services/model-registry');
const {
  APP_DIR,
  BACKEND_WORKER_LOG_DIR,
  ENABLE_PASSWORD_LOGIN,
  VSCODE_WEB_URL,
  FORGOTTEN_FLAG_ISSUE_INTERVAL_MINUTES_MIN,
  FORGOTTEN_FLAG_RESEARCH_INTERVAL_MINUTES_MIN,
  FORGOTTEN_FLAG_INTERVAL_MINUTES_MAX,
  FORGOTTEN_FLAG_BACKOFF_MIN,
  FORGOTTEN_FLAG_BACKOFF_MAX,
  FORGOTTEN_FLAG_PATIENCE_MIN,
  FORGOTTEN_FLAG_PATIENCE_MAX,
} = require('../config');

const router = express.Router();
const MAIN_PROJECT_PORT_REL = path.join('.imac', 'port_forward', 'main_project_port.txt');

function normalizeRollbackHash(value) {
  const hash = String(value || '').trim();
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) return '';
  return hash;
}

function spawnProductOtherVersion(gitHash) {
  const logDir = BACKEND_WORKER_LOG_DIR;
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, 'deploy_other_version.log');
  const out = fs.openSync(logPath, 'a');
  const child = spawn('python3', ['start.py', '--detach', '--other-versions', gitHash], {
    cwd: APP_DIR,
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  });
  child.unref();
  return { pid: child.pid, log_path: logPath };
}

function normalizeProjectPort(value) {
  const text = String(value ?? '').trim();
  if (!/^[0-9]{1,5}$/.test(text)) return null;
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

function mainProjectPortPath(project) {
  if (!project?.bind_path) return '';
  return path.join(project.bind_path, MAIN_PROJECT_PORT_REL);
}

function spawnProductHardReset(gitHash) {
  const logDir = BACKEND_WORKER_LOG_DIR;
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, 'hard_reset_version.log');
  const out = fs.openSync(logPath, 'a');
  const child = spawn('python3', ['start.py', '--detach', '--hard-reset', gitHash], {
    cwd: APP_DIR,
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  });
  child.unref();
  return { pid: child.pid, log_path: logPath };
}

// 在项目 bind_path 内解析子路径, 返回 { absPath, relPath } 或 { error }.
// 允许的字符: 任何 (用 path.resolve 规范化), 但绝对值必须落在 bind_path 子树.
function resolveProjectPath(bindPath, rawPath = '/') {
  if (!bindPath) return { error: '项目未绑定路径' };
  const root = path.resolve(bindPath);
  const relPath = String(rawPath || '/').replace(/\.\./g, '');
  const absPath = path.resolve(root, relPath.replace(/^\/+/, ''));
  if (absPath !== root && !absPath.startsWith(root + path.sep)) return { error: 'Access denied' };
  return { root, relPath: '/' + path.relative(root, absPath).replace(/\\/g, '/'), absPath };
}

function isProjectImportDemoBindPath(bindPath) {
  const normalized = path.resolve(String(bindPath || '')).replace(/\\/g, '/');
  return normalized.endsWith('/imac-demo/todomvc-import');
}

function fileIncludes(absPath, marker) {
  try {
    return fs.readFileSync(absPath, 'utf8').includes(marker);
  } catch {
    return false;
  }
}

function removePathIfExists(absPath, root, removed) {
  if (!absPath || absPath === root || !absPath.startsWith(root + path.sep)) return;
  if (!fs.existsSync(absPath)) return;
  fs.rmSync(absPath, { recursive: true, force: true });
  removed.push('/' + path.relative(root, absPath).replace(/\\/g, '/'));
}

function clearProjectImportUploadedSample(project) {
  const resolved = resolveProjectPath(project.bind_path, '/');
  if (resolved.error) throw new Error(resolved.error);
  const { root } = resolved;
  const removed = [];

  removePathIfExists(path.join(root, 'vanilla-todomvc'), root, removed);
  removePathIfExists(path.join(root, 'vanilla-todomvc-upload-sample.zip'), root, removed);

  const rootLooksLikeSample = (
    fileIncludes(path.join(root, 'package.json'), 'vanilla-todomvc-upload-sample') ||
    fileIncludes(path.join(root, 'index.html'), 'todo-app') ||
    fileIncludes(path.join(root, 'src', 'app.js'), 'todoStorageKey')
  );

  if (rootLooksLikeSample) {
    for (const rel of ['index.html', 'package.json', 'src']) {
      removePathIfExists(path.join(root, rel), root, removed);
    }
  }

  return removed;
}

// 校验 bindPath：必须位于用户 work_dir 内；默认要求已存在且为目录。
// 新建项目可传 createIfMissing，在确认创建时同步创建目录。
// rawPath 可以是绝对路径（必须在 work_dir 下），或相对家目录的路径（如 "/imac-test"，会被解析到 work_dir 下）。
// 规范化 git 仓库数组：[{url, name?}, ...]。空 URL 项被丢弃；非数组抛错。
function normalizeGitRepos(raw) {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) throw new Error('git 仓库列表格式错误');
  const out = [];
  for (const item of raw) {
    if (!item) continue;
    const url = typeof item === 'string' ? item : (typeof item.url === 'string' ? item.url : '');
    const trimmed = url.trim();
    if (!trimmed) continue;
    if (trimmed.length > 500) throw new Error('git 仓库地址过长');
    const name = (typeof item === 'object' && typeof item.name === 'string') ? item.name.trim().slice(0, 100) : '';
    out.push(name ? { url: trimmed, name } : { url: trimmed });
  }
  return out;
}

function resolveBindPath(rawPath, userWorkDir, options = {}) {
  if (rawPath === undefined || rawPath === null || rawPath === '') throw new Error('绑定路径为必填项');
  if (typeof rawPath !== 'string') throw new Error('绑定路径格式错误');
  if (!userWorkDir) throw new Error('用户尚未配置 work_dir, 无法绑定项目路径');
  const createIfMissing = !!options.createIfMissing;
  const userRoot = path.resolve(userWorkDir);
  let abs;
  if (path.isAbsolute(rawPath) && (rawPath === userRoot || rawPath.startsWith(userRoot + path.sep))) {
    abs = path.resolve(rawPath);
  } else {
    // 相对路径或相对家目录的伪绝对路径 (e.g. "/imac-test")
    abs = path.resolve(userRoot, rawPath.replace(/^\//, ''));
  }
  if (abs !== userRoot && !abs.startsWith(userRoot + path.sep)) throw new Error('绑定路径必须位于您的工作目录下');
  if (!fs.existsSync(abs)) {
    if (!createIfMissing) throw new Error('路径不存在');
    try {
      fs.mkdirSync(abs, { recursive: true });
    } catch (e) {
      throw new Error(`创建绑定路径失败: ${e.message}`);
    }
  }
  if (!fs.statSync(abs).isDirectory()) throw new Error('绑定路径必须是目录');
  return abs;
}

// 手动输入的绑定路径: 用户显式选择"不校验" —— 不检查是否存在 / 是否目录 /
// 是否落在 work_dir 内, 把控制权完全交给用户. 仅做非空与(绝对路径)规范化.
function resolveBindPathManual(rawPath) {
  if (rawPath === undefined || rawPath === null || rawPath === '') throw new Error('绑定路径为必填项');
  if (typeof rawPath !== 'string') throw new Error('绑定路径格式错误');
  const p = rawPath.trim();
  if (!p) throw new Error('绑定路径为必填项');
  return path.isAbsolute(p) ? path.resolve(p) : p;
}

function removeDemoWorkspaceIfRequested(project, user, cleanupRequested) {
  if (!cleanupRequested) return { removed: false };
  const bindPath = (project?.bind_path || '').trim();
  const workDir = (user?.work_dir || '').trim();
  if (!bindPath || !workDir) return { removed: false };

  const root = path.resolve(workDir);
  const demoRoot = path.resolve(root, 'imac-demo');
  const target = path.resolve(bindPath);
  const rel = path.relative(root, target);
  const isDemoPath = rel && !rel.startsWith('..') && !path.isAbsolute(rel) && rel.split(path.sep)[0] === 'imac-demo';
  if (!isDemoPath || target === root || target === demoRoot) {
    return { removed: false, reason: '非演示目录, 已跳过工作区清理' };
  }
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
    return { removed: true, path: target };
  }
  return { removed: false };
}

function normalizeIntervalMinutes(raw, label, min) {
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`${label}必须是整数分钟`);
  if (n < min) throw new Error(`${label}不能小于 ${min} 分钟`);
  if (n > FORGOTTEN_FLAG_INTERVAL_MINUTES_MAX) {
    throw new Error(`${label}不能超过 ${FORGOTTEN_FLAG_INTERVAL_MINUTES_MAX} 分钟`);
  }
  return n;
}

function normalizeBackoff(raw, label) {
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${label}必须是数字`);
  if (n < FORGOTTEN_FLAG_BACKOFF_MIN) throw new Error(`${label}不能小于 ${FORGOTTEN_FLAG_BACKOFF_MIN}`);
  if (n > FORGOTTEN_FLAG_BACKOFF_MAX) throw new Error(`${label}不能超过 ${FORGOTTEN_FLAG_BACKOFF_MAX}`);
  return n;
}

function normalizePatience(raw, label) {
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`${label}必须是整数`);
  if (n < FORGOTTEN_FLAG_PATIENCE_MIN) throw new Error(`${label}不能小于 ${FORGOTTEN_FLAG_PATIENCE_MIN}`);
  if (n > FORGOTTEN_FLAG_PATIENCE_MAX) throw new Error(`${label}不能超过 ${FORGOTTEN_FLAG_PATIENCE_MAX}`);
  return n;
}

function accessList(body, snakeKey, camelKey) {
  return uniqStringList(body?.[snakeKey] ?? body?.[camelKey]);
}

function projectAccessBody(body = {}) {
  const maybeList = (snakeKey, camelKey) => (
    Object.prototype.hasOwnProperty.call(body, snakeKey) || Object.prototype.hasOwnProperty.call(body, camelKey)
      ? accessList(body, snakeKey, camelKey)
      : undefined
  );
  return {
    visibility: body.visibility,
    allowUserIds: maybeList('allow_user_ids', 'allowUserIds'),
    allowGroupIds: maybeList('allow_group_ids', 'allowGroupIds'),
  };
}

const TODO_TITLE_MAX_LENGTH = 500;
const TODO_DESCRIPTION_MAX_LENGTH = 4000;
const EXTENSION_DISPLAY_NAME_MAX_LENGTH = 120;
const EXTENSION_DESCRIPTION_MAX_LENGTH = 1000;

function hasOwn(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function normalizeTodoTitle(raw) {
  if (typeof raw !== 'string') throw new Error('待办标题格式错误');
  const title = raw.trim();
  if (!title) throw new Error('请填写待办标题');
  if (title.length > TODO_TITLE_MAX_LENGTH) throw new Error(`待办标题不能超过 ${TODO_TITLE_MAX_LENGTH} 字符`);
  return title;
}

function normalizeTodoDescription(raw) {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') throw new Error('待办描述格式错误');
  if (raw.length > TODO_DESCRIPTION_MAX_LENGTH) throw new Error(`待办描述不能超过 ${TODO_DESCRIPTION_MAX_LENGTH} 字符`);
  return raw;
}

function normalizeTodoSortOrder(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error('待办排序值必须是整数');
  return n;
}

function boolFromBody(body, snakeKey, camelKey, fallback = false) {
  if (hasOwn(body, snakeKey)) return !!body[snakeKey];
  if (hasOwn(body, camelKey)) return !!body[camelKey];
  return fallback;
}

function hasBoolField(body, snakeKey, camelKey) {
  return hasOwn(body, snakeKey) || hasOwn(body, camelKey);
}

// 项目级默认模型偏好: 接受 null/空串 (表示"未指定, 跟系统默认"), 或 model-registry
// listSessionModelOptions() 暴露的某个 key. 不在白名单 → 抛 400.
function normalizeDefaultModel(raw) {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const allowed = modelRegistry.listSessionModelOptions().map((opt) => opt.key);
  if (!allowed.includes(trimmed)) {
    throw new Error(`默认模型偏好必须是可选模型之一: ${allowed.join(', ') || '(暂无可选模型)'}`);
  }
  return trimmed;
}

function shapeProjectForUser(project, user, opts = {}) {
  if (!project) return project;
  const canCreate = canCreateIssue(user, project);
  const muted = opts.mutedIds
    ? opts.mutedIds.has(project.id)
    : (user?.id ? UserProjectView.isMuted(user.id, project.id) : false);
  const hidden = user?.id
    ? !!(project.hidden || muted || isHidden(user.id, 'project', project.id))
    : !!project.hidden;
  return {
    ...project,
    visibility: normalizeProjectVisibility(project.visibility, 'private'),
    access: projectAccessPayload(project.id),
    can_manage: canManageProject(user, project),
    can_create_issue: canCreate,
    can_create_session: projectAllowsReaderWrite(user, project, 'can_run_session'),
    can_create_research: canCreate && !!project.research_enabled,
    muted,
    muted_label: muted ? '已屏蔽' : null,
    hidden,
  };
}

function normalizeText(value, fallback, maxLength) {
  const text = typeof value === 'string' ? value.trim() : '';
  return (text || fallback).slice(0, maxLength);
}

function writeFileExclusive(filePath, content) {
  fs.writeFileSync(filePath, content, { flag: 'wx' });
}

function createExtensionSkeleton({ extensionName, displayName, description }) {
  const { EXTENSION_ROOT } = require('../config');
  const extRoot = path.join(EXTENSION_ROOT, extensionName);
  if (fs.existsSync(extRoot)) {
    throw Object.assign(new Error(`拓展目录已存在：mobius/extension/${extensionName}/`), { statusCode: 400 });
  }

  const safeDisplayName = normalizeText(displayName, extensionName, EXTENSION_DISPLAY_NAME_MAX_LENGTH);
  const safeDescription = typeof description === 'string' ? description.trim().slice(0, EXTENSION_DESCRIPTION_MAX_LENGTH) : '';
  const manifest = {
    name: extensionName,
    display_name: safeDisplayName,
    description: safeDescription,
    version: '0.1.0',
  };

  fs.mkdirSync(path.join(extRoot, 'backend'), { recursive: true });
  fs.mkdirSync(path.join(extRoot, 'frontend'), { recursive: true });
  try {
    writeFileExclusive(path.join(extRoot, 'extension.json'), JSON.stringify(manifest, null, 2) + '\n');
    writeFileExclusive(path.join(extRoot, 'backend', 'extension_backend_handler.js'), `/**
 * ${extensionName}/backend/extension_backend_handler.js
 *
 * CommonJS handler for /api/ext. Keep it stateless and write only under ext_data_dir.
 */
const path = require('path');
const fs = require('fs/promises');

const STATE_FILE = 'state.json';

async function readState(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

module.exports = async function extensionBackendHandler({
  username,
  display_name,
  ext_main_payload,
  ext_data_dir,
  extension_name,
  logger,
}) {
  const action = ext_main_payload && ext_main_payload.action;
  const stateFile = path.join(ext_data_dir, STATE_FILE);

  if (action === 'whoami') {
    return { ok: true, username, display_name, extension_name };
  }

  if (action === 'save_note') {
    const note = typeof ext_main_payload.note === 'string' ? ext_main_payload.note.slice(0, 2000) : '';
    const state = await readState(stateFile);
    state[username] = { note, updated_at: Date.now() };
    await fs.writeFile(stateFile, JSON.stringify(state, null, 2));
    logger && logger.info && logger.info('save_note', { username });
    return { ok: true };
  }

  if (action === 'load_note') {
    const state = await readState(stateFile);
    return { ok: true, note: state[username]?.note || '' };
  }

  return { ok: true, message: 'Hello from ${extensionName}', action: action || null };
};
`);
    writeFileExclusive(path.join(extRoot, 'frontend', 'index.html'), `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeDisplayName.replace(/[<>&]/g, '')}</title>
  <link rel="stylesheet" href="./styles.css">
</head>
<body>
  <main class="app">
    <section class="hero">
      <p class="eyebrow">Mobius Extension</p>
      <h1>${safeDisplayName.replace(/[<>&]/g, '')}</h1>
      <p class="description">${(safeDescription || `拓展 ${extensionName} 已创建，可以从这里继续开发前端与后端 handler。`).replace(/[<>&]/g, '')}</p>
    </section>

    <section class="panel">
      <div>
        <div class="label">当前拓展</div>
        <div class="value" id="extensionName">${extensionName}</div>
      </div>
      <div>
        <div class="label">当前用户</div>
        <div class="value" id="identity">-</div>
      </div>
      <textarea id="noteInput" placeholder="写一点只有你能看到的调试备注"></textarea>
      <div class="actions">
        <button id="saveBtn" type="button">保存备注</button>
        <button id="loadBtn" type="button">读取备注</button>
      </div>
      <div id="status" class="status"></div>
    </section>
  </main>
  <script type="module" src="./main.js"></script>
</body>
</html>
`);
    writeFileExclusive(path.join(extRoot, 'frontend', 'main.js'), `import { extCall, extName } from '/extension/_sdk/ext.js';

const identityEl = document.getElementById('identity');
const noteInput = document.getElementById('noteInput');
const saveBtn = document.getElementById('saveBtn');
const loadBtn = document.getElementById('loadBtn');
const statusEl = document.getElementById('status');

function setStatus(text, error = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', error);
}

async function refreshIdentity() {
  try {
    const data = await extCall({ action: 'whoami' });
    identityEl.textContent = data.display_name || data.username || '-';
    document.getElementById('extensionName').textContent = extName();
  } catch (err) {
    setStatus(err.message || '加载用户信息失败', true);
  }
}

async function saveNote() {
  try {
    await extCall({ action: 'save_note', note: noteInput.value });
    setStatus('已保存');
  } catch (err) {
    setStatus(err.message || '保存失败', true);
  }
}

async function loadNote() {
  try {
    const data = await extCall({ action: 'load_note' });
    noteInput.value = data.note || '';
    setStatus('已读取');
  } catch (err) {
    setStatus(err.message || '读取失败', true);
  }
}

saveBtn.addEventListener('click', saveNote);
loadBtn.addEventListener('click', loadNote);
refreshIdentity();
`);
    writeFileExclusive(path.join(extRoot, 'frontend', 'styles.css'), `:root {
  color-scheme: dark;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #0f172a;
  color: #e5e7eb;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  background:
    radial-gradient(circle at 20% 20%, rgba(59, 130, 246, 0.22), transparent 32rem),
    linear-gradient(135deg, #0f172a 0%, #111827 52%, #172554 100%);
}

.app {
  width: min(920px, calc(100vw - 40px));
  margin: 0 auto;
  padding: 56px 0;
}

.hero {
  margin-bottom: 22px;
}

.eyebrow {
  margin: 0 0 10px;
  font-size: 12px;
  letter-spacing: 0;
  color: #93c5fd;
}

h1 {
  margin: 0;
  font-size: 34px;
  line-height: 1.15;
}

.description {
  max-width: 680px;
  color: #cbd5e1;
  line-height: 1.7;
}

.panel {
  display: grid;
  gap: 14px;
  padding: 18px;
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.72);
}

.label {
  margin-bottom: 4px;
  font-size: 12px;
  color: #94a3b8;
}

.value {
  font-size: 14px;
  color: #f8fafc;
}

textarea {
  width: 100%;
  min-height: 120px;
  resize: vertical;
  border: 1px solid rgba(148, 163, 184, 0.28);
  border-radius: 8px;
  padding: 10px 12px;
  background: rgba(15, 23, 42, 0.88);
  color: #f8fafc;
  font: inherit;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

button {
  height: 34px;
  border: 1px solid rgba(96, 165, 250, 0.35);
  border-radius: 8px;
  padding: 0 14px;
  background: rgba(59, 130, 246, 0.18);
  color: #bfdbfe;
  cursor: pointer;
}

button:hover {
  background: rgba(59, 130, 246, 0.28);
}

.status {
  min-height: 18px;
  font-size: 12px;
  color: #86efac;
}

.status.error {
  color: #fca5a5;
}
`);
    return { extRoot, manifest };
  } catch (e) {
    try { fs.rmSync(extRoot, { recursive: true, force: true }); } catch {}
    throw e;
  }
}

function loadReadableProject(req, res, id, notFoundText = '项目未找到') {
  const project = Projects.findById(id, req.user?.id);
  if (!project || !canReadProject(req.user, project)) {
    res.status(404).json({ error: notFoundText });
    return null;
  }
  recordAdminAuditIfCrossUser(req.user, 'read_project', 'project', project.id, project.created_by);
  return project;
}

function loadManageableProject(req, res, id) {
  const project = loadReadableProject(req, res, id);
  if (!project) return null;
  if (!canManageProject(req.user, project)) {
    res.status(403).json({ error: '只有项目 owner/admin 可以修改项目待办' });
    return null;
  }
  return project;
}

const GIT_REPO_SCAN_MAX_DEPTH = 3;
const GIT_REPO_SCAN_MAX_DIRS = 500;
const GIT_COMMIT_LIMIT_DEFAULT = 12;
const GIT_COMMIT_LIMIT_MAX = 30;
const ARCHITECTURE_ISSUE_TITLE = '项目结构绘制';
const ARCHITECTURE_ISSUE_DESCRIPTION = [
  '自动生成或刷新项目系统结构剖析图。',
  '请分析当前项目结构，优先输出单文件 HTML/SVG 架构图到项目绑定路径下的 .imac/generated_figures/arch.html。',
  '如需兼容截图或封面，也可以额外输出 arch.svg、arch.png、arch.jpg、arch.jpeg、arch.webp 等常见预览格式。',
].join('\n');
const FIXED_LOGO_REVIEW_PROJECT_ID = '9986bdc3';
const ARCHITECTURE_FIGURE_EXTENSIONS = ['.html', '.htm', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];
const GIT_FIELD_SEPARATOR = '\x1f';
const GIT_RECORD_SEPARATOR = '\x1e';
const PACKAGE_ZIP_RELATIVE_DIR = path.join('.imac', 'package_zip');
const PACKAGE_SIZE_WARNING_BYTES = 500 * 1024 * 1024;
const GIT_SCAN_SKIP_DIRS = new Set([
  '.git',
  '.imac',
  '.cache',
  '.next',
  '.nuxt',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
  'uploads',
  'vendor',
]);

function normalizeCommitLimit(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return GIT_COMMIT_LIMIT_DEFAULT;
  return Math.min(Math.max(Math.floor(n), 1), GIT_COMMIT_LIMIT_MAX);
}

function isWithinPath(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function packageZipDir(root) {
  return path.join(root, PACKAGE_ZIP_RELATIVE_DIR);
}

function isPackageZipPath(root, target) {
  return isWithinPath(packageZipDir(root), target);
}

function packageEntryType(dirent, absPath) {
  if (dirent.isSymbolicLink()) return 'symlink';
  if (dirent.isDirectory()) return 'dir';
  if (dirent.isFile()) return 'file';
  try {
    const st = fs.lstatSync(absPath);
    if (st.isSymbolicLink()) return 'symlink';
    if (st.isDirectory()) return 'dir';
    if (st.isFile()) return 'file';
  } catch {}
  return 'other';
}

function safePackageName(name) {
  const raw = String(name || 'project').trim() || 'project';
  const cleaned = raw
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned || 'project';
}

function normalizePackageEntryNames(rawNames) {
  if (!Array.isArray(rawNames)) throw new Error('请选择要打包的文件或文件夹');
  const out = [];
  const seen = new Set();
  for (const raw of rawNames) {
    const name = String(raw || '').trim();
    if (!name || name === '.' || name === '..') continue;
    if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
      throw new Error('打包条目只能选择项目根目录下的表层文件或文件夹');
    }
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  if (out.length === 0) throw new Error('请至少选择一个文件或文件夹');
  return out;
}

function directorySizeWithoutPackageZip(root, target) {
  if (isPackageZipPath(root, target)) return 0;
  let st;
  try {
    st = fs.lstatSync(target);
  } catch {
    return 0;
  }
  if (st.isSymbolicLink()) {
    try {
      return Buffer.byteLength(fs.readlinkSync(target));
    } catch {
      return 0;
    }
  }
  if (st.isFile()) return st.size;
  if (!st.isDirectory()) return 0;
  let total = 0;
  let children = [];
  try {
    children = fs.readdirSync(target);
  } catch {
    return 0;
  }
  for (const child of children) {
    total += directorySizeWithoutPackageZip(root, path.join(target, child));
  }
  return total;
}

function projectPackageRoot(project) {
  if (!project?.bind_path) throw new Error('项目未绑定路径');
  const root = path.resolve(project.bind_path);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error('项目绑定路径不存在或不是目录');
  return root;
}

function listPackageEntries(project) {
  const root = projectPackageRoot(project);
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .map((dirent) => {
      const absPath = path.join(root, dirent.name);
      const type = packageEntryType(dirent, absPath);
      let st;
      try {
        st = fs.lstatSync(absPath);
      } catch {
        return null;
      }
      return {
        name: dirent.name,
        type,
        size: directorySizeWithoutPackageZip(root, absPath),
        modified: st.mtime,
        default_selected: dirent.name !== '.imac',
        excluded_children: dirent.name === '.imac' ? [PACKAGE_ZIP_RELATIVE_DIR.replace(/\\/g, '/')] : [],
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const aDir = a.type === 'dir';
      const bDir = b.type === 'dir';
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  return { root, entries };
}

function estimatePackageSelection(project, rawNames) {
  const root = projectPackageRoot(project);
  const names = normalizePackageEntryNames(rawNames);
  let totalSize = 0;
  const selected = [];
  for (const name of names) {
    const absPath = path.join(root, name);
    if (!isWithinPath(root, absPath) || !fs.existsSync(absPath)) {
      throw new Error(`打包条目不存在: ${name}`);
    }
    const size = directorySizeWithoutPackageZip(root, absPath);
    selected.push({ name, size });
    totalSize += size;
  }
  return {
    names,
    selected,
    total_size: totalSize,
    warning_threshold: PACKAGE_SIZE_WARNING_BYTES,
    over_warning_threshold: totalSize > PACKAGE_SIZE_WARNING_BYTES,
  };
}

const PYTHON_ZIP_SCRIPT = String.raw`
import json
import os
import stat
import sys
import time
import zipfile

payload = json.load(sys.stdin)
root = os.path.abspath(payload["root"])
out_path = os.path.abspath(payload["out_path"])
names = payload["names"]
package_dir = os.path.realpath(os.path.join(root, ".imac", "package_zip"))

def is_inside_package(path):
    real = os.path.realpath(path)
    return real == package_dir or real.startswith(package_dir + os.sep)

def zip_info(name, mode, is_dir=False, is_symlink=False):
    archive_name = name.replace(os.sep, "/")
    if is_dir and not archive_name.endswith("/"):
        archive_name += "/"
    info = zipfile.ZipInfo(archive_name, time.localtime()[:6])
    kind = stat.S_IFLNK if is_symlink else (stat.S_IFDIR if is_dir else stat.S_IFREG)
    info.external_attr = (kind | mode) << 16
    return info

def add_symlink(zf, abs_path, arcname):
    try:
        target = os.readlink(abs_path)
    except OSError:
        return
    zf.writestr(zip_info(arcname, 0o777, is_symlink=True), target)

def add_file(zf, abs_path, arcname):
    if is_inside_package(abs_path):
        return
    try:
        st = os.lstat(abs_path)
    except OSError:
        return
    mode = stat.S_IMODE(st.st_mode) or 0o644
    if stat.S_ISLNK(st.st_mode):
        add_symlink(zf, abs_path, arcname)
    elif stat.S_ISREG(st.st_mode):
        zf.write(abs_path, arcname)
    elif stat.S_ISDIR(st.st_mode):
        add_dir(zf, abs_path, arcname)

def add_dir(zf, abs_path, arcname):
    if is_inside_package(abs_path):
        return
    try:
        st = os.lstat(abs_path)
    except OSError:
        return
    zf.writestr(zip_info(arcname, stat.S_IMODE(st.st_mode) or 0o755, is_dir=True), b"")
    for current, dirs, files in os.walk(abs_path, topdown=True, followlinks=False):
        if is_inside_package(current):
            dirs[:] = []
            continue
        keep_dirs = []
        for dirname in dirs:
            child = os.path.join(current, dirname)
            child_arc = os.path.relpath(child, root)
            if is_inside_package(child):
                continue
            if os.path.islink(child):
                add_symlink(zf, child, child_arc)
            else:
                keep_dirs.append(dirname)
        dirs[:] = keep_dirs
        if current != abs_path:
            rel_dir = os.path.relpath(current, root)
            try:
                dir_st = os.lstat(current)
                zf.writestr(zip_info(rel_dir, stat.S_IMODE(dir_st.st_mode) or 0o755, is_dir=True), b"")
            except OSError:
                pass
        for filename in files:
            child = os.path.join(current, filename)
            child_arc = os.path.relpath(child, root)
            add_file(zf, child, child_arc)

compression = zipfile.ZIP_DEFLATED
os.makedirs(os.path.dirname(out_path), exist_ok=True)
with zipfile.ZipFile(out_path, "w", compression=compression, allowZip64=True) as zf:
    for name in names:
        abs_path = os.path.abspath(os.path.join(root, name))
        if not (abs_path == root or abs_path.startswith(root + os.sep)):
            raise SystemExit(f"invalid path: {name}")
        if not os.path.lexists(abs_path):
            raise SystemExit(f"missing path: {name}")
        add_file(zf, abs_path, name)
print(json.dumps({"ok": True, "size": os.path.getsize(out_path)}))
`;

function createPackageZip(project, rawNames) {
  const estimate = estimatePackageSelection(project, rawNames);
  const root = projectPackageRoot(project);
  const outDir = packageZipDir(root);
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const fileName = `${safePackageName(project.name)}-${stamp}-${uuid().slice(0, 8)}.zip`;
  const outPath = path.join(outDir, fileName);
  const result = spawnSync('python3', ['-c', PYTHON_ZIP_SCRIPT], {
    input: JSON.stringify({ root, out_path: outPath, names: estimate.names }),
    encoding: 'utf8',
    timeout: 30 * 60 * 1000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) throw new Error(`创建压缩包失败: ${result.error.message}`);
  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim();
    const stdout = String(result.stdout || '').trim();
    throw new Error(stderr || stdout || `创建压缩包失败: python3 exited ${result.status}`);
  }
  return {
    ...estimate,
    file_name: fileName,
    file_path: outPath,
    zip_size: fs.existsSync(outPath) ? fs.statSync(outPath).size : null,
  };
}

function runGit(cwd, args, opts = {}) {
  try {
    const result = spawnSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: opts.timeout || 5000,
      maxBuffer: opts.maxBuffer || 1024 * 1024,
    });
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    const stderr = typeof result.stderr === 'string' ? result.stderr : '';
    if (result.error) {
      return { ok: false, stdout, stderr, error: result.error.message };
    }
    if (result.status !== 0) {
      return {
        ok: false,
        stdout,
        stderr,
        status: result.status,
        error: stderr.trim() || `git exited with status ${result.status}`,
      };
    }
    return { ok: true, stdout, stderr };
  } catch (e) {
    return { ok: false, stdout: '', stderr: '', error: e.message };
  }
}

function hasGitMarker(dir) {
  try {
    return fs.existsSync(path.join(dir, '.git'));
  } catch {
    return false;
  }
}

function discoverNestedGitRepo(root) {
  const queue = [{ dir: root, depth: 0 }];
  const seen = new Set();
  let scanned = 0;

  while (queue.length > 0 && scanned < GIT_REPO_SCAN_MAX_DIRS) {
    const { dir, depth } = queue.shift();
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    scanned += 1;

    if (hasGitMarker(resolved)) {
      const top = runGit(resolved, ['rev-parse', '--show-toplevel']);
      if (top.ok && top.stdout.trim()) {
        const repoPath = path.resolve(top.stdout.trim());
        if (isWithinPath(root, repoPath)) return repoPath;
      }
    }

    if (depth >= GIT_REPO_SCAN_MAX_DEPTH) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(resolved, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || GIT_SCAN_SKIP_DIRS.has(entry.name)) continue;
      const child = path.join(resolved, entry.name);
      if (!isWithinPath(root, child)) continue;
      queue.push({ dir: child, depth: depth + 1 });
    }
  }
  return null;
}

function discoverGitRepo(bindPath) {
  if (!bindPath) {
    return { available: false, reason: '项目未绑定路径' };
  }
  const root = path.resolve(bindPath);
  try {
    if (!fs.existsSync(root)) {
      return { available: false, bind_path: root, reason: '绑定路径不存在' };
    }
    if (!fs.statSync(root).isDirectory()) {
      return { available: false, bind_path: root, reason: '绑定路径不是目录' };
    }
  } catch (e) {
    return { available: false, bind_path: root, reason: `无法读取绑定路径: ${e.message}` };
  }

  const containing = runGit(root, ['rev-parse', '--show-toplevel']);
  if (containing.ok && containing.stdout.trim()) {
    return {
      available: true,
      bind_path: root,
      repo_path: path.resolve(containing.stdout.trim()),
      source: 'containing',
    };
  }

  const nested = discoverNestedGitRepo(root);
  if (nested) {
    return {
      available: true,
      bind_path: root,
      repo_path: nested,
      source: nested === root ? 'root' : 'nested',
    };
  }

  return { available: false, bind_path: root, reason: '绑定路径下未检测到 Git 仓库' };
}

function parseGitStatus(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).filter(Boolean);
  const summary = { dirty_count: lines.length, staged_count: 0, unstaged_count: 0, untracked_count: 0 };
  for (const line of lines) {
    if (line.startsWith('??')) {
      summary.untracked_count += 1;
      continue;
    }
    if (line[0] && line[0] !== ' ') summary.staged_count += 1;
    if (line[1] && line[1] !== ' ') summary.unstaged_count += 1;
  }
  return summary;
}

function parseGitCommits(stdout) {
  return String(stdout || '')
    .split(GIT_RECORD_SEPARATOR)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const fields = record.split(GIT_FIELD_SEPARATOR);
      const refs = String(fields[7] || '')
        .split(',')
        .map((ref) => ref.trim())
        .filter(Boolean);
      return {
        hash: fields[0] || '',
        short_hash: fields[1] || '',
        author_name: fields[2] || '',
        author_email: fields[3] || '',
        date: fields[4] || '',
        relative_date: fields[5] || '',
        subject: fields[6] || '',
        refs,
      };
    })
    .filter((commit) => commit.hash);
}

function readProjectGitTracking(project, rawLimit) {
  const limit = normalizeCommitLimit(rawLimit);
  const discovered = discoverGitRepo(project.bind_path);
  const base = {
    available: false,
    bind_path: discovered.bind_path || project.bind_path || '',
    repo_path: '',
    repo_name: '',
    source: discovered.source || '',
    branch: '',
    head: '',
    remote: '',
    dirty: false,
    dirty_count: 0,
    staged_count: 0,
    unstaged_count: 0,
    untracked_count: 0,
    commits: [],
    updated_at: new Date().toISOString(),
  };
  if (!discovered.available) {
    return { ...base, reason: discovered.reason || '未检测到 Git 仓库' };
  }

  const repoPath = discovered.repo_path;
  const branch = runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = runGit(repoPath, ['rev-parse', '--short', 'HEAD']);
  const remote = runGit(repoPath, ['config', '--get', 'remote.origin.url']);
  const status = runGit(repoPath, ['status', '--porcelain=v1'], { maxBuffer: 512 * 1024 });
  const log = runGit(repoPath, [
    'log',
    `-${limit}`,
    '--date=iso-strict',
    `--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%ad%x1f%ar%x1f%s%x1f%D%x1e`,
  ]);

  const statusSummary = status.ok ? parseGitStatus(status.stdout) : parseGitStatus('');
  const commits = log.ok ? parseGitCommits(log.stdout) : [];
  const logError = log.ok || /does not have any commits|bad default revision/i.test(log.error || '')
    ? ''
    : (log.error || '读取提交历史失败');

  return {
    ...base,
    available: true,
    repo_path: repoPath,
    repo_name: path.basename(repoPath),
    source: discovered.source || '',
    branch: branch.ok ? branch.stdout.trim() : '',
    head: head.ok ? head.stdout.trim() : '',
    remote: remote.ok ? remote.stdout.trim() : '',
    dirty: statusSummary.dirty_count > 0,
    ...statusSummary,
    commits,
    ...(logError ? { log_error: logError } : {}),
  };
}

function shapeContextItem(row) {
  return {
    id: row.id,
    scope: row.scope,
    owner_id: row.owner_id,
    name: row.name,
    description: row.description || '',
  };
}

function idsAllowedByAvailable(raw, available) {
  const allowed = new Set(available.map((item) => item.id));
  const out = [];
  const seen = new Set();
  for (const id of Array.isArray(raw) ? raw : []) {
    if (typeof id !== 'string') continue;
    const trimmed = id.trim();
    if (!trimmed || !allowed.has(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function buildUserContextWhitelistPayload(projectId, userId) {
  const whitelist = Projects.getUserContextWhitelist(projectId, userId);
  const availableSkills = Skills.listForUser(userId).map(shapeContextItem);
  const availableBuiltinSkills = Skills.listBuiltin().map(shapeContextItem);
  const availableMemories = Memories.listForUser(userId).map(shapeContextItem);
  const skillIds = Array.isArray(whitelist.skill_ids)
    ? idsAllowedByAvailable(whitelist.skill_ids, availableSkills)
    : [];
  const builtinSkillIds = Array.isArray(whitelist.builtin_skill_ids)
    ? idsAllowedByAvailable(whitelist.builtin_skill_ids, availableBuiltinSkills)
    : [];
  const memoryIds = Array.isArray(whitelist.memory_ids)
    ? idsAllowedByAvailable(whitelist.memory_ids, availableMemories)
    : [];
  return {
    skill_whitelist_enabled: Array.isArray(whitelist.skill_ids),
    builtin_skill_whitelist_enabled: Array.isArray(whitelist.builtin_skill_ids),
    memory_whitelist_enabled: Array.isArray(whitelist.memory_ids),
    skill_ids: skillIds,
    builtin_skill_ids: builtinSkillIds,
    memory_ids: memoryIds,
    available_skills: availableSkills,
    available_builtin_skills: availableBuiltinSkills,
    available_memories: availableMemories,
    updated_at: whitelist.updated_at || null,
  };
}

function findArchitectureIssue(projectId) {
  return Issues.findByProjectAndTitle(projectId, ARCHITECTURE_ISSUE_TITLE);
}

function ensureArchitectureIssue(projectId, userId) {
  const existing = findArchitectureIssue(projectId);
  if (existing) return { issue: existing, created: false };
  const issueId = uuid().slice(0, 8);
  Issues.insert({
    id: issueId,
    project_id: projectId,
    title: ARCHITECTURE_ISSUE_TITLE,
    description: ARCHITECTURE_ISSUE_DESCRIPTION,
    created_by: userId,
    use_worktree: false,
    worktree_branch: '',
  });
  return { issue: Issues.findById(issueId), created: true };
}

function toIdList(value) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  if (typeof value === 'string' && value.length > 0) {
    return value.split(',').map(v => v.trim()).filter(Boolean);
  }
  return [];
}

function contentTypeForFigure(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'text/html; charset=utf-8';
  if (ext === '.svg') return 'image/svg+xml; charset=utf-8';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.bmp') return 'image/bmp';
  return 'application/octet-stream';
}

function figureKind(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.svg') return 'svg';
  return 'image';
}

function findArchitectureFigure(project) {
  const bindPath = (project?.bind_path || '').trim();
  if (!bindPath) return null;
  const dir = path.resolve(bindPath, '.imac', 'generated_figures');
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => {
        const absPath = path.join(dir, entry.name);
        const ext = path.extname(entry.name).toLowerCase();
        if (!ARCHITECTURE_FIGURE_EXTENSIONS.includes(ext)) return null;
        if (path.basename(entry.name, ext).toLowerCase() !== 'arch') return null;
        const stat = fs.statSync(absPath);
        return { absPath, name: entry.name, ext, stat };
      })
      .filter(Boolean)
      .sort((a, b) => {
        const pa = ARCHITECTURE_FIGURE_EXTENSIONS.indexOf(a.ext);
        const pb = ARCHITECTURE_FIGURE_EXTENSIONS.indexOf(b.ext);
        if (pa !== pb) return pa - pb;
        return b.stat.mtimeMs - a.stat.mtimeMs;
      });
    return entries[0] || null;
  } catch {
    return null;
  }
}

function readableProjectsForUser(user) {
  return Projects.listAll(user.id).filter((project) => canReadProject(user, project));
}

function shapeProjectList(projects, req) {
  const mutedIds = UserProjectView.mutedIds(req.user.id);
  return projects.map((project) => shapeProjectForUser(project, req.user, { mutedIds }));
}

function auditAdminProjectList(req, action, projects) {
  if (req.user?.role !== 'admin') return;
  if (!projects.some((project) => project.created_by && project.created_by !== req.user.id)) return;
  recordAdminAuditIfCrossUser(req.user, action, 'project', '*', '');
}

function projectSearchResults(req) {
  const query = req.query.q ?? req.query.search ?? '';
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  return filterProjectListForUser(readableProjectsForUser(req.user), req.user, { query })
    .slice(0, limit);
}

function sendProjectSearch(req, res) {
  const projects = projectSearchResults(req);
  auditAdminProjectList(req, 'search_projects', projects);
  res.json(shapeProjectList(projects, req));
}

router.get('/', auth, (req, res) => {
  if (normalizeProjectSearch(req.query.q ?? req.query.search ?? '')) {
    return sendProjectSearch(req, res);
  }
  // ?all=true: 跳过 user_view_prefs.hide_others_projects, 让当前用户拿到自己可见的全部项目
  // (默认 /api/projects 仍然尊重该偏好, 用于 chip 筛选等窄视角场景).
  const showAll = String(req.query.all || '').toLowerCase() === 'true' || req.query.all === '1';
  const projects = filterProjectListForUser(readableProjectsForUser(req.user), req.user, { showAll })
    .filter((project) => !isHidden(req.user.id, 'project', project.id));
  auditAdminProjectList(req, 'list_projects', projects);
  res.json(shapeProjectList(projects, req));
});

router.get('/search', auth, sendProjectSearch);

router.get('/view-prefs', auth, (req, res) => {
  res.json(UserProjectView.getPrefs(req.user.id));
});

router.patch('/view-prefs', auth, (req, res) => {
  if (!hasBoolField(req.body || {}, 'hide_others_projects', 'hideOthersProjects')) {
    return res.status(400).json({ error: 'hide_others_projects 必须是布尔值' });
  }
  res.json(UserProjectView.setPrefs(req.user.id, {
    hideOthersProjects: boolFromBody(req.body || {}, 'hide_others_projects', 'hideOthersProjects'),
  }));
});

router.get('/muted', auth, (req, res) => {
  const mutedIds = UserProjectView.mutedIds(req.user.id);
  const projects = readableProjectsForUser(req.user).filter((project) => mutedIds.has(project.id));
  res.json(shapeProjectList(projects, req));
});

router.post('/', auth, (req, res) => {
  const { name, description, bindPath, bindPathManual, gitRepos, defaultUseWorktree, researchEnabled, guidedDemoKind, kind, extensionName } = req.body;
  if (!name) return res.status(400).json({ error: '请填写项目名称' });
  const visibility = normalizeProjectVisibility(req.body?.visibility, 'private');
  const canPostIssue = boolFromBody(req.body || {}, 'can_post_issue', 'canPostIssue', false);
  const canRunSession = boolFromBody(req.body || {}, 'can_run_session', 'canRunSession', false);

  // ── 莫比乌斯拓展项目 ──────────────────────────────────────────────────────
  if (kind === 'extension') {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: '只有管理员可以创建莫比乌斯拓展项目' });
    }
    if (hasBoolField(req.body || {}, 'can_post_issue', 'canPostIssue')
      || hasBoolField(req.body || {}, 'can_run_session', 'canRunSession')) {
      return res.status(400).json({ error: '拓展项目的写权限开关由系统管理, 不可手动修改' });
    }
    if (req.body?.default_model !== undefined || req.body?.defaultModel !== undefined) {
      return res.status(400).json({ error: '拓展项目的默认模型偏好由 manifest 管理, 不可手动修改' });
    }
    const registry = require('../services/extension-registry');
    const normalizedExtensionName = typeof extensionName === 'string' ? extensionName.trim().toLowerCase() : '';
    if (!normalizedExtensionName || !registry.EXT_NAME_RE.test(normalizedExtensionName)) {
      return res.status(400).json({ error: '拓展标识名格式不符：需以小写字母开头，可含小写字母、数字和连字符，1-32字符' });
    }
    try {
      createExtensionSkeleton({
        extensionName: normalizedExtensionName,
        displayName: name,
        description,
      });
      const reloadResult = registry.reload();
      const project = Projects.findByExtensionName(normalizedExtensionName, req.user.id);
      if (!project) {
        const error = reloadResult?.errors?.find((item) => item?.name === normalizedExtensionName)?.error || '拓展注册失败';
        return res.status(500).json({ error });
      }
      setProjectAccess(project.id, { ...projectAccessBody(req.body), visibility });
      return res.json({
        ...shapeProjectForUser(Projects.findById(project.id, req.user.id), req.user),
        extension_reload: reloadResult,
      });
    } catch (e) {
      return res.status(e.statusCode || 500).json({ error: '创建拓展项目失败：' + e.message });
    }
  }

  // ── 普通 / Research 项目 ──────────────────────────────────────────────────
  let resolvedPath = '';
  let repos = [];
  let normalizedDefaultModel;
  try {
    resolvedPath = bindPathManual
      ? resolveBindPathManual(bindPath)
      : resolveBindPath(bindPath, req.user.work_dir, { createIfMissing: true });
    repos = normalizeGitRepos(gitRepos) || [];
    normalizedDefaultModel = normalizeDefaultModel(req.body?.default_model ?? req.body?.defaultModel);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const projectId = uuid().slice(0, 8);
  // 未显式传则默认 true (保持存量行为: 新建 Issue 时 worktree 勾选框默认打钩)
  let defWt = defaultUseWorktree === undefined ? true : !!defaultUseWorktree;
  const nextResearchEnabled = researchEnabled === undefined ? false : !!researchEnabled;
  // 项目级规则: Research 启用时强制禁用 worktree (research 流程不走 worktree)
  if (nextResearchEnabled) defWt = false;
  Projects.insert({
    id: projectId,
    name,
    description,
    createdBy: req.user.id,
    bindPath: resolvedPath,
    bindPathManual: !!bindPathManual,
    gitRepos: repos,
    defaultUseWorktree: defWt,
    researchEnabled: nextResearchEnabled,
    visibility,
    canPostIssue,
    canRunSession,
    defaultModel: normalizedDefaultModel,
  });
  setProjectAccess(projectId, { ...projectAccessBody(req.body), visibility });
  const project = Projects.findById(projectId, req.user.id);
  const guidedKind = typeof guidedDemoKind === 'string' ? guidedDemoKind.trim() : '';
  let guidedDemoAssets = null;
  if (guidedKind) {
    guidedDemoAssets = ensureGuidedDemoAssets({ kind: guidedKind, project, user: req.user });
    if (!guidedDemoAssets.ok) {
      try {
        Skills.deleteForProject(projectId);
        Memories.deleteForProject(projectId);
        removeDemoWorkspaceIfRequested(project, req.user, true);
        Projects.delete(projectId);
      } catch {}
      return res.status(400).json({ error: guidedDemoAssets.error || '演示项目资料准备失败' });
    }
  }
  res.json({ ...shapeProjectForUser(project, req.user), guided_demo_assets: guidedDemoAssets });
});

router.delete('/:id', auth, (req, res) => {
  const project = Projects.findById(req.params.id);
  if (!project) return res.status(404).json({ error: '未找到' });
  if (project.created_by !== req.user.id) {
    return res.status(403).json({ error: '只有项目创建者可以删除项目' });
  }
  if (project.id === FIXED_LOGO_REVIEW_PROJECT_ID) {
    return res.status(400).json({
      error: '这个项目是引导系统固定完成案例，用于“验收完成案例”路线，不能删除。其他同名临时演示项目仍可删除。',
    });
  }
  if (project.kind === 'extension') {
    return res.status(400).json({ error: '拓展项目由 mobius/extension/ 目录管理, 请删除对应目录后 reload' });
  }

  const { password, confirm } = req.body || {};
  const normalizedConfirm = String(confirm || '').trim();
  const accepted = new Set([project.name, project.id].filter(Boolean).map(String));
  if (!accepted.has(normalizedConfirm)) {
    return res.status(400).json({ error: '请输入项目名或项目 ID 确认' });
  }

  if (ENABLE_PASSWORD_LOGIN) {
    if (!password) return res.status(400).json({ error: '请输入密码' });
    const fullUser = Users.findById(req.user.id);
    if (!fullUser?.password_hash || !bcrypt.compareSync(password, fullUser.password_hash)) {
      return res.status(401).json({ error: '密码错误' });
    }
  }

  try {
    const contextCleanup = {
      skills: Skills.deleteForProject(req.params.id),
      memories: Memories.deleteForProject(req.params.id),
    };
    const workspaceCleanup = removeDemoWorkspaceIfRequested(project, req.user, !!req.body?.cleanup_demo_workspace);
    recordAdminAuditIfCrossUser(req.user, 'delete_project', 'project', project.id, project.created_by);
    Projects.delete(req.params.id);
    res.json({ ok: true, context_cleanup: contextCleanup, workspace_cleanup: workspaceCleanup });
  } catch (e) {
    res.status(500).json({ error: e.message || '删除项目失败' });
  }
});

// 拓展项目: 每用户隐藏 (隐藏卡片, 不动数据). 可被同一用户自己撤销, 也可被管理员撤销.
router.post('/:id/hide', auth, (req, res) => {
  const project = Projects.findById(req.params.id);
  if (!project) return res.status(404).json({ error: '未找到' });
  if (!canReadProject(req.user, project)) return res.status(404).json({ error: '未找到' });
  if (project.kind === 'extension') Projects.setHidden(req.params.id, req.user.id, true);
  UserProjectView.mute(req.user.id, req.params.id);
  setHidden(req.user.id, 'project', req.params.id, true);
  recordAdminAuditIfCrossUser(req.user, 'mute_project', 'project', project.id, project.created_by);
  res.json({ ok: true, muted: true });
});

router.post('/:id/unhide', auth, (req, res) => {
  const project = Projects.findById(req.params.id);
  if (!project) return res.status(404).json({ error: '未找到' });
  if (!canReadProject(req.user, project)) return res.status(404).json({ error: '未找到' });
  if (project.kind === 'extension') Projects.setHidden(req.params.id, req.user.id, false);
  UserProjectView.unmute(req.user.id, req.params.id);
  setHidden(req.user.id, 'project', req.params.id, false);
  recordAdminAuditIfCrossUser(req.user, 'unmute_project', 'project', project.id, project.created_by);
  res.json({ ok: true, muted: false });
});

router.post('/:id/mute', auth, (req, res) => {
  const project = Projects.findById(req.params.id);
  if (!project) return res.status(404).json({ error: '未找到' });
  if (!canReadProject(req.user, project)) return res.status(404).json({ error: '未找到' });
  UserProjectView.mute(req.user.id, req.params.id);
  setHidden(req.user.id, 'project', req.params.id, true);
  recordAdminAuditIfCrossUser(req.user, 'mute_project', 'project', project.id, project.created_by);
  res.json({ ok: true, muted: true });
});

router.post('/:id/unmute', auth, (req, res) => {
  const project = Projects.findById(req.params.id);
  if (!project) return res.status(404).json({ error: '未找到' });
  if (!canReadProject(req.user, project)) return res.status(404).json({ error: '未找到' });
  UserProjectView.unmute(req.user.id, req.params.id);
  setHidden(req.user.id, 'project', req.params.id, false);
  recordAdminAuditIfCrossUser(req.user, 'unmute_project', 'project', project.id, project.created_by);
  res.json({ ok: true, muted: false });
});

// 拓展项目: 彻底删除 = 事务删该用户在此拓展上的全部私有/共享数据 + 标记隐藏.
// 不可逆 (管理员撤销隐藏只能恢复卡片可见, 不能恢复数据).
router.post('/:id/purge', auth, (req, res) => {
  const project = Projects.findById(req.params.id);
  if (!project) return res.status(404).json({ error: '未找到' });
  if (project.kind !== 'extension') {
    return res.status(400).json({ error: '只能对拓展项目执行彻底删除' });
  }
  // 防止误触: 要求请求体里携带 confirm = 拓展名 / 项目名 / id 之一
  const confirm = String(req.body?.confirm || '').trim();
  const accept = new Set([
    project.name, project.extension_name, project.id,
  ].filter(Boolean).map(String));
  if (!accept.has(confirm)) {
    return res.status(400).json({ error: '请输入拓展名以确认' });
  }
  try {
    Projects.purgeUserExtensionData(req.params.id, req.user.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id/star', auth, (req, res) => {
  const project = Projects.findById(req.params.id);
  if (!project) return res.status(404).json({ error: '未找到' });
  if (!canReadProject(req.user, project)) return res.status(404).json({ error: '未找到' });
  if (typeof req.body?.starred !== 'boolean') {
    return res.status(400).json({ error: '星标状态格式错误' });
  }
  Projects.setStarred(req.params.id, req.user.id, req.body.starred);
  res.json(shapeProjectForUser(Projects.findById(req.params.id, req.user.id), req.user));
});

router.patch('/:id', auth, (req, res) => {
  const project = Projects.findById(req.params.id);
  if (!project) return res.status(404).json({ error: '未找到' });
  if (!canManageProject(req.user, project)) return res.status(403).json({ error: '只有项目 owner/admin 可以修改项目设置' });
  const {
    name,
    description,
    bindPath,
    bindPathManual,
    gitRepos,
    defaultUseWorktree,
    researchEnabled,
    canPostIssue,
    canRunSession,
    visibility,
    defaultModel,
    forgottenFlagMessage,
    forgottenFlagIssueIntervalMinutes,
    forgottenFlagResearchIntervalMinutes,
    forgottenFlagIssueInitMinutes,
    forgottenFlagIssueBackoff,
    forgottenFlagIssuePatience,
    forgottenFlagResearchInitMinutes,
    forgottenFlagResearchBackoff,
    forgottenFlagResearchPatience,
  } = req.body;
  // 拓展项目: name/description/bindPath/gitRepos/defaultUseWorktree/researchEnabled 由 registry 锁定,
  // 任何尝试修改这些字段的请求都拒掉. forgotten_flag.* 与星标仍允许.
  if (project.kind === 'extension') {
    const locked = [
      ['name', name],
      ['description', description],
      ['bindPath', bindPath],
      ['bindPathManual', bindPathManual],
      ['gitRepos', gitRepos],
      ['defaultUseWorktree', defaultUseWorktree],
      ['researchEnabled', researchEnabled],
      ['canPostIssue', canPostIssue],
      ['can_run_session', req.body?.can_run_session],
      ['canRunSession', canRunSession],
      ['can_post_issue', req.body?.can_post_issue],
      ['visibility', visibility],
      ['default_model', req.body?.default_model],
      ['defaultModel', defaultModel],
    ];
    const offender = locked.find(([, v]) => v !== undefined);
    if (offender) {
      return res.status(400).json({ error: `拓展项目的 ${offender[0]} 由 manifest 管理, 不可手动修改` });
    }
  }
  if (defaultModel !== undefined || req.body?.default_model !== undefined) {
    try {
      const normalized = normalizeDefaultModel(defaultModel ?? req.body?.default_model);
      Projects.updateDefaultModel(req.params.id, normalized);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }
  if (forgottenFlagMessage !== undefined) {
    if (typeof forgottenFlagMessage !== 'string') {
      return res.status(400).json({ error: '被遗忘 flag 提醒消息格式错误' });
    }
    if (forgottenFlagMessage.length > 4000) {
      return res.status(400).json({ error: '被遗忘 flag 提醒消息过长 (上限 4000 字符)' });
    }
    Projects.updateForgottenFlagMessage(req.params.id, forgottenFlagMessage);
  }
  const issuePolicyTouched = (
    forgottenFlagIssueIntervalMinutes !== undefined ||
    forgottenFlagIssueInitMinutes !== undefined ||
    forgottenFlagIssueBackoff !== undefined ||
    forgottenFlagIssuePatience !== undefined
  );
  if (issuePolicyTouched) {
    try {
      const initRaw = forgottenFlagIssueInitMinutes !== undefined
        ? forgottenFlagIssueInitMinutes
        : (forgottenFlagIssueIntervalMinutes !== undefined
          ? forgottenFlagIssueIntervalMinutes
          : project.forgotten_flag_issue_init_minutes);
      const policy = {
        initMinutes: normalizeIntervalMinutes(initRaw, 'Issue Session Init', FORGOTTEN_FLAG_ISSUE_INTERVAL_MINUTES_MIN),
        backoff: normalizeBackoff(
          forgottenFlagIssueBackoff !== undefined ? forgottenFlagIssueBackoff : project.forgotten_flag_issue_backoff,
          'Issue Session Backoff',
        ),
        patience: normalizePatience(
          forgottenFlagIssuePatience !== undefined ? forgottenFlagIssuePatience : project.forgotten_flag_issue_patience,
          'Issue Session Patience',
        ),
      };
      Projects.updateForgottenFlagIssuePolicy(req.params.id, policy);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }
  const researchPolicyTouched = (
    forgottenFlagResearchIntervalMinutes !== undefined ||
    forgottenFlagResearchInitMinutes !== undefined ||
    forgottenFlagResearchBackoff !== undefined ||
    forgottenFlagResearchPatience !== undefined
  );
  if (researchPolicyTouched) {
    try {
      const initRaw = forgottenFlagResearchInitMinutes !== undefined
        ? forgottenFlagResearchInitMinutes
        : (forgottenFlagResearchIntervalMinutes !== undefined
          ? forgottenFlagResearchIntervalMinutes
          : project.forgotten_flag_research_init_minutes);
      const policy = {
        initMinutes: normalizeIntervalMinutes(initRaw, 'Research Agent Init', FORGOTTEN_FLAG_RESEARCH_INTERVAL_MINUTES_MIN),
        backoff: normalizeBackoff(
          forgottenFlagResearchBackoff !== undefined ? forgottenFlagResearchBackoff : project.forgotten_flag_research_backoff,
          'Research Agent Backoff',
        ),
        patience: normalizePatience(
          forgottenFlagResearchPatience !== undefined ? forgottenFlagResearchPatience : project.forgotten_flag_research_patience,
          'Research Agent Patience',
        ),
      };
      Projects.updateForgottenFlagResearchPolicy(req.params.id, policy);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }
  if (bindPath !== undefined) {
    try {
      const resolvedPath = bindPathManual
        ? resolveBindPathManual(bindPath)
        : resolveBindPath(bindPath, req.user.work_dir);
      Projects.updateBindPath(req.params.id, resolvedPath, !!bindPathManual);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }
  if (gitRepos !== undefined) {
    try {
      const repos = normalizeGitRepos(gitRepos);
      if (repos !== null) Projects.updateGitRepos(req.params.id, repos);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }
  // 项目级规则: Research 启用时强制禁用 worktree.
  // 先算出本次 PATCH 后 research 的最终值, 再据此决定 worktree 是否要强制 false.
  const nextResearchEnabled = (researchEnabled !== undefined) ? !!researchEnabled : !!project.research_enabled;
  if (researchEnabled !== undefined) Projects.updateResearchEnabled(req.params.id, nextResearchEnabled);
  if (nextResearchEnabled) {
    // Research 开启时, 忽略请求中的 defaultUseWorktree, 强制写入 false
    Projects.updateDefaultUseWorktree(req.params.id, false);
  } else if (defaultUseWorktree !== undefined) {
    Projects.updateDefaultUseWorktree(req.params.id, !!defaultUseWorktree);
  }
  if (hasBoolField(req.body || {}, 'can_post_issue', 'canPostIssue')) {
    Projects.updateCanPostIssue(req.params.id, boolFromBody(req.body || {}, 'can_post_issue', 'canPostIssue'));
  }
  if (hasBoolField(req.body || {}, 'can_run_session', 'canRunSession')) {
    Projects.updateCanRunSession(req.params.id, boolFromBody(req.body || {}, 'can_run_session', 'canRunSession'));
  }
  if (name) Projects.updateName(req.params.id, name);
  if (description !== undefined) Projects.updateDescription(req.params.id, description);
  if (visibility !== undefined
    || req.body?.allow_user_ids !== undefined || req.body?.allowUserIds !== undefined
    || req.body?.allow_group_ids !== undefined || req.body?.allowGroupIds !== undefined) {
    setProjectAccess(req.params.id, projectAccessBody(req.body));
  }
  recordAdminAuditIfCrossUser(req.user, 'write_project', 'project', project.id, project.created_by);
  res.json(shapeProjectForUser(Projects.findById(req.params.id, req.user.id), req.user));
});

router.get('/:id/git-tracking', auth, (req, res) => {
  const project = loadReadableProject(req, res, req.params.id);
  if (!project) return;
  try {
    res.json(readProjectGitTracking(project, req.query.limit));
  } catch (e) {
    res.status(500).json({ error: e.message || '读取 Git 追踪信息失败' });
  }
});

router.post('/:id/deploy-version', auth, (req, res) => {
  const project = loadReadableProject(req, res, req.params.id);
  if (!project) return;
  if (!project.is_self_develop) return res.status(400).json({ error: '只有 Mobius 自迭代项目可以回退版本' });
  if (req.user?.role !== 'admin') return res.status(403).json({ error: '只有管理员可以回退 Mobius 版本' });

  const gitHash = normalizeRollbackHash(req.body?.git_hash || req.body?.hash || req.body?.commit);
  if (!gitHash) return res.status(400).json({ error: 'git_hash 必须是 7-40 位 commit hash' });

  try {
    const spawned = spawnProductOtherVersion(gitHash);
    res.json({
      ok: true,
      git_hash: gitHash,
      pid: spawned.pid,
      log_path: spawned.log_path,
      message: `已开始回退到 ${gitHash}`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message || '启动版本回退失败' });
  }
});

router.post('/:id/hard-reset-version', auth, (req, res) => {
  const project = loadReadableProject(req, res, req.params.id);
  if (!project) return;
  if (!project.is_self_develop) return res.status(400).json({ error: '只有 Mobius 自迭代项目可以硬回退版本' });
  if (req.user?.role !== 'admin') return res.status(403).json({ error: '只有管理员可以硬回退 Mobius 版本' });

  const gitHash = normalizeRollbackHash(req.body?.git_hash || req.body?.hash || req.body?.commit);
  if (!gitHash) return res.status(400).json({ error: 'git_hash 必须是 7-40 位 commit hash' });

  try {
    const spawned = spawnProductHardReset(gitHash);
    res.json({
      ok: true,
      git_hash: gitHash,
      pid: spawned.pid,
      log_path: spawned.log_path,
      message: `已开始硬回退到 ${gitHash}, 当前版本会先保存到 discard/<timestamp> 分支`,
    });
  } catch (e) {
    res.status(500).json({ error: e.message || '启动版本硬回退失败' });
  }
});

router.get('/:id/todos', auth, (req, res) => {
  const project = loadReadableProject(req, res, req.params.id);
  if (!project) return;
  res.json({ items: ProjectTodos.listForProject(project.id) });
});

router.post('/:id/todos', auth, (req, res) => {
  const project = loadManageableProject(req, res, req.params.id);
  if (!project) return;

  let title;
  let description;
  try {
    title = normalizeTodoTitle(req.body?.title);
    description = normalizeTodoDescription(req.body?.description);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const completed = typeof req.body?.completed === 'boolean' ? req.body.completed : false;
  let sortOrder;
  if (hasOwn(req.body, 'sort_order') || hasOwn(req.body, 'sortOrder')) {
    try {
      sortOrder = normalizeTodoSortOrder(req.body.sort_order ?? req.body.sortOrder);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  const id = uuid().slice(0, 8);
  res.json(ProjectTodos.insert({
    id,
    projectId: project.id,
    title,
    description,
    completed,
    sortOrder,
    createdBy: req.user.id,
  }));
});

router.patch('/:id/todos/:todoId', auth, (req, res) => {
  const project = loadManageableProject(req, res, req.params.id);
  if (!project) return;

  const patch = {};
  try {
    if (hasOwn(req.body, 'title')) patch.title = normalizeTodoTitle(req.body.title);
    if (hasOwn(req.body, 'description')) patch.description = normalizeTodoDescription(req.body.description);
    if (hasOwn(req.body, 'completed')) {
      if (typeof req.body.completed !== 'boolean') throw new Error('待办完成状态格式错误');
      patch.completed = req.body.completed;
    }
    if (hasOwn(req.body, 'sort_order') || hasOwn(req.body, 'sortOrder')) {
      patch.sortOrder = normalizeTodoSortOrder(req.body.sort_order ?? req.body.sortOrder);
    }
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const todo = ProjectTodos.update(project.id, req.params.todoId, patch, req.user.id);
  if (!todo) return res.status(404).json({ error: '待办不存在' });
  res.json(todo);
});

router.delete('/:id/todos/:todoId', auth, (req, res) => {
  const project = loadManageableProject(req, res, req.params.id);
  if (!project) return;
  const result = ProjectTodos.delete(project.id, req.params.todoId);
  if (result.changes === 0) return res.status(404).json({ error: '待办不存在' });
  res.json({ ok: true });
});

router.put('/:id/todos/reorder', auth, (req, res) => {
  const project = loadManageableProject(req, res, req.params.id);
  if (!project) return;
  if (!Array.isArray(req.body?.ids)) return res.status(400).json({ error: '待办排序列表格式错误' });
  try {
    res.json({ items: ProjectTodos.reorder(project.id, req.body.ids) });
  } catch (e) {
    res.status(400).json({ error: e.message || '待办排序失败' });
  }
});

router.get('/:id/package/items', auth, (req, res) => {
  const project = loadReadableProject(req, res, req.params.id);
  if (!project) return;
  try {
    const { root, entries } = listPackageEntries(project);
    res.json({
      bind_path: root,
      package_dir: packageZipDir(root),
      excluded_path: PACKAGE_ZIP_RELATIVE_DIR.replace(/\\/g, '/'),
      warning_threshold: PACKAGE_SIZE_WARNING_BYTES,
      entries,
    });
  } catch (e) {
    res.status(400).json({ error: e.message || '读取可打包文件失败' });
  }
});

router.post('/:id/package/estimate', auth, (req, res) => {
  const project = loadReadableProject(req, res, req.params.id);
  if (!project) return;
  try {
    res.json(estimatePackageSelection(project, req.body?.names));
  } catch (e) {
    res.status(400).json({ error: e.message || '统计打包大小失败' });
  }
});

router.post('/:id/package/download', auth, (req, res) => {
  const project = loadReadableProject(req, res, req.params.id);
  if (!project) return;
  let created;
  try {
    created = createPackageZip(project, req.body?.names);
  } catch (e) {
    return res.status(400).json({ error: e.message || '创建压缩包失败' });
  }
  res.setHeader('Content-Type', 'application/zip');
  res.download(created.file_path, created.file_name, (err) => {
    if (err && !res.headersSent) {
      res.status(500).json({ error: err.message || '下载压缩包失败' });
    }
  });
});

function handleArchitectureSessionPresetContextPreview(req, res) {
  const project = loadReadableProject(req, res, req.params.id);
  if (!project) return;
  const src = (req.method === 'POST' && req.body && typeof req.body === 'object')
    ? req.body : req.query;
  const draftSession = {
    name: typeof src.name === 'string' ? src.name : '',
    description: typeof src.description === 'string' ? src.description : '',
  };
  const excludedSkillIds = toIdList(src.excluded_skill_ids);
  const excludedMemoryIds = toIdList(src.excluded_memory_ids);
  const language = src.language === 'en' ? 'en' : 'zh';
  const existingIssue = findArchitectureIssue(project.id);
  const ctx = existingIssue
    ? buildIssueContextPreview(req.user, existingIssue.id, draftSession, excludedSkillIds, excludedMemoryIds, language)
    : buildProjectIssueContextPreview(
      req.user,
      project.id,
      { title: ARCHITECTURE_ISSUE_TITLE, description: ARCHITECTURE_ISSUE_DESCRIPTION },
      draftSession,
      excludedSkillIds,
      excludedMemoryIds,
      language,
    );
  res.json({ body: ctx.body, sources: ctx.sources });
}

router.get('/:id/architecture-session-preset/context-preview', auth, handleArchitectureSessionPresetContextPreview);
router.post('/:id/architecture-session-preset/context-preview', auth, handleArchitectureSessionPresetContextPreview);

router.get('/:id/architecture-session-preset/session-selection-defaults', auth, (req, res) => {
  const project = loadReadableProject(req, res, req.params.id);
  if (!project) return;
  const existingIssue = findArchitectureIssue(project.id);
  if (existingIssue) return res.json(buildIssueSelectionDefaults(req.user, existingIssue.id));
  res.json(buildProjectIssueSelectionDefaults(req.user, project.id, {
    title: ARCHITECTURE_ISSUE_TITLE,
    description: ARCHITECTURE_ISSUE_DESCRIPTION,
  }));
});

router.post('/:id/architecture-issue', auth, (req, res) => {
  const project = loadReadableProject(req, res, req.params.id);
  if (!project) return;
  if (!canCreateIssue(req.user, project)) return res.status(403).json({ error: '无权在此项目创建 Issue' });
  const result = ensureArchitectureIssue(project.id, req.user.id);
  res.json(result);
});

router.get('/:id/architecture-figure', auth, (req, res) => {
  const project = loadReadableProject(req, res, req.params.id);
  if (!project) return;
  const figure = findArchitectureFigure(project);
  if (!figure) return res.status(404).json({ error: '项目结构图不存在或正在绘制中' });
  const kind = figureKind(figure.name);
  res.setHeader('Content-Type', contentTypeForFigure(figure.name));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Architecture-Figure-Name', encodeURIComponent(figure.name));
  res.setHeader('X-Architecture-Figure-Kind', kind);
  res.setHeader('X-Architecture-Figure-Updated-At', figure.stat.mtime.toISOString());
  if (kind === 'html' || kind === 'svg') {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; script-src 'none'"
    );
  }
  res.sendFile(figure.absPath);
});

// 项目设置中的"用户级 Skill 与 Memory 白名单".
// 只影响当前用户的用户级条目和平台内置 Skill; 项目级 Skill/Memory 始终保留.
router.get('/:id/user-context-whitelist', auth, (req, res) => {
  const project = loadReadableProject(req, res, req.params.id);
  if (!project) return;
  res.json(buildUserContextWhitelistPayload(req.params.id, req.user.id));
});

router.patch('/:id/user-context-whitelist', auth, (req, res) => {
  const project = loadReadableProject(req, res, req.params.id);
  if (!project) return;

  const availableSkills = Skills.listForUser(req.user.id).map(shapeContextItem);
  const availableBuiltinSkills = Skills.listBuiltin().map(shapeContextItem);
  const availableMemories = Memories.listForUser(req.user.id).map(shapeContextItem);
  const skillEnabled = !!req.body?.skill_whitelist_enabled;
  const builtinSkillEnabled = !!req.body?.builtin_skill_whitelist_enabled;
  const memoryEnabled = !!req.body?.memory_whitelist_enabled;
  const skillIds = skillEnabled ? idsAllowedByAvailable(req.body?.skill_ids, availableSkills) : null;
  const builtinSkillIds = builtinSkillEnabled ? idsAllowedByAvailable(req.body?.builtin_skill_ids, availableBuiltinSkills) : null;
  const memoryIds = memoryEnabled ? idsAllowedByAvailable(req.body?.memory_ids, availableMemories) : null;

  Projects.setUserContextWhitelist(req.params.id, req.user.id, { skillIds, builtinSkillIds, memoryIds });
  res.json(buildUserContextWhitelistPayload(req.params.id, req.user.id));
});

router.post('/:id/guided-demo/import/clear-upload-sample', auth, (req, res) => {
  const project = loadReadableProject(req, res, req.params.id);
  if (!project) return;
  if (!isProjectImportDemoBindPath(project.bind_path)) {
    return res.status(400).json({ error: '只能清理导入演示项目的上传样例' });
  }
  try {
    const removed = clearProjectImportUploadedSample(project);
    res.json({ ok: true, removed });
  } catch (e) {
    res.status(500).json({ error: e.message || '清理上传样例失败' });
  }
});

// 项目 bind_path 下的文件浏览 + VSCode Web 反代入口.
// v1.9 主栈版: vscode_web_url 改为相对路径 `/code-server/<userId>__<projectId>`,
// 走 mobius 反代 + JWT, 每(用户, 项目)独立 code-server 进程 (services/code-server-pool.js).
// 旧 VSCODE_WEB_URL env (绝对 URL) 仅 fallback (vscode_web_url_legacy).
//
// 新增字段:
//   - bind_path_writable: bind_path 对服务进程是否可写 (不可写则前端屏蔽"打开"按钮)
//   - cs_url_token_required: 前端首次 navigate 必须把 JWT 当 ?_jwt=<token> 拼上
router.get('/:id/files', auth, (req, res) => {
  const project = loadReadableProject(req, res, req.params.id);
  if (!project) return;
  if (!project.bind_path) {
    return res.json({
      bind_path: '', vscode_web_url: '', vscode_web_url_legacy: VSCODE_WEB_URL || '',
      vscode_workspace_path: '',
      bind_path_writable: false, cs_url_token_required: true,
      path: '/', entries: [],
    });
  }

  let writable = false;
  try { fs.accessSync(project.bind_path, fs.constants.W_OK); writable = true; } catch {}

  const csUrl = `/code-server/${req.user.id}__${project.id}`;
  const vscodeWorkspacePath = defaultCodeServerWorkspace(project);

  const resolved = resolveProjectPath(project.bind_path, req.query.path || '/');
  if (resolved.error) return res.status(400).json({ error: resolved.error });
  const { absPath, relPath } = resolved;
  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isDirectory()) return res.status(404).json({ error: 'Not found' });
  try {
    const entries = fs.readdirSync(absPath, { withFileTypes: true })
      .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
      .map(e => {
        const full = path.join(absPath, e.name);
        let stat;
        try { stat = fs.statSync(full); } catch { return null; }
        return {
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file',
          size: e.isFile() ? stat.size : null,
          modified: stat.mtime,
          abs_path: full,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name));
    res.json({
      bind_path: project.bind_path,
      vscode_web_url: csUrl,
      vscode_web_url_legacy: VSCODE_WEB_URL || '',
      vscode_workspace_path: vscodeWorkspacePath,
      bind_path_writable: writable,
      cs_url_token_required: true,
      path: relPath,
      entries,
    });
  } catch {
    res.status(500).json({ error: 'Read failed' });
  }
});

router.get('/:id/main-project-port', auth, (req, res) => {
  const project = loadReadableProject(req, res, req.params.id);
  if (!project) return;
  const filePath = mainProjectPortPath(project);
  if (!filePath) return res.json({ port: null, valid: false, exists: false });
  try {
    if (!fs.existsSync(filePath)) {
      return res.json({ port: null, valid: false, exists: false });
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const port = normalizeProjectPort(raw);
    return res.json({ port, valid: port !== null, exists: true });
  } catch (e) {
    return res.status(500).json({ error: e.message || '读取项目端口失败' });
  }
});

router.post('/:id/main-project-port', auth, (req, res) => {
  const project = loadReadableProject(req, res, req.params.id);
  if (!project) return;
  if (!project.bind_path) return res.status(400).json({ error: '项目未配置 bind_path' });
  const port = normalizeProjectPort(req.body?.port);
  if (port === null) return res.status(400).json({ error: '端口必须是 1-65535 的整数' });
  const filePath = mainProjectPortPath(project);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${port}\n`, 'utf8');
    return res.json({ port, valid: true, exists: true });
  } catch (e) {
    return res.status(500).json({ error: e.message || '保存项目端口失败' });
  }
});

module.exports = router;
