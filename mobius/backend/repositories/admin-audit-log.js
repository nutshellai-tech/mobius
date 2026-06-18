const { db } = require('../../db');

function clampLimit(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return 100;
  return Math.min(n, 500);
}

function clampOffset(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) return 0;
  return n;
}

const AdminAuditLog = {
  record: ({ adminId, action, resourceType, resourceId }) => {
    const admin = String(adminId || '').trim();
    const act = String(action || '').trim();
    const type = String(resourceType || '').trim();
    const id = String(resourceId || '').trim();
    if (!admin || !act || !type || !id) return null;
    const info = db.prepare(`
      INSERT INTO admin_audit_log (admin_id, action, resource_type, resource_id, occurred_at)
      VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `).run(admin, act, type, id);
    return info.lastInsertRowid;
  },

  list: ({ limit, offset } = {}) => db.prepare(`
    SELECT id, admin_id, action, resource_type, resource_id, occurred_at
    FROM admin_audit_log
    ORDER BY occurred_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(clampLimit(limit), clampOffset(offset)),

  count: () => db.prepare('SELECT COUNT(*) AS count FROM admin_audit_log').get()?.count || 0,
};

module.exports = { AdminAuditLog };
