const { db } = require('../../db');

const DEFAULT_WINDOW_HOURS = 5;
const MAX_WINDOW_HOURS = 24 * 7;

function normalizeHours(value, fallback = DEFAULT_WINDOW_HOURS) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(n, 1), MAX_WINDOW_HOURS);
}

function sinceExpr(hours) {
  const h = normalizeHours(hours);
  return `-${h} hours`;
}

function recordPromptPaste({ backendName, sessionId, contentLength }) {
  if (!backendName || !sessionId) return false;
  try {
    db.prepare(`
      INSERT INTO agent_prompt_events(backend_name, session_id, content_length)
      VALUES (?, ?, ?)
    `).run(
      String(backendName),
      String(sessionId),
      Math.max(0, Number(contentLength) || 0),
    );
    return true;
  } catch (e) {
    console.warn(`[agent-prompt-events] record failed (${backendName}/${sessionId}): ${e.message}`);
    return false;
  }
}

function statsSince(hours = DEFAULT_WINDOW_HOURS) {
  const modifier = sinceExpr(hours);
  const total = db.prepare(`
    SELECT COUNT(*) AS c
    FROM agent_prompt_events
    WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)
  `).get(modifier).c;
  const byBackendRows = db.prepare(`
    SELECT backend_name, COUNT(*) AS count
    FROM agent_prompt_events
    WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)
    GROUP BY backend_name
  `).all(modifier);
  const byBackend = {};
  for (const row of byBackendRows) byBackend[row.backend_name] = row.count;
  const since = db.prepare(`
    SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now', ?) AS since
  `).get(modifier).since;
  return {
    window_hours: normalizeHours(hours),
    since,
    total,
    by_backend: byBackend,
  };
}

function countsBySessionSince(hours = DEFAULT_WINDOW_HOURS) {
  const modifier = sinceExpr(hours);
  const rows = db.prepare(`
    SELECT session_id, COUNT(*) AS count
    FROM agent_prompt_events
    WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)
    GROUP BY session_id
  `).all(modifier);
  return new Map(rows.map((row) => [row.session_id, row.count]));
}

function statsSinceMinutes(minutes = 2) {
  const m = Math.max(1, Math.round(Number(minutes) || 2));
  const modifier = `-${m} minutes`;
  const byBackendRows = db.prepare(`
    SELECT backend_name, COUNT(*) AS count
    FROM agent_prompt_events
    WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now', ?)
    GROUP BY backend_name
  `).all(modifier);
  const byBackend = {};
  for (const row of byBackendRows) byBackend[row.backend_name] = row.count;
  return { window_minutes: m, by_backend: byBackend };
}

module.exports = {
  DEFAULT_WINDOW_HOURS,
  normalizeHours,
  recordPromptPaste,
  statsSince,
  statsSinceMinutes,
  countsBySessionSince,
};
