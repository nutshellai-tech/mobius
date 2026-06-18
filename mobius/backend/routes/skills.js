/**
 * skills.js — 用户级 / 项目级 Skill 管理 (文件系统驱动).
 *
 * 添加: POST { name: '<skill 标识符>' } → 在目标目录下执行 `npx --yes skills add <name>`.
 * 存储: CORE_DATA_PATH/skills/user=<userId>/{default_project|project=<projectId>}/<skill-dir>/SKILL.md.
 *
 * 挂载位置:
 *   /api/skills                     用户级 (落在 user=<userId>/default_project/)
 *   /api/projects/:projectId/skills 项目级 (落在 user=<userId>/project=<projectId>/, 跨用户合并展示)
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { auth } = require('../middleware/auth');
const { Skills } = require('../repositories/skills');
const { Projects } = require('../repositories/projects');
const { UPLOAD_DIR } = require('../config');
const { parseFrontmatter } = require('../services/skill-loader');
const {
  MAX_SKILL_UPLOAD_BYTES,
  detectContextFileKind,
  extractArchiveFile,
  formatBytes,
  removeIfExists,
  safeOriginalName,
  safeResolveUnder,
  stripArchiveOrMarkdownExtension,
  unlinkIfExists,
} = require('../services/context-import-utils');
const {
  canContributeProjectContext,
  canManageContextItem,
  canReadContextItem,
  canReadProject,
  contextAccessPayload,
  filterReadableContextItems,
  isHidden,
  setHidden,
  setResourcePolicy,
  uniqStringList,
  withContextAccess,
} = require('../services/access-control');

const skillUpload = multer({
  dest: path.join(UPLOAD_DIR, 'skill-imports'),
  limits: { fileSize: MAX_SKILL_UPLOAD_BYTES },
});

function shape(row) {
  if (!row) return row;
  return {
    id: row.id,
    scope: row.scope,
    owner_id: row.owner_id,
    name: row.name,
    description: row.description || '',
    body: row.body || '',
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    visibility: row.visibility,
    access: row.access,
    can_manage: !!row.can_manage,
    hidden: !!row.hidden,
  };
}

function shapeLite(row) {
  const s = shape(row);
  if (!s) return s;
  const { body, ...lite } = s;
  return { ...lite, body_length: (body || '').length };
}

function sanitizeSkillDirName(name) {
  return String(name || '')
    .trim()
    .replace(/[/\\]/g, '')
    .replace(/\.\./g, '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^-+|-+$/g, '');
}

function uploadedSkillBaseName(filename) {
  return sanitizeSkillDirName(stripArchiveOrMarkdownExtension(filename));
}

function listChildDirs(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name));
}

function hasSkillMd(dir) {
  return fs.existsSync(path.join(dir, 'SKILL.md'));
}

function directSkillChildDirs(dir) {
  return listChildDirs(dir).filter((child) => hasSkillMd(child));
}

function preferredArchiveImportSource(root) {
  if (hasSkillMd(root) || directSkillChildDirs(root).length > 0) return root;

  const skillsDir = path.join(root, 'skills');
  if (directSkillChildDirs(skillsDir).length > 0) return skillsDir;

  const childDirs = listChildDirs(root).filter((child) => {
    const name = path.basename(child);
    return name !== '__MACOSX' && !name.startsWith('.');
  });
  if (childDirs.length === 1) {
    const child = childDirs[0];
    if (hasSkillMd(child) || directSkillChildDirs(child).length > 0) return child;
    const nestedSkillsDir = path.join(child, 'skills');
    if (directSkillChildDirs(nestedSkillsDir).length > 0) return nestedSkillsDir;
  }

  return root;
}

function materializeRootSkillSource({ sourceDir, uploadRoot, filename }) {
  const skillMdPath = path.join(sourceDir, 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) return sourceDir;

  let content = '';
  try { content = fs.readFileSync(skillMdPath, 'utf8'); } catch { return sourceDir; }
  const parsed = parseFrontmatter(content);
  const dirName = sanitizeSkillDirName(parsed.meta?.name || uploadedSkillBaseName(filename) || 'uploaded-skill');
  if (!dirName || path.basename(sourceDir) === dirName) return sourceDir;

  const target = safeResolveUnder(uploadRoot, dirName);
  if (!target) return sourceDir;
  removeIfExists(target);
  fs.cpSync(sourceDir, target, { recursive: true });
  return target;
}

function maybeList(body, snakeKey, camelKey) {
  if (!body || (!Object.prototype.hasOwnProperty.call(body, snakeKey) && !Object.prototype.hasOwnProperty.call(body, camelKey))) {
    return undefined;
  }
  return uniqStringList(body[snakeKey] ?? body[camelKey]);
}

function accessBody(body = {}) {
  return {
    visibility: body.visibility,
    allowUserIds: maybeList(body, 'allow_user_ids', 'allowUserIds'),
    allowGroupIds: maybeList(body, 'allow_group_ids', 'allowGroupIds'),
  };
}

function shapeSkill(row, user, lite = false) {
  const shaped = withContextAccess('skill', row, user);
  return lite ? shapeLite(shaped) : shape(shaped);
}

function visibleSkillList(user, items) {
  return filterReadableContextItems(user, 'skill', items)
    .filter((item) => !isHidden(user.id, 'skill', item.id));
}

// ---- 用户级路由 -----------------------------------------------------------
const router = express.Router();

router.get('/', auth, (req, res) => {
  res.json(Skills.listForUser(req.user.id).map((sk) => shapeSkill(sk, req.user, true)));
});

// ---- 跨用户/项目复制目录 (全员可读) --------------------------------------
// 列出全平台所有用户级 / 项目级 skill, 供「新建时从其他用户/项目复制」浏览.
// 必须定义在 GET /:id 之前, 否则 'catalog' 会被当成 skill id.
router.get('/catalog', auth, (req, res) => {
  res.json(visibleSkillList(req.user, Skills.listAll()).map((sk) => shapeSkill(sk, req.user, true)));
});

router.get('/catalog/:id', auth, (req, res) => {
  const sk = Skills.findById(req.params.id);
  if (!sk) return res.status(404).json({ error: '未找到' });
  if (!canReadContextItem(req.user, 'skill', sk) || isHidden(req.user.id, 'skill', sk.id)) {
    return res.status(404).json({ error: '未找到' });
  }
  res.json(shapeSkill(sk, req.user));
});

// 复制目录中任意一条 skill 到我的用户级 (快照模式, 与源独立).
router.post('/copy', auth, (req, res) => {
  const sourceId = (req.body?.source_id || '').trim();
  if (!sourceId) return res.status(400).json({ error: '缺少 source_id' });
  const source = Skills.findById(sourceId);
  if (!source || !canReadContextItem(req.user, 'skill', source)) return res.status(404).json({ error: '源 Skill 不可见' });
  const result = Skills.copyToScope({ sourceId, targetUserId: req.user.id });
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(shapeSkill(result.skill, req.user));
});

router.get('/:id/access', auth, (req, res) => {
  const sk = Skills.findById(req.params.id);
  if (!sk || !canReadContextItem(req.user, 'skill', sk)) return res.status(404).json({ error: '未找到' });
  res.json(contextAccessPayload('skill', sk));
});

router.patch('/:id/access', auth, (req, res) => {
  const sk = Skills.findById(req.params.id);
  if (!sk || !canManageContextItem(req.user, 'skill', sk)) return res.status(403).json({ error: '无权修改此 Skill 权限' });
  res.json(setResourcePolicy('skill', sk.id, { ...accessBody(req.body), createdBy: sk.created_by }));
});

router.post('/:id/hide', auth, (req, res) => {
  const sk = Skills.findById(req.params.id);
  if (!sk || !canReadContextItem(req.user, 'skill', sk)) return res.status(404).json({ error: '未找到' });
  setHidden(req.user.id, 'skill', sk.id, true);
  res.json({ ok: true });
});

router.post('/:id/unhide', auth, (req, res) => {
  const sk = Skills.findById(req.params.id);
  if (!sk || !canReadContextItem(req.user, 'skill', sk)) return res.status(404).json({ error: '未找到' });
  setHidden(req.user.id, 'skill', sk.id, false);
  res.json({ ok: true });
});

router.get('/:id', auth, (req, res) => {
  const sk = Skills.findById(req.params.id);
  if (!sk || sk.scope !== 'user' || !canReadContextItem(req.user, 'skill', sk)) return res.status(404).json({ error: '未找到' });
  res.json(shapeSkill(sk, req.user));
});

router.post('/', auth, async (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'skill 名称不能为空' });
  const result = await Skills.install({ userId: req.user.id, skillName: name });
  if (!result.ok) return res.status(400).json({ error: result.error, stdout: result.stdout });
  res.json(shapeSkill(result.skill, req.user));
});

// 从服务器本地绝对路径导入自制 skill (开发者自己写的 skill, 不走 Github/npx).
router.post('/import-local', auth, (req, res) => {
  const sourcePath = (req.body?.path || '').trim();
  if (!sourcePath) return res.status(400).json({ error: '请输入 skill 的服务器绝对路径' });
  const result = Skills.importLocal({ userId: req.user.id, sourcePath });
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ skills: (result.skills || []).map((sk) => shapeSkill(sk, req.user)), skipped: result.skipped || [] });
});

function skillUploadRoot({ userId, project }) {
  if (project) {
    const bindPath = (project.bind_path || '').trim();
    if (!bindPath) return { ok: false, error: '项目未绑定路径' };
    const uploadRoot = safeResolveUnder(bindPath, '.imac', 'uploaded-skills');
    if (!uploadRoot) return { ok: false, error: '项目路径非法' };
    return { ok: true, uploadRoot };
  }
  const uploadRoot = safeResolveUnder(path.join(UPLOAD_DIR, 'user-skill-imports'), `user=${userId}`);
  if (!uploadRoot) return { ok: false, error: '用户上传路径非法' };
  return { ok: true, uploadRoot };
}

function skillListForTarget({ userId, projectId }) {
  return projectId ? Skills.listForProject(projectId) : Skills.listForUser(userId);
}

function duplicateSkillReason(projectId) {
  return projectId ? '项目已存在同名 skill' : '用户级已存在同名 skill';
}

function importMarkdownSkillFile({ req, res, content, filename, projectId, project }) {
  if (!content.trim()) return res.status(400).json({ error: 'SKILL.md 内容不能为空' });
  if (Buffer.byteLength(content, 'utf8') > MAX_SKILL_UPLOAD_BYTES) {
    return res.status(413).json({ error: `SKILL.md 不能超过 ${formatBytes(MAX_SKILL_UPLOAD_BYTES)}` });
  }

  const parsed = parseFrontmatter(content);
  const requestedName = (req.body?.name || parsed.meta?.name || uploadedSkillBaseName(filename) || '').trim();
  const dirName = sanitizeSkillDirName(requestedName);
  if (!dirName) return res.status(400).json({ error: '无法从文件中确定合法的 skill 名称' });

  const existing = skillListForTarget({ userId: req.user.id, projectId }).find((skill) => {
    const id = typeof skill.id === 'string' ? skill.id : '';
    return skill.name === requestedName || id.endsWith(`:${dirName}`);
  });
  if (existing) {
    return res.json({
      ok: true,
      already_exists: true,
      source_type: 'markdown',
      skills: [shapeSkill(existing, req.user)],
      skipped: [{ name: requestedName || dirName, reason: duplicateSkillReason(projectId) }],
    });
  }

  const rootResult = skillUploadRoot({ userId: req.user.id, project });
  if (!rootResult.ok) return res.status(400).json({ error: rootResult.error });
  const uploadRoot = rootResult.uploadRoot;
  const sourceDir = safeResolveUnder(uploadRoot, dirName);
  if (!sourceDir) return res.status(400).json({ error: 'skill 名称非法' });
  const skillPath = path.join(sourceDir, 'SKILL.md');
  try {
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(skillPath, content, 'utf8');
  } catch (e) {
    return res.status(500).json({ error: `写入 SKILL.md 失败: ${e.message}` });
  }

  const result = Skills.importLocal({
    userId: req.user.id,
    projectId,
    sourcePath: sourceDir,
  });
  if (!result.ok) return res.status(400).json({ error: result.error || '导入 skill 失败' });
  return res.json({
    ok: true,
    source_type: 'markdown',
    source_path: sourceDir,
    skills: (result.skills || []).map((sk) => shapeSkill(sk, req.user)),
    skipped: result.skipped || [],
  });
}

function importArchiveSkillFile({ req, res, file, projectId, project }) {
  const rootResult = skillUploadRoot({ userId: req.user.id, project });
  if (!rootResult.ok) return res.status(400).json({ error: rootResult.error });
  const uploadRoot = rootResult.uploadRoot;
  const safeName = safeOriginalName(file.originalname, 'skill-archive');
  const stagingName = `_archive-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
  const stagingDir = safeResolveUnder(uploadRoot, stagingName);
  if (!stagingDir) return res.status(400).json({ error: '上传文件名非法' });

  try {
    fs.mkdirSync(stagingDir, { recursive: true });
    extractArchiveFile(file.path, stagingDir, { kind: detectContextFileKind(file) });
    const selectedSource = preferredArchiveImportSource(stagingDir);
    const sourcePath = materializeRootSkillSource({
      sourceDir: selectedSource,
      uploadRoot,
      filename: file.originalname,
    });
    const result = Skills.importLocal({
      userId: req.user.id,
      projectId,
      sourcePath,
    });
    if (!result.ok) return res.status(400).json({ error: result.error || '导入 skill 压缩包失败' });
    return res.json({
      ok: true,
      source_type: 'archive',
      source_path: sourcePath,
      skills: (result.skills || []).map((sk) => shapeSkill(sk, req.user)),
      skipped: result.skipped || [],
    });
  } catch (e) {
    removeIfExists(stagingDir);
    return res.status(400).json({ error: e.message || '导入 skill 压缩包失败' });
  }
}

function handleSkillFileImport(req, res, { projectId, project } = {}) {
  skillUpload.single('file')(req, res, (uploadErr) => {
    if (uploadErr) {
      const message = uploadErr.code === 'LIMIT_FILE_SIZE'
        ? `Skill 文件不能超过 ${formatBytes(MAX_SKILL_UPLOAD_BYTES)}`
        : uploadErr.message || '上传失败';
      return res.status(uploadErr.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: message });
    }

    try {
      if (req.file) {
        const kind = detectContextFileKind(req.file);
        if (kind === 'markdown') {
          const content = fs.readFileSync(req.file.path, 'utf8');
          return importMarkdownSkillFile({ req, res, content, filename: req.file.originalname, projectId, project });
        }
        if (kind === 'zip' || kind === 'tar') {
          return importArchiveSkillFile({ req, res, file: req.file, projectId, project });
        }
        return res.status(400).json({ error: '只支持上传 .md、.zip、.tar、.tar.gz、.tgz 等 Skill 文件' });
      }

      // 兼容旧前端: JSON body 直接提交 { content, filename }。
      const content = typeof req.body?.content === 'string' ? req.body.content : '';
      return importMarkdownSkillFile({ req, res, content, filename: req.body?.filename || 'SKILL.md', projectId, project });
    } finally {
      if (req.file) unlinkIfExists(req.file.path);
    }
  });
}

// 上传 SKILL.md 或 skill 压缩包, 导入为用户级 Skill。
router.post('/import-file', auth, (req, res) => {
  handleSkillFileImport(req, res);
});

router.delete('/:id', auth, (req, res) => {
  const sk = Skills.findById(req.params.id);
  if (!sk || sk.scope !== 'user' || !canManageContextItem(req.user, 'skill', sk)) return res.status(404).json({ error: '未找到' });
  Skills.delete(sk.id);
  res.json({ ok: true });
});

// 用户级 skill → 项目级 (必须指定 project_id, 校验项目存在).
router.post('/:id/move', auth, (req, res) => {
  const sk = Skills.findById(req.params.id);
  if (!sk || sk.scope !== 'user' || !canManageContextItem(req.user, 'skill', sk)) return res.status(404).json({ error: '未找到' });
  const projectId = (req.body?.project_id || '').trim();
  if (!projectId) return res.status(400).json({ error: '请选择目标项目' });
  const targetProject = Projects.findById(projectId);
  if (!targetProject || !canContributeProjectContext(req.user, targetProject)) return res.status(404).json({ error: '目标项目不存在或不可写' });
  const result = Skills.move({
    id: sk.id, requesterUserId: req.user.id, isAdmin: req.user.role === 'admin',
    targetScope: 'project', targetProjectId: projectId,
  });
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(shapeSkill(result.skill, req.user));
});

// ---- 项目级路由 (挂在 /api/projects/:projectId/skills) --------------------
const projectScoped = express.Router({ mergeParams: true });

function ensureProjectAccess(req, res) {
  const project = Projects.findById(req.params.projectId);
  if (!project) { res.status(404).json({ error: '项目未找到' }); return null; }
  if (!canReadProject(req.user, project)) { res.status(404).json({ error: '项目未找到' }); return null; }
  return { project };
}

projectScoped.get('/', auth, (req, res) => {
  const acc = ensureProjectAccess(req, res); if (!acc) return;
  res.json(visibleSkillList(req.user, Skills.listForProject(req.params.projectId)).map((sk) => shapeSkill(sk, req.user, true)));
});

// 上传 SKILL.md 或 skill 压缩包, 写入项目目录后导入为项目级 Skill.
// Markdown 适合单文件 skill; 压缩包适合携带 scripts/assets/templates 等资源文件, 也支持批量导入多个 skill 子目录。
projectScoped.post('/import-file', auth, (req, res) => {
  const acc = ensureProjectAccess(req, res); if (!acc) return;
  if (!canContributeProjectContext(req.user, acc.project)) return res.status(403).json({ error: '无权向此项目导入 Skill' });
  handleSkillFileImport(req, res, { projectId: req.params.projectId, project: acc.project });
});

projectScoped.get('/:id/access', auth, (req, res) => {
  const acc = ensureProjectAccess(req, res); if (!acc) return;
  const sk = Skills.findById(req.params.id);
  if (!sk || sk.scope !== 'project' || sk.owner_id !== req.params.projectId || !canReadContextItem(req.user, 'skill', sk)) {
    return res.status(404).json({ error: '未找到' });
  }
  res.json(contextAccessPayload('skill', sk));
});

projectScoped.patch('/:id/access', auth, (req, res) => {
  const acc = ensureProjectAccess(req, res); if (!acc) return;
  const sk = Skills.findById(req.params.id);
  if (!sk || sk.scope !== 'project' || sk.owner_id !== req.params.projectId || !canManageContextItem(req.user, 'skill', sk)) {
    return res.status(403).json({ error: '无权修改此 Skill 权限' });
  }
  res.json(setResourcePolicy('skill', sk.id, { ...accessBody(req.body), createdBy: sk.created_by }));
});

projectScoped.post('/:id/hide', auth, (req, res) => {
  const acc = ensureProjectAccess(req, res); if (!acc) return;
  const sk = Skills.findById(req.params.id);
  if (!sk || sk.scope !== 'project' || sk.owner_id !== req.params.projectId || !canReadContextItem(req.user, 'skill', sk)) {
    return res.status(404).json({ error: '未找到' });
  }
  setHidden(req.user.id, 'skill', sk.id, true);
  res.json({ ok: true });
});

projectScoped.post('/:id/unhide', auth, (req, res) => {
  const acc = ensureProjectAccess(req, res); if (!acc) return;
  const sk = Skills.findById(req.params.id);
  if (!sk || sk.scope !== 'project' || sk.owner_id !== req.params.projectId || !canReadContextItem(req.user, 'skill', sk)) {
    return res.status(404).json({ error: '未找到' });
  }
  setHidden(req.user.id, 'skill', sk.id, false);
  res.json({ ok: true });
});

projectScoped.get('/:id', auth, (req, res) => {
  const acc = ensureProjectAccess(req, res); if (!acc) return;
  const sk = Skills.findById(req.params.id);
  if (!sk || sk.scope !== 'project' || sk.owner_id !== req.params.projectId) return res.status(404).json({ error: '未找到' });
  if (!canReadContextItem(req.user, 'skill', sk) || isHidden(req.user.id, 'skill', sk.id)) return res.status(404).json({ error: '未找到' });
  res.json(shapeSkill(sk, req.user));
});

projectScoped.post('/', auth, async (req, res) => {
  const acc = ensureProjectAccess(req, res); if (!acc) return;
  if (!canContributeProjectContext(req.user, acc.project)) return res.status(403).json({ error: '无权向此项目添加 Skill' });
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'skill 名称不能为空' });
  const result = await Skills.install({
    userId: req.user.id, projectId: req.params.projectId, skillName: name,
  });
  if (!result.ok) return res.status(400).json({ error: result.error, stdout: result.stdout });
  res.json(shapeSkill(result.skill, req.user));
});

// 从服务器本地绝对路径导入自制 skill 到本项目级 (跨用户合并展示).
projectScoped.post('/import-local', auth, (req, res) => {
  const acc = ensureProjectAccess(req, res); if (!acc) return;
  if (!canContributeProjectContext(req.user, acc.project)) return res.status(403).json({ error: '无权向此项目导入 Skill' });
  const sourcePath = (req.body?.path || '').trim();
  if (!sourcePath) return res.status(400).json({ error: '请输入 skill 的服务器绝对路径' });
  const result = Skills.importLocal({
    userId: req.user.id, projectId: req.params.projectId, sourcePath,
  });
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ skills: (result.skills || []).map((sk) => shapeSkill(sk, req.user)), skipped: result.skipped || [] });
});

// 复制目录中任意一条 skill 到本项目 (快照模式).
projectScoped.post('/copy', auth, (req, res) => {
  const acc = ensureProjectAccess(req, res); if (!acc) return;
  if (!canContributeProjectContext(req.user, acc.project)) return res.status(403).json({ error: '无权向此项目复制 Skill' });
  const sourceId = (req.body?.source_id || '').trim();
  if (!sourceId) return res.status(400).json({ error: '缺少 source_id' });
  const source = Skills.findById(sourceId);
  if (!source || !canReadContextItem(req.user, 'skill', source)) return res.status(404).json({ error: '源 Skill 不可见' });
  const result = Skills.copyToScope({
    sourceId, targetUserId: req.user.id, targetProjectId: req.params.projectId,
  });
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(shapeSkill(result.skill, req.user));
});

projectScoped.delete('/:id', auth, (req, res) => {
  const acc = ensureProjectAccess(req, res); if (!acc) return;
  const sk = Skills.findById(req.params.id);
  if (!sk || sk.scope !== 'project' || sk.owner_id !== req.params.projectId) return res.status(404).json({ error: '未找到' });
  if (!canManageContextItem(req.user, 'skill', sk)) return res.status(403).json({ error: '无权删除此项目级 Skill' });
  Skills.delete(sk.id);
  res.json({ ok: true });
});

// 项目级 skill → 用户级 (回到自己的 default_project); 也支持跨项目搬迁 (传 target_project_id).
// 默认搬到当前用户的用户级.
projectScoped.post('/:id/move', auth, (req, res) => {
  const acc = ensureProjectAccess(req, res); if (!acc) return;
  const sk = Skills.findById(req.params.id);
  if (!sk || sk.scope !== 'project' || sk.owner_id !== req.params.projectId) return res.status(404).json({ error: '未找到' });
  const isAdmin = req.user.role === 'admin';
  if (!canManageContextItem(req.user, 'skill', sk)) return res.status(403).json({ error: '无权移动此项目级 Skill' });

  const targetScope = (req.body?.scope || 'user').trim();
  let targetProjectId = (req.body?.project_id || '').trim() || null;
  if (targetScope === 'project') {
    if (!targetProjectId) return res.status(400).json({ error: '请选择目标项目' });
    const targetProject = Projects.findById(targetProjectId);
    if (!targetProject || !canContributeProjectContext(req.user, targetProject)) return res.status(404).json({ error: '目标项目不存在或不可写' });
  } else {
    targetProjectId = null;
  }
  const result = Skills.move({
    id: sk.id, requesterUserId: req.user.id, isAdmin,
    targetScope, targetProjectId,
  });
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json(shapeSkill(result.skill, req.user));
});

module.exports = { router, projectScoped };
