/**
 * inactive-tmux-cleaner.js — 自动清理不活跃的 tmux agent window.
 *
 * 范围:
 *   - 只扫描 agent hub 里的 session window, 不动普通 tmux session.
 *   - 同时覆盖 tmux-codex 与 tmux-claude-code.
 *   - `_root` hub 占位 window 永不清理.
 *
 * 不活跃判定:
 *   last_activity = max(tmux window_activity, runtime.startedAt, runtime jsonl mtime,
 *                       sessions_v2.last_active, sessions_v2.last_agent_event,
 *                       messages_v2 最近消息时间)
 *   - running.flag 已删除的完成态 session: 当 now - last_activity >= 10m 时清理.
 *   - 其他 session: 当 now - last_activity >= 3h 时清理.
 *
 * 清理动作:
 *   - 调 backend.terminateSession(sessionId), 复用现有 kill-window / runtime 清理.
 *   - 若 DB 能找到项目 bind_path, 再兜底删除 .imac/flags/<sessionId> 目录.
 *   - DB session 标为 idle 并写一条 system 消息留痕.
 */
const fs = require('fs');
const path = require('path');

const { db } = require('../../db');
const { BACKEND_WORKER_LOG_DIR, DEFAULT_AGENT_BACKEND, MODEL_OPTIONS } = require('../config');
const { Messages } = require('../repositories/messages');
const { flagDirOf, runningFlagPathOf, safeRemoveFlagDir } = require('../utils/session-flags');
const agents = require('../agents');

const DEFAULT_INACTIVE_MS = 3 * 60 * 60 * 1000;
const DEFAULT_COMPLETED_INACTIVE_MS = 10 * 60 * 1000;
const INACTIVE_MS = parseDurationMs(process.env.IMAC_TMUX_AGENT_INACTIVE_MS, DEFAULT_INACTIVE_MS);
const COMPLETED_INACTIVE_MS = parseDurationMs(
  process.env.IMAC_TMUX_AGENT_COMPLETED_INACTIVE_MS,
  DEFAULT_COMPLETED_INACTIVE_MS,
);
const SCAN_INTERVAL_MS = parseDurationMs(process.env.IMAC_TMUX_AGENT_CLEANUP_INTERVAL_MS, 30 * 60 * 1000);
const FIRST_RUN_DELAY_MS = parseDurationMs(process.env.IMAC_TMUX_AGENT_CLEANUP_FIRST_DELAY_MS, 60 * 1000);

const LOG_DIR = BACKEND_WORKER_LOG_DIR;
const LOG_FILE = path.join(LOG_DIR, 'cleanup_inactive_tmux_agents.log');

let timer = null;
let scanning = false;

function parseDurationMs(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function appendLog(text) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, text);
  } catch (e) {
    console.warn(`[inactive-tmux-cleaner] 写日志失败: ${e.message}`);
  }
}

function iso(ms) {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : '(unknown)';
}

function ageText(ageMs) {
  if (!Number.isFinite(ageMs)) return 'unknown';
  const hours = Math.floor(ageMs / (60 * 60 * 1000));
  const mins = Math.floor((ageMs % (60 * 60 * 1000)) / (60 * 1000));
  return `${hours}h${String(mins).padStart(2, '0')}m`;
}

function parseDbTime(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const ms = Date.parse(raw.endsWith('Z') ? raw : `${raw}Z`);
  return Number.isFinite(ms) ? ms : null;
}

function normalizeEpochMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 10_000_000_000 ? n * 1000 : n;
}

function statMtimeMs(filePath) {
  if (!filePath) return null;
  try {
    const st = fs.statSync(filePath);
    return Number.isFinite(st.mtimeMs) ? st.mtimeMs : null;
  } catch {
    return null;
  }
}

function source(ms, label) {
  return ms ? { ms, label } : null;
}

function latestActivity(sources) {
  const valid = sources.filter((x) => x && Number.isFinite(x.ms) && x.ms > 0);
  if (!valid.length) return null;
  return valid.reduce((best, cur) => (cur.ms > best.ms ? cur : best), valid[0]);
}

function loadDbSessionsById() {
  const rows = db.prepare(`
    SELECT s.session_id, s.name AS session_name, s.status,
           s.agent_status, s.last_active, s.last_agent_event, s.model,
           p.bind_path AS bind_path, p.name AS project_name,
           i.title AS issue_title,
           r.title AS research_title,
           (SELECT MAX(created_at) FROM messages_v2 WHERE task_id = s.session_id) AS last_message_at
    FROM sessions_v2 s
    LEFT JOIN projects p ON s.project_id = p.id
    LEFT JOIN issues i ON s.issue_id = i.id
    LEFT JOIN researches r ON s.research_id = r.id
  `).all();
  return new Map(rows.map((row) => [row.session_id, row]));
}

function backendNames() {
  return Array.from(new Set([
    DEFAULT_AGENT_BACKEND,
    ...Object.values(MODEL_OPTIONS || {}).map((m) => m.backend).filter(Boolean),
  ]));
}

function runtimeEntryFor(backend, sessionId) {
  try {
    if (backend?.runtime?.get) return backend.runtime.get(sessionId) || null;
  } catch {}
  return null;
}

function activityForWindow(backend, windowInfo, dbSession) {
  const runtime = runtimeEntryFor(backend, windowInfo.sessionId);
  const sources = [
    source(normalizeEpochMs(windowInfo.lastActivityMs), 'tmux.window_activity'),
    source(normalizeEpochMs(runtime?.startedAt), 'runtime.startedAt'),
    source(statMtimeMs(runtime?.jsonlPath), 'runtime.jsonl_mtime'),
    source(parseDbTime(dbSession?.last_active), 'db.last_active'),
    source(parseDbTime(dbSession?.last_agent_event), 'db.last_agent_event'),
    source(parseDbTime(dbSession?.last_message_at), 'db.last_message_at'),
  ];
  const latest = latestActivity(sources);
  return {
    latest,
    runtime,
    sources: sources.filter(Boolean),
  };
}

function cleanupFlagDir(sessionId, dbSession, runtime) {
  const roots = new Set();
  if (runtime?.flagRoot) roots.add(runtime.flagRoot);
  if (runtime?.cwd) roots.add(runtime.cwd);
  if (dbSession?.bind_path) roots.add(dbSession.bind_path);
  let removed = false;
  for (const root of roots) {
    if (safeRemoveFlagDir(root, sessionId, 'inactive-tmux-cleaner')) removed = true;
  }
  return removed;
}

function completionFlagState(sessionId, dbSession, runtime) {
  const roots = new Set();
  if (runtime?.flagRoot) roots.add(runtime.flagRoot);
  if (runtime?.cwd) roots.add(runtime.cwd);
  if (dbSession?.bind_path) roots.add(dbSession.bind_path);

  const checked = [];
  let sawFlagDir = false;
  for (const root of roots) {
    let flagDirExists = false;
    let runningFlagExists = false;
    try { flagDirExists = fs.existsSync(flagDirOf(root, sessionId)); } catch {}
    try { runningFlagExists = fs.existsSync(runningFlagPathOf(root, sessionId)); } catch {}
    checked.push({ root, flagDirExists, runningFlagExists });
    if (runningFlagExists) {
      return { known: true, completed: false, root, checked };
    }
    if (flagDirExists) sawFlagDir = true;
  }

  return {
    known: sawFlagDir,
    completed: sawFlagDir,
    root: checked.find((x) => x.flagDirExists)?.root || null,
    checked,
  };
}

function thresholdText(ms) {
  if (!Number.isFinite(ms)) return 'unknown';
  const minutes = Math.round(ms / (60 * 1000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.round(ms / (60 * 60 * 1000));
  return `${hours} 小时`;
}

function markDbIdle(sessionId) {
  try {
    db.prepare(`
      UPDATE sessions_v2
      SET agent_status = 'idle',
          last_agent_event = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE session_id = ?
    `).run(sessionId);
  } catch (e) {
    console.warn(`[inactive-tmux-cleaner] 更新 DB idle 失败 (${sessionId}): ${e.message}`);
  }
}

function writeCleanupMessage(sessionId, backendName, windowInfo, lastActivity, ageMs, cleanupReason, thresholdMs) {
  try {
    const turnNum = (Messages.maxTurnFor(sessionId) || 0) + 1;
    Messages.insertSystem(
      sessionId,
      [
        `后台巡检已自动清理超过 ${thresholdText(thresholdMs)}无活动的 agent tmux window。`,
        `backend=${backendName}`,
        `window=${windowInfo.sessionId}`,
        `pid=${windowInfo.pid || '(unknown)'}`,
        `cleanup_reason=${cleanupReason || 'inactive'}`,
        `last_activity=${iso(lastActivity?.ms)}`,
        `last_activity_source=${lastActivity?.label || '(unknown)'}`,
        `inactive_age=${ageText(ageMs)}`,
      ].join('\n'),
      turnNum,
      '自动清理不活跃 Agent',
    );
  } catch (e) {
    console.warn(`[inactive-tmux-cleaner] 写清理消息失败 (${sessionId}): ${e.message}`);
  }
}

async function scanOnce() {
  if (scanning) {
    appendLog(`[${nowIso()}] (skip) 上一轮清理尚未结束, 跳过本轮\n`);
    return;
  }
  scanning = true;
  const startedAt = Date.now();
  let totalWindows = 0;
  let skippedRoot = 0;
  let unknownActivity = 0;
  let completedFlagWindows = 0;
  const candidates = [];

  try {
    const dbSessions = loadDbSessionsById();
    for (const backendName of backendNames()) {
      let backend;
      try { backend = agents.get(backendName); }
      catch (e) {
        appendLog(`[${nowIso()}] backend=${backendName} unavailable: ${e.message}\n`);
        continue;
      }

      let windows = [];
      try { windows = backend.listSessions(); }
      catch (e) {
        appendLog(`[${nowIso()}] backend=${backendName} listSessions failed: ${e.message}\n`);
        continue;
      }

      for (const w of windows) {
        totalWindows++;
        const sid = w.sessionId;
        if (!sid || sid === '_root') { skippedRoot++; continue; }

        const dbSession = dbSessions.get(sid) || null;
        const activity = activityForWindow(backend, w, dbSession);
        if (!activity.latest) { unknownActivity++; continue; }

        const ageMs = Date.now() - activity.latest.ms;
        const flagState = completionFlagState(sid, dbSession, activity.runtime);
        if (flagState.completed) completedFlagWindows++;
        const useCompletedThreshold = flagState.completed && ageMs >= COMPLETED_INACTIVE_MS;
        const useNormalThreshold = ageMs >= INACTIVE_MS;
        if (useCompletedThreshold || useNormalThreshold) {
          let isWorking = null;
          try { isWorking = backend.isWorking(sid); } catch (e) { isWorking = `ERR:${e.message}`; }
          candidates.push({
            backendName,
            backend,
            windowInfo: w,
            dbSession,
            activity,
            ageMs,
            isWorking,
            flagState,
            cleanupReason: useCompletedThreshold ? 'completed_running_flag_missing' : 'inactive',
            thresholdMs: useCompletedThreshold ? COMPLETED_INACTIVE_MS : INACTIVE_MS,
          });
        }
      }
    }

    const durMs = Date.now() - startedAt;
    appendLog(
      `[${nowIso()}] scan done: total_windows=${totalWindows} candidates=${candidates.length} ` +
      `completed_flag_windows=${completedFlagWindows} skipped_root=${skippedRoot} ` +
      `unknown_activity=${unknownActivity} inactive_threshold=${INACTIVE_MS}ms ` +
      `completed_threshold=${COMPLETED_INACTIVE_MS}ms cost=${durMs}ms\n`
    );

    for (const f of candidates) {
      const sid = f.windowInfo.sessionId;
      const s = f.dbSession;
      const sources = f.activity.sources
        .map((x) => `${x.label}=${iso(x.ms)}`)
        .join(', ');
      appendLog([
        '──────── INACTIVE tmux agent cleanup ────────',
        `  time              : ${nowIso()}`,
        `  backend           : ${f.backendName}`,
        `  session_id        : ${sid}`,
        `  session_name      : ${s?.session_name || '(no db row)'}`,
        `  db.status         : ${s?.status || '(no db row)'}`,
        `  project           : ${s?.project_name || '(无)'}`,
        `  issue             : ${s?.issue_title || '(无)'}`,
        `  research          : ${s?.research_title || '(无)'}`,
        `  pid               : ${f.windowInfo.pid || '(unknown)'}`,
        `  tmux_window_index : ${f.windowInfo.index}`,
        `  last_activity     : ${iso(f.activity.latest.ms)} (${f.activity.latest.label})`,
        `  inactive_age      : ${ageText(f.ageMs)} (${Math.round(f.ageMs / 1000)}s)`,
        `  cleanup_reason    : ${f.cleanupReason}`,
        `  cleanup_threshold : ${f.thresholdMs}ms`,
        `  completed_flag    : ${f.flagState?.completed ? 'yes' : 'no'}${f.flagState?.root ? ` (${f.flagState.root})` : ''}`,
        `  backend.isWorking : ${f.isWorking}`,
        `  activity_sources  : ${sources || '(none)'}`,
      ].join('\n') + '\n');

      let result = null;
      try {
        result = await f.backend.terminateSession(sid);
      } catch (e) {
        appendLog(`  cleanup=FAIL (terminateSession: ${e.message})\n────────────────────────────────────────\n\n`);
        continue;
      }

      const flagRemoved = cleanupFlagDir(sid, s, f.activity.runtime);
      if (s) {
        markDbIdle(sid);
        writeCleanupMessage(
          sid,
          f.backendName,
          f.windowInfo,
          f.activity.latest,
          f.ageMs,
          f.cleanupReason,
          f.thresholdMs,
        );
      }

      appendLog(
        `  cleanup=OK killed=${!!result?.killed} wasWorking=${!!result?.wasWorking} flag_dir_removed=${flagRemoved}\n` +
        '────────────────────────────────────────\n\n'
      );
    }
  } catch (e) {
    appendLog(`[${nowIso()}] (error) 清理扫描异常: ${e && e.stack ? e.stack : e}\n`);
  } finally {
    scanning = false;
  }
}

function startInactiveTmuxCleaner() {
  if (timer) return timer;
  appendLog(
    `\n[${nowIso()}] ===== inactive-tmux-cleaner 启动 ` +
    `(inactive=${INACTIVE_MS}ms, completed_inactive=${COMPLETED_INACTIVE_MS}ms, ` +
    `interval=${SCAN_INTERVAL_MS}ms, first_run_in=${FIRST_RUN_DELAY_MS}ms) =====\n` +
    `[${nowIso()}] log_file=${LOG_FILE}\n`
  );
  const safeScan = () => {
    Promise.resolve().then(scanOnce).catch(
      (e) => appendLog(`[${nowIso()}] (error) scanOnce 异常: ${e && e.stack ? e.stack : e}\n`)
    );
  };
  setTimeout(() => {
    safeScan();
    timer = setInterval(safeScan, SCAN_INTERVAL_MS);
  }, FIRST_RUN_DELAY_MS);
  console.log(
    `[inactive-tmux-cleaner] 已启动, 每 ${Math.round(SCAN_INTERVAL_MS / 1000)}s 扫描一次, ` +
    `清理 completed ${Math.round(COMPLETED_INACTIVE_MS / 60000)}m / inactive ${Math.round(INACTIVE_MS / 3600000)}h ` +
    `无活动 agent window → ${LOG_FILE}`
  );
  return timer;
}

module.exports = {
  startInactiveTmuxCleaner,
  scanOnce,
  LOG_FILE,
  INACTIVE_MS,
  COMPLETED_INACTIVE_MS,
  SCAN_INTERVAL_MS,
};
