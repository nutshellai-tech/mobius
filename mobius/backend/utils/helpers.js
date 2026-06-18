const fs = require('fs');
const path = require('path');
const { TEST_ROOT } = require('../config');

function nowIso() {
  return new Date().toISOString();
}

function currentBaseRevision() {
  try {
    const gitHead = path.join(TEST_ROOT, '.git', 'HEAD');
    if (fs.existsSync(gitHead)) {
      const head = fs.readFileSync(gitHead, 'utf8').trim();
      if (head.startsWith('ref:')) {
        const refPath = path.join(TEST_ROOT, '.git', head.replace('ref:', '').trim());
        if (fs.existsSync(refPath)) return `test-main@${fs.readFileSync(refPath, 'utf8').trim().slice(0, 12)}`;
      }
      if (head) return `test-main@${head.slice(0, 12)}`;
    }
  } catch {}
  return `test-main@${nowIso()}`;
}

function normalizeChangedFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  let p = filePath.trim().replace(/^["'`]+|["'`]+$/g, '');
  if (!p) return null;
  p = p.replace(/\\/g, '/');
  p = p.replace(/^\/home\/user\/imac-test\//, '');
  p = p.replace(/^imac-test\//, '');
  p = p.replace(/^\.\//, '');
  if (p.includes('..') || p.startsWith('/')) return null;
  if (!p || p.length > 220) return null;
  return p;
}

function fileRisk(filePath) {
  if (/(^|\/)(db\.js|schema|migration)/i.test(filePath)) return 'schema';
  if (/config|\.toml$|\.env|gateway-manager\.sh|package(-lock)?\.json$/i.test(filePath)) return 'config';
  if (/server\.js$|bridge-client\.js$/.test(filePath)) return 'high';
  if (/frontend\/src\//.test(filePath)) return 'medium';
  return 'low';
}

function conflictId(leftId, rightId, filePath) {
  const [a, b] = [leftId, rightId].sort();
  return `${a}:${b}:${Buffer.from(filePath).toString('base64url').slice(0, 32)}`;
}

function conflictKind(filePath, risk) {
  if (risk === 'schema') return { type: 'schema', severity: 'blocking' };
  if (risk === 'config') return { type: 'config', severity: 'blocking' };
  if (/server\.js$|db\.js$/.test(filePath)) return { type: 'same_symbol', severity: 'blocking' };
  return { type: 'same_file', severity: 'warn' };
}

function permissionContentFromValue(value) {
  switch (String(value || '').trim()) {
    case 'perm:allow':
    case 'allow':
      return 'allow';
    case 'perm:deny':
    case 'deny':
      return 'deny';
    case 'perm:allow_all':
    case 'allow_all':
    case 'allow all':
      return 'allow all';
    default:
      return '';
  }
}

function extractTaskId(sessionKey) {
  // web:userId:taskId → taskId
  const parts = (sessionKey || '').split(':');
  return parts.length >= 3 ? parts[2] : sessionKey;
}

module.exports = {
  nowIso,
  currentBaseRevision,
  normalizeChangedFile,
  fileRisk,
  conflictId,
  conflictKind,
  permissionContentFromValue,
  extractTaskId,
};
