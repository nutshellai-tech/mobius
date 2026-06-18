/**
 * src/bridge/instance.js — 兼容 shim.
 *
 * 旧 v1 / 早期 v2 时代留下的 routes/admin/sessions/health 等模块
 * 都 require 这里取 `bridge`. 新架构 (v1.10 起 agents 抽象层) 不再有"bridge"概念,
 * 但短期保留这个 shim 避免大面积改 routes. 关键方法转给 backend:
 *   - closeSession(sessionKey)      → fire-and-forget 关进程 (归一 session_key → sessionId)
 *   - closeSessionAsync(sessionKey) → 可 await, 返回 {killed,wasWorking} 供"抛出提醒"
 *   - sendMessage(...)         → noop (新链路是 HTTP send route → backend.noPauseAndQueue; SSE 负责回推)
 *   - isConnected()            → 恒 true
 *   - status()                 → backend.listSessions 概览
 */
const agents = require('../agents')
const modelRegistry = require('../services/model-registry')

// session_key 形如 `web:<userId>:<sessionId>`, 而 backend 一律按裸 sessionId
// (= tmux window 名 / runtime map key) 寻址. 历史遗留 bug: routes 把 session_key
// 原样传进 closeSession → terminateSession(sessionKey) → windowExists(sessionKey)
// 恒 false → tmux kill-window 从不执行 → 后台 claude code 杀不掉 (静默失败).
// 这里统一归一: 剥掉 `web:<uid>:` 前缀, 拿到真正的 sessionId.
function toAgentSessionId(keyOrId) {
  if (!keyOrId) return keyOrId
  const m = String(keyOrId).match(/^web:[^:]+:(.+)$/)
  return m ? m[1] : String(keyOrId)
}

const bridge = {
  isConnected() { return true },

  // 可 await 版: 归一 session_key → 裸 sessionId, 返回 backend.terminateSession 的结果
  // ({ sessionId, killed, wasWorking }), 供调用方据此"抛出提醒".
  async closeSessionAsync(sessionKey, model) {
    const sid = toAgentSessionId(sessionKey)
    const backend = agents.get(modelRegistry.backendNameForSessionModel(model))
    const r = await backend.terminateSession(sid)
    console.log(`[mobius/bridge-shim] close ${sessionKey} (sid=${sid}, backend=${backend.name}) → killed=${r?.killed} working=${r?.wasWorking}`)
    return r || { sessionId: sid, killed: false, wasWorking: false }
  },

  // 兼容 fire-and-forget 同步 API: 老 routes 不 await 时仍可用.
  closeSession(sessionKey, model) {
    return bridge.closeSessionAsync(sessionKey, model)
      .catch((e) => { console.warn('[mobius/bridge-shim] close failed:', e.message); return { killed: false, error: e.message } })
  },

  sendMessage(sessionKey) {
    console.warn(`[mobius/bridge-shim] sendMessage(${sessionKey}) 被调用 — 新架构应该走 HTTP send route → backend`)
    return false
  },

  sendCardAction() { return false },

  status() {
    const backend = agents.get(modelRegistry.backendNameForSessionModel())
    return {
      v2: true,
      backend: backend.name,
      active_sessions: backend.listSessions(),
    }
  },
}

module.exports = { bridge }
