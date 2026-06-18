const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { auth, downloadAuth } = require('../middleware/auth');
const { Projects } = require('../repositories/projects');
const { canReadProject } = require('../services/access-control');
const {
  APP_DIR,
  UPLOAD_DIR,
  SHARED_SKILL_LIBRARY_DIR,
  SHARED_SKILL_BACKUP_DIR,
  EXTENSION_DATA_ROOT,
} = require('../config');

const router = express.Router();
const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 50 * 1024 * 1024 } });

// scope=shared 时切到 shared-skill-library, 否则用户自己的 work_dir
function getFileRoot(req) {
  return req.query.scope === 'shared' ? SHARED_SKILL_LIBRARY_DIR : req.user.work_dir;
}

// 解析 path query 到绝对路径并做 root 越界检查
function resolveScopedPath(req, rawPath = '/') {
  const root = path.resolve(getFileRoot(req));
  const relPath = String(rawPath || '/').replace(/\.\./g, '');
  const absPath = path.resolve(root, relPath.replace(/^\//, ''));
  if (absPath !== root && !absPath.startsWith(root + path.sep)) {
    return { error: 'Access denied' };
  }
  return { root, relPath, absPath };
}

function isSharedSkillPath(absPath) {
  const resolved = path.resolve(absPath);
  const root = path.resolve(SHARED_SKILL_LIBRARY_DIR);
  return resolved === root || resolved.startsWith(root + path.sep);
}

function isExtensionUserDataPath(absPath, userId) {
  const resolved = path.resolve(absPath);
  const root = path.resolve(EXTENSION_DATA_ROOT);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const parts = rel.split(path.sep);
  return parts.length >= 4 && parts[1] === 'users' && parts[2] === String(userId);
}

function isMobiusUploadPath(absPath) {
  const resolved = path.resolve(absPath);
  const root = path.resolve(APP_DIR, '.imac', 'upload');
  return resolved === root || resolved.startsWith(root + path.sep);
}

function canDownloadPath(req, absPath) {
  const userRoot = path.resolve(req.user.work_dir);
  return absPath === userRoot
    || absPath.startsWith(userRoot + path.sep)
    || isSharedSkillPath(absPath)
    || isExtensionUserDataPath(absPath, req.user.id)
    || isMobiusUploadPath(absPath);
}

// 编辑前自动备份: 落到 SHARED_SKILL_BACKUP_DIR/<timestamp>/<相对路径>
function backupSharedSkillFile(absPath) {
  if (!isSharedSkillPath(absPath) || !fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) return;
  const rel = path.relative(SHARED_SKILL_LIBRARY_DIR, absPath);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(SHARED_SKILL_BACKUP_DIR, stamp, rel);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  fs.copyFileSync(absPath, backupPath);
}

router.post('/upload', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const tempPath = req.file.path;
  const cleanupTemp = () => { try { fs.unlinkSync(tempPath); } catch {} };

  const projectId = String(req.query.project_id || req.body?.project_id || '').trim();
  let uploadDir;
  if (projectId) {
    const project = Projects.findById(projectId);
    if (!project) { cleanupTemp(); return res.status(404).json({ error: '项目未找到' }); }
    if (!canReadProject(req.user, project)) { cleanupTemp(); return res.status(403).json({ error: '无权访问此项目' }); }
    const bindPath = (project.bind_path || '').trim();
    if (!bindPath) { cleanupTemp(); return res.status(400).json({ error: '项目未配置 bind_path' }); }
    uploadDir = path.join(bindPath, '.imac', 'upload');
  } else {
    uploadDir = path.join(req.user.work_dir, 'uploads');
  }
  fs.mkdirSync(uploadDir, { recursive: true });

  // 文件名 = 毫秒时间戳 + 原扩展名. 同毫秒并发再追加 _<n> 避免覆盖.
  const ext = path.extname(req.file.originalname) || '';
  const baseTs = Date.now();
  let dest = path.join(uploadDir, `${baseTs}${ext}`);
  let suffix = 1;
  while (fs.existsSync(dest)) {
    dest = path.join(uploadDir, `${baseTs}_${suffix}${ext}`);
    suffix += 1;
  }

  fs.copyFileSync(tempPath, dest);
  cleanupTemp();
  res.json({ path: dest, name: req.file.originalname, size: req.file.size });
});

router.get('/download', downloadAuth, (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'Path required' });
  const absPath = path.resolve(filePath);
  if (!canDownloadPath(req, absPath)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (!fs.existsSync(absPath)) return res.status(404).json({ error: 'Not found' });
  res.download(absPath);
});

router.get('/files/download', downloadAuth, (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'Path required' });
  const absPath = path.resolve(filePath);
  if (!canDownloadPath(req, absPath)) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (!fs.existsSync(absPath)) return res.status(404).json({ error: 'Not found' });
  res.download(absPath);
});

router.get('/files', auth, (req, res) => {
  const resolved = resolveScopedPath(req, req.query.path || '/');
  if (resolved.error) return res.status(403).json({ error: resolved.error });
  const { relPath, absPath } = resolved;
  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isDirectory()) return res.status(404).json({ error: 'Not found' });
  try {
    const entries = fs.readdirSync(absPath, { withFileTypes: true })
      .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
      .map(e => {
        const stat = fs.statSync(path.join(absPath, e.name));
        return { name: e.name, type: e.isDirectory() ? 'dir' : 'file', size: e.isFile() ? stat.size : null, modified: stat.mtime };
      })
      .sort((a, b) => a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name));
    res.json({ path: relPath, entries });
  } catch {
    res.status(500).json({ error: 'Read failed' });
  }
});

// POST /api/files/mkdir  body: { path: "/sub/dir" }
// 在用户 work_dir 下创建目录(递归)。已存在则视为成功。
router.post('/files/mkdir', auth, (req, res) => {
  const { path: rawPath } = req.body || {};
  if (!rawPath || typeof rawPath !== 'string') return res.status(400).json({ error: 'Path required' });
  if (rawPath === '/' || rawPath === '') return res.status(400).json({ error: '请输入目录名' });
  const resolved = resolveScopedPath(req, rawPath);
  if (resolved.error) return res.status(403).json({ error: resolved.error });
  const { absPath, relPath } = resolved;
  try {
    if (fs.existsSync(absPath)) {
      if (!fs.statSync(absPath).isDirectory()) return res.status(400).json({ error: '同名文件已存在' });
    } else {
      fs.mkdirSync(absPath, { recursive: true });
    }
    res.json({ ok: true, path: relPath });
  } catch {
    res.status(500).json({ error: '创建失败' });
  }
});

router.get('/files/read', auth, (req, res) => {
  const resolved = resolveScopedPath(req, req.query.path || '');
  if (resolved.error) return res.status(403).json({ error: resolved.error });
  const { absPath } = resolved;
  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) return res.status(404).json({ error: 'Not found' });
  const stat = fs.statSync(absPath);
  const ext = path.extname(absPath).toLowerCase();
  const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico'];
  if (imageExts.includes(ext)) {
    return res.json({ type: 'image', url: `/api/download?path=${encodeURIComponent(absPath)}`, size: stat.size, ext });
  }
  if (stat.size > 1024 * 1024) return res.status(413).json({ error: 'File too large (>1MB)' });
  try {
    const content = fs.readFileSync(absPath, 'utf8');
    res.json({ type: 'text', content, size: stat.size, ext });
  } catch {
    res.status(500).json({ error: 'Read failed' });
  }
});

// PUT /api/files/write?scope=shared
// 仅允许编辑 shared-skill-library 内文件 (用户自己的 workspace 上传走 /upload),
// 写入前自动备份原文件到 SHARED_SKILL_BACKUP_DIR
router.put('/files/write', auth, (req, res) => {
  if (req.query.scope !== 'shared') {
    return res.status(403).json({ error: 'Only shared skill library files are editable here' });
  }
  if (!(req.user?.role === 'admin')) {
    return res.status(403).json({ error: 'Only admin can edit shared skill library files' });
  }
  const { path: filePath, content } = req.body || {};
  if (!filePath || typeof content !== 'string') return res.status(400).json({ error: 'Path and content required' });
  const resolved = resolveScopedPath(req, filePath);
  if (resolved.error) return res.status(403).json({ error: resolved.error });
  const { absPath } = resolved;
  if (fs.existsSync(absPath) && !fs.statSync(absPath).isFile()) return res.status(400).json({ error: 'Not a file' });
  if (Buffer.byteLength(content, 'utf8') > 1024 * 1024) return res.status(413).json({ error: 'File too large (>1MB)' });
  try {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    backupSharedSkillFile(absPath);
    fs.writeFileSync(absPath, content, 'utf8');
    const stat = fs.statSync(absPath);
    res.json({ ok: true, path: filePath, size: stat.size, modified: stat.mtime });
  } catch {
    res.status(500).json({ error: 'Write failed' });
  }
});

module.exports = router;
