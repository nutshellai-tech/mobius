const { db } = require('../../db');

const Researches = {
  findById: (id) => db.prepare('SELECT * FROM researches WHERE id = ?').get(id),

  findByIdWithProject: (id) => db.prepare(`
    SELECT r.*, p.name AS project_name, p.bind_path AS bind_path, p.research_enabled AS research_enabled
    FROM researches r
    LEFT JOIN projects p ON r.project_id = p.id
    WHERE r.id = ?
  `).get(id),

  listForProject: (projectId, statusFilter) => {
    let where = 'r.project_id = ?';
    const params = [projectId];
    if (statusFilter === 'active' || statusFilter === 'completed') {
      where += ' AND r.status = ?';
      params.push(statusFilter);
    }
    return db.prepare(`
      SELECT r.*, u.display_name as created_by_name,
        (SELECT COUNT(*) FROM sessions_v2 WHERE research_id = r.id AND scope_type = 'research' AND status = 'active') as session_count,
        (SELECT COUNT(*) FROM sessions_v2 WHERE research_id = r.id AND scope_type = 'research' AND research_role = 'chief_researcher') as chief_count
      FROM researches r
      LEFT JOIN users u ON r.created_by = u.id
      WHERE ${where}
      ORDER BY r.last_active DESC
    `).all(...params);
  },

  insert: ({ id, project_id, title, description, created_by, visibility }) => db.prepare(
    'INSERT INTO researches (id, project_id, title, description, created_by, status, visibility) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, project_id, title, description || '', created_by, 'active', visibility || 'inherit'),

  updateTitle: (id, title) => db.prepare('UPDATE researches SET title = ? WHERE id = ?').run(title, id),
  updateDescription: (id, desc) => db.prepare('UPDATE researches SET description = ? WHERE id = ?').run(desc, id),
  updateStatus: (id, status) => db.prepare('UPDATE researches SET status = ? WHERE id = ?').run(status, id),
  updatePinned: (id, pinned) => db.prepare('UPDATE researches SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id),
  updateVisibility: (id, visibility) => db.prepare('UPDATE researches SET visibility = ? WHERE id = ?').run(visibility, id),

  markCompleted: (id) => db.prepare(
    "UPDATE researches SET status = 'completed' WHERE id = ?"
  ).run(id),

  touchActiveAndIncrement: (id) => db.prepare(
    "UPDATE researches SET last_active = strftime('%Y-%m-%dT%H:%M:%fZ','now'), message_count = message_count + 1 WHERE id = ?"
  ).run(id),
};

module.exports = { Researches };
