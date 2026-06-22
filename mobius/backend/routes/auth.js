const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { JWT_SECRET, ENABLE_PASSWORD_LOGIN, BRANDING } = require('../config');
const { auth } = require('../middleware/auth');
const { Users } = require('../repositories/users');
const { db } = require('../../db');

const router = express.Router();

router.get('/config', (req, res) => {
  res.json({ password_required: ENABLE_PASSWORD_LOGIN });
});

// 全站品牌显示配置 (顶部 Logo / 系统名称 / Tab 标题). 由 .env 注入, 任何客户端
// (含未登录的登录页) 都可读取, 用于首屏渲染前同步注入避免闪烁. 不接受 PUT.
router.get('/branding', (req, res) => {
  res.json({
    hideLogo: BRANDING.hideLogo === true,
    systemNameZh: BRANDING.systemNameZh,
    systemNameEn: BRANDING.systemNameEn,
  });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username) return res.status(400).json({ error: 'Missing credentials' });
  if (ENABLE_PASSWORD_LOGIN && !password) return res.status(400).json({ error: 'Missing credentials' });

  const user = Users.findById(username);
  if (!user) return res.status(401).json({ error: 'User not found' });
  if (ENABLE_PASSWORD_LOGIN && !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Wrong password' });
  }

  const token = jwt.sign(
    { id: user.id, display_name: user.display_name, role: user.role, work_dir: user.work_dir },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  res.json({ token, user: { id: user.id, display_name: user.display_name, role: user.role, work_dir: user.work_dir } });
});

router.get('/me', auth, (req, res) => {
  res.json(req.user);
});

// 资源访问面板 (项目权限 / Skill 权限 / Memory 权限) 的 user picker 需要
// 一个轻量查询接口: 输入关键字返回匹配的活跃用户 {id, display_name, role}.
// 仅返回最少字段, 严格按关键字前缀匹配, 上限 12 条, 避免被滥用为用户列表枚举.
router.get('/user-search', auth, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);
  const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
  const rows = db.prepare(`
    SELECT id, display_name, role
    FROM users
    WHERE (deleted_at IS NULL OR deleted_at = '')
      AND (id LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')
    ORDER BY
      CASE WHEN id = ? COLLATE NOCASE THEN 0
           WHEN display_name = ? COLLATE NOCASE THEN 1
           ELSE 2 END ASC,
      display_name ASC, id ASC
    LIMIT 12
  `).all(like, like, q, q);
  res.json(rows);
});

// user picker 解析已选 ID 时使用: 一次查一组 ID 对应的 {id, display_name, role}.
// 上限 64 个, 多余截断; 重复去空, 缺失自动跳过.
router.post('/users-by-id', auth, (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return res.json([]);
  const cleaned = Array.from(new Set(
    ids.map((x) => String(x || '').trim()).filter(Boolean)
  )).slice(0, 64);
  if (!cleaned.length) return res.json([]);
  const placeholders = cleaned.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT id, display_name, role
    FROM users
    WHERE id IN (${placeholders}) AND (deleted_at IS NULL OR deleted_at = '')
  `).all(...cleaned);
  res.json(rows);
});

router.post('/change-password', auth, (req, res) => {
  const { old_password, new_password } = req.body;
  if (!old_password || !new_password) return res.status(400).json({ error: '请填写完整' });
  if (new_password.length < 6) return res.status(400).json({ error: '新密码至少 6 位' });

  const user = Users.findById(req.user.id);
  if (!user || !bcrypt.compareSync(old_password, user.password_hash)) {
    return res.status(401).json({ error: '原密码错误' });
  }
  Users.updatePassword(req.user.id, bcrypt.hashSync(new_password, 10));
  res.json({ ok: true });
});

module.exports = router;
