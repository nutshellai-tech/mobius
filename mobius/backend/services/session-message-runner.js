const { Sessions } = require('../repositories/sessions');
const { Messages } = require('../repositories/messages');
const { buildSessionContext, wrapUserMessage } = require('./session-context');
const modelRegistry = require('./model-registry');
const agents = require('../agents');
const { resolveSessionWorkspace } = require('./workspace');
const { appendSessionInput } = require('./session-inputs');
const { syncSkillsToWorkspace } = require('./session-skills-sync');
const { formatBackendSendFailure } = require('./session-errors');
const { transferAppendPrompt } = require('./session-transfer');
const { canOperateSession } = require('./access-control');
const {
  safeRemoveRunningFlag,
  safeWriteFailedFlag,
} = require('../utils/session-flags');
const { db } = require('../../db');

function httpError(message, status = 500, category = '') {
  const err = new Error(message);
  err.status = status;
  if (category) err.category = category;
  return err;
}

function findSessionOperable(id, user) {
  const session = Sessions.findById(id);
  return session && canOperateSession(user, session) ? session : null;
}

function mobiusPromptKind(content) {
  return String(content || '').trim().startsWith('/compact') ? 'compact' : 'user_input';
}

function readPendingTransferPath(sessionId) {
  try {
    const row = db.prepare(`
      SELECT content
      FROM messages_v2
      WHERE task_id = ? AND role = 'system' AND turn_summary = 'session_transfer'
      ORDER BY id DESC
      LIMIT 1
    `).get(sessionId);
    if (!row?.content) return null;
    const parsed = JSON.parse(row.content);
    return typeof parsed?.path === 'string' && parsed.path.trim() ? parsed.path.trim() : null;
  } catch {
    return null;
  }
}

async function runSessionMessage({
  user,
  sessionId,
  content,
  inputText = '',
  hasInputText = false,
  requestId = null,
  source = 'service.session.messages',
  logger = console,
} = {}) {
  const normalizedSessionId = String(sessionId || '').trim();
  const normalizedContent = typeof content === 'string' ? content : '';
  const normalizedRequestId = typeof requestId === 'string' ? requestId : null;
  const normalizedInputText = hasInputText ? String(inputText || '') : '';

  if (!normalizedContent.trim()) throw httpError('content 不能为空', 400);
  if (!user?.id) throw httpError('用户不可用', 401);

  const sess = findSessionOperable(normalizedSessionId, user);
  if (!sess) throw httpError(`session ${normalizedSessionId} 不存在或不属于你`, 404);

  const workspace = resolveSessionWorkspace(user, normalizedSessionId);
  if (workspace.error) {
    try { Sessions.setIdle(normalizedSessionId, user.id); } catch {}
    try { Messages.insertSystem(normalizedSessionId, workspace.error, null, '工作目录不可用'); } catch {}
    throw httpError(workspace.error, 400, 'workspace');
  }
  const workDir = workspace.workDir;
  const flagRoot = workspace.projectRoot || workspace.workDir;

  const launch = modelRegistry.launchOptionsForSession(sess);
  const backend = agents.get(launch.backend);

  const turnNum = (Messages.maxTurnFor(normalizedSessionId) || 0) + 1;
  Messages.insertUser(normalizedSessionId, normalizedContent, turnNum);
  Sessions.touchActive(normalizedSessionId);
  if (hasInputText) {
    try {
      appendSessionInput({
        projectRoot: flagRoot,
        sessionId: normalizedSessionId,
        inputText: normalizedInputText,
        content: normalizedContent,
        requestId: normalizedRequestId,
        turnNumber: turnNum,
      });
    } catch (e) {
      logger?.warn?.(`[sessions/messages] append session input failed (${normalizedSessionId}): ${e.message}`);
    }
  }

  const mobiusJsonl = {
    source,
    kind: mobiusPromptKind(normalizedContent),
    content: normalizedContent,
    inputText: hasInputText ? normalizedInputText : null,
    requestId: normalizedRequestId,
    turnNumber: turnNum,
    userId: user?.id || null,
    timestamp: new Date().toISOString(),
  };

  let finalContent = normalizedContent;
  if (Messages.countUserMessagesFor(normalizedSessionId) <= 1) {
    const ctx = buildSessionContext(user, normalizedSessionId);
    if (workDir && ctx.sources?.skills?.length > 0) {
      try { syncSkillsToWorkspace(workDir, ctx.sources.skills); }
      catch (e) { logger?.warn?.(`[sessions/messages] sync skills failed: ${e.message}`); }
    }
    if (ctx.body) {
      try {
        Sessions.writeContextSnapshot(
          normalizedSessionId,
          ctx.body,
          ctx.sources ? JSON.stringify(ctx.sources) : null,
        );
      } catch (e) {
        logger?.warn?.(`[sessions/messages] writeContextSnapshot: ${e.message}`);
      }
      finalContent = wrapUserMessage(ctx.body, normalizedContent, ctx.language);
    }
    const transferPath = readPendingTransferPath(normalizedSessionId);
    if (transferPath) {
      try {
        finalContent = transferAppendPrompt(transferPath, finalContent);
      } catch (e) {
        logger?.warn?.(`[sessions/messages] append session transfer failed (${normalizedSessionId}): ${e.message}`);
      }
    }
  }

  try {
    await backend.noPauseCurrentAndQueueQueryAtSession({
      sessionId: normalizedSessionId,
      prompt: finalContent,
      cwd: workDir,
      flagRoot,
      model: launch.model || undefined,
      settingsPath: launch.settingsPath,
      forceNoProxy: launch.forceNoProxy,
      useProxy: launch.forceNoProxy ? false : launch.useProxy === true,
      codexProfileKey: launch.codexProfileKey || undefined,
      codexChannel: launch.codexChannel || undefined,
      codexConfigPath: launch.codexConfigPath || undefined,
      codexSecretEnvKey: launch.codexSecretEnvKey || undefined,
      codexSecretValue: launch.codexSecretValue || undefined,
      displayName: sess.name,
      agentSessionId: sess.claude_session_id || undefined,
      mobiusJsonl,
    });
    const runtimeInfo = backend.listSessions().find(s => s.sessionId === normalizedSessionId);
    const newAgentSid = runtimeInfo?.agentSessionId || null;
    if (newAgentSid && newAgentSid !== sess.claude_session_id) {
      try {
        db.prepare('UPDATE sessions_v2 SET claude_session_id=? WHERE session_id=?').run(newAgentSid, normalizedSessionId);
      } catch (e) {
        logger?.warn?.(`[sessions/messages] save agent session id: ${e.message}`);
      }
    }
    return {
      ok: true,
      session_id: normalizedSessionId,
      turn_number: turnNum,
      request_id: normalizedRequestId,
      backend: backend.name,
    };
  } catch (e) {
    const { userMessage: detail, rawMessage } = formatBackendSendFailure(e);
    logger?.warn?.(`[sessions/messages] ${rawMessage}${rawMessage !== detail ? `; user_message=${detail}` : ''} (session=${normalizedSessionId})`);
    const failedFields = { backend: backend.name, reason: detail };
    if (rawMessage !== detail) failedFields.raw_reason = rawMessage;
    safeRemoveRunningFlag(flagRoot, normalizedSessionId, 'sessions/messages');
    safeWriteFailedFlag(flagRoot, normalizedSessionId, failedFields, 'sessions/messages');
    try { Sessions.setIdle(normalizedSessionId, user.id); } catch {}
    try { Messages.insertSystem(normalizedSessionId, detail, turnNum, '启动失败'); } catch {}
    throw httpError(detail, 500, 'backend');
  }
}

module.exports = {
  runSessionMessage,
};
