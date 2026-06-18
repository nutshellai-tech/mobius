const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const { auth, downloadAuth } = require('../middleware/auth');
const { Researches } = require('../repositories/researches');
const { Projects } = require('../repositories/projects');
const { Sessions } = require('../repositories/sessions');
const modelRegistry = require('../services/model-registry');
const modelPromptLimits = require('../services/model-prompt-limits');
const {
  buildResearchContextPreview,
  buildResearchSelectionDefaults,
  buildResearchSessionSelectionSnapshot,
} = require('../services/session-context');
const { appendBlackboardRecord, normalizeWriteInput, readBlackboard } = require('../services/research-blackboard');
const { readGraph, resolveGraphImage } = require('../services/research-graph');
const { withSessionProxyState } = require('../services/session-proxy-state');
const { flagDirOf, runningFlagPathOf, failedFlagPathOf } = require('../utils/session-flags');
const {
  accessPayload,
  canCreateIssue,
  canCreateSessionForResearch,
  canManageResearch,
  canReadProject,
  canReadResearch,
  canReadSession,
  normalizeVisibility,
  setResourcePolicy,
  uniqStringList,
} = require('../services/access-control');
const { recordAdminAuditIfCrossUser } = require('../services/admin-audit');

const router = express.Router();
const projectScoped = express.Router({ mergeParams: true });
const researchScoped = express.Router({ mergeParams: true });
const blackboardRouter = express.Router();
const graphRouter = express.Router();

function readJobFlagState(root, sessionId) {
  const hasFlagDir = fs.existsSync(flagDirOf(root, sessionId));
  return {
    accomplished: hasFlagDir ? !fs.existsSync(runningFlagPathOf(root, sessionId)) : false,
    failed: hasFlagDir ? fs.existsSync(failedFlagPathOf(root, sessionId)) : false,
  };
}

function sanitizeIds(arr) {
  return Array.isArray(arr) ? arr.filter(x => typeof x === 'string' && x.length > 0) : [];
}

function toIdList(v) {
  if (Array.isArray(v)) return v.map(s => String(s).trim()).filter(Boolean);
  if (typeof v === 'string' && v.length > 0) return v.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

function maybeList(body, snakeKey, camelKey) {
  if (!body || (!Object.prototype.hasOwnProperty.call(body, snakeKey) && !Object.prototype.hasOwnProperty.call(body, camelKey))) {
    return undefined;
  }
  return uniqStringList(body[snakeKey] ?? body[camelKey]);
}

function researchAccessBody(body = {}) {
  return {
    visibility: body.visibility,
    allowUserIds: maybeList(body, 'allow_user_ids', 'allowUserIds'),
    allowGroupIds: maybeList(body, 'allow_group_ids', 'allowGroupIds'),
  };
}

function shapeResearchForUser(research, user) {
  if (!research) return research;
  const visibility = normalizeVisibility(research.visibility, 'inherit', true);
  return {
    ...research,
    visibility,
    access: accessPayload('research', research.id, visibility),
    can_manage: canManageResearch(user, research),
  };
}

function auditResearchAccess(user, action, research) {
  if (!research) return;
  const project = Projects.findById(research.project_id);
  recordAdminAuditIfCrossUser(
    user,
    action,
    'research',
    research.id,
    research.created_by || project?.created_by,
  );
}

projectScoped.get('/', auth, (req, res) => {
  const project = Projects.findById(req.params.projectId);
  if (!project) return res.status(404).json({ error: '未找到' });
  if (!canReadProject(req.user, project)) return res.status(404).json({ error: '未找到' });
  if (!project.research_enabled) return res.json([]);
  const researches = Researches.listForProject(req.params.projectId, req.query.status)
    .filter((research) => canReadResearch(req.user, research))
  if (req.user?.role === 'admin' && project.created_by !== req.user.id) {
    recordAdminAuditIfCrossUser(req.user, 'list_researches', 'project', project.id, project.created_by);
  }
  res.json(researches.map((research) => shapeResearchForUser(research, req.user)));
});

projectScoped.post('/', auth, (req, res) => {
  const project = Projects.findById(req.params.projectId);
  if (!project) return res.status(404).json({ error: '未找到' });
  if (!canCreateIssue(req.user, project)) return res.status(403).json({ error: '无权在此项目创建 Research' });
  if (!project.research_enabled) return res.status(400).json({ error: '当前项目未启用 Research 系统' });
  const { title, description } = req.body;
  if (!title) return res.status(400).json({ error: '请填写 Research 标题' });
  if (!description) return res.status(400).json({ error: '请填写 Research 描述' });
  const researchId = uuid().slice(0, 8);
  Researches.insert({
    id: researchId,
    project_id: req.params.projectId,
    title,
    description,
    created_by: req.user.id,
    visibility: normalizeVisibility(req.body?.visibility, 'inherit', true),
  });
  recordAdminAuditIfCrossUser(req.user, 'create_research', 'project', project.id, project.created_by);
  if (req.body?.visibility !== undefined
    || req.body?.allow_user_ids !== undefined || req.body?.allowUserIds !== undefined
    || req.body?.allow_group_ids !== undefined || req.body?.allowGroupIds !== undefined) {
    setResourcePolicy('research', researchId, { ...researchAccessBody(req.body), createdBy: req.user.id });
  }
  res.json(shapeResearchForUser(Researches.findById(researchId), req.user));
});

router.get('/:id', auth, (req, res) => {
  const research = Researches.findById(req.params.id);
  if (!research) return res.status(404).json({ error: '未找到' });
  if (!canReadResearch(req.user, research)) return res.status(404).json({ error: '未找到' });
  auditResearchAccess(req.user, 'read_research', research);
  res.json(shapeResearchForUser(research, req.user));
});

router.patch('/:id', auth, (req, res) => {
  const research = Researches.findById(req.params.id);
  if (!research) return res.status(404).json({ error: '未找到' });
  if (!canManageResearch(req.user, research)) return res.status(403).json({ error: '无权修改此 Research' });
  auditResearchAccess(req.user, 'write_research', research);
  const { title, description, status, pinned, visibility } = req.body;
  if (title) Researches.updateTitle(req.params.id, title);
  if (description !== undefined) Researches.updateDescription(req.params.id, description);
  if (status && ['active', 'completed'].includes(status)) Researches.updateStatus(req.params.id, status);
  if (typeof pinned === 'boolean') Researches.updatePinned(req.params.id, pinned);
  if (visibility !== undefined) {
    const nextVisibility = normalizeVisibility(visibility, 'inherit', true);
    Researches.updateVisibility(req.params.id, nextVisibility);
    setResourcePolicy('research', req.params.id, { ...researchAccessBody(req.body), visibility: nextVisibility, createdBy: research.created_by });
  } else if (req.body?.allow_user_ids !== undefined || req.body?.allowUserIds !== undefined
    || req.body?.allow_group_ids !== undefined || req.body?.allowGroupIds !== undefined) {
    setResourcePolicy('research', req.params.id, { ...researchAccessBody(req.body), createdBy: research.created_by });
  }
  res.json(shapeResearchForUser(Researches.findById(req.params.id), req.user));
});

researchScoped.get('/', auth, (req, res) => {
  const research = Researches.findByIdWithProject(req.params.researchId);
  if (!research) return res.status(404).json({ error: '未找到' });
  if (!canReadResearch(req.user, research)) return res.status(404).json({ error: '未找到' });
  auditResearchAccess(req.user, 'list_research_sessions', research);
  const list = Sessions.listForResearch(req.params.researchId).filter((session) => canReadSession(req.user, session));
  const root = (research.bind_path || '').trim() ? path.resolve(research.bind_path) : null;
  const enriched = list.map((s) => {
    let job_accomplished = null;
    let job_failed = null;
    if (root) {
      try {
        const st = readJobFlagState(root, s.session_id);
        job_accomplished = st.accomplished;
        job_failed = st.failed;
      } catch {}
    }
    return { ...withSessionProxyState(s), job_accomplished, job_failed };
  });
  res.json(enriched);
});

researchScoped.post('/', auth, async (req, res) => {
  const research = Researches.findByIdWithProject(req.params.researchId);
  if (!research) return res.status(404).json({ error: '未找到' });
  if (!canCreateSessionForResearch(req.user, research)) return res.status(403).json({ error: '无权加入此 Research' });
  if (!research.research_enabled) return res.status(400).json({ error: '当前项目未启用 Research 系统' });
  auditResearchAccess(req.user, 'create_research_session', research);

  const { name, description, role, excluded_skill_ids, excluded_memory_ids, model, language } = req.body;
  const suppressJoinNotice = req.body?.suppress_join_notice === true || req.body?.suppressJoinNotice === true;
  if (!name) return res.status(400).json({ error: '请填写会话名称' });
  if (!['chief_researcher', 'research_assistant'].includes(role)) {
    return res.status(400).json({ error: 'Research Session role 非法' });
  }
  if (role === 'chief_researcher' && Sessions.findChiefForResearch(req.params.researchId)) {
    return res.status(409).json({ error: '当前 Research 已存在 chief_researcher' });
  }

  const resolvedModel = modelRegistry.resolveSessionModelForCreate(model);
  const limitCheck = modelPromptLimits.checkCreateAllowed(req.user.id, resolvedModel.key);
  if (!limitCheck.allowed) {
    return res.status(limitCheck.status).json({
      error: limitCheck.error,
      code: limitCheck.code,
      usage: limitCheck.usage,
    });
  }
  const sessionLanguage = language === 'en' ? 'en' : 'zh';
  const sessionId = uuid().slice(0, 8);
  const sessionKey = `web:${req.user.id}:${sessionId}`;
  const excludedSkillIds = sanitizeIds(excluded_skill_ids);
  const excludedMemoryIds = sanitizeIds(excluded_memory_ids);
  const selectionSnapshot = buildResearchSessionSelectionSnapshot(
    req.user,
    req.params.researchId,
    excludedSkillIds,
    excludedMemoryIds,
  );

  try {
    Sessions.insert({
      session_id: sessionId,
      issue_id: null,
      project_id: research.project_id,
      scope_type: 'research',
      research_id: req.params.researchId,
      research_role: role,
      user_id: req.user.id,
      name,
      description,
      session_key: sessionKey,
      excluded_skill_ids: excludedSkillIds,
      excluded_memory_ids: excludedMemoryIds,
      selection_snapshot: selectionSnapshot,
      model: resolvedModel.sessionModelValue,
      language: sessionLanguage,
    });
  } catch (e) {
    if (String(e.message || '').includes('idx_sessions_v2_one_chief_per_research')) {
      return res.status(409).json({ error: '当前 Research 已存在 chief_researcher' });
    }
    throw e;
  }

  const displayRole = role === 'chief_researcher' ? 'chief_researcher' : 'research_assistant';
  if (!suppressJoinNotice) {
    const blackboardResult = appendBlackboardRecord({
      researchId: req.params.researchId,
      author: 'HR',
      content: `新的 ${displayRole} 已加入研究环境: session_id=${sessionId}, name=${name}`,
      metadata: { event: 'session_joined', session_id: sessionId, role: displayRole, name },
    });
    if (blackboardResult.error) return res.status(500).json({ error: blackboardResult.error });
  }
  res.json(withSessionProxyState(Sessions.findById(sessionId)));
});

function handleContextPreview(req, res) {
  const research = Researches.findById(req.params.id);
  if (!research) return res.status(404).json({ error: '未找到' });
  if (!canReadResearch(req.user, research)) return res.status(404).json({ error: '未找到' });
  auditResearchAccess(req.user, 'read_research_context_preview', research);
  const src = (req.method === 'POST' && req.body && typeof req.body === 'object') ? req.body : req.query;
  const ctx = buildResearchContextPreview(
    req.user,
    req.params.id,
    {
      name: typeof src.name === 'string' ? src.name : '',
      description: typeof src.description === 'string' ? src.description : '',
      role: typeof src.role === 'string' ? src.role : 'research_assistant',
    },
    toIdList(src.excluded_skill_ids),
    toIdList(src.excluded_memory_ids),
    src.language === 'en' ? 'en' : 'zh',
  );
  res.json({ body: ctx.body, sources: ctx.sources });
}

router.get('/:id/context-preview', auth, handleContextPreview);
router.post('/:id/context-preview', auth, handleContextPreview);

router.get('/:id/session-selection-defaults', auth, (req, res) => {
  const research = Researches.findById(req.params.id);
  if (!research) return res.status(404).json({ error: '未找到' });
  if (!canReadResearch(req.user, research)) return res.status(404).json({ error: '未找到' });
  auditResearchAccess(req.user, 'read_research_session_selection_defaults', research);
  res.json(buildResearchSelectionDefaults(req.user, req.params.id));
});

// "research agent skill": 名字以 research- 开头、且 frontmatter 含 research_role 字段的 skill.
// 用 resolveEffectiveSkills 走与 Wizard 相同的 (用户级+项目级) 去重逻辑, 保证返回的 id
// 与第二步勾选列表里的 id 完全一致, 前端可据此锁定该 skill 必选.
router.get('/:id/research-agent-skills', auth, (req, res) => {
  const research = Researches.findByIdWithProject(req.params.id);
  if (!research) return res.status(404).json({ error: '未找到' });
  if (!canReadResearch(req.user, research)) return res.status(404).json({ error: '未找到' });
  auditResearchAccess(req.user, 'read_research_agent_skills', research);
  const preview = buildResearchContextPreview(req.user, req.params.id, null, [], [], 'zh');
  const effective = Array.isArray(preview.sources?.skills) ? preview.sources.skills : [];
  const agentSkills = effective
    .filter(s => typeof s.name === 'string' && s.name.startsWith('research-') && s.research_role)
    .map(s => ({ id: s.id, name: s.name, description: s.description || '', research_role: s.research_role, scope: s.scope }));
  res.json(agentSkills);
});

router.post('/:id/complete', auth, (req, res) => {
  const research = Researches.findById(req.params.id);
  if (!research) return res.status(404).json({ error: '未找到' });
  if (!canManageResearch(req.user, research)) return res.status(403).json({ error: '无权完成此 Research' });
  auditResearchAccess(req.user, 'complete_research', research);
  Researches.markCompleted(req.params.id);
  res.json(shapeResearchForUser(Researches.findById(req.params.id), req.user));
});

blackboardRouter.get('/:researchId', (req, res) => {
  const result = readBlackboard(req.params.researchId);
  if (result.error) return res.status(404).type('text/plain').send(result.error);
  res.type('application/x-ndjson; charset=utf-8').send(result.content || '');
});

blackboardRouter.post('/:researchId', async (req, res) => {
  const normalized = normalizeWriteInput(req.body || {});
  if (normalized.error) return res.status(400).json({ error: normalized.error });
  const result = appendBlackboardRecord({
    researchId: req.params.researchId,
    author: normalized.author,
    content: normalized.content,
    metadata: normalized.metadata,
  });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ ok: true, record: result.record });
});

// Research Graph: 读取 blackboard 目录旁的 research-graph.yml, 解析为节点/边 JSON.
// GET 不加 auth (与 blackboardRouter 一致, 方便 agent 直接 curl); 图片接口走 downloadAuth (支持 ?token=).
graphRouter.get('/:researchId', (req, res) => {
  const result = readGraph(req.params.researchId);
  if (result.error) return res.status(404).json({ error: result.error });
  res.json({
    exists: result.exists,
    nodes: result.nodes,
    edges: result.edges,
    file: result.file,
  });
});

graphRouter.get('/:researchId/image', downloadAuth, (req, res) => {
  const result = resolveGraphImage(req.params.researchId, req.query.path);
  if (result.error) return res.status(result.error.includes('不存在') ? 404 : 403).json({ error: result.error });
  res.sendFile(result.absPath);
});

module.exports = { router, projectScoped, researchScoped, blackboardRouter, graphRouter };
