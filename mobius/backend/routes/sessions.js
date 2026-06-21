const express = require('express');
const { v4: uuid } = require('uuid');
const { auth, authOrQuery } = require('../middleware/auth');
const { Sessions } = require('../repositories/sessions');
const { Issues } = require('../repositories/issues');
const { Messages } = require('../repositories/messages');
const { bridge } = require('../bridge/instance');
const { buildSessionContext, buildSessionSelectionSnapshot } = require('../services/session-context');
const { audit } = require('../repositories/audit');
const modelRegistry = require('../services/model-registry');
const { useProxyForSession, withSessionProxyState } = require('../services/session-proxy-state');
const agents = require('../agents');
const fs = require('fs');
const path = require('path');
const { Projects } = require('../repositories/projects');
const { recordAdminAuditIfCrossUser } = require('../services/admin-audit');
const { gitTopLevel, isGitRepoRoot, resolveSessionWorkspace } = require('../services/workspace');
const {
  countMergedJsonl,
  readMergedJsonlSlice,
  appendMobiusErrorEntry,
  readLastMobiusEntryType,
  DEFAULT_HISTORY_TAIL,
  MAX_HISTORY_FETCH,
} = require('../services/mobius-jsonl');
const { readSessionInputs } = require('../services/session-inputs');
const sessionFeatures = require('../services/session-features');
const { runSessionMessage } = require('../services/session-message-runner');
const { writeSessionTransferDocument } = require('../services/session-transfer');
const { predictNextQuestionsForSession } = require('../services/session-next-question-predictor');
const { appendBlackboardRecord } = require('../services/research-blackboard');
const { db } = require('../../db');
const {
  canCreateSessionForIssue,
  canOperateSession,
  canReadIssue,
  canReadSession,
} = require('../services/access-control');
// flag 路径约定单一来源 (与 backend / scanner 一致): <仓库根>/.imac/flags/<sid>/{running,failed}.flag
const {
  flagDirOf,
  runningFlagPathOf,
  failedFlagPathOf,
  readFailedFlag,
  safeRemoveRunningFlag,
  readJobFlagState,
} = require('../utils/session-flags');
const { DEFAULT_WINDOW_HOURS, statsSince, statsSinceMinutes } = require('../services/agent-prompt-events');
const modelPromptLimits = require('../services/model-prompt-limits');

const router = express.Router();

const PROMPT_STATS_BACKENDS = [
  { key: 'codex', backendName: 'tmux-codex' },
  { key: 'claude_code', backendName: 'tmux-claude-code' },
];

function pidExists(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

function activeWindowCountForBackend(backendName) {
  let backend;
  try {
    backend = agents.get(backendName);
  } catch {
    return 0;
  }
  let windows = [];
  try {
    windows = backend.listSessions();
  } catch {
    return 0;
  }
  return windows.filter((w) => {
    if (!w?.sessionId || w.sessionId === '_root') return false;
    if (w.paneDead) return false;
    if (!pidExists(w.pid)) return false;
    try { return !!backend.isAlive(w.sessionId); }
    catch { return false; }
  }).length;
}

function activeWindowsByPromptBackend() {
  return Object.fromEntries(
    PROMPT_STATS_BACKENDS.map((def) => [def.key, activeWindowCountForBackend(def.backendName)])
  );
}

// 全站 codex / claude-code 最近提问聚合 — 给 NewSessionModal 用.
// 真正阻止创建的限制由 modelPromptLimits.checkCreateAllowed 统一判定.
router.get('/prompt-stats', auth, (req, res) => {
  const s = statsSince(DEFAULT_WINDOW_HOURS);
  const s5 = statsSinceMinutes(modelPromptLimits.WINDOW_MINUTES);
  const activeWindows = activeWindowsByPromptBackend();
  res.json({
    window_hours: s.window_hours,
    window_minutes: modelPromptLimits.WINDOW_MINUTES,
    since: s.since,
    codex: s.by_backend['tmux-codex'] || 0,
    claude_code: s.by_backend['tmux-claude-code'] || 0,
    codex_5min: s5.by_backend['tmux-codex'] || 0,
    claude_code_5min: s5.by_backend['tmux-claude-code'] || 0,
    // Backward-compatible aliases for older frontends.
    codex_2min: s5.by_backend['tmux-codex'] || 0,
    claude_code_2min: s5.by_backend['tmux-claude-code'] || 0,
    total: s.total,
    active_tmux_window_count: Object.values(activeWindows).reduce((sum, count) => sum + count, 0),
    active_windows_by_backend: activeWindows,
    model_usage_limits: modelPromptLimits.usageForUser(req.user.id),
  });
});

router.get('/model-options', auth, (req, res) => {
  res.json(modelRegistry.listSessionModelOptions());
});

function findSessionReadable(id, user) {
  const session = Sessions.findById(id);
  return session && canReadSession(user, session) ? session : null;
}

function findSessionOperable(id, user) {
  const session = Sessions.findById(id);
  return session && canOperateSession(user, session) ? session : null;
}

function auditSessionAccess(user, action, session) {
  if (!session) return;
  recordAdminAuditIfCrossUser(user, action, 'session', session.session_id, session.user_id);
}

function backendForSession(session) {
  return agents.get(modelRegistry.backendNameForSessionModel(session?.model));
}

function isTurnCompleteEntry(entry) {
  const sr = entry?.message?.stop_reason;
  if (entry?.type === 'assistant' && sr && sr !== 'tool_use') return true;
  if (entry?.type === 'event_msg' && entry?.payload?.type === 'task_complete') return true;
  return false;
}

function shapeSessionForStream(s) {
  const backend = backendForSession(s);
  return {
    session_id: s.session_id,
    name: s.name,
    description: s.description,
    status: s.status,
    agent_status: s.agent_status,
    issue_id: s.issue_id,
    project_id: s.project_id,
    scope_type: s.scope_type,
    research_id: s.research_id,
    research_role: s.research_role,
    message_count: s.message_count,
    turn_count: s.turn_count,
    last_active: s.last_active,
    created_at: s.created_at,
    model: s.model,
    total_cost_usd: s.total_cost_usd,
    use_proxy: useProxyForSession(s, backend),
    model_label: modelRegistry.labelForSessionModel(s.model),
    claude_session_id: s.claude_session_id,
    agent_backend: modelRegistry.backendNameForSessionModel(s.model),
  };
}

function sseDataLine(payload) {
  return JSON.stringify(payload).replace(/\r?\n/g, '\ndata: ');
}

async function writeSse(res, event, payload) {
  if (!res || res.writableEnded || res.destroyed) return false;
  const frame = `event: ${event}\ndata: ${sseDataLine(payload)}\n\n`;
  if (res.write(frame)) return true;
  await new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
  });
  return !(res.writableEnded || res.destroyed);
}

function writeSseComment(res, text) {
  if (!res || res.writableEnded || res.destroyed) return false;
  return res.write(`: ${text}\n\n`);
}

async function sendSseJsonlHistory(res, sessionId, hist) {
  const entries = Array.isArray(hist?.entries) ? hist.entries : [];
  const baseMeta = {
    event: 'jsonl_history',
    session_id: sessionId,
    total: hist?.total ?? entries.length,
    total_approximate: !!hist?.totalApproximate,
    truncated: !!hist?.truncated,
  };

  if (entries.length === 0) {
    return writeSse(res, 'jsonl_history', { ...baseMeta, reset: true, done: true, chunk_index: 0, entries: [] });
  }

  const maxEntries = 250;
  const maxBytes = 512 * 1024;
  let chunkIndex = 0;
  let chunkBytes = 0;
  let chunk = [];

  const flush = async (done) => {
    if (!chunk.length && !done) return true;
    const payload = {
      ...baseMeta,
      reset: chunkIndex === 0,
      done: !!done,
      chunk_index: chunkIndex,
      count: chunk.length,
      entries: chunk,
    };
    chunkIndex += 1;
    chunkBytes = 0;
    chunk = [];
    return writeSse(res, 'jsonl_history', payload);
  };

  for (const entry of entries) {
    let encoded;
    try { encoded = JSON.stringify(entry); } catch { continue; }
    const entryBytes = Buffer.byteLength(encoded);
    if (chunk.length > 0 && (chunk.length >= maxEntries || chunkBytes + entryBytes > maxBytes)) {
      const ok = await flush(false);
      if (!ok) return false;
    }
    chunk.push(entry);
    chunkBytes += entryBytes + 1;
  }

  return flush(true);
}


router.patch('/:id', auth, (req, res) => {
  const session = findSessionOperable(req.params.id, req.user);
  if (!session) return res.status(404).json({ error: '未找到' });
  auditSessionAccess(req.user, 'write_session', session);
  const { name, status } = req.body;
  if (name) Sessions.updateName(req.params.id, name);
  if (status !== undefined) {
    if (!['active', 'completed', 'archived'].includes(status)) {
      return res.status(400).json({ error: '状态无效' });
    }
    Sessions.updateStatus(req.params.id, status);
  }
  res.json(Sessions.findById(req.params.id));
});

async function closeBackgroundForDelete(session, sid, label) {
  const backend = backendForSession(session);
  const wasAlive = backend.isAlive(sid);
  const wasWorking = wasAlive && backend.isWorking(sid);

  // 删除前先关掉后台 agent (tmux window + TUI). closeSessionAsync 内部归一
  // session_key -> 裸 sessionId, 故传 session_key 或 sid 都能命中.
  let terminated = false;
  try {
    const r = await bridge.closeSessionAsync(session.session_key || sid, session.model);
    terminated = !!r?.killed;
  } catch (e) {
    console.warn(`[sessions] ${label}时关闭后台 agent 失败 (${sid}): ${e.message}`);
  }

  const message = wasAlive
    ? (wasWorking
      ? `会话已永久删除; 检测到后台 agent 仍在执行任务, 已强制终止该进程 (window=${sid})。`
      : `会话已永久删除; 已清理其后台 agent 进程 (window=${sid})。`)
    : null;

  return { wasAlive, wasWorking, terminated, message };
}

async function terminateBackgroundSession(session, sid) {
  const backend = backendForSession(session);
  let wasAlive = false;
  let wasWorking = false;
  try {
    wasAlive = backend.isAlive(sid);
    wasWorking = wasAlive && backend.isWorking(sid);
  } catch {}

  let terminated = false;
  try {
    const r = await bridge.closeSessionAsync(session.session_key || sid, session.model);
    terminated = !!r?.killed;
  } catch (e) {
    console.warn(`[sessions] 终止后台 agent 失败 (${sid}): ${e.message}`);
  }

  const message = wasAlive
    ? (wasWorking
      ? `已终止旧 Session 的后台执行 (window=${sid})。`
      : `已关闭旧 Session 的后台 agent (window=${sid})。`)
    : '旧 Session 没有正在运行的后台 agent。';

  return { wasAlive, wasWorking, terminated, message };
}

function shouldNotifyResearchPeers(req) {
  return req.body?.notify_others === true || req.body?.notifyOthers === true;
}

function researchSessionLeftContent(session) {
  const role = session.research_role === 'chief_researcher' ? 'chief_researcher' : 'research_assistant';
  return `Research Agent「${session.name || session.session_id}」已离开团队。session_id=${session.session_id}, role=${role}`;
}

function appendResearchSessionLeftNotice(session, userId) {
  if (session.scope_type !== 'research' || !session.research_id) return null;
  const role = session.research_role === 'chief_researcher' ? 'chief_researcher' : 'research_assistant';
  return appendBlackboardRecord({
    researchId: session.research_id,
    author: 'HR',
    content: researchSessionLeftContent(session),
    metadata: {
      event: 'session_left',
      session_id: session.session_id,
      role,
      name: session.name || '',
      deleted_by: userId || null,
    },
  });
}

// 删除 Session = 直接永久删除, 不再进入项目回收站.
router.delete('/:id', auth, async (req, res) => {
  const session = findSessionOperable(req.params.id, req.user);
  if (!session) return res.status(404).json({ error: '未找到' });
  auditSessionAccess(req.user, 'delete_session', session);

  const sid = req.params.id;
  let noticeResult = null;
  if (session.scope_type === 'research' && shouldNotifyResearchPeers(req)) {
    noticeResult = appendResearchSessionLeftNotice(session, req.user.id);
    if (noticeResult?.error) return res.status(500).json({ error: noticeResult.error });
  }

  const closed = await closeBackgroundForDelete(session, sid, '删除');
  audit(req.user.id, 'session.delete', 'session', sid,
    JSON.stringify({
      scope_type: session.scope_type || 'issue',
      research_id: session.research_id || null,
      notify_others: !!noticeResult,
      was_alive: closed.wasAlive,
      was_working: closed.wasWorking,
      terminated: closed.terminated,
    }));

  Sessions.permanentDelete(sid);
  const noticeMessage = noticeResult ? '已由 HR 在 Blackboard 写入该 Research Agent 已离开团队。' : null;
  res.json({
    ok: true,
    notified_others: !!noticeResult,
    blackboard_record_id: noticeResult?.record?.id || null,
    background_was_alive: closed.wasAlive,
    background_was_working: closed.wasWorking,
    background_terminated: closed.terminated,
    message: [noticeMessage, closed.message].filter(Boolean).join('\n') || null,
  });
});

// 兼容旧调用: /permanent 仍然执行同一套硬删除逻辑.
router.delete('/:id/permanent', auth, async (req, res) => {
  const session = findSessionOperable(req.params.id, req.user);
  if (!session) return res.status(404).json({ error: '未找到' });
  auditSessionAccess(req.user, 'delete_session_permanent', session);
  let noticeResult = null;
  if (session.scope_type === 'research' && shouldNotifyResearchPeers(req)) {
    noticeResult = appendResearchSessionLeftNotice(session, req.user.id);
    if (noticeResult?.error) return res.status(500).json({ error: noticeResult.error });
  }
  const closed = await closeBackgroundForDelete(session, req.params.id, '永久删除');
  audit(req.user.id, 'session.permanent_delete', 'session', req.params.id,
    JSON.stringify({
      scope_type: session.scope_type || 'issue',
      research_id: session.research_id || null,
      notify_others: !!noticeResult,
      terminated: closed.terminated,
    }));
  Sessions.permanentDelete(req.params.id);
  const noticeMessage = noticeResult ? '已由 HR 在 Blackboard 写入该 Research Agent 已离开团队。' : null;
  res.json({
    ok: true,
    notified_others: !!noticeResult,
    blackboard_record_id: noticeResult?.record?.id || null,
    background_was_alive: closed.wasAlive,
    background_was_working: closed.wasWorking,
    background_terminated: closed.terminated,
    message: [noticeMessage, closed.message].filter(Boolean).join('\n') || null,
  });
});

router.post('/:id/terminate', auth, async (req, res) => {
  const session = findSessionOperable(req.params.id, req.user);
  if (!session) return res.status(404).json({ error: '未找到' });
  auditSessionAccess(req.user, 'terminate_session', session);

  const sid = req.params.id;
  const closed = await terminateBackgroundSession(session, sid);
  try { Sessions.setIdle(sid, session.user_id || req.user.id); } catch {}
  try {
    Messages.insertSystem(
      sid,
      closed.message,
      null,
      '终止执行',
    );
  } catch {}
  audit(req.user.id, 'session.terminate', 'session', sid,
    JSON.stringify({
      was_alive: closed.wasAlive,
      was_working: closed.wasWorking,
      terminated: closed.terminated,
    }));

  res.json({
    ok: true,
    background_was_alive: closed.wasAlive,
    background_was_working: closed.wasWorking,
    background_terminated: closed.terminated,
    message: closed.message,
  });
});

router.post('/:id/stop', auth, async (req, res) => {
  const session = findSessionOperable(req.params.id, req.user);
  if (!session) return res.status(404).json({ error: '未找到' });
  auditSessionAccess(req.user, 'stop_session', session);

  const sessionId = req.params.id;
  const backend = backendForSession(session);
  let workDir;
  let flagRoot;
  try {
    const workspace = resolveSessionWorkspace(req.user, sessionId);
    if (!workspace.error) {
      workDir = workspace.workDir;
      flagRoot = workspace.projectRoot || workspace.workDir;
    }
  } catch {}

  let ok = true;
  try {
    await backend.pauseCurrentAndResumeFromSession({
      sessionId,
      prompt: '',
      cwd: workDir || undefined,
      flagRoot: flagRoot || workDir || undefined,
    });
  } catch (e) {
    ok = false;
    console.warn('[sessions/stop] stop failed:', e.message);
  }

  try { Sessions.setIdle(sessionId, session.user_id || req.user.id); } catch {}
  try {
    Messages.insertSystem(
      sessionId,
      ok ? '已发 C-c × 3 给后台智能体 (软停).' : 'Stop 失败.',
      null,
      '终止执行',
    );
  } catch {}

  res.json({ ok, task_id: sessionId });
});

router.get('/:id/events', authOrQuery, async (req, res) => {
  const sessionId = req.params.id;
  const session = findSessionReadable(sessionId, req.user);
  if (!session) return res.status(404).json({ error: `session ${sessionId} 不存在或不属于你` });
  auditSessionAccess(req.user, 'read_session_events', session);

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  if (req.socket) req.socket.setTimeout(0);

  let closed = false;
  let unsub = null;
  const keepalive = setInterval(() => writeSseComment(res, 'keepalive'), 25000);
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    if (unsub) { try { unsub(); } catch {} }
    unsub = null;
  };
  const endStream = () => {
    cleanup();
    if (!res.writableEnded && !res.destroyed) {
      try { res.end(); } catch {}
    }
  };

  res.on('close', cleanup);

  try {
    const backend = backendForSession(session);
    const workspace = resolveSessionWorkspace(req.user, sessionId);

    if (!writeSseComment(res, 'connected')) return endStream();

    const subscribed = await writeSse(res, 'subscribed', {
      event: 'subscribed',
      session: shapeSessionForStream(session),
    });
    if (!subscribed || closed) return endStream();

    const history = Messages.listForTask(sessionId, 200);
    const historySent = await writeSse(res, 'history', {
      event: 'history',
      messages: history,
      total: history.length,
    });
    if (!historySent || closed) return endStream();

    if (workspace.error) {
      await writeSse(res, 'server_error', {
        event: 'error',
        message: workspace.error,
        category: 'workspace',
      });
      return endStream();
    }

    // count-then-tail: 先发 cheap total (不 parse, 只数 \n), 让前端立刻显示 "N entries / X 轮".
    // 然后只回灌末尾 DEFAULT_HISTORY_TAIL 条; 用户点 "展开全部" 时再走 REST 补齐.
    // 默认 full=0; ?full=1 走旧路径 (一次性回灌全部, 最多 maxLines).
    const fullHistory = String(req.query.full || '') === '1';
    let metaTotal = 0;
    let metaApproximate = false;
    if (!fullHistory) {
      try {
        const histPath = typeof backend._resolveJsonlPath === 'function'
          ? backend._resolveJsonlPath(sessionId)
          : null;
        if (histPath) {
          const counted = countMergedJsonl(histPath);
          metaTotal = counted.total;
          metaApproximate = counted.totalApproximate;
          const metaSent = await writeSse(res, 'jsonl_meta', {
            event: 'jsonl_meta',
            session_id: sessionId,
            total: metaTotal,
            total_approximate: metaApproximate,
            tail_count: DEFAULT_HISTORY_TAIL,
          });
          if (!metaSent || closed) return endStream();
        }
      } catch (e) {
        console.warn(`[sessions/events] jsonl_meta count failed (${sessionId}): ${e.message}`);
      }
    }

    const histOpts = fullHistory ? {} : { tailCount: DEFAULT_HISTORY_TAIL };
    const hist = backend.getHistory(sessionId, histOpts);
    // 把 cheap total 覆盖回 hist.total, 让 sendSseJsonlHistory 的 baseMeta.total 跟 jsonl_meta 一致.
    if (!fullHistory && metaTotal > 0) {
      hist.total = metaTotal;
      hist.totalApproximate = metaApproximate;
      hist.truncated = metaTotal > (hist.entries?.length || 0);
    }
    const jsonlHistorySent = await sendSseJsonlHistory(res, sessionId, hist);
    if (!jsonlHistorySent || closed) return endStream();

    unsub = backend.getAgentRawThoughtStream(
      sessionId,
      (entry) => {
        writeSse(res, 'jsonl_entry', { event: 'jsonl_entry', session_id: sessionId, entry }).catch(() => cleanup());
        if (isTurnCompleteEntry(entry)) {
          writeSse(res, 'typing', { event: 'typing', active: false }).catch(() => cleanup());
          try {
            db.prepare('UPDATE sessions_v2 SET agent_status=?, last_agent_event=strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE session_id=?')
              .run('idle', sessionId);
          } catch {}
        }
      },
      { fromSentinel: hist.sentinel },
    );
  } catch (e) {
    console.warn(`[sessions/events] stream failed (${sessionId}): ${e.message}`);
    try { await writeSse(res, 'server_error', { event: 'error', message: e.message || String(e) }); } catch {}
    endStream();
  }
});

// jsonl-history REST — "展开全部" 时按需补齐. SSE 默认只回灌末尾 DEFAULT_HISTORY_TAIL,
// 前端要看完整历史时调用这个端点拉指定窗口 [from, from+limit).
router.get('/:id/jsonl-history', auth, (req, res) => {
  const session = findSessionReadable(req.params.id, req.user);
  if (!session) return res.status(404).json({ error: '未找到' });
  auditSessionAccess(req.user, 'read_session_jsonl_history', session);

  const backend = backendForSession(session);
  const histPath = typeof backend._resolveJsonlPath === 'function'
    ? backend._resolveJsonlPath(req.params.id)
    : null;
  if (!histPath) {
    return res.json({ entries: [], total: 0, from: 0, returned: 0, has_more: false });
  }

  const fromIndex = Math.max(0, Math.floor(Number(req.query.from) || 0));
  const requestedLimit = Math.floor(Number(req.query.limit) || DEFAULT_HISTORY_TAIL);
  const limit = Math.max(0, Math.min(MAX_HISTORY_FETCH, requestedLimit));

  try {
    const slice = readMergedJsonlSlice(histPath, { fromIndex, limit });
    if (slice.exceeded) {
      return res.status(413).json({
        error: 'jsonl 文件超过安全上限, 无法整文件解析. 请联系管理员或缩小窗口.',
        total: slice.total,
      });
    }
    return res.json({
      session_id: req.params.id,
      entries: slice.entries,
      total: slice.total,
      from: slice.from,
      returned: slice.returned,
      has_more: slice.from + slice.returned < slice.total,
    });
  } catch (e) {
    console.warn(`[sessions/jsonl-history] failed (${req.params.id}): ${e.message}`);
    return res.status(500).json({ error: e.message || String(e) });
  }
});

function sessionJsonlPath(session, sessionId) {
  const backend = backendForSession(session);
  return typeof backend._resolveJsonlPath === 'function'
    ? backend._resolveJsonlPath(sessionId)
    : null;
}

router.post('/:id/predicted-next-questions', auth, async (req, res) => {
  const sessionId = req.params.id;
  const session = findSessionOperable(sessionId, req.user);
  if (!session) return res.status(404).json({ error: '未找到' });
  auditSessionAccess(req.user, 'predict_next_questions', session);

  const jsonlPath = sessionJsonlPath(session, sessionId);
  try {
    const result = await predictNextQuestionsForSession({ session, jsonlPath });
    return res.json({
      session_id: sessionId,
      questions: result.questions,
      meta: result.meta,
    });
  } catch (e) {
    const status = Number(e?.status) || 500;
    return res.status(status).json({ error: e?.message || String(e) });
  }
});

function featureWorkspaceForSession(user, sessionId) {
  const workspace = resolveSessionWorkspace(user, sessionId);
  if (workspace.error) return { workspace, workDir: null, gitRoot: null, error: workspace.error };
  let gitRoot = null;
  try { gitRoot = gitTopLevel(workspace.workDir); } catch {}
  return { workspace, workDir: workspace.workDir, gitRoot, error: null };
}

function queryFiles(value) {
  if (Array.isArray(value)) return value.map((v) => String(v || '')).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

// 从当前 session 的 codex / claude-code JSONL 中抽取文件修改特征.
// 特征缓存写入同目录同名 .feature.jsonl; diff 内容不写缓存, 由 /features/git-diff 实时问 git.
router.get('/:id/features/files', auth, (req, res) => {
  const sessionId = req.params.id;
  const session = findSessionReadable(sessionId, req.user);
  if (!session) return res.status(404).json({ error: '未找到' });
  auditSessionAccess(req.user, 'read_session_file_features', session);

  const jsonlPath = sessionJsonlPath(session, sessionId);
  if (!jsonlPath) {
    return res.json({
      session_id: sessionId,
      files: [],
      total: 0,
      appended: 0,
      source_jsonl: null,
      feature_jsonl: null,
      workspace_error: null,
    });
  }

  try {
    const scanned = sessionFeatures.scanSessionFeatures(jsonlPath);
    const workspace = featureWorkspaceForSession(req.user, sessionId);
    const files = sessionFeatures.summarizeFileChanges(scanned.entries, {
      workDir: workspace.workDir,
      gitRoot: workspace.gitRoot,
    });
    return res.json({
      session_id: sessionId,
      files,
      total: files.length,
      appended: scanned.appended,
      scanned_from_offset: scanned.scanned_from_offset,
      source_jsonl: scanned.source_jsonl,
      feature_jsonl: scanned.feature_jsonl,
      git_root: workspace.gitRoot,
      workspace_error: workspace.error,
    });
  } catch (e) {
    console.warn(`[sessions/features/files] failed (${sessionId}): ${e.message}`);
    return res.status(500).json({ error: e.message || String(e) });
  }
});

// 从当前 session JSONL 中抽取 Bash / shell 命令特征, 按时间顺序返回.
router.get('/:id/features/bash', auth, (req, res) => {
  const sessionId = req.params.id;
  const session = findSessionReadable(sessionId, req.user);
  if (!session) return res.status(404).json({ error: '未找到' });
  auditSessionAccess(req.user, 'read_session_bash_features', session);

  const jsonlPath = sessionJsonlPath(session, sessionId);
  if (!jsonlPath) {
    return res.json({
      session_id: sessionId,
      commands: [],
      total: 0,
      appended: 0,
      source_jsonl: null,
      feature_jsonl: null,
    });
  }

  try {
    const scanned = sessionFeatures.scanSessionFeatures(jsonlPath);
    const commands = sessionFeatures.listBashCommands(scanned.entries);
    return res.json({
      session_id: sessionId,
      commands,
      total: commands.length,
      appended: scanned.appended,
      scanned_from_offset: scanned.scanned_from_offset,
      source_jsonl: scanned.source_jsonl,
      feature_jsonl: scanned.feature_jsonl,
    });
  } catch (e) {
    console.warn(`[sessions/features/bash] failed (${sessionId}): ${e.message}`);
    return res.status(500).json({ error: e.message || String(e) });
  }
});

// 按文件修改特征清单限定路径, 实时读取 git diff.
// mode: unstaged | staged | last_commit | last_two_commits
router.get('/:id/features/git-diff', auth, (req, res) => {
  const sessionId = req.params.id;
  const session = findSessionReadable(sessionId, req.user);
  if (!session) return res.status(404).json({ error: '未找到' });
  auditSessionAccess(req.user, 'read_session_feature_git_diff', session);

  const jsonlPath = sessionJsonlPath(session, sessionId);
  if (!jsonlPath) {
    return res.json({ session_id: sessionId, mode: sessionFeatures.normalizeDiffMode(req.query.mode), diffs: [], files: [] });
  }

  try {
    const scanned = sessionFeatures.scanSessionFeatures(jsonlPath);
    const workspace = featureWorkspaceForSession(req.user, sessionId);
    if (workspace.error) return res.status(400).json({ error: workspace.error });

    const files = sessionFeatures.summarizeFileChanges(scanned.entries, {
      workDir: workspace.workDir,
      gitRoot: workspace.gitRoot,
    });
    const allowed = new Map();
    for (const file of files) {
      allowed.set(file.path, file.path);
      allowed.set(file.display_path, file.path);
      for (const original of file.original_paths || []) allowed.set(original, file.path);
    }

    const requested = queryFiles(req.query.file);
    const targetFiles = requested.length
      ? requested.map((file) => allowed.get(file)).filter(Boolean)
      : files.map((file) => file.path);
    if (requested.length && targetFiles.length === 0) {
      return res.status(400).json({ error: '请求的文件不在当前 Session 文件修改清单中' });
    }

    const result = sessionFeatures.gitDiffForFiles(
      workspace.workDir,
      [...new Set(targetFiles)],
      req.query.mode,
    );
    return res.json({
      session_id: sessionId,
      files,
      ...result,
    });
  } catch (e) {
    console.warn(`[sessions/features/git-diff] failed (${sessionId}): ${e.message}`);
    return res.status(500).json({ error: e.message || String(e) });
  }
});

// 进程存活 + PID — 前端轮询此接口作为"是否执行中"的唯一真相源.
// 不读 sessions_v2.agent_status (那个不可靠), 直接问 agent backend.
// (agents/backend 已在文件顶部 require, 删除路由也用到.)
router.get('/:id/status', auth, (req, res) => {
  const session = findSessionReadable(req.params.id, req.user);
  if (!session) return res.status(404).json({ error: '未找到' });
  auditSessionAccess(req.user, 'read_session_status', session);
  const backend = backendForSession(session);
  const alive = backend.isAlive(req.params.id);
  // working: 进程活的前提下, 是否还在 turn 中. alive && !working = "alive 待命".
  const working = alive && backend.isWorking(req.params.id);
  let pid = null;
  if (alive) {
    const found = backend.listSessions().find(s => s.sessionId === req.params.id);
    pid = found?.pid ?? null;
  }
  // 任务标记位: running.flag 在 → 未完成; 删除且无 failed.flag → 已结束(成功);
  // failed.flag 在 → 失败. 三者据 flag 文件判定.
  // 真相源优先用项目 bind_path 仓库根直接看 flag 文件 (运行时无关 — reopen 的
  // 历史会话/后端没 runtime 条目时也准, 比 backend.isXxx 只认 runtime map 更可靠);
  // 没 bind_path 才回退到 backend 抽象方法.
  let jobAccomplished, jobFailed, failedReason = '', failedAt = null;
  const proj = session.project_id ? Projects.findById(session.project_id) : null;
  const root = (proj && proj.bind_path) ? path.resolve(proj.bind_path) : null;
  const issue = session.issue_id ? Issues.findById(session.issue_id) : null;
  const worktreeIgnored = !!(issue?.use_worktree && root && !isGitRepoRoot(root));
  if (root) {
    try {
      jobAccomplished = readJobFlagState(root, req.params.id).accomplished;
    }
    catch { jobAccomplished = backend.isJobGoalAccomplished(req.params.id); }
    try {
      const st = readJobFlagState(root, req.params.id);
      jobFailed = st.failed;
      failedReason = st.failedReason;
      failedAt = st.failedAt || null;
    }
    catch { jobFailed = backend.isFailed(req.params.id); }
  } else {
    jobAccomplished = backend.isJobGoalAccomplished(req.params.id);
    jobFailed = backend.isFailed(req.params.id);
  }

  // 错误扫描: agent 进程在但当前不在 turn 中 (isWorking=false), 且 .mobius.jsonl
  // 末条不是 error (去重) 时, 调 backend.getRecentError 扫 TUI 屏幕.
  // 命中则追加一条 type:'error' 到 .mobius.jsonl, 前端经 SSE 自然收到并以红色卡片渲染.
  // tmux-claude-code 的 getRecentError 恒 null, 整段自动跳过.
  if (alive && !working) {
    try {
      const jsonlPath = backend._lookupPersistedJsonlPath(req.params.id)
      if (jsonlPath && readLastMobiusEntryType(jsonlPath) !== 'error') {
        const err = backend.getRecentError(req.params.id)
        if (err) {
          const p = backend._lookupPersistedEntry(req.params.id) || {}
          appendMobiusErrorEntry({
            jsonlPath,
            sessionId: req.params.id,
            agentSessionId: p.agentSessionId || null,
            cwd: p.cwd || null,
            backendName: backend.name,
            error: err,
          })
          console.log(`[sessions/status] error_scan hit sid=${req.params.id} backend=${backend.name} msg="${String(err.message).slice(0, 120)}"`)
        }
      }
    } catch (e) {
      console.warn(`[sessions/status] error_scan failed sid=${req.params.id}: ${e.message}`)
    }
  }

  res.json({
    session_id: req.params.id,
    alive,
    working,
    job_accomplished: jobAccomplished,
    failed: jobFailed,
    failed_reason: failedReason || null,
    failed_at: failedAt || null,
    pid,
    agent_backend: backend.name,
    use_proxy: useProxyForSession(session, backend),
    claude_session_id: session.claude_session_id || null,
    worktree_ignored: worktreeIgnored,
  });
});

router.get('/:id/turns', auth, (req, res) => {
  const session = findSessionReadable(req.params.id, req.user);
  if (!session) return res.status(404).json({ error: '未找到' });
  auditSessionAccess(req.user, 'read_session_turns', session);
  res.json(Messages.turnsForSession(req.params.id));
});

router.get('/:id/inputs', auth, (req, res) => {
  const session = findSessionReadable(req.params.id, req.user);
  if (!session) return res.status(404).json({ error: '未找到' });
  auditSessionAccess(req.user, 'read_session_inputs', session);
  if (!session.project_id) return res.status(400).json({ error: '当前 Session 未关联项目, 无法读取输入回放' });

  const project = Projects.findById(session.project_id);
  const bindPath = (project?.bind_path || '').trim();
  if (!bindPath) return res.status(400).json({ error: '当前 Session 所属项目未配置 bind_path, 无法读取输入回放' });

  try {
    const { entries, filePath } = readSessionInputs(bindPath, req.params.id);
    const fileTurns = new Set(
      entries
        .map((entry) => Number(entry?.turn_number))
        .filter((turn) => Number.isFinite(turn) && turn > 0)
    );
    const fileTextKeys = new Set(
      entries
        .map((entry) => String(entry?.input_text || entry?.content || '').trim())
        .filter(Boolean)
    );
    const dbEntries = Messages.userInputsForTask(req.params.id)
      .filter((row) => {
        const turn = Number(row?.turn_number);
        if (Number.isFinite(turn) && turn > 0 && fileTurns.has(turn)) return false;
        const text = String(row?.content || '').trim();
        return text && !fileTextKeys.has(text);
      })
      .map((row) => ({
        id: `message-${row.id}`,
        session_id: req.params.id,
        input_text: '',
        content: row.content || '',
        created_at: row.created_at || '',
        request_id: null,
        turn_number: Number.isFinite(Number(row.turn_number)) ? Number(row.turn_number) : null,
      }));
    const newestFirst = entries.concat(dbEntries).sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    res.json({ entries: newestFirst, file_path: filePath });
  } catch (e) {
    res.status(500).json({ error: e.message || '读取输入回放失败', file_path: e.filePath || null });
  }
});

// 注入预览/快照:
//   - 已写过快照 (首轮发过消息): 返回快照本体, applied=true
//   - 未写过快照 (从未发消息): 按 Session 创建时保存的选择快照构建, applied=false
router.get('/:id/context-preview', auth, (req, res) => {
  const session = findSessionReadable(req.params.id, req.user);
  if (!session) return res.status(404).json({ error: '未找到' });
  auditSessionAccess(req.user, 'read_session_context_preview', session);

  const userMsgCount = Messages.countUserMessagesFor(req.params.id);
  const snap = Sessions.getContextSnapshot(req.params.id);
  if (snap && snap.context_snapshot_at) {
    let sources = null;
    try { sources = snap.context_snapshot_sources ? JSON.parse(snap.context_snapshot_sources) : null; } catch {}
    return res.json({
      body: snap.context_snapshot_body || '',
      sources,
      applied: true,
      pending: false,
      snapshot_at: snap.context_snapshot_at,
      user_message_count: userMsgCount,
    });
  }

  const ctx = buildSessionContext(req.user, req.params.id);
  res.json({
    body: ctx.body,
    sources: ctx.sources,
    applied: false,
    pending: userMsgCount === 0,
    snapshot_at: null,
    user_message_count: userMsgCount,
  });
});

// Session 右栏 Skill / Memory 只读快照:
// 新 Session 直接读创建时写入的 session_selection_snapshot.
// 老 Session 没有该字段时, 优先回退到首轮 context 快照; 再没有才实时构建一次作为兼容展示.
router.get('/:id/selection-snapshot', auth, (req, res) => {
  const session = findSessionReadable(req.params.id, req.user);
  if (!session) return res.status(404).json({ error: '未找到' });
  auditSessionAccess(req.user, 'read_session_selection_snapshot', session);

  const stripBodies = (snapshot) => {
    const src = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const skills = Array.isArray(src.skills) ? src.skills : [];
    const memories = Array.isArray(src.memories) ? src.memories : [];
    const allSkills = Array.isArray(src.all_skills) ? src.all_skills : skills.map((s) => ({ ...s, enabled: true }));
    const allMemories = Array.isArray(src.all_memories) ? src.all_memories : memories.map((m) => ({ ...m, enabled: true }));
    const totals = src.totals && typeof src.totals === 'object' ? src.totals : {};
    const mapSkill = (s) => ({
      id: s.id,
      scope: s.scope,
      name: s.name,
      description: s.description || '',
      dirName: s.dirName || null,
      enabled: s.enabled !== false,
    });
    const mapMemory = (m) => ({
      id: m.id,
      scope: m.scope,
      name: m.name,
      description: m.description || '',
      enabled: m.enabled !== false,
    });
    return {
      version: src.version || 1,
      skills: skills.map((s) => mapSkill({ ...s, enabled: true })).filter((s) => s.id && s.name),
      memories: memories.map((m) => mapMemory({ ...m, enabled: true })).filter((m) => m.id && m.name),
      all_skills: allSkills.map(mapSkill).filter((s) => s.id && s.name),
      all_memories: allMemories.map(mapMemory).filter((m) => m.id && m.name),
      totals: {
        skills: Number.isFinite(Number(totals.skills)) ? Number(totals.skills) : allSkills.length,
        memories: Number.isFinite(Number(totals.memories)) ? Number(totals.memories) : allMemories.length,
      },
    };
  };

  const stored = Sessions.getSelectionSnapshot(req.params.id);
  if (stored?.session_selection_snapshot) {
    try {
      return res.json({
        snapshot: stripBodies(JSON.parse(stored.session_selection_snapshot)),
        snapshot_at: stored.session_selection_snapshot_at || null,
        source: 'created',
        legacy: false,
      });
    } catch (e) {
      console.warn(`[sessions] selection snapshot parse failed (${req.params.id}): ${e.message}`);
    }
  }

  const snap = Sessions.getContextSnapshot(req.params.id);
  if (snap?.context_snapshot_sources) {
    try {
      const sources = JSON.parse(snap.context_snapshot_sources);
      return res.json({
        snapshot: stripBodies({
          skills: sources?.skills || [],
          memories: sources?.memories || [],
          totals: { skills: (sources?.skills || []).length, memories: (sources?.memories || []).length },
        }),
        snapshot_at: snap.context_snapshot_at || null,
        source: 'context',
        legacy: true,
      });
    } catch (e) {
      console.warn(`[sessions] context snapshot sources parse failed (${req.params.id}): ${e.message}`);
    }
  }

  const ctx = buildSessionContext(req.user, req.params.id);
  res.json({
    snapshot: stripBodies({
      skills: ctx.sources?.skills || [],
      memories: ctx.sources?.memories || [],
      totals: {
        skills: ctx.sources?.selection_totals?.skills ?? (ctx.sources?.skills || []).length,
        memories: ctx.sources?.selection_totals?.memories ?? (ctx.sources?.memories || []).length,
      },
    }),
    snapshot_at: null,
    source: 'live',
    legacy: true,
  });
});

// 向 Session 提交一条用户消息.
// 行为与旧 chat socket handleSend 保持一致:
//   1) 鉴权 + 解析 workspace
//   2) Messages.insertUser + 分配 turn_number
//   3) appendSessionInput (input_text 落盘, 可选)
//   4) 首轮注入 context (skill + memory) → wrapUserMessage
//   5) backend.noPauseCurrentAndQueueQueryAtSession 推到 TUI
//   6) 同步 backend 内部 agent session id 回 DB
// 不做流式响应 — 请求成功即表示后端已接收; 后续 jsonl 由 /api/sessions/:id/events SSE 推送.
// Body: { content: string, input_text?: string, request_id?: string, attachments?: Array }
router.post('/:id/messages', auth, async (req, res) => {
  const sessionId = req.params.id;
  const content = typeof req.body?.content === 'string' ? req.body.content : '';
  const requestId = typeof req.body?.request_id === 'string' ? req.body.request_id : null;
  const hasInputText = Object.prototype.hasOwnProperty.call(req.body || {}, 'input_text');
  const inputText = hasInputText ? String(req.body.input_text || '') : '';

  try {
    const result = await runSessionMessage({
      user: req.user,
      sessionId,
      content,
      inputText,
      hasInputText,
      requestId,
      attachments: req.body?.attachments,
      source: 'http.session.messages',
      logger: console,
    });
    auditSessionAccess(req.user, 'send_session_message', Sessions.findById(sessionId));
    return res.json(result);
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message || '启动失败', category: e.category || undefined });
  }
});

// 嵌在 /api/issues/:issueId/sessions 下
const issueScoped = express.Router({ mergeParams: true });

issueScoped.get('/', auth, (req, res) => {
  const issue = Issues.findById(req.params.issueId);
  if (!issue) return res.status(404).json({ error: '未找到' });
  if (!canReadIssue(req.user, issue)) return res.status(404).json({ error: '未找到' });
  const list = Sessions.listForIssue(req.params.issueId).filter((session) => canReadSession(req.user, session));
  // 列表里的 session 多数已不在后端 runtime (历史会话), 故不走 backend.isXxx
  // (那依赖 runtime map), 直接按项目 bind_path 仓库根看 flag 文件 — 运行时无关,
  // 历史会话也能正确反映最终态. running.flag 在=未结束; 不在=已结束; failed.flag 在=失败.
  // 无 bind_path → 两字段给 null, 前端回退到原 agent_status 显示 (不破坏现状).
  const proj = issue.project_id ? Projects.findById(issue.project_id) : null;
  const root = (proj && proj.bind_path) ? path.resolve(proj.bind_path) : null;
  const enriched = list.map((s) => {
    let job_accomplished = null;
    let job_failed = null;
    if (root) {
      try {
        job_accomplished = readJobFlagState(root, s.session_id).accomplished;
      } catch {}
      try {
        job_failed = readJobFlagState(root, s.session_id).failed;
      } catch {}
    }
    return { ...withSessionProxyState(s), job_accomplished, job_failed };
  });
  res.json(enriched);
});

issueScoped.post('/', auth, async (req, res) => {
  const issue = Issues.findById(req.params.issueId);
  if (!issue) return res.status(404).json({ error: '未找到' });
  if (!canCreateSessionForIssue(req.user, issue)) return res.status(403).json({ error: '无权在此 Issue 创建 Session' });

  const { name, description, excluded_skill_ids, excluded_memory_ids, model, language } = req.body;
  if (!name) return res.status(400).json({ error: '请填写会话名称' });

  // 前端传内置短键或管理员导入模型 key; 非法/缺省回退默认模型.
  // 导入模型仍来自管理员白名单, 不直接把用户串塞进 --model.
  const resolvedModel = modelRegistry.resolveSessionModelForCreate(model);
  if (!resolvedModel) {
    return res.status(503).json({ error: '没有可用的模型，请先在管理后台配置模型（或检查 ~/.claude/mobiusdefault.settings.json 是否存在）' });
  }
  const limitCheck = modelPromptLimits.checkCreateAllowed(req.user.id, resolvedModel.key);
  if (!limitCheck.allowed) {
    return res.status(limitCheck.status).json({
      error: limitCheck.error,
      code: limitCheck.code,
      usage: limitCheck.usage,
    });
  }
  // 注入上下文语言: 仅 zh/en, 缺省中文.
  const sessionLanguage = language === 'en' ? 'en' : 'zh';

  const sessionId = uuid().slice(0, 8);
  const sessionKey = `web:${req.user.id}:${sessionId}`;

  // Wizard 勾选状态: 用户在 Issue 默认集合上取消勾选的 skill/memory id 列表.
  // 留空 = 全部启用 (兼容现有调用方).
  const sanitizeIds = (arr) => Array.isArray(arr) ? arr.filter(x => typeof x === 'string' && x.length > 0) : [];
  const excludedSkillIds = sanitizeIds(excluded_skill_ids);
  const excludedMemoryIds = sanitizeIds(excluded_memory_ids);
  const selectionSnapshot = buildSessionSelectionSnapshot(req.user, req.params.issueId, excludedSkillIds, excludedMemoryIds);
  const continueFromSessionId = typeof req.body?.continue_from_session_id === 'string'
    ? req.body.continue_from_session_id.trim()
    : '';
  let sourceSession = null;
  let transferResult = null;
  if (continueFromSessionId) {
    sourceSession = findSessionOperable(continueFromSessionId, req.user);
    if (!sourceSession) return res.status(404).json({ error: '旧 Session 不存在或无权操作' });
    if (sourceSession.issue_id !== req.params.issueId || sourceSession.scope_type !== 'issue') {
      return res.status(400).json({ error: '只能从当前 Issue 下的旧 Session 继续' });
    }
    const project = Projects.findById(issue.project_id);
    const bindPath = (project?.bind_path || '').trim();
    if (!bindPath) return res.status(400).json({ error: '当前项目未绑定路径, 无法创建 Session 转接文档' });
    const jsonlPath = sessionJsonlPath(sourceSession, continueFromSessionId);
    if (!jsonlPath) return res.status(400).json({ error: '旧 Session 没有可读取的 JSONL 记录' });
    try {
      transferResult = writeSessionTransferDocument({
        bindPath,
        sourceSession,
        targetSessionId: sessionId,
        jsonlPath,
      });
    } catch (e) {
      console.warn(`[sessions] create transfer document failed (${continueFromSessionId}): ${e.message}`);
      return res.status(500).json({ error: e.message || '创建 Session 转接文档失败' });
    }
  }

  Sessions.insert({
    session_id: sessionId,
    issue_id: req.params.issueId,
    project_id: issue.project_id,
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
  if (sourceSession && transferResult?.filePath) {
    try {
      Messages.insertSystem(
        sessionId,
        JSON.stringify({
          type: 'session_transfer',
          from_session_id: sourceSession.session_id,
          path: transferResult.filePath,
          section_count: transferResult.sectionCount,
          entry_count: transferResult.entryCount,
          truncated: transferResult.truncated,
        }),
        null,
        'session_transfer',
      );
    } catch (e) {
      console.warn(`[sessions] save transfer marker failed (${sessionId}): ${e.message}`);
    }
    const closed = await terminateBackgroundSession(sourceSession, sourceSession.session_id);
    try {
      const project = Projects.findById(issue.project_id);
      if (project?.bind_path) safeRemoveRunningFlag(path.resolve(project.bind_path), sourceSession.session_id, 'session-transfer');
    } catch {}
    try { Sessions.setIdle(sourceSession.session_id, sourceSession.user_id || req.user.id); } catch {}
    try {
      Messages.insertSystem(
        sourceSession.session_id,
        `${closed.message}\n已创建更换模型继续的转接文档: ${transferResult.filePath}`,
        null,
        '修改模型并继续',
      );
    } catch {}
    audit(req.user.id, 'session.continue_with_model', 'session', sessionId,
      JSON.stringify({
        from_session_id: sourceSession.session_id,
        transfer_path: transferResult.filePath,
        background_was_alive: closed.wasAlive,
        background_was_working: closed.wasWorking,
        background_terminated: closed.terminated,
      }));
    const startContent = [name, description].map((part) => String(part || '').trim()).filter(Boolean).join('\n\n');
    if (startContent) {
      try {
        await runSessionMessage({
          user: req.user,
          sessionId,
          content: startContent,
          inputText: startContent,
          hasInputText: true,
          requestId: `continue-${sourceSession.session_id}-${Date.now()}`,
          source: 'http.session.continue_with_model',
          logger: console,
        });
      } catch (e) {
        console.warn(`[sessions] auto start continued session failed (${sessionId}): ${e.message}`);
        return res.status(e.status || 500).json({ error: e.message || '启动新 Session 失败', category: e.category || undefined });
      }
    }
  }
  recordAdminAuditIfCrossUser(req.user, 'create_session', 'issue', issue.id, issue.created_by);
  Issues.touchActiveAndIncrement(req.params.issueId);
  res.json({
    ...withSessionProxyState(Sessions.findById(sessionId)),
    continue_from_session_id: sourceSession?.session_id || null,
    transfer_path: transferResult?.filePath || null,
  });
});

module.exports = { router, issueScoped };
