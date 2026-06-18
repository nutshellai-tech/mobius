const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const { auth } = require('../middleware/auth');
const { Issues } = require('../repositories/issues');
const { Projects } = require('../repositories/projects');
const { Skills } = require('../repositories/skills');
const { resolveEffectiveSkills } = require('../services/skill-resolver');
const { buildIssueContextPreview, buildIssueSelectionDefaults, buildSessionSelectionSnapshot, gatherIssueSources } = require('../services/session-context');
const { recordAdminAuditIfCrossUser } = require('../services/admin-audit');
const { ensureProjectKnowledgeFile } = require('../services/project-knowledge');
const { Sessions } = require('../repositories/sessions');
const modelRegistry = require('../services/model-registry');
const PLANNER_SKILL_ID = 'builtin:mobius-planner';
const {
  accessPayload,
  canSetIssueVisibilityWithinProject,
  canCreateIssue,
  canManageIssue,
  canReadIssue,
  canReadProject,
  filterReadableContextItems,
  normalizeVisibility,
  setResourcePolicy,
  uniqStringList,
} = require('../services/access-control');

// 校验分支名: 既要是合法 git ref, 又要能安全拼进 bind_path 下作目录名.
function sanitizeBranchName(raw) {
  const b = String(raw || '').trim();
  if (!b) return { error: '分支名不能为空' };
  if (b.length > 200) return { error: '分支名过长' };
  if (/\s/.test(b)) return { error: '分支名不能含空白字符' };
  if (b.includes('..')) return { error: '分支名不能含 ".."' };
  if (b.startsWith('/') || b.endsWith('/')) return { error: '分支名不能以 / 开头或结尾' };
  if (b.startsWith('-') || b.startsWith('.')) return { error: '分支名不能以 - 或 . 开头' };
  if (/[~^:?*\[\]\\\x00-\x1F\x7F]/.test(b)) return { error: '分支名含非法字符 (~ ^ : ? * [ ] \\ 或控制字符)' };
  return { branch: b };
}

function withSkillFields(issue) {
  if (!issue) return issue;
  const { selected, excluded } = parseSkillArrays(issue);
  return { ...issue, selected_skills: selected, excluded_skills: excluded };
}

function maybeList(body, snakeKey, camelKey) {
  if (!body || (!Object.prototype.hasOwnProperty.call(body, snakeKey) && !Object.prototype.hasOwnProperty.call(body, camelKey))) {
    return undefined;
  }
  return uniqStringList(body[snakeKey] ?? body[camelKey]);
}

function issueAccessBody(body = {}) {
  return {
    visibility: body.visibility,
    allowUserIds: maybeList(body, 'allow_user_ids', 'allowUserIds'),
    allowGroupIds: maybeList(body, 'allow_group_ids', 'allowGroupIds'),
  };
}

function shapeIssueForUser(issue, user) {
  if (!issue) return issue;
  return {
    ...withSkillFields(issue),
    visibility: normalizeVisibility(issue.visibility, 'inherit', true),
    access: accessPayload('issue', issue.id, normalizeVisibility(issue.visibility, 'inherit', true)),
    can_manage: canManageIssue(user, issue),
  };
}

function auditIssueAccess(user, action, issue) {
  if (!issue) return;
  const project = Projects.findById(issue.project_id);
  recordAdminAuditIfCrossUser(
    user,
    action,
    'issue',
    issue.id,
    issue.created_by || project?.created_by,
  );
}

function validateIssueVisibilityForProject(res, project, visibility) {
  if (canSetIssueVisibilityWithinProject(project, visibility)) return true;
  res.status(400).json({ error: 'Issue 可见性不能比 Project 更宽' });
  return false;
}

const router = express.Router();

// 嵌在 /api/projects/:projectId/issues 下
const projectScoped = express.Router({ mergeParams: true });

projectScoped.get('/', auth, (req, res) => {
  const project = Projects.findById(req.params.projectId);
  if (!project) return res.status(404).json({ error: '未找到' });
  if (!canReadProject(req.user, project)) return res.status(404).json({ error: '未找到' });
  const issues = Issues.listForProject(req.params.projectId, req.query.status)
    .filter((issue) => canReadIssue(req.user, issue))
  if (req.user?.role === 'admin' && project.created_by !== req.user.id) {
    recordAdminAuditIfCrossUser(req.user, 'list_issues', 'project', project.id, project.created_by);
  }
  res.json(issues.map((issue) => shapeIssueForUser(issue, req.user)));
});

projectScoped.post('/', auth, (req, res) => {
  const project = Projects.findById(req.params.projectId);
  if (!project) return res.status(404).json({ error: '未找到' });
  if (!canCreateIssue(req.user, project)) return res.status(403).json({ error: '无权在此项目创建 Issue' });

  const { title, description } = req.body;
  if (!title) return res.status(400).json({ error: '请填写 Issue 标题' });
  if (!description) return res.status(400).json({ error: '请填写 Issue 描述' });

  const issueId = uuid().slice(0, 8);
  const issueVisibility = normalizeVisibility(req.body?.visibility, 'inherit', true);
  if (!validateIssueVisibilityForProject(res, project, issueVisibility)) return;

  // git worktree: 未显式传则取项目级默认 (project.default_use_worktree).
  // 分支名默认 = issue 标识 (issueId). 启用时校验 `bind_path/<分支>` 不存在, 存在则拒绝让用户重输.
  const useWorktree = req.body.use_worktree === undefined
    ? !!project.default_use_worktree
    : !!req.body.use_worktree;
  let worktreeBranch = '';
  if (useWorktree) {
    const bindPath = (project.bind_path || '').trim();
    if (!bindPath) {
      return res.status(400).json({ error: '项目未配置绑定路径, 无法使用 git worktree' });
    }
    const rawBranch = (req.body.worktree_branch || '').trim() || issueId;
    const v = sanitizeBranchName(rawBranch);
    if (v.error) return res.status(400).json({ error: v.error });
    worktreeBranch = v.branch;

    const abs = path.resolve(bindPath);
    const wtPath = path.join(abs, worktreeBranch);
    if (wtPath !== abs && !wtPath.startsWith(abs + path.sep)) {
      return res.status(400).json({ error: '分支名导致路径越出绑定路径, 请重新输入' });
    }
    if (fs.existsSync(wtPath)) {
      return res.status(409).json({ error: `路径已存在: ${wtPath} — 请换一个分支名重新输入` });
    }
  }

  Issues.insert({
    id: issueId,
    project_id: req.params.projectId,
    title,
    description,
    created_by: req.user.id,
    use_worktree: useWorktree,
    worktree_branch: worktreeBranch,
    visibility: issueVisibility,
    is_planning: req.body.is_planning === true,
  });
  recordAdminAuditIfCrossUser(req.user, 'create_issue', 'project', project.id, project.created_by);

  // 规划模式: 自动创建预配置 Session (仅启用 mobius-planner SKILL + 全量 Memory).
  // 不启动 Agent、不发首条消息, 用户在 UI 中自己交互.
  let planningSessionId = null;
  if (req.body.is_planning === true) {
    const initResult = ensureProjectKnowledgeFile(project);
    if (!initResult.ok) {
      console.warn(`[issues] planning init project_knowledge.md failed (${issueId}): ${initResult.error}`);
    }
    const created = Issues.findById(issueId);
    const sources = gatherIssueSources(req.user, created, { skills: [], memories: [] });
    const allSkillIds = (sources.skills || []).map(s => s.id);
    // 排除"除 mobius-planner 之外的全部", 实现"仅启用 mobius-planner".
    const excludedSkillIds = allSkillIds.filter(id => id !== PLANNER_SKILL_ID);
    const excludedMemoryIds = [];
    const selectionSnapshot = buildSessionSelectionSnapshot(req.user, issueId, excludedSkillIds, excludedMemoryIds);
    const resolvedModel = modelRegistry.resolveSessionModelForCreate(undefined);
    planningSessionId = uuid().slice(0, 8);
    const sessionKey = `web:${req.user.id}:${planningSessionId}`;
    try {
      Sessions.insert({
        session_id: planningSessionId,
        issue_id: issueId,
        project_id: req.params.projectId,
        user_id: req.user.id,
        name: '系统宏观规划',
        description: '规划 Session: 维护 project_knowledge.md, 不执行代码',
        session_key: sessionKey,
        excluded_skill_ids: excludedSkillIds,
        excluded_memory_ids: excludedMemoryIds,
        selection_snapshot: selectionSnapshot,
        model: resolvedModel.sessionModelValue,
        language: 'zh',
      });
      Issues.touchActiveAndIncrement(issueId);
    } catch (e) {
      console.warn(`[issues] planning session auto-create failed (${issueId}): ${e.message}`);
      planningSessionId = null;
    }
  }
  if (req.body?.visibility !== undefined
    || req.body?.allow_user_ids !== undefined || req.body?.allowUserIds !== undefined
    || req.body?.allow_group_ids !== undefined || req.body?.allowGroupIds !== undefined) {
    setResourcePolicy('issue', issueId, {
      ...issueAccessBody(req.body),
      createdBy: req.user.id,
    });
  }
  res.json({
    ...shapeIssueForUser(Issues.findById(issueId), req.user),
    ...(planningSessionId ? { planning_session_id: planningSessionId } : {}),
  });
});

// 直接在 /api/issues 下
router.get('/:id', auth, (req, res) => {
  const issue = Issues.findById(req.params.id);
  if (!issue) return res.status(404).json({ error: '未找到' });
  if (!canReadIssue(req.user, issue)) return res.status(404).json({ error: '未找到' });
  auditIssueAccess(req.user, 'read_issue', issue);
  res.json(shapeIssueForUser(issue, req.user));
});

// Issue 视角的 skill 列表 = 用户级 skills ∪ 项目级 skills, 同时返回 selected/excluded.
router.get('/:id/skills', auth, (req, res) => {
  const issue = Issues.findById(req.params.id);
  if (!issue) return res.status(404).json({ error: '未找到' });
  if (!canReadIssue(req.user, issue)) return res.status(404).json({ error: '未找到' });
  auditIssueAccess(req.user, 'read_issue_skills', issue);
  const all = filterReadableContextItems(req.user, 'skill', Skills.listForIssue(req.user.id, issue.project_id));
  const { selected, excluded } = parseSkillArrays(issue);
  res.json({
    available: all.map(s => ({
      id: s.id, scope: s.scope, name: s.name, description: s.description,
    })),
    selected, excluded,
    effective: resolveEffectiveSkills(all, { selected, excluded }).map(s => ({ id: s.id, name: s.name })),
  });
});

router.patch('/:id', auth, (req, res) => {
  const issue = Issues.findById(req.params.id);
  if (!issue) return res.status(404).json({ error: '未找到' });
  if (!canManageIssue(req.user, issue)) return res.status(403).json({ error: '无权修改此 Issue' });
  auditIssueAccess(req.user, 'write_issue', issue);
  const project = Projects.findById(issue.project_id);

  const { title, description, status, pinned, selected_skills, excluded_skills, visibility } = req.body;
  if (title) Issues.updateTitle(req.params.id, title);
  if (description !== undefined) Issues.updateDescription(req.params.id, description);
  if (status && ['active', 'completed'].includes(status)) {
    const prevStatus = issue.status;
    Issues.updateStatus(req.params.id, status);
    // 规划 Issue 状态联动: 完成→归档, 重开→恢复.
    if (issue.is_planning && prevStatus !== status) {
      try {
        const sessions = Sessions.listAllByIssue ? Sessions.listAllByIssue(req.params.id) : Sessions.listForIssue(req.params.id);
        if (status === 'completed') {
          for (const s of (sessions || [])) {
            if (s.status === 'active') Sessions.archive(s.session_id);
          }
        } else if (status === 'active') {
          for (const s of (sessions || [])) {
            if (s.status === 'archived') Sessions.restoreFromArchive(s.session_id);
          }
        }
      } catch (e) {
        console.warn(`[issues] planning session lifecycle failed (${req.params.id}): ${e.message}`);
      }
    }
  }
  if (typeof pinned === 'boolean') Issues.updatePinned(req.params.id, pinned);
  if (visibility !== undefined) {
    const nextVisibility = normalizeVisibility(visibility, 'inherit', true);
    if (!validateIssueVisibilityForProject(res, project, nextVisibility)) return;
    Issues.updateVisibility(req.params.id, nextVisibility);
    setResourcePolicy('issue', req.params.id, { ...issueAccessBody(req.body), visibility: nextVisibility, createdBy: issue.created_by });
  } else if (req.body?.allow_user_ids !== undefined || req.body?.allowUserIds !== undefined
    || req.body?.allow_group_ids !== undefined || req.body?.allowGroupIds !== undefined) {
    setResourcePolicy('issue', req.params.id, { ...issueAccessBody(req.body), createdBy: issue.created_by });
  }

  if (Array.isArray(selected_skills) || Array.isArray(excluded_skills)) {
    const cur = parseSkillArrays(issue);
    const sel = Array.isArray(selected_skills) ? selected_skills.filter(x => typeof x === 'string') : cur.selected;
    const exc = Array.isArray(excluded_skills) ? excluded_skills.filter(x => typeof x === 'string') : cur.excluded;
    Issues.updateSkillOverrides(req.params.id, { selected: sel, excluded: exc });
  }

  res.json(shapeIssueForUser(Issues.findById(req.params.id), req.user));
});

function parseSkillArrays(issue) {
  let selected = [], excluded = [];
  try { selected = JSON.parse(issue.selected_skills || '[]'); } catch {}
  try { excluded = JSON.parse(issue.excluded_skills || '[]'); } catch {}
  if (!Array.isArray(selected)) selected = [];
  if (!Array.isArray(excluded)) excluded = [];
  return { selected, excluded };
}

// 新建 Session Wizard 预览: 在用户提交前显示将注入的完整上下文.
// 优先 POST + JSON body (description 可能很长, 放 URL 会撑爆请求头导致 fail to fetch):
//   { name, description, excluded_skill_ids: [...], excluded_memory_ids: [...] }
// 仍保留 GET + query 以兼容旧前端:
//   ?name=...&description=...&excluded_skill_ids=a,b,c&excluded_memory_ids=x,y
function handleContextPreview(req, res) {
  const issue = Issues.findById(req.params.id);
  if (!issue) return res.status(404).json({ error: '未找到' });
  if (!canReadIssue(req.user, issue)) return res.status(404).json({ error: '未找到' });
  // 兼容两种来源: POST 走 body, GET 走 query.
  const src = (req.method === 'POST' && req.body && typeof req.body === 'object')
    ? req.body : req.query;
  // excluded ids 既可能是数组 (POST JSON), 也可能是逗号分隔字符串 (GET query).
  const toIdList = (v) => {
    if (Array.isArray(v)) return v.map(s => String(s).trim()).filter(Boolean);
    if (typeof v === 'string' && v.length > 0) {
      return v.split(',').map(s => s.trim()).filter(Boolean);
    }
    return [];
  };
  const ctx = buildIssueContextPreview(
    req.user, req.params.id,
    {
      name: typeof src.name === 'string' ? src.name : '',
      description: typeof src.description === 'string' ? src.description : '',
    },
    toIdList(src.excluded_skill_ids),
    toIdList(src.excluded_memory_ids),
    src.language === 'en' ? 'en' : 'zh',
  );
  res.json({ body: ctx.body, sources: ctx.sources });
}
router.get('/:id/context-preview', auth, handleContextPreview);
router.post('/:id/context-preview', auth, handleContextPreview);

// 新建 Session Wizard 默认勾选状态:
// 若同一 Issue 已有其他非删除 Session, 参考最新创建 Session 的 Skill/Memory 勾选状态.
router.get('/:id/session-selection-defaults', auth, (req, res) => {
  const issue = Issues.findById(req.params.id);
  if (!issue) return res.status(404).json({ error: '未找到' });
  if (!canReadIssue(req.user, issue)) return res.status(404).json({ error: '未找到' });
  res.json(buildIssueSelectionDefaults(req.user, req.params.id));
});

router.post('/:id/complete', auth, (req, res) => {
  const issue = Issues.findById(req.params.id);
  if (!issue) return res.status(404).json({ error: '未找到' });
  if (!canManageIssue(req.user, issue)) return res.status(403).json({ error: '无权完成此 Issue' });
  Issues.markCompleted(req.params.id);
  // 规划 Issue 完成时, 自动归档绑定的规划 Session (不删除).
  if (issue.is_planning) {
    try {
      const sessions = Sessions.listActiveByIssue(req.params.id);
      for (const s of sessions) Sessions.archive(s.session_id);
    } catch (e) {
      console.warn(`[issues] archive planning session failed (${req.params.id}): ${e.message}`);
    }
  }
  res.json(shapeIssueForUser(Issues.findById(req.params.id), req.user));
});

router.delete('/:id', auth, (req, res) => {
  const issue = Issues.findById(req.params.id);
  if (!issue) return res.status(404).json({ error: '未找到' });
  if (!canManageIssue(req.user, issue)) return res.status(403).json({ error: '无权删除此 Issue' });
  Issues.delete(req.params.id);
  res.json({ ok: true });
});

module.exports = { router, projectScoped };
