const { AdminAuditLog } = require('../repositories/admin-audit-log');

function recordAdminAuditIfCrossUser(user, action, resourceType, resourceId, ownerId) {
  if (!user || user.role !== 'admin') return null;
  const owner = String(ownerId || '').trim();
  if (owner && owner === user.id) return null;
  try {
    return AdminAuditLog.record({
      adminId: user.id,
      action,
      resourceType,
      resourceId,
    });
  } catch (e) {
    console.warn(`[admin-audit] record failed: ${e.message}`);
    return null;
  }
}

module.exports = { recordAdminAuditIfCrossUser };
