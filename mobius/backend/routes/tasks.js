const express = require('express');
const { v4: uuid } = require('uuid');
const { auth } = require('../middleware/auth');
const { Sessions } = require('../repositories/sessions');
const { Messages } = require('../repositories/messages');
const { withSessionProxyState, withSessionProxyStates } = require('../services/session-proxy-state');
const { canOperateSession, canReadSession } = require('../services/access-control');

const router = express.Router();

function findSessionReadable(id, user) {
  const session = Sessions.findById(id);
  return session && canReadSession(user, session) ? session : null;
}

function findSessionOperable(id, user) {
  const session = Sessions.findById(id);
  return session && canOperateSession(user, session) ? session : null;
}

router.get('/', auth, (req, res) => {
  res.json(withSessionProxyStates(Sessions.listForUser(req.user.id)));
});

router.post('/', auth, (req, res) => {
  const { name, description, issue_id } = req.body;
  if (!name) return res.status(400).json({ error: '请填写任务名称' });

  const sessionId = uuid().slice(0, 8);
  const sessionKey = `web:${req.user.id}:${sessionId}`;
  const targetIssue = issue_id || '__default_issue__';

  Sessions.insert({
    session_id: sessionId,
    issue_id: targetIssue,
    user_id: req.user.id,
    name,
    description,
    session_key: sessionKey,
  });
  res.json(withSessionProxyState(Sessions.findById(sessionId)));
});

router.get('/:id', auth, (req, res) => {
  const session = findSessionReadable(req.params.id, req.user);
  if (!session) return res.status(404).json({ error: '未找到' });
  res.json(withSessionProxyState(session));
});

router.patch('/:id', auth, (req, res) => {
  const session = findSessionOperable(req.params.id, req.user);
  if (!session) return res.status(404).json({ error: '未找到' });

  const { name, status, description, risk_level } = req.body;
  if (name) Sessions.updateName(req.params.id, name);
  if (status) {
    if (status === 'deleted') {
      return res.status(400).json({ error: 'Session 删除请使用 DELETE；删除后不会进入回收站' });
    }
    if (session.scope_type === 'research' && ['deleted', 'archived'].includes(status)) {
      return res.status(400).json({ error: 'Research Session 创建后不能删除或归档' });
    }
    Sessions.updateStatus(req.params.id, status);
  }
  if (description !== undefined) Sessions.updateDescription(req.params.id, description);
  if (risk_level && ['medium', 'low'].includes(risk_level)) Sessions.updateRiskLevel(req.params.id, risk_level);

  res.json(withSessionProxyState(Sessions.findById(req.params.id)));
});

router.delete('/:id', auth, (req, res) => {
  const session = findSessionOperable(req.params.id, req.user);
  if (!session) return res.status(404).json({ error: '未找到' });
  if (session.scope_type === 'research') {
    return res.status(400).json({ error: 'Research Session 创建后不能删除；如需暂停执行，请使用“终止”按钮' });
  }
  Sessions.archive(req.params.id);
  res.json({ ok: true });
});

router.post('/:id/restore', auth, (req, res) => {
  const session = findSessionOperable(req.params.id, req.user);
  if (!session) return res.status(404).json({ error: '未找到' });
  Sessions.restoreFromArchive(req.params.id);
  res.json({ ok: true, session: withSessionProxyState(Sessions.findById(req.params.id)) });
});

router.delete('/:id/permanent', auth, (req, res) => {
  const session = findSessionOperable(req.params.id, req.user);
  if (!session) return res.status(404).json({ error: '未找到' });
  if (session.scope_type === 'research') return res.status(400).json({ error: 'Research Session 不能永久删除' });
  Sessions.permanentDelete(req.params.id);
  res.json({ ok: true });
});

router.get('/:id/messages', auth, (req, res) => {
  const session = findSessionReadable(req.params.id, req.user);
  if (!session) return res.status(404).json({ error: '未找到' });
  res.json(Messages.recentForTask(req.params.id, req.query.limit));
});

router.get('/:id/bookmarks', auth, (req, res) => {
  const task = findSessionReadable(req.params.id, req.user);
  if (!task) return res.status(404).json({ error: 'Not found' });
  res.json(Messages.bookmarksForTask(req.params.id));
});

// no-auth: wrapper/hooks 查询用
router.get('/:id/risk', (req, res) => {
  const task = Sessions.findRiskById(req.params.id);
  res.json({ risk_level: task ? task.risk_level : 'medium' });
});

module.exports = router;
