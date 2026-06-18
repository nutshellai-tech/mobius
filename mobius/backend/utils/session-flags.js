const fs = require('fs')
const path = require('path')

function flagDirOf(root, sessionId) {
  return path.join(path.resolve(root), '.imac', 'flags', sessionId)
}

function runningFlagPathOf(root, sessionId) {
  return path.join(flagDirOf(root, sessionId), 'running.flag')
}

function failedFlagPathOf(root, sessionId) {
  return path.join(flagDirOf(root, sessionId), 'failed.flag')
}

function encodeFlagValue(value) {
  return String(value ?? '')
    .replace(/\r?\n/g, '\\n')
    .slice(0, 2000)
}

function decodeFlagValue(value) {
  return String(value ?? '').replace(/\\n/g, '\n')
}

function parseFlagBody(body) {
  const out = {}
  for (const line of String(body || '').split('\n')) {
    const i = line.indexOf('=')
    if (i < 0) continue
    out[line.slice(0, i)] = decodeFlagValue(line.slice(i + 1))
  }
  return out
}

// 解析 running.flag 为 { session, runId, startedAt, backend, ... }; 不存在/读失败返回 null.
function readRunningFlag(root, sessionId) {
  if (!root || !sessionId) return null
  try {
    return parseFlagBody(fs.readFileSync(runningFlagPathOf(root, sessionId), 'utf8'))
  } catch {
    return null
  }
}

// 解析 failed.flag 为 { session, failedAt, backend, reason, ... }; 不存在/读失败返回 null.
function readFailedFlag(root, sessionId) {
  if (!root || !sessionId) return null
  try {
    return parseFlagBody(fs.readFileSync(failedFlagPathOf(root, sessionId), 'utf8'))
  } catch {
    return null
  }
}

function writeRunningFlag(root, sessionId, fields = {}) {
  if (!root || !sessionId) return false
  fs.mkdirSync(flagDirOf(root, sessionId), { recursive: true })
  const existing = readRunningFlag(root, sessionId)
  const startedAt = existing?.startedAt || new Date().toISOString()
  const runId = existing?.runId || `${sessionId}:${startedAt}`
  const body = {
    session: sessionId,
    runId,
    pid: process.pid,
    startedAt,
    ...fields,
  }
  fs.writeFileSync(
    runningFlagPathOf(root, sessionId),
    Object.entries(body)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${encodeFlagValue(v)}`)
      .join('\n') + '\n',
  )
  try { removeFailedFlag(root, sessionId) }
  catch (e) { console.warn(`[session-flags] remove stale failed.flag failed (${sessionId}): ${e.message}`) }
  return true
}

function safeWriteRunningFlag(root, sessionId, fields = {}, label = 'session-flags') {
  try { return writeRunningFlag(root, sessionId, fields) }
  catch (e) {
    console.warn(`[${label}] write running.flag failed (${sessionId}): ${e.message}`)
    return false
  }
}

function removeRunningFlag(root, sessionId) {
  if (!root || !sessionId) return false
  fs.rmSync(runningFlagPathOf(root, sessionId), { force: true })
  return true
}

function safeRemoveRunningFlag(root, sessionId, label = 'session-flags') {
  try { return removeRunningFlag(root, sessionId) }
  catch (e) {
    console.warn(`[${label}] remove running.flag failed (${sessionId}): ${e.message}`)
    return false
  }
}

function removeFailedFlag(root, sessionId) {
  if (!root || !sessionId) return false
  fs.rmSync(failedFlagPathOf(root, sessionId), { force: true })
  return true
}

function safeRemoveFailedFlag(root, sessionId, label = 'session-flags') {
  try { return removeFailedFlag(root, sessionId) }
  catch (e) {
    console.warn(`[${label}] remove failed.flag failed (${sessionId}): ${e.message}`)
    return false
  }
}

function writeFailedFlag(root, sessionId, fields = {}) {
  if (!root || !sessionId) return false
  fs.mkdirSync(flagDirOf(root, sessionId), { recursive: true })
  const body = {
    session: sessionId,
    failedAt: new Date().toISOString(),
    ...fields,
  }
  fs.writeFileSync(
    failedFlagPathOf(root, sessionId),
    Object.entries(body)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${encodeFlagValue(v)}`)
      .join('\n') + '\n',
  )
  return true
}

function safeWriteFailedFlag(root, sessionId, fields = {}, label = 'session-flags') {
  try { return writeFailedFlag(root, sessionId, fields) }
  catch (e) {
    console.warn(`[${label}] write failed.flag failed (${sessionId}): ${e.message}`)
    return false
  }
}

function safeRemoveFlagDir(root, sessionId, label = 'session-flags') {
  if (!root || !sessionId) return false
  try {
    fs.rmSync(flagDirOf(root, sessionId), { recursive: true, force: true })
    return true
  } catch (e) {
    console.warn(`[${label}] remove flag dir failed (${sessionId}): ${e.message}`)
    return false
  }
}

module.exports = {
  flagDirOf,
  runningFlagPathOf,
  failedFlagPathOf,
  writeRunningFlag,
  safeWriteRunningFlag,
  readRunningFlag,
  removeRunningFlag,
  safeRemoveRunningFlag,
  removeFailedFlag,
  safeRemoveFailedFlag,
  writeFailedFlag,
  safeWriteFailedFlag,
  readFailedFlag,
  safeRemoveFlagDir,
}
