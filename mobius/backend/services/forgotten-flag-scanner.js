/**
 * forgotten-flag-scanner.js — "被遗忘的 running.flag" 后台巡检任务.
 *
 * 背景:
 *   每次向 session 提交 prompt 时后端在 <bind_path>/.imac/flags/<sessionId>/running.flag
 *   落一个标记文件; agent 收工 (无论成功/失败) 时按 session-context 注入的提示
 *   自删该文件. 正常情况下 "flag 不在" == "任务结束".
 *
 *   但 agent 可能异常停止 (tmux window 被杀 / claude TUI 崩 / 机器重启 / agent
 *   自己忘了删) —— 此时 agent 已经不在工作 (isWorking=false), running.flag 却
 *   还留在磁盘上. 这类 "僵尸 flag" 会让上层 isJobGoalAccomplished 一直判
 *   "任务未结束", 是需要人工关注的异常态.
 *
 * 本任务:
 *   每 60 秒扫描所有 active session, 找出
 *       running.flag 仍存在  且  backend.isWorking(sessionId) === false
 *   的 session, 把详细诊断信息追加写入
 *       CORE_DATA_PATH/backend_worker_log/scan_forgotten_running_flag.log
 *
 *   只做"发现 + 记录", 不自动删除 flag —— 删除会掩盖真实问题, 且属于破坏性
 *   动作, 不在本需求范围内. 人工据日志判断后再处理.
 *
 * "是否在工作" 的真相源:
 *   用 agent backend 的 isWorking()/isAlive() (tmux window 存活 + jsonl 尾判),
 *   而非 sessions_v2.agent_status —— 后者代码里多处注明"不可靠".
 *
 * flag 路径不依赖 backend 的 runtime map (后端重启后未必有该 session 的内存
 * 条目), 而是直接由 DB 的 projects.bind_path 推出, 这样无论 agent 死活都能
 * 准确定位 flag 文件.
 */
const fs = require('fs');
const path = require('path');

const { db } = require('../../db');
const {
  APP_DIR,
  DEFAULT_FORGOTTEN_FLAG_MESSAGE,
  DEFAULT_FORGOTTEN_FLAG_ISSUE_INTERVAL_MINUTES,
  DEFAULT_FORGOTTEN_FLAG_RESEARCH_INTERVAL_MINUTES,
  DEFAULT_FORGOTTEN_FLAG_ISSUE_BACKOFF,
  DEFAULT_FORGOTTEN_FLAG_RESEARCH_BACKOFF,
  DEFAULT_FORGOTTEN_FLAG_ISSUE_PATIENCE,
  DEFAULT_FORGOTTEN_FLAG_RESEARCH_PATIENCE,
  FORGOTTEN_FLAG_ISSUE_INTERVAL_MINUTES_MIN,
  FORGOTTEN_FLAG_RESEARCH_INTERVAL_MINUTES_MIN,
  FORGOTTEN_FLAG_INTERVAL_MINUTES_MAX,
  FORGOTTEN_FLAG_BACKOFF_MIN,
  FORGOTTEN_FLAG_BACKOFF_MAX,
  FORGOTTEN_FLAG_PATIENCE_MIN,
  FORGOTTEN_FLAG_PATIENCE_MAX,
  BACKEND_WORKER_LOG_DIR,
} = require('../config');
const { Messages } = require('../repositories/messages');
const { Sessions } = require('../repositories/sessions');
const { resolveSessionWorkspace } = require('./workspace');
const { flagDirOf, runningFlagPathOf, failedFlagPathOf, readFailedFlag } = require('../utils/session-flags');
const adminSettings = require('./admin-settings');
const modelRegistry = require('./model-registry');
const {
  assistantSessionKeyLike,
  isAssistantSession,
} = require('./assistant-session');
const agents = require('../agents');

const SCAN_INTERVAL_MS = 60 * 1000;           // 每 60 秒一轮
const FIRST_RUN_DELAY_MS = 20 * 1000;         // 启动后先等 20s, 让 backend runtime 恢复完
const ASSISTANT_CALLBACK_ACTIVE_MS = 48 * 60 * 60 * 1000;
const SCANNER_STARTED_AT_MS = Date.now();

// 检测到 FORGOTTEN 后, 自动发给 agent 的默认提醒文案在 config.js (单一真相源,
// 前端预填用同一份). 项目可在设置里用 forgotten_flag_message 覆盖.

// 防刷/首次提醒等待: 同一个 flag 实例按 running.flag 内的稳定 runId/startedAt
// 识别, 避免自动提醒本身刷新文件 mtime 后把同一个任务误判成新 flag.
// flag 刚创建且未到 init 时也只记日志、不自动发消息.

const LOG_DIR = BACKEND_WORKER_LOG_DIR;
const LOG_FILE = path.join(LOG_DIR, 'scan_forgotten_running_flag.log');
// 通知去重状态 (跨后端重启保留): { [sessionId]: { flagKey, flagMtimeMs, lastNotifiedAt, count } }
const NOTIFY_STATE_FILE = path.join(LOG_DIR, 'forgotten_flag_notify_state.json');
// Session 生命周期回调状态 (跨后端重启保留): 记录已观察到的 running/failed flag 转换.
const LIFECYCLE_STATE_FILE = path.join(LOG_DIR, 'session_lifecycle_callback_state.json');

let timer = null;
let scanning = false;   // 防止单轮耗时过长时重入

// ── 通知去重状态: 加载 / 保存 (best-effort, 失败不阻断) ──
let notifyState = {};
function loadNotifyState() {
  try {
    if (fs.existsSync(NOTIFY_STATE_FILE)) {
      const j = JSON.parse(fs.readFileSync(NOTIFY_STATE_FILE, 'utf8'));
      if (j && typeof j === 'object') notifyState = j;
    }
  } catch (e) {
    console.warn(`[forgotten-flag-scanner] 读通知状态失败 (忽略): ${e.message}`);
  }
}
function saveNotifyState() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const tmp = `${NOTIFY_STATE_FILE}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(notifyState, null, 1));
    fs.renameSync(tmp, NOTIFY_STATE_FILE);
  } catch (e) {
    console.warn(`[forgotten-flag-scanner] 写通知状态失败 (忽略): ${e.message}`);
  }
}
loadNotifyState();

let lifecycleState = {};
function loadLifecycleState() {
  try {
    if (fs.existsSync(LIFECYCLE_STATE_FILE)) {
      const j = JSON.parse(fs.readFileSync(LIFECYCLE_STATE_FILE, 'utf8'));
      if (j && typeof j === 'object') lifecycleState = j;
    }
  } catch (e) {
    console.warn(`[forgotten-flag-scanner] 读生命周期状态失败 (忽略): ${e.message}`);
  }
}
function saveLifecycleState() {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const tmp = `${LIFECYCLE_STATE_FILE}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(lifecycleState, null, 1));
    fs.renameSync(tmp, LIFECYCLE_STATE_FILE);
  } catch (e) {
    console.warn(`[forgotten-flag-scanner] 写生命周期状态失败 (忽略): ${e.message}`);
  }
}
loadLifecycleState();

function nowIso() {
  return new Date().toISOString();
}

function appendLog(text) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, text);
  } catch (e) {
    // 日志都写不了就只能打 console, 绝不让巡检本身把进程搞挂.
    console.warn(`[forgotten-flag-scanner] 写日志失败: ${e.message}`);
  }
}

function fileExists(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

function readPathMtimeMs(p) {
  try { return Math.round(fs.statSync(p).mtimeMs); } catch { return null; }
}

function backendForSession(s) {
  return agents.get(modelRegistry.backendNameForSessionModel(s?.model));
}

function normalizeIntervalMinutes(value, fallback, min) {
  const n = Number(value);
  if (Number.isInteger(n) && n >= min && n <= FORGOTTEN_FLAG_INTERVAL_MINUTES_MAX) return n;
  return fallback;
}

function normalizeBackoff(value, fallback) {
  const n = Number(value);
  if (Number.isFinite(n) && n >= FORGOTTEN_FLAG_BACKOFF_MIN && n <= FORGOTTEN_FLAG_BACKOFF_MAX) return n;
  return fallback;
}

function normalizePatience(value, fallback) {
  const n = Number(value);
  if (Number.isInteger(n) && n >= FORGOTTEN_FLAG_PATIENCE_MIN && n <= FORGOTTEN_FLAG_PATIENCE_MAX) return n;
  return fallback;
}

function sessionScopeType(s) {
  return (s?.scope_type === 'research' || s?.research_id) ? 'research' : 'issue';
}

function notifyPolicyForSession(s) {
  if (sessionScopeType(s) === 'research') {
    return {
      scope: 'research',
      initMinutes: normalizeIntervalMinutes(
        s.forgotten_flag_research_init_minutes ?? s.forgotten_flag_research_interval_minutes,
        DEFAULT_FORGOTTEN_FLAG_RESEARCH_INTERVAL_MINUTES,
        FORGOTTEN_FLAG_RESEARCH_INTERVAL_MINUTES_MIN,
      ),
      backoff: normalizeBackoff(s.forgotten_flag_research_backoff, DEFAULT_FORGOTTEN_FLAG_RESEARCH_BACKOFF),
      patience: normalizePatience(s.forgotten_flag_research_patience, DEFAULT_FORGOTTEN_FLAG_RESEARCH_PATIENCE),
    };
  }
  return {
    scope: 'issue',
    initMinutes: normalizeIntervalMinutes(
      s.forgotten_flag_issue_init_minutes ?? s.forgotten_flag_issue_interval_minutes,
      DEFAULT_FORGOTTEN_FLAG_ISSUE_INTERVAL_MINUTES,
      FORGOTTEN_FLAG_ISSUE_INTERVAL_MINUTES_MIN,
    ),
    backoff: normalizeBackoff(s.forgotten_flag_issue_backoff, DEFAULT_FORGOTTEN_FLAG_ISSUE_BACKOFF),
    patience: normalizePatience(s.forgotten_flag_issue_patience, DEFAULT_FORGOTTEN_FLAG_ISSUE_PATIENCE),
  };
}

function notifyDelayMinutesForCount(policy, sentCount) {
  const exponent = Math.max(0, Number(sentCount) || 0);
  const raw = policy.initMinutes * Math.pow(policy.backoff, exponent);
  if (!Number.isFinite(raw)) return FORGOTTEN_FLAG_INTERVAL_MINUTES_MAX;
  return Math.min(raw, FORGOTTEN_FLAG_INTERVAL_MINUTES_MAX);
}

function formatMinutes(minutes) {
  return Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(2).replace(/\.?0+$/, '');
}

function notifyPolicySummaryForSession(s) {
  const policy = notifyPolicyForSession(s);
  return `init=${policy.initMinutes}min, backoff=${policy.backoff}, patience=${policy.patience}`;
}

// 读 flag 文件内容 + 落盘时间, 失败不抛.
function readFlagMeta(flagPath) {
  const meta = { content: null, mtime: null, mtimeMs: null, ageSec: null, startedAt: null, runId: null };
  try {
    const st = fs.statSync(flagPath);
    meta.mtime = st.mtime.toISOString();
    meta.mtimeMs = Math.round(st.mtimeMs);
    meta.ageSec = Math.round((Date.now() - st.mtimeMs) / 1000);
  } catch {}
  try {
    meta.content = fs.readFileSync(flagPath, 'utf8').trim();
    for (const line of meta.content.split('\n')) {
      const i = line.indexOf('=');
      if (i < 0) continue;
      const key = line.slice(0, i);
      const value = line.slice(i + 1);
      if (key === 'startedAt') meta.startedAt = value.trim();
      if (key === 'runId') meta.runId = value.trim();
    }
    if (!meta.runId && meta.startedAt) {
      const sessionLine = meta.content.split('\n').find((line) => line.startsWith('session='));
      const sessionId = sessionLine ? sessionLine.slice('session='.length).trim() : '';
      meta.runId = sessionId ? `${sessionId}:${meta.startedAt}` : meta.startedAt;
    }
  } catch {}
  return meta;
}

function isAssistantSourceSession(s) {
  return isAssistantSession(s);
}

function parseTimeMs(value) {
  const t = Date.parse(String(value || ''));
  return Number.isFinite(t) ? t : null;
}

function isRecentAssistantSession(session) {
  const t = parseTimeMs(session?.last_active);
  return t != null && (Date.now() - t) <= ASSISTANT_CALLBACK_ACTIVE_MS;
}

function findRecentAssistantSessionForUser(userId) {
  const row = db.prepare(`
    SELECT s.*, p.bind_path AS bind_path,
           u.display_name AS user_display_name, u.role AS user_role
    FROM sessions_v2 s
    LEFT JOIN projects p ON s.project_id = p.id
    LEFT JOIN users u ON s.user_id = u.id
    WHERE s.user_id = ?
      AND s.session_key LIKE ?
      AND s.status = 'active'
    ORDER BY s.last_active DESC, s.created_at DESC
    LIMIT 1
  `).get(userId, assistantSessionKeyLike(userId));
  return row && isRecentAssistantSession(row) ? row : null;
}

function listEnabledAdminCallbackUsers(excludeUserId) {
  const ids = adminSettings.listAdminAssistantCallbackUserIds()
    .filter((id) => id && id !== excludeUserId);
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(`
    SELECT id, display_name, role
    FROM users
    WHERE id IN (${placeholders})
      AND role = 'admin'
      AND (deleted_at IS NULL OR deleted_at = '')
  `).all(...ids);
}

function callbackTargetsForSourceSession(s) {
  const targets = [];
  const seenSessionIds = new Set();
  const addTarget = (assistantSession, kind, user) => {
    if (!assistantSession?.session_id) return;
    if (assistantSession.session_id === s.session_id) return;
    if (seenSessionIds.has(assistantSession.session_id)) return;
    seenSessionIds.add(assistantSession.session_id);
    targets.push({ kind, session: assistantSession, user });
  };

  addTarget(
    findRecentAssistantSessionForUser(s.user_id),
    'owner',
    { id: s.user_id, display_name: s.user_display_name || s.user_id, role: s.user_role || 'user' },
  );

  for (const adminUser of listEnabledAdminCallbackUsers(s.user_id)) {
    addTarget(findRecentAssistantSessionForUser(adminUser.id), 'admin', adminUser);
  }
  return targets;
}

function compactText(value, fallback = '无描述') {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

function sessionDescriptionForCallback(s) {
  return compactText(
    s.session_description
      || s.research_title
      || s.issue_title
      || s.project_name
      || s.session_name
      || '',
  );
}

function sessionLabelForCallback(s) {
  const name = compactText(s.session_name || s.issue_title || s.research_title || s.session_id, s.session_id);
  return `Session「${name}」（session id: ${s.session_id}，描述：${sessionDescriptionForCallback(s)}）`;
}

function lifecyclePromptForTarget(s, event, target) {
  const ownerName = compactText(s.user_display_name || s.user_id, s.user_id || '未知用户');
  const subject = `${target.kind === 'admin' ? `用户 ${ownerName} 的` : ''}${sessionLabelForCallback(s)}`;
  const notifyTarget = target.kind === 'admin' ? '当前管理员' : '用户';
  if (event.type === 'failed') {
    const reason = compactText(event.failedReason || '', '');
    return [
      `【${subject}】\n\n以上 Session 没有完成属于它的任务，可能遇到不可抗的困难或者故障，已经于 ${event.occurredAt} 时间结束，请你撰写消息通知${notifyTarget}。你只负责通知，不处理错误。`
      // reason ? `失败原因：${reason}` : '',
    ].filter(Boolean).join('\n');
  }
  return `【${subject}】\n\n以上 Session 已经于 ${event.occurredAt} 时间顺利完成，请你撰写消息通知${notifyTarget}。你只负责通知，不处理后续。`;
}

async function deliverLifecycleEventToAssistant({ sourceSession, event, target }) {
  const assistantSession = target.session;
  const prompt = lifecyclePromptForTarget(sourceSession, event, target);
  const launch = modelRegistry.launchOptionsForSession(assistantSession);
  const backend = agents.get(launch.backend);
  const workDir = path.resolve(assistantSession.bind_path || APP_DIR);
  const turnNum = (Messages.maxTurnFor(assistantSession.session_id) || 0) + 1;
  const mobiusJsonl = {
    source: 'assistant.lifecycle-callback',
    kind: event.type,
    content: prompt,
    inputText: prompt,
    requestId: `lifecycle:${sourceSession.session_id}:${event.key}`,
    turnNumber: turnNum,
    userId: assistantSession.user_id,
    timestamp: new Date().toISOString(),
  };

  await backend.noPauseCurrentAndQueueQueryAtSession({
    sessionId: assistantSession.session_id,
    prompt,
    cwd: workDir,
    flagRoot: workDir,
    model: launch.model || undefined,
    settingsPath: launch.settingsPath,
    forceNoProxy: launch.forceNoProxy,
    useProxy: launch.forceNoProxy ? false : launch.useProxy === true,
    codexProfileKey: launch.codexProfileKey || undefined,
    codexChannel: launch.codexChannel || undefined,
    codexConfigPath: launch.codexConfigPath || undefined,
    codexSecretEnvKey: launch.codexSecretEnvKey || undefined,
    codexSecretValue: launch.codexSecretValue || undefined,
    displayName: assistantSession.name || undefined,
    agentSessionId: assistantSession.claude_session_id || undefined,
    mobiusJsonl,
  });

  try {
    Messages.insertUser(assistantSession.session_id, prompt, turnNum);
    Sessions.touchActive(assistantSession.session_id);
  } catch (e) {
    console.warn(`[forgotten-flag-scanner] 写小莫回调消息失败 (${assistantSession.session_id}): ${e.message}`);
  }

  try {
    const runtimeInfo = backend.listSessions().find((item) => item.sessionId === assistantSession.session_id);
    const newAgentSid = runtimeInfo?.agentSessionId || null;
    if (newAgentSid && newAgentSid !== assistantSession.claude_session_id) {
      db.prepare('UPDATE sessions_v2 SET claude_session_id=? WHERE session_id=?').run(newAgentSid, assistantSession.session_id);
    }
  } catch (e) {
    console.warn(`[forgotten-flag-scanner] 同步小莫 agent session id 失败 (${assistantSession.session_id}): ${e.message}`);
  }
}

function normalizePendingLifecycleEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const type = event.type === 'failed' ? 'failed' : (event.type === 'completed' ? 'completed' : null);
  const key = String(event.key || '').trim();
  if (!type || !key) return null;
  const deliveredTo = Array.isArray(event.deliveredTo)
    ? event.deliveredTo.filter((id) => typeof id === 'string' && id.trim())
    : [];
  return {
    type,
    key,
    occurredAt: String(event.occurredAt || nowIso()),
    failedReason: typeof event.failedReason === 'string' ? event.failedReason : '',
    deliveredTo: Array.from(new Set(deliveredTo)),
  };
}

function mergePendingLifecycleEvents(existing, nextEvents) {
  const out = [];
  const seen = new Set();
  for (const raw of [...(Array.isArray(existing) ? existing : []), ...nextEvents]) {
    const event = normalizePendingLifecycleEvent(raw);
    if (!event || seen.has(event.key)) continue;
    seen.add(event.key);
    out.push(event);
  }
  return out;
}

function failedReasonFromSnapshot(snapshot) {
  const failed = snapshot.failedData || {};
  return failed.reason || failed.raw_reason || failed.error || '';
}

function collectLifecycleEvents(s, snapshot) {
  const sid = s.session_id;
  const prev = lifecycleState[sid] && typeof lifecycleState[sid] === 'object' ? lifecycleState[sid] : null;
  const pending = isAssistantSourceSession(s)
    ? []
    : (Array.isArray(prev?.pendingEvents) ? prev.pendingEvents : []);
  const newEvents = [];
  const observedAt = nowIso();

  if (!isAssistantSourceSession(s)) {
    const firstObservation = !prev;
    const failedCreated = snapshot.failedExists && (
      firstObservation
        ? (snapshot.failedMtimeMs != null && snapshot.failedMtimeMs >= SCANNER_STARTED_AT_MS)
        : (!prev.failedExists || (snapshot.failedMtimeMs != null && prev.failedMtimeMs !== snapshot.failedMtimeMs))
    );
    if (failedCreated) {
      newEvents.push({
        type: 'failed',
        key: `failed:${snapshot.failedMtimeMs || snapshot.flagDirMtimeMs || Date.now()}`,
        occurredAt: snapshot.failedData?.failedAt || snapshot.failedMeta?.mtime || observedAt,
        failedReason: failedReasonFromSnapshot(snapshot),
        deliveredTo: [],
      });
    }

    const runningRemoved = !snapshot.failedExists && !snapshot.runningExists && (
      firstObservation
        ? (snapshot.flagDirExists && snapshot.flagDirMtimeMs != null && snapshot.flagDirMtimeMs >= SCANNER_STARTED_AT_MS)
        : (prev.runningExists === true || (
            prev.flagDirMtimeMs != null
            && snapshot.flagDirMtimeMs != null
            && snapshot.flagDirMtimeMs !== prev.flagDirMtimeMs
          ))
    );
    if (runningRemoved) {
      newEvents.push({
        type: 'completed',
        key: `completed:${prev?.runningMtimeMs || snapshot.flagDirMtimeMs || Date.now()}`,
        occurredAt: observedAt,
        failedReason: '',
        deliveredTo: [],
      });
    }
  }

  const pendingEvents = mergePendingLifecycleEvents(pending, newEvents);
  lifecycleState[sid] = {
    runningExists: !!snapshot.runningExists,
    runningMtimeMs: snapshot.runningMtimeMs,
    failedExists: !!snapshot.failedExists,
    failedMtimeMs: snapshot.failedMtimeMs,
    flagDirExists: !!snapshot.flagDirExists,
    flagDirMtimeMs: snapshot.flagDirMtimeMs,
    lastObservedAt: observedAt,
    pendingEvents,
  };
  return pendingEvents;
}

async function processLifecycleEvent(sourceSession, event) {
  const sid = sourceSession.session_id;
  const state = lifecycleState[sid];
  if (!state) return { status: 'skip', detail: 'state missing' };

  const normalized = normalizePendingLifecycleEvent(event);
  if (!normalized) return { status: 'skip', detail: 'bad event' };

  const targets = callbackTargetsForSourceSession(sourceSession)
    .filter((target) => !normalized.deliveredTo.includes(target.session.session_id));
  if (!targets.length) {
    state.pendingEvents = (state.pendingEvents || []).filter((item) => item.key !== normalized.key);
    return { status: 'done', detail: 'no active assistant targets' };
  }

  const deliveredTo = new Set(normalized.deliveredTo);
  const failures = [];
  for (const target of targets) {
    try {
      await deliverLifecycleEventToAssistant({ sourceSession, event: normalized, target });
      deliveredTo.add(target.session.session_id);
    } catch (e) {
      failures.push(`${target.kind}:${target.session.session_id}:${e.message || e}`);
    }
  }

  state.pendingEvents = (state.pendingEvents || []).map((item) => {
    const normalizedItem = normalizePendingLifecycleEvent(item);
    if (!normalizedItem || normalizedItem.key !== normalized.key) return item;
    return { ...normalizedItem, deliveredTo: Array.from(deliveredTo) };
  }).filter((item) => {
    const normalizedItem = normalizePendingLifecycleEvent(item);
    if (!normalizedItem) return false;
    if (normalizedItem.key !== normalized.key) return true;
    return failures.length > 0;
  });

  if (failures.length > 0) {
    return { status: 'pending', detail: failures.join('; ') };
  }
  return { status: 'sent', detail: `targets=${targets.map((t) => `${t.kind}:${t.session.session_id}`).join(',')}` };
}

// 决定是否给某个 finding 自动发提醒, 并执行发送. 失败不抛 (不更新去重状态 →
// 下一轮会重试). 返回一行人类可读的结果串, 供日志记录.
async function maybeNotify(f) {
  const { s, fm } = f;
  const sid = s.session_id;
  const backend = backendForSession(s);
  const policy = notifyPolicyForSession(s);
  const prev = notifyState[sid];
  const flagKey = fm.runId || fm.startedAt || (fm.content ? `content:${fm.content}` : `mtime:${fm.mtimeMs || 'unknown'}`);
  const sameFlag = !!prev && (
    (prev.flagKey && prev.flagKey === flagKey) ||
    (!prev.flagKey && fm.mtimeMs != null && prev.flagMtimeMs === fm.mtimeMs)
  );
  const sentCount = sameFlag && prev ? (Number(prev.count) || 0) : 0;
  const delayMinutes = notifyDelayMinutesForCount(policy, sentCount);
  const delayMs = delayMinutes * 60 * 1000;

  // 0) tmux 窗口必须仍存活才发. 发送前重新确认 (而非沿用扫描时采的旧 isAlive,
  //    避免扫描→发送之间窗口刚死的竞态). 窗口不在 → 只记日志, 绝不发送.
  //    原因: backend 的 queue 实现在窗口不存在时会 spawn 一个全新 tmux 窗口再发,
  //    这会"凭空创建一个新 session" —— 正是用户反馈要消除的异常. 既然 agent 进程
  //    已不存在, 这条遗留 flag 只需记录待人工处理, 不该把 agent 强行拉回来.
  let aliveNow = false;
  try { aliveNow = backend.isAlive(sid) === true; } catch (e) {
    return `notify=skip (无法确认窗口存活: ${e.message}, 不发送)`;
  }
  if (!aliveNow) {
    return 'notify=skip (tmux 窗口已不存在, 仅记录; 不再 spawn 新窗口/创建新 session)';
  }

  // 1) 首次提醒等待: flag 太新 → 只记日志, 不发 (防误伤刚启动的新会话).
  if (!sameFlag && fm.ageSec != null && fm.ageSec * 1000 < delayMs) {
    return `notify=skip (flag 太新 ${fm.ageSec}s < ${formatMinutes(delayMinutes)}min 首次等待, 仅记录)`;
  }

  // 2) Patience / 冷却: 同一 flag 实例最多提醒 patience 次, 后续按 backoff 递增等待.
  if (sameFlag && sentCount >= policy.patience) {
    return `notify=skip (同一 flag 已达到 patience=${policy.patience} 次上限, 仅记录; 不改状态/不删 flag)`;
  }
  if (sameFlag && (Date.now() - (prev.lastNotifiedAt || 0)) < delayMs) {
    const mins = Math.round((Date.now() - prev.lastNotifiedAt) / 60000);
    return `notify=skip (同一 flag 已于 ${mins}min 前通知过, 未到 ${formatMinutes(delayMinutes)}min backoff 间隔, 累计 ${sentCount}/${policy.patience} 次)`;
  }

  // 3) 解析消息: 项目配置优先, 空则用默认.
  const projMsg = (typeof s.forgotten_flag_message === 'string' && s.forgotten_flag_message.trim())
    ? s.forgotten_flag_message : null;
  const message = projMsg || DEFAULT_FORGOTTEN_FLAG_MESSAGE;
  const msgSrc = projMsg ? 'project-config' : 'default';

  // 4) 解析 workspace (拿 cwd/flagRoot 供 backend "进程不在则 spawn"). 失败则
  //    回退到 bind_path 仓库根 (非 worktree 假设); window 还活时其实用不到 cwd.
  let cwd, flagRoot;
  try {
    const wsp = resolveSessionWorkspace({ id: s.user_id }, sid);
    if (!wsp.error) { cwd = wsp.workDir; flagRoot = wsp.projectRoot || wsp.workDir; }
  } catch {}
  if (!cwd && s.bind_path) { cwd = path.resolve(s.bind_path); flagRoot = cwd; }

  // 5) 发送: 此时已确认 window 存活, 直接 paste 进现有 TUI. (window 不存活的情况
  //    已在步骤 0 拦截并 skip, 不会走到这里, 故 backend 不会再 spawn 新窗口.)
  try {
    const launch = modelRegistry.launchOptionsForSession(s);
    await backend.noPauseCurrentAndQueueQueryAtSession({
      sessionId: sid,
      prompt: message,
      cwd,
      flagRoot: flagRoot || cwd,
      model: launch.model || undefined,
      settingsPath: launch.settingsPath,
      forceNoProxy: launch.forceNoProxy,
      useProxy: launch.forceNoProxy ? false : launch.useProxy === true,
      codexProfileKey: launch.codexProfileKey || undefined,
      codexChannel: launch.codexChannel || undefined,
      codexConfigPath: launch.codexConfigPath || undefined,
      codexSecretEnvKey: launch.codexSecretEnvKey || undefined,
      codexSecretValue: launch.codexSecretValue || undefined,
      displayName: s.session_name || undefined,
      agentSessionId: s.claude_session_id || undefined,
    });
  } catch (e) {
    return `notify=FAIL (backend 发送失败: ${e.message})`;
  }

  // 6) 记到会话里 (system 消息, 前端可见), 与普通系统提醒同款做法.
  try {
    const turnNum = (Messages.maxTurnFor(sid) || 0) + 1;
    Messages.insertSystem(
      sid,
      `[自动提醒] 检测到 running.flag 仍存在但 agent 已停工, 已自动向本会话发送提醒消息 (来源: ${msgSrc}):\n\n${message}`,
      turnNum,
      '⚠️ 被遗忘的 running.flag · 自动提醒',
    );
  } catch (e) {
    console.warn(`[forgotten-flag-scanner] 写 system 消息失败 (${sid}): ${e.message}`);
  }

  // 7) 更新去重状态并持久化.
  const count = (sameFlag && prev ? prev.count : 0) + 1;
  notifyState[sid] = { flagKey, flagMtimeMs: fm.mtimeMs, flagStartedAt: fm.startedAt || null, lastNotifiedAt: Date.now(), count };
  saveNotifyState();

  return `notify=SENT (src=${msgSrc}, init=${policy.initMinutes}min, backoff=${policy.backoff}, patience=${policy.patience}, scope=${policy.scope}, flagKey=${JSON.stringify(flagKey)}, paste-到现有TUI, 第 ${count} 次, 字数=${message.length})`;
}

// 单轮扫描.
async function scanOnce() {
  if (scanning) {
    appendLog(`[${nowIso()}] (skip) 上一轮扫描尚未结束, 跳过本轮\n`);
    return;
  }
  scanning = true;
  const startedAt = Date.now();
  try {
    // 所有 active session, 带 bind_path / 项目名 / issue 标题 / 项目自定义提醒
    // 文案 / model / claude_session_id (后两者供自动发消息用).
    const sessions = db.prepare(`
      SELECT s.session_id, s.user_id, s.name AS session_name,
             s.description AS session_description, s.session_key AS session_key,
             s.status,
             s.scope_type AS scope_type, s.research_id AS research_id,
             s.agent_status, s.last_agent_event, s.last_active,
             s.model AS model, s.claude_session_id AS claude_session_id,
             p.bind_path AS bind_path, p.name AS project_name,
             p.forgotten_flag_message AS forgotten_flag_message,
             p.forgotten_flag_issue_interval_minutes AS forgotten_flag_issue_interval_minutes,
             p.forgotten_flag_research_interval_minutes AS forgotten_flag_research_interval_minutes,
             p.forgotten_flag_issue_init_minutes AS forgotten_flag_issue_init_minutes,
             p.forgotten_flag_issue_backoff AS forgotten_flag_issue_backoff,
             p.forgotten_flag_issue_patience AS forgotten_flag_issue_patience,
             p.forgotten_flag_research_init_minutes AS forgotten_flag_research_init_minutes,
             p.forgotten_flag_research_backoff AS forgotten_flag_research_backoff,
             p.forgotten_flag_research_patience AS forgotten_flag_research_patience,
             u.display_name AS user_display_name, u.role AS user_role,
             i.title AS issue_title,
             r.title AS research_title
      FROM sessions_v2 s
      LEFT JOIN projects p ON s.project_id = p.id
      LEFT JOIN users u ON s.user_id = u.id
      LEFT JOIN issues i   ON s.issue_id   = i.id
      LEFT JOIN researches r ON s.research_id = r.id
      WHERE s.status = 'active'
    `).all();

    const findings = [];
    const lifecycleDeliveries = [];
    let checked = 0;
    let noBindPath = 0;
    let flagAbsent = 0;
    let assistantExempt = 0;

    for (const s of sessions) {
      const bindPath = (s.bind_path || '').trim();
      if (!bindPath) { noBindPath++; continue; }   // 没绑路径无从定位 flag

      const flagDir = flagDirOf(bindPath, s.session_id);
      const flagPath = runningFlagPathOf(bindPath, s.session_id);
      const failedPath = failedFlagPathOf(bindPath, s.session_id);
      const flagExists = fileExists(flagPath);
      const failedExists = fileExists(failedPath);
      const snapshot = {
        runningExists: flagExists,
        runningMtimeMs: flagExists ? readPathMtimeMs(flagPath) : null,
        failedExists,
        failedMtimeMs: failedExists ? readPathMtimeMs(failedPath) : null,
        flagDirExists: fileExists(flagDir),
        flagDirMtimeMs: readPathMtimeMs(flagDir),
        failedMeta: failedExists ? readFlagMeta(failedPath) : null,
        failedData: failedExists ? readFailedFlag(bindPath, s.session_id) : null,
      };
      const pendingLifecycleEvents = collectLifecycleEvents(s, snapshot);
      for (const event of pendingLifecycleEvents) {
        lifecycleDeliveries.push({ s, event });
      }

      if (!flagExists) { flagAbsent++; continue; } // flag 已被正常删除 = 正常态
      if (isAssistantSession(s)) { assistantExempt++; continue; } // 小莫 session 不要求自删 running.flag, 也不提醒

      checked++;

      // 是否还在工作: backend 真相源. isWorking 内部已先判 isAlive
      // (tmux window 不在 → 必 false), 故这里 isWorking=false 即"agent 已停工".
      let isAlive = false;
      let isWorking = false;
      let jobAccomplished = null;
      let backend = null;
      try { backend = backendForSession(s); } catch (e) { isAlive = isWorking = `ERR:${e.message}`; }
      if (backend) {
        try { isAlive = backend.isAlive(s.session_id); } catch (e) { isAlive = `ERR:${e.message}`; }
        try { isWorking = backend.isWorking(s.session_id); } catch (e) { isWorking = `ERR:${e.message}`; }
        try { jobAccomplished = backend.isJobGoalAccomplished(s.session_id); } catch {}
      }

      // 命中条件: flag 还在 且 agent 已不在工作.
      if (isWorking === false) {
        const fm = readFlagMeta(flagPath);
        findings.push({ s, flagPath, isAlive, isWorking, jobAccomplished, fm });
      }
    }

    // ── 写日志 ──────────────────────────────────────────────
    // 每轮都写一行心跳概览 (即便无命中), 方便确认巡检确实在跑.
    const durMs = Date.now() - startedAt;
    const header =
      `[${nowIso()}] scan done: total_active=${sessions.length} ` +
      `flag_present=${checked} forgotten=${findings.length} ` +
      `lifecycle_events=${lifecycleDeliveries.length} ` +
      `flag_absent=${flagAbsent} assistant_exempt=${assistantExempt} ` +
      `no_bind_path=${noBindPath} cost=${durMs}ms\n`;
    appendLog(header);
    saveLifecycleState();

    for (const item of lifecycleDeliveries) {
      const { s, event } = item;
      const block = [
        `──────── SESSION ${event.type === 'failed' ? 'FAILED' : 'COMPLETED'} CALLBACK ────────`,
        `  time             : ${nowIso()}`,
        `  event_key        : ${event.key}`,
        `  occurred_at      : ${event.occurredAt}`,
        `  session_id       : ${s.session_id}`,
        `  session_name     : ${s.session_name}`,
        `  session_desc     : ${sessionDescriptionForCallback(s)}`,
        `  user_id          : ${s.user_id}`,
        `  user_display     : ${s.user_display_name || '(无)'}`,
        `  project          : ${s.project_name || '(无)'}`,
        `  issue            : ${s.issue_title || '(无)'}`,
        `  research         : ${s.research_title || '(无)'}`,
      ].join('\n');
      appendLog(block + '\n');

      let lifecycleResult;
      try {
        lifecycleResult = await processLifecycleEvent(s, event);
      } catch (e) {
        lifecycleResult = { status: 'pending', detail: e && e.message ? e.message : String(e) };
      }
      appendLog(
        `  callback=${lifecycleResult.status} (${lifecycleResult.detail})\n` +
        '────────────────────────────────────────\n\n'
      );
    }
    saveLifecycleState();

    for (const f of findings) {
      const { s, flagPath, isAlive, isWorking, jobAccomplished, fm } = f;
      const aliveHint = (isAlive === true)
        ? 'agent 进程(tmux window)仍在, 但不在 turn 中 — 可能多轮任务等待输入, 也可能 TUI 卡死'
        : 'agent 进程(tmux window)已不存在 — 典型的"僵尸 flag": agent 已死却没删 flag';
      const block = [
        '──────── FORGOTTEN running.flag ────────',
        `  time             : ${nowIso()}`,
        `  session_id       : ${s.session_id}`,
        `  session_name     : ${s.session_name}`,
        `  user_id          : ${s.user_id}`,
        `  project          : ${s.project_name || '(无)'}`,
        `  issue            : ${s.issue_title || '(无)'}`,
        `  research         : ${s.research_title || '(无)'}`,
        `  db.status        : ${s.status}`,
        `  db.agent_status  : ${s.agent_status}`,
        `  db.last_agent_evt: ${s.last_agent_event || '(null)'}`,
        `  db.last_active   : ${s.last_active || '(null)'}`,
        `  flag_path        : ${flagPath}`,
        `  flag_mtime       : ${fm.mtime || '(读取失败)'}`,
        `  flag_run_id      : ${fm.runId || '(无)'}`,
        `  flag_started_at  : ${fm.startedAt || '(无)'}`,
        `  flag_age_seconds : ${fm.ageSec == null ? '(未知)' : fm.ageSec}`,
        `  flag_content     : ${fm.content ? JSON.stringify(fm.content) : '(空/读取失败)'}`,
        `  notify_scope     : ${sessionScopeType(s)}`,
        `  notify_policy    : ${notifyPolicySummaryForSession(s)}`,
        `  backend.isAlive  : ${isAlive}`,
        `  backend.isWorking: ${isWorking}`,
        `  backend.jobAccomplished: ${jobAccomplished}`,
        `  diagnosis        : agent 已停止工作(isWorking=false) 但 running.flag 未删除.`,
        `                     ${aliveHint}`,
      ].join('\n');
      appendLog(block + '\n');

      // 自动给该 session 发提醒消息 (含启动宽限 / 去重 / 冷却). 绝不让异常冒泡.
      let notifyResult;
      try {
        notifyResult = await maybeNotify(f);
      } catch (e) {
        notifyResult = `notify=FAIL (异常: ${e && e.message ? e.message : e})`;
      }
      appendLog(
        `  ${notifyResult}\n` +
        '────────────────────────────────────────\n\n'
      );
    }
  } catch (e) {
    appendLog(`[${nowIso()}] (error) 扫描异常: ${e && e.stack ? e.stack : e}\n`);
  } finally {
    scanning = false;
  }
}

// 启动巡检. 幂等: 重复调用只保留一个 timer.
function startForgottenFlagScanner() {
  if (timer) return timer;
  appendLog(
    `\n[${nowIso()}] ===== forgotten-flag-scanner 启动 ` +
    `(interval=${SCAN_INTERVAL_MS}ms, first_run_in=${FIRST_RUN_DELAY_MS}ms) =====\n` +
    `[${nowIso()}] log_file=${LOG_FILE}\n`
  );
  // scanOnce 现在是 async; 永不让 promise rejection 冒成 unhandledRejection.
  const safeScan = () => { Promise.resolve().then(scanOnce).catch(
    (e) => appendLog(`[${nowIso()}] (error) scanOnce 异常: ${e && e.stack ? e.stack : e}\n`)
  ); };
  setTimeout(() => {
    safeScan();
    timer = setInterval(safeScan, SCAN_INTERVAL_MS);
  }, FIRST_RUN_DELAY_MS);
  console.log(`[forgotten-flag-scanner] 已启动, 每 ${SCAN_INTERVAL_MS / 1000}s 扫描一次 → ${LOG_FILE}`);
  return timer;
}

module.exports = { startForgottenFlagScanner, scanOnce, LOG_FILE };
