const express = require('express');
const { v4: uuid } = require('uuid');
const { auth } = require('../middleware/auth');
const { Sessions } = require('../repositories/sessions');
const { Issues } = require('../repositories/issues');
const { Projects } = require('../repositories/projects');
const { Changes, Conflicts, Queue } = require('../repositories/changes');
const { audit } = require('../repositories/audit');
const {
  canManageIssue,
  canOperateSession,
  canReadIssue,
  canReadProject,
  canReadSession,
} = require('../services/access-control');
const {
  scanSessionChange,
  recomputeProjectConflicts,
  refreshIssueIntegration,
  changePayload,
  integrateIssue,
} = require('../services/change-scan');

const router = express.Router();

function getVisibleSession(req, sessionId) {
  const session = Sessions.findByIdWithJoins(sessionId);
  if (!session) return null;
  if (!canReadSession(req.user, session)) return null;
  return session;
}

function getOperableSession(req, sessionId) {
  const session = Sessions.findByIdWithJoins(sessionId);
  if (!session) return null;
  if (!canOperateSession(req.user, session)) return null;
  return session;
}

// ===== /api/sessions/:id/changes =====
router.get('/sessions/:id/changes', auth, (req, res) => {
  const session = getVisibleSession(req, req.params.id);
  if (!session) return res.status(404).json({ error: '未找到' });
  const change = Changes.findIdBySession(req.params.id);
  res.json(change ? changePayload(change.id) : null);
});

router.post('/sessions/:id/changes/scan', auth, (req, res) => {
  const session = getOperableSession(req, req.params.id);
  if (!session) return res.status(404).json({ error: '未找到' });
  res.json(scanSessionChange(req, session, req.body?.files || []));
});

router.post('/sessions/:id/changes/check', auth, (req, res) => {
  const session = getOperableSession(req, req.params.id);
  if (!session) return res.status(404).json({ error: '未找到' });
  const payload = scanSessionChange(req, session, req.body?.files || []);
  const hasBlocking = payload.conflicts.some(c => c.severity === 'blocking');
  const checkStatus = hasBlocking ? 'failed' : 'passed';
  const detail = hasBlocking ? '存在阻塞冲突, 需要先消解或管理员忽略。' : '观测检查通过: 未发现阻塞冲突。';
  Changes.setCheckResult(payload.id, checkStatus, detail, hasBlocking ? 'conflict' : 'ready');
  refreshIssueIntegration(session.issue_id);
  audit(req.user.id, 'check_session_change', 'session', session.session_id, detail);
  res.json(changePayload(payload.id));
});

// ===== /api/issues/:id/integration =====
router.get('/issues/:id/integration', auth, (req, res) => {
  const issue = Issues.findById(req.params.id);
  if (!issue || !canReadIssue(req.user, issue)) return res.status(404).json({ error: '未找到' });
  const integration = refreshIssueIntegration(issue.id);
  const changes = Changes.forIssueWithUser(issue.id).map(c => changePayload(c.id));
  res.json({ issue, integration, changes });
});

router.post('/issues/:id/integration/check', auth, (req, res) => {
  const issue = Issues.findById(req.params.id);
  if (!issue || !canManageIssue(req.user, issue)) return res.status(404).json({ error: '未找到' });
  const sessions = Sessions.listActiveByIssue(issue.id);
  for (const session of sessions) scanSessionChange(req, session, []);
  const integration = refreshIssueIntegration(issue.id);
  audit(req.user.id, 'check_issue_integration', 'issue', issue.id, `status=${integration?.status}`);
  res.json({
    issue,
    integration,
    changes: sessions.map(s => Changes.findIdBySession(s.session_id)).filter(Boolean).map(c => changePayload(c.id)),
  });
});

router.post('/issues/:id/integration/accept', auth, (req, res) => {
  const issue = Issues.findById(req.params.id);
  if (!issue || !canManageIssue(req.user, issue)) return res.status(404).json({ error: '未找到' });
  let integration = refreshIssueIntegration(issue.id);
  const canAccept = integration && integration.internal_conflict_count === 0 && integration.build_status !== 'failed';
  // setAcceptance signature: (issueId, acceptance, status, releaseNote)
  const { IssueIntegrations } = require('../repositories/issues');
  IssueIntegrations.setAcceptance(
    issue.id,
    canAccept ? 'passed' : 'failed',
    canAccept ? 'ready' : 'blocked',
    req.body?.release_note || null
  );
  integration = refreshIssueIntegration(issue.id);
  audit(req.user.id, 'accept_issue', 'issue', issue.id, canAccept ? 'passed' : 'failed');
  res.json({ issue, integration });
});

router.post('/issues/:id/integration/enqueue', auth, (req, res) => {
  const issue = Issues.findById(req.params.id);
  if (!issue || !canManageIssue(req.user, issue)) return res.status(404).json({ error: '未找到' });
  const integration = refreshIssueIntegration(issue.id);
  const maxPriority = Queue.maxPriority(issue.project_id);
  const status = integration?.status === 'ready' ? 'queued' : 'blocked';
  const reason = status === 'queued' ? '' : 'Issue 尚未验收通过或存在阻塞冲突';
  Queue.upsert({
    id: uuid().slice(0, 12),
    projectId: issue.project_id,
    issueId: issue.id,
    priority: maxPriority + 1,
    status,
    reason,
  });
  audit(req.user.id, 'enqueue_issue', 'issue', issue.id, status);
  res.json({ ok: true, status, reason });
});

// ===== /api/projects/:id/integration-queue =====
router.get('/projects/:id/integration-queue', auth, (req, res) => {
  const project = Projects.findById(req.params.id);
  if (!project || !canReadProject(req.user, project)) return res.status(404).json({ error: '未找到' });
  recomputeProjectConflicts(project.id);
  res.json({
    project,
    metrics: Queue.projectMetrics(project.id),
    queue: Queue.listForProject(project.id),
    issues: Queue.issuesWithIntegrationForProject(project.id),
  });
});

router.post('/projects/:id/integration-queue/reorder', auth, (req, res) => {
  const project = Projects.findById(req.params.id);
  if (!project || req.user.role !== 'admin') return res.status(404).json({ error: '未找到或无权限' });
  const issueIds = Array.isArray(req.body?.issue_ids) ? req.body.issue_ids : [];
  Queue.reorder(project.id, issueIds);
  audit(req.user.id, 'reorder_queue', 'project', project.id, issueIds.join(','));
  res.json({ ok: true });
});

router.post('/projects/:id/integration-queue/run', auth, (req, res) => {
  const project = Projects.findById(req.params.id);
  if (!project || req.user.role !== 'admin') return res.status(404).json({ error: '未找到或无权限' });
  const selected = Array.isArray(req.body?.issue_ids) ? req.body.issue_ids : [];
  const queue = Queue.queuedIssueIds(project.id).filter(id => selected.length === 0 || selected.includes(id));
  const results = queue.map(issueId => ({ issue_id: issueId, ...integrateIssue(req, issueId) }));
  res.json({ results });
});

// ===== /api/conflicts =====
router.get('/conflicts', auth, (req, res) => {
  const projectId = req.query.project_id;
  const project = projectId ? Projects.findById(projectId) : null;
  if (!project || !canReadProject(req.user, project)) return res.status(404).json({ error: '未找到' });
  recomputeProjectConflicts(projectId);
  res.json(Conflicts.listForProject(projectId));
});

router.patch('/conflicts/:id', auth, (req, res) => {
  const conflict = Conflicts.findByIdJoined(req.params.id);
  if (!conflict || req.user.role !== 'admin') return res.status(404).json({ error: '未找到或无权限' });
  const status = ['open', 'resolved', 'ignored'].includes(req.body?.status) ? req.body.status : conflict.status;
  const note = req.body?.resolution_note || '';
  Conflicts.updateStatus(conflict.id, status, note);
  refreshIssueIntegration(conflict.left_issue_id);
  refreshIssueIntegration(conflict.right_issue_id);
  audit(req.user.id, 'update_conflict', 'conflict', conflict.id, `${status}: ${note}`);
  res.json(Conflicts.findById(conflict.id));
});

module.exports = router;
