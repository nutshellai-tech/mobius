const { db } = require('../../db');

function audit(actorId, action, entityType, entityId, detail = '') {
  try {
    db.prepare(
      'INSERT INTO integration_audit_logs (actor_id, action, entity_type, entity_id, detail) VALUES (?, ?, ?, ?, ?)'
    ).run(actorId, action, entityType, entityId, detail);
  } catch {}
}

module.exports = { audit };
