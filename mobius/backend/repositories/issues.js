const { db } = require('../../db');

const Issues = {
  findById: (id, userId) => {
    if (!userId) {
      return db.prepare('SELECT *, 0 AS starred FROM issues WHERE id = ?').get(id);
    }
    return db.prepare(`
      SELECT i.*, CASE WHEN ius.user_id IS NULL THEN 0 ELSE 1 END AS starred
      FROM issues i
      LEFT JOIN issue_user_stars ius ON ius.issue_id = i.id AND ius.user_id = ?
      WHERE i.id = ?
    `).get(userId, id);
  },
  findByProjectAndTitle: (projectId, title) => db.prepare(
    'SELECT * FROM issues WHERE project_id = ? AND title = ? ORDER BY created_at ASC LIMIT 1'
  ).get(projectId, title),

  listForProject: (projectId, statusFilter, userId) => {
    if (userId) {
      let where = 'i.project_id = ?';
      const params = [userId, projectId];
      if (statusFilter === 'active' || statusFilter === 'completed') {
        where += ' AND i.status = ?';
        params.push(statusFilter);
      }
      return db.prepare(`
        SELECT i.*, u.display_name as created_by_name,
          CASE WHEN ius.user_id IS NULL THEN 0 ELSE 1 END AS starred,
          (SELECT COUNT(*) FROM sessions_v2 WHERE issue_id = i.id AND scope_type = 'issue' AND status = 'active') as session_count
        FROM issues i
        LEFT JOIN users u ON i.created_by = u.id
        LEFT JOIN issue_user_stars ius ON ius.issue_id = i.id AND ius.user_id = ?
        WHERE ${where}
        ORDER BY i.last_active DESC
      `).all(...params);
    }
    let where = 'i.project_id = ?';
    const params = [projectId];
    if (statusFilter === 'active' || statusFilter === 'completed') {
      where += ' AND i.status = ?';
      params.push(statusFilter);
    }
    return db.prepare(`
      SELECT i.*, u.display_name as created_by_name, 0 AS starred,
        (SELECT COUNT(*) FROM sessions_v2 WHERE issue_id = i.id AND scope_type = 'issue' AND status = 'active') as session_count
      FROM issues i
      LEFT JOIN users u ON i.created_by = u.id
      WHERE ${where}
      ORDER BY i.last_active DESC
    `).all(...params);
  },

  insert: ({ id, project_id, title, description, created_by, use_worktree, worktree_branch, visibility, is_planning }) => db.prepare(
    'INSERT INTO issues (id, project_id, title, description, created_by, status, use_worktree, worktree_branch, visibility, is_planning) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, project_id, title, description, created_by, 'active',
    use_worktree ? 1 : 0, worktree_branch || '', visibility || 'inherit', is_planning ? 1 : 0),

  updateTitle: (id, title) => db.prepare('UPDATE issues SET title = ? WHERE id = ?').run(title, id),
  updateDescription: (id, desc) => db.prepare('UPDATE issues SET description = ? WHERE id = ?').run(desc, id),
  updateStatus: (id, status) => db.prepare('UPDATE issues SET status = ? WHERE id = ?').run(status, id),
  updatePinned: (id, pinned) => db.prepare('UPDATE issues SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id),
  setStarred: (id, userId, starred) => {
    const uid = String(userId || '').trim();
    if (!uid) return false;
    if (starred) {
      db.prepare(`
        INSERT INTO issue_user_stars (issue_id, user_id)
        VALUES (?, ?)
        ON CONFLICT(issue_id, user_id) DO NOTHING
      `).run(id, uid);
    } else {
      db.prepare(`
        DELETE FROM issue_user_stars
        WHERE issue_id = ? AND user_id = ?
      `).run(id, uid);
    }
    return true;
  },
  updateVisibility: (id, visibility) => db.prepare('UPDATE issues SET visibility = ? WHERE id = ?').run(visibility, id),
  markCompleted: (id) => db.prepare(
    "UPDATE issues SET status = 'completed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
  ).run(id),
  delete: (id) => db.prepare('DELETE FROM issues WHERE id = ?').run(id),

  updateSkillOverrides: (id, { selected, excluded }) => db.prepare(
    'UPDATE issues SET selected_skills = ?, excluded_skills = ? WHERE id = ?'
  ).run(JSON.stringify(selected || []), JSON.stringify(excluded || []), id),

  touchActiveAndIncrement: (id) => db.prepare(
    "UPDATE issues SET last_active = strftime('%Y-%m-%dT%H:%M:%fZ','now'), message_count = message_count + 1 WHERE id = ?"
  ).run(id),

  listIdsForProject: (projectId) => db.prepare('SELECT id FROM issues WHERE project_id = ?').all(projectId),
};

const IssueIntegrations = {
  findByIssue: (issueId) => db.prepare('SELECT * FROM issue_integrations WHERE issue_id = ?').get(issueId),

  conflictCounts: (issueId) => db.prepare(`
    SELECT
      SUM(CASE WHEN lc.issue_id = rc.issue_id THEN 1 ELSE 0 END) as internal_count,
      SUM(CASE WHEN lc.issue_id != rc.issue_id THEN 1 ELSE 0 END) as external_count,
      SUM(CASE WHEN c.severity = 'blocking' THEN 1 ELSE 0 END) as blocking_count
    FROM session_conflicts c
    JOIN session_changes lc ON c.left_change_id = lc.id
    JOIN session_changes rc ON c.right_change_id = rc.id
    WHERE c.status = 'open' AND (lc.issue_id = ? OR rc.issue_id = ?)
  `).get(issueId, issueId),

  changeStats: (issueId) => db.prepare(`
    SELECT COUNT(*) as total,
      SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) as ready_count,
      SUM(CASE WHEN status = 'conflict' THEN 1 ELSE 0 END) as conflict_count,
      SUM(CASE WHEN check_status = 'failed' THEN 1 ELSE 0 END) as failed_count
    FROM session_changes WHERE issue_id = ?
  `).get(issueId),

  upsert: ({ id, issueId, projectId, status, internal, external, buildStatus }) => db.prepare(`
    INSERT INTO issue_integrations (id, issue_id, project_id, status, internal_conflict_count, external_conflict_count, build_status, acceptance_status, release_note, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', '', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(issue_id) DO UPDATE SET
      status = excluded.status,
      internal_conflict_count = excluded.internal_conflict_count,
      external_conflict_count = excluded.external_conflict_count,
      build_status = excluded.build_status,
      updated_at = excluded.updated_at
  `).run(id, issueId, projectId, status, internal, external, buildStatus),

  setAcceptance: (issueId, acceptance, status, releaseNote) => db.prepare(`
    UPDATE issue_integrations SET acceptance_status = ?, status = ?, release_note = COALESCE(?, release_note), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE issue_id = ?
  `).run(acceptance, status, releaseNote, issueId),

  markIntegrated: (issueId) => db.prepare(
    "UPDATE issue_integrations SET status = 'integrated', integrated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE issue_id = ?"
  ).run(issueId),

  countAcceptancePending: (projectId) => db.prepare(
    "SELECT COUNT(*) FROM issue_integrations WHERE project_id = ? AND acceptance_status = 'pending'"
  ).get(projectId),

  countReady: (projectId) => db.prepare(
    "SELECT COUNT(*) FROM issue_integrations WHERE project_id = ? AND status = 'ready'"
  ).get(projectId),

  integratedListForProject: (projectId) => db.prepare(`
    SELECT i.title, ii.release_note, ii.integrated_at, sc.summary, sc.id as change_id
    FROM issue_integrations ii
    JOIN issues i ON ii.issue_id = i.id
    LEFT JOIN session_changes sc ON sc.issue_id = i.id
    WHERE ii.project_id = ? AND ii.status = 'integrated'
    ORDER BY ii.integrated_at DESC
  `).all(projectId),

  integratedFilesForProject: (projectId) => db.prepare(`
    SELECT DISTINCT f.file_path, f.risk_level
    FROM session_change_files f
    JOIN session_changes sc ON f.change_id = sc.id
    JOIN issue_integrations ii ON sc.issue_id = ii.issue_id
    WHERE ii.project_id = ? AND ii.status = 'integrated'
    ORDER BY f.file_path
  `).all(projectId),
};

module.exports = { Issues, IssueIntegrations };
