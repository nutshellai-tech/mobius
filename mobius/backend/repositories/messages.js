const { db } = require('../../db');

const Messages = {
  insertUser: (taskId, content, turnNumber) => db.prepare(
    'INSERT INTO messages_v2 (task_id, role, content, turn_number) VALUES (?, ?, ?, ?)'
  ).run(taskId, 'user', content, turnNumber),

  // system 消息支持 turn_summary 字段, 用于 stop 终止信号、permission 持久化等
  insertSystem: (taskId, content, turnNumber, turnSummary) => db.prepare(
    'INSERT INTO messages_v2 (task_id, role, content, turn_number, turn_summary) VALUES (?, ?, ?, ?, ?)'
  ).run(taskId, 'system', content, turnNumber, turnSummary),

  // ─── v2 直连专属: 从 SDK 事件流落库 ────────────────────────────────
  insertAssistant: (taskId, content, turnNumber) => db.prepare(
    'INSERT INTO messages_v2 (task_id, role, content, turn_number) VALUES (?, ?, ?, ?)'
  ).run(taskId, 'assistant', content, turnNumber),

  insertAssistantWithRaw: (taskId, content, rawEvent, turnNumber) => db.prepare(
    'INSERT INTO messages_v2 (task_id, role, content, raw_event, turn_number) VALUES (?, ?, ?, ?, ?)'
  ).run(taskId, 'assistant', content, rawEvent || null, turnNumber),

  insertThinking: (taskId, content, turnNumber) => db.prepare(
    'INSERT INTO messages_v2 (task_id, role, content, turn_number) VALUES (?, ?, ?, ?)'
  ).run(taskId, 'thinking', content, turnNumber),

  insertTool: (taskId, summary, status, turnNumber) => db.prepare(
    'INSERT INTO messages_v2 (task_id, role, content, tool_summary, tool_status, turn_number) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(taskId, 'tool', summary, summary, status, turnNumber),

  insertToolWithContent: (taskId, summary, content, status, turnNumber) => db.prepare(
    'INSERT INTO messages_v2 (task_id, role, content, tool_summary, tool_status, turn_number) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(taskId, 'tool', content, summary, status, turnNumber),

  insertToolResult: (taskId, content, status, turnNumber) => db.prepare(
    'INSERT INTO messages_v2 (task_id, role, content, tool_status, turn_number) VALUES (?, ?, ?, ?, ?)'
  ).run(taskId, 'tool', content, status, turnNumber),

  // ⭐ 未知 SDK 事件兜底
  insertRaw: (taskId, rawJson, turnNumber) => db.prepare(
    'INSERT INTO messages_v2 (task_id, role, content, raw_event, turn_number) VALUES (?, ?, ?, ?, ?)'
  ).run(taskId, 'raw', '(unknown SDK event)', rawJson, turnNumber),

  // 主对话框 history 回灌
  listForTask: (taskId, limit = 200) => db.prepare(
    'SELECT * FROM messages_v2 WHERE task_id = ? ORDER BY id ASC LIMIT ?'
  ).all(taskId, limit),

  userInputsForTask: (taskId) => db.prepare(
    "SELECT id, content, created_at, turn_number FROM messages_v2 WHERE task_id = ? AND role = 'user' ORDER BY id ASC"
  ).all(taskId),

  // limit 语义:
  //   > 0 -> 取最近 limit 条(按 id DESC 后 reverse,保持时序)
  //   <=0 / undefined / null / 'all' -> 全量返回(按 id ASC 时序),主对话框展示该 session 全部 segment
  recentForTask: (taskId, limit) => {
    const total = db.prepare('SELECT COUNT(*) as c FROM messages_v2 WHERE task_id = ?').get(taskId);
    const parsed = parseInt(limit, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      const messages = db.prepare('SELECT * FROM messages_v2 WHERE task_id = ? ORDER BY id DESC LIMIT ?').all(taskId, parsed);
      return { messages: messages.reverse(), total: total.c };
    }
    const messages = db.prepare('SELECT * FROM messages_v2 WHERE task_id = ? ORDER BY id ASC').all(taskId);
    return { messages, total: total.c };
  },

  countAll: () => db.prepare('SELECT COUNT(*) as c FROM messages_v2').get().c,

  deleteForTask: (taskId) => db.prepare(
    'DELETE FROM messages_v2 WHERE task_id = ?'
  ).run(taskId),

  findWithUser: (id) => db.prepare(
    'SELECT m.*, t.user_id FROM messages_v2 m JOIN sessions_v2 t ON m.task_id = t.session_id WHERE m.id = ?'
  ).get(id),

  setBookmark: (id, val) => db.prepare('UPDATE messages_v2 SET bookmarked = ? WHERE id = ?').run(val, id),

  bookmarksForTask: (taskId) => db.prepare(
    'SELECT id, role, content, created_at FROM messages_v2 WHERE task_id = ? AND bookmarked = 1 ORDER BY id'
  ).all(taskId),

  maxTurnFor: (taskId) => {
    const r = db.prepare("SELECT MAX(turn_number) as max_t FROM messages_v2 WHERE task_id = ?").get(taskId);
    return r?.max_t || 0;
  },

  countUserMessagesFor: (taskId) => db.prepare(
    "SELECT COUNT(*) as cnt FROM messages_v2 WHERE task_id = ? AND role = 'user'"
  ).get(taskId).cnt,

  turnsForSession: (sessionId) => db.prepare(`
    SELECT turn_number, turn_summary, created_at,
      (SELECT content FROM messages_v2 WHERE task_id = ? AND turn_number = m.turn_number AND role = 'user' ORDER BY id ASC LIMIT 1) as user_input,
      (SELECT content FROM messages_v2 WHERE task_id = ? AND turn_number = m.turn_number AND role = 'assistant' ORDER BY id DESC LIMIT 1) as agent_output
    FROM messages_v2 m
    WHERE task_id = ? AND turn_number IS NOT NULL
    GROUP BY turn_number
    ORDER BY MIN(id)
  `).all(sessionId, sessionId, sessionId),

  // 用于 turn-summary polling 与变更扫描
  findLastAssistantInTurn: (taskId, turnNum) => db.prepare(
    "SELECT id FROM messages_v2 WHERE task_id = ? AND turn_number = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1"
  ).get(taskId, turnNum),

  updateTurnSummary: (id, summary) => db.prepare("UPDATE messages_v2 SET turn_summary = ? WHERE id = ?").run(summary, id),

  recentContentForSession: (sessionId, limit = 80) => db.prepare(
    "SELECT content FROM messages_v2 WHERE task_id = ? ORDER BY id DESC LIMIT ?"
  ).all(sessionId, limit),

  latestAssistantOrTool: (sessionId) => db.prepare(
    "SELECT content FROM messages_v2 WHERE task_id = ? AND role IN ('assistant','tool') ORDER BY id DESC LIMIT 1"
  ).get(sessionId),
};

module.exports = { Messages };
