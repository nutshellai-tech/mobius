const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const watcher = require('./jsonl-watcher')

const DEFAULT_MAX_LINES = 10000
const DEFAULT_HISTORY_TAIL = 200
const MAX_HISTORY_FETCH = 5000
const MOBIUS_JSONL_VERSION = 1

function mobiusJsonlPathOf(jsonlPath) {
  if (!jsonlPath || typeof jsonlPath !== 'string') return null
  return jsonlPath.endsWith('.jsonl')
    ? jsonlPath.slice(0, -'.jsonl'.length) + '.mobius.jsonl'
    : jsonlPath + '.mobius.jsonl'
}

function fileSize(filePath) {
  if (!filePath) return 0
  try { return fs.existsSync(filePath) ? fs.statSync(filePath).size : 0 }
  catch { return 0 }
}

function parseTimestampMs(entry) {
  const candidates = [
    entry?.timestamp,
    entry?.created_at,
    entry?.payload?.timestamp,
    entry?.message?.created_at,
  ]
  for (const raw of candidates) {
    if (!raw) continue
    const ms = new Date(raw).getTime()
    if (Number.isFinite(ms)) return ms
  }
  return null
}

function sourceOrder(source) {
  return source === 'primary' ? 0 : 1
}

function compareRecords(a, b) {
  const at = parseTimestampMs(a.entry)
  const bt = parseTimestampMs(b.entry)
  if (at != null && bt != null && at !== bt) return at - bt
  if (at == null && bt != null) return -1
  if (at != null && bt == null) return 1
  const so = sourceOrder(a.source) - sourceOrder(b.source)
  if (so !== 0) return so
  return a.index - b.index
}

function readMergedJsonlHistory(jsonlPath, opts = {}) {
  const maxLines = Math.max(0, Math.floor(Number.isFinite(Number(opts.maxLines)) ? Number(opts.maxLines) : DEFAULT_MAX_LINES))
  const tailCount = Math.max(0, Math.floor(Number.isFinite(Number(opts.tailCount)) ? Number(opts.tailCount) : 0))
  const mobiusPath = mobiusJsonlPathOf(jsonlPath)
  // tailCount > 0 时, 单侧读取也按 tailCount 截尾 — 合并后再二次截尾即可,
  // 不必双侧都读满 maxLines 浪费 parse.
  const sideOpts = { ...opts, maxLines, tailCount }
  const primary = watcher.readAll(jsonlPath, sideOpts)
  const mobius = mobiusPath ? watcher.readAll(mobiusPath, sideOpts) : { entries: [], total: 0, totalApproximate: false, truncated: false, size: 0 }
  const records = []

  primary.entries.forEach((entry, index) => records.push({ entry, index, source: 'primary' }))
  mobius.entries.forEach((entry, index) => records.push({ entry, index, source: 'mobius' }))
  records.sort(compareRecords)

  const total = (primary.total || 0) + (mobius.total || 0)
  const effectiveLimit = tailCount > 0
    ? (maxLines > 0 ? Math.min(maxLines, tailCount) : tailCount)
    : maxLines
  const entries = (effectiveLimit > 0 ? records.slice(-effectiveLimit) : []).map((r) => r.entry)
  return {
    entries,
    total,
    totalApproximate: !!primary.totalApproximate || !!mobius.totalApproximate,
    truncated: total > entries.length || !!primary.truncated || !!mobius.truncated,
    sentinel: {
      primary: primary.size || 0,
      mobius: mobius.size || 0,
    },
    paths: {
      primary: jsonlPath || null,
      mobius: mobiusPath || null,
    },
  }
}

/**
 * 仅扫字节数 \n, 不 parse — count-then-tail 的 count 阶段, 给 SSE jsonl_meta / REST 标题用.
 * 同时返回 primary + mobius 两侧字节大小, 方便上层 normalize sentinel.
 * @param {string} jsonlPath
 * @param {object} [opts] 透传 jsonl-watcher.countLines 的 opts
 * @returns {{ total: number, primary: number, mobius: number, totalApproximate: boolean, sizes: {primary:number, mobius:number}, paths: {primary:string|null, mobius:string|null} }}
 */
function countMergedJsonl(jsonlPath, opts = {}) {
  const mobiusPath = mobiusJsonlPathOf(jsonlPath)
  const p = watcher.countLines(jsonlPath, opts)
  const m = mobiusPath ? watcher.countLines(mobiusPath, opts) : { count: 0, size: 0, approximate: false }
  return {
    total: (p.count || 0) + (m.count || 0),
    primary: p.count || 0,
    mobius: m.count || 0,
    totalApproximate: !!p.approximate || !!m.approximate,
    sizes: {
      primary: p.size || 0,
      mobius: m.size || 0,
    },
    paths: {
      primary: jsonlPath || null,
      mobius: mobiusPath || null,
    },
  }
}

/**
 * 取合并 jsonl 历史的 [fromIndex, fromIndex + limit). 用于前端 "展开全部" 按需补齐.
 * 实现: 双侧各自全文件 parse, merge 后按 sort key 取窗口. 仅在用户主动点 "展开全部"
 * 时触发, 不在 SSE 首包路径上, 因此可以接受 O(total) 解析.
 * @param {string} jsonlPath
 * @param {object} [opts]
 * @param {number} [opts.fromIndex=0]
 * @param {number} [opts.limit=DEFAULT_HISTORY_TAIL]
 * @param {number} [opts.maxBytes] 透传 readSlice 的安全上限
 * @returns {{ entries: object[], total: number, from: number, returned: number, exceeded: boolean }}
 */
function readMergedJsonlSlice(jsonlPath, opts = {}) {
  const fromIndex = Math.max(0, Math.floor(Number.isFinite(Number(opts.fromIndex)) ? Number(opts.fromIndex) : 0))
  const limit = Math.max(0, Math.min(
    MAX_HISTORY_FETCH,
    Math.floor(Number.isFinite(Number(opts.limit)) ? Number(opts.limit) : DEFAULT_HISTORY_TAIL),
  ))
  const mobiusPath = mobiusJsonlPathOf(jsonlPath)

  // 单侧拿全文件 (上限受 readSlice.maxBytes 保护). 这里 limit 给一个很大的值,
  // 因为我们需要 merge 后再取窗口, 不能只取单侧前 N 行.
  const sliceOpts = { fromIndex: 0, limit: Number.MAX_SAFE_INTEGER, ...(opts.maxBytes ? { maxBytes: opts.maxBytes } : {}) }
  const p = watcher.readSlice(jsonlPath, sliceOpts)
  const m = mobiusPath ? watcher.readSlice(mobiusPath, sliceOpts) : { entries: [], total: 0, exceeded: false }
  if (p.exceeded || m.exceeded) {
    return { entries: [], total: (p.total || 0) + (m.total || 0), from: fromIndex, returned: 0, exceeded: true }
  }
  const records = []
  p.entries.forEach((entry, index) => records.push({ entry, index, source: 'primary' }))
  m.entries.forEach((entry, index) => records.push({ entry, index, source: 'mobius' }))
  records.sort(compareRecords)
  const total = records.length
  const slice = limit > 0 ? records.slice(fromIndex, fromIndex + limit) : []
  return {
    entries: slice.map((r) => r.entry),
    total,
    from: fromIndex,
    returned: slice.length,
    exceeded: false,
  }
}

function currentMergedJsonlSentinel(jsonlPath) {
  const mobiusPath = mobiusJsonlPathOf(jsonlPath)
  return {
    primary: fileSize(jsonlPath),
    mobius: fileSize(mobiusPath),
  }
}

function normalizeSentinel(sentinel, jsonlPath) {
  const current = currentMergedJsonlSentinel(jsonlPath)
  if (typeof sentinel === 'number') {
    return {
      primary: Math.max(0, sentinel),
      mobius: sentinel === 0 ? 0 : current.mobius,
    }
  }
  if (!sentinel || typeof sentinel !== 'object') return current
  const primary = Number(sentinel.primary ?? sentinel.primarySize ?? sentinel.size)
  const mobius = Number(sentinel.mobius ?? sentinel.mobiusSize)
  return {
    primary: Number.isFinite(primary) && primary >= 0 ? primary : current.primary,
    mobius: Number.isFinite(mobius) && mobius >= 0 ? mobius : current.mobius,
  }
}

function watchMergedJsonl({ path: jsonlPath, startSentinel, onEntry, onPrimaryEntry, onError = () => {} }) {
  if (!jsonlPath || typeof onEntry !== 'function') {
    throw new Error('watchMergedJsonl 需要 { path, onEntry }')
  }
  const mobiusPath = mobiusJsonlPathOf(jsonlPath)
  const offsets = normalizeSentinel(startSentinel, jsonlPath)
  const watchers = []

  watchers.push(watcher.watch({
    path: jsonlPath,
    startOffset: offsets.primary,
    onEntry: (raw, lineNo) => {
      try { if (typeof onPrimaryEntry === 'function') onPrimaryEntry(raw, lineNo) } catch (e) { onError(e) }
      onEntry(raw, lineNo, 'primary')
    },
    onError,
  }))

  if (mobiusPath) {
    watchers.push(watcher.watch({
      path: mobiusPath,
      startOffset: offsets.mobius,
      onEntry: (raw, lineNo) => onEntry(raw, lineNo, 'mobius'),
      onError,
    }))
  }

  return {
    stop() {
      for (const w of watchers) {
        try { w.stop() } catch {}
      }
    },
    state() {
      return {
        primary: watchers[0]?.state?.() || null,
        mobius: watchers[1]?.state?.() || null,
      }
    },
  }
}

function promptKind(content, explicitKind) {
  if (explicitKind) return explicitKind
  const text = String(content || '').trim()
  return text.startsWith('/compact') ? 'compact' : 'user_input'
}

function buildMobiusUserEntry({
  sessionId,
  agentSessionId,
  cwd,
  backendName,
  content,
  inputText,
  requestId,
  turnNumber,
  source,
  userId,
  kind,
  timestamp,
}) {
  const ts = timestamp || new Date().toISOString()
  const body = String(content || '')
  const typed = inputText == null ? null : String(inputText)
  const resolvedKind = promptKind(body, kind)
  const promptId = crypto.randomUUID()
  const entry = {
    parentUuid: null,
    isSidechain: false,
    promptId,
    type: 'user',
    message: {
      role: 'user',
      content: body,
    },
    uuid: crypto.randomUUID(),
    timestamp: ts,
    permissionMode: 'bypassPermissions',
    userType: 'external',
    entrypoint: 'mobius',
    cwd: cwd || null,
    sessionId: agentSessionId || sessionId,
    version: `mobius-jsonl/${MOBIUS_JSONL_VERSION}`,
    mobius: {
      schema_version: MOBIUS_JSONL_VERSION,
      source: source || 'session.send',
      kind: resolvedKind,
      backend: backendName || null,
      session_id: sessionId || null,
      agent_session_id: agentSessionId || null,
      user_id: userId || null,
      request_id: requestId || null,
      turn_number: Number.isFinite(Number(turnNumber)) ? Number(turnNumber) : null,
      input_text: typed,
      content_length: body.length,
      captured_at: ts,
    },
  }
  return entry
}

function appendMobiusPromptEntry({ jsonlPath, ...entryOpts }) {
  const filePath = mobiusJsonlPathOf(jsonlPath)
  if (!filePath) throw new Error('缺少原始 JSONL 路径, 无法写入 mobius JSONL')
  const entry = buildMobiusUserEntry(entryOpts)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n')
  return { filePath, entry }
}

module.exports = {
  mobiusJsonlPathOf,
  readMergedJsonlHistory,
  readMergedJsonlSlice,
  countMergedJsonl,
  currentMergedJsonlSentinel,
  watchMergedJsonl,
  buildMobiusUserEntry,
  appendMobiusPromptEntry,
  DEFAULT_HISTORY_TAIL,
  MAX_HISTORY_FETCH,
}
