const { db } = require('../../db');

const UserProjectView = {
  getPrefs: (userId) => {
    const uid = String(userId || '').trim();
    if (!uid) return { hide_others_projects: false, updated_at: null };
    const row = db.prepare(`
      SELECT user_id, hide_others_projects, updated_at
      FROM user_view_prefs
      WHERE user_id = ?
    `).get(uid);
    return {
      user_id: uid,
      hide_others_projects: !!row?.hide_others_projects,
      updated_at: row?.updated_at || null,
    };
  },

  setPrefs: (userId, { hideOthersProjects } = {}) => {
    const uid = String(userId || '').trim();
    if (!uid) return null;
    db.prepare(`
      INSERT INTO user_view_prefs (user_id, hide_others_projects, updated_at)
      VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(user_id) DO UPDATE SET
        hide_others_projects = excluded.hide_others_projects,
        updated_at = excluded.updated_at
    `).run(uid, hideOthersProjects ? 1 : 0);
    return UserProjectView.getPrefs(uid);
  },

  isMuted: (userId, projectId) => {
    const uid = String(userId || '').trim();
    const pid = String(projectId || '').trim();
    if (!uid || !pid) return false;
    return !!db.prepare(`
      SELECT 1
      FROM user_muted_projects
      WHERE user_id = ? AND project_id = ?
    `).get(uid, pid);
  },

  mutedIds: (userId) => {
    const uid = String(userId || '').trim();
    if (!uid) return new Set();
    const rows = db.prepare(`
      SELECT project_id
      FROM user_muted_projects
      WHERE user_id = ?
    `).all(uid);
    return new Set(rows.map((row) => row.project_id));
  },

  mute: (userId, projectId) => {
    const uid = String(userId || '').trim();
    const pid = String(projectId || '').trim();
    if (!uid || !pid) return false;
    db.prepare(`
      INSERT INTO user_muted_projects (user_id, project_id, muted_at)
      VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(user_id, project_id) DO UPDATE SET
        muted_at = excluded.muted_at
    `).run(uid, pid);
    return true;
  },

  unmute: (userId, projectId) => {
    const uid = String(userId || '').trim();
    const pid = String(projectId || '').trim();
    if (!uid || !pid) return false;
    db.prepare(`
      DELETE FROM user_muted_projects
      WHERE user_id = ? AND project_id = ?
    `).run(uid, pid);
    return true;
  },

  listMutedProjects: (userId) => {
    const uid = String(userId || '').trim();
    if (!uid) return [];
    return db.prepare(`
      SELECT p.*, u.display_name AS created_by_name, m.muted_at,
        CASE WHEN pus.user_id IS NULL THEN 0 ELSE 1 END AS starred,
        CASE WHEN puh.user_id IS NULL THEN 0 ELSE 1 END AS hidden,
        (SELECT COUNT(*) FROM issues WHERE project_id = p.id) AS issue_count,
        (SELECT COUNT(*) FROM researches WHERE project_id = p.id) AS research_count
      FROM user_muted_projects m
      JOIN projects p ON p.id = m.project_id
      LEFT JOIN users u ON p.created_by = u.id
      LEFT JOIN project_user_stars pus ON pus.project_id = p.id AND pus.user_id = ?
      LEFT JOIN project_user_hidden puh ON puh.project_id = p.id AND puh.user_id = ?
      WHERE m.user_id = ?
      ORDER BY m.muted_at DESC
    `).all(uid, uid, uid);
  },
};

module.exports = { UserProjectView };
