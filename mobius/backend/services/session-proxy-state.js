const modelRegistry = require('./model-registry')
const agents = require('../agents')

function normalizeUseProxy(value) {
  if (value === true || value === 1 || value === '1' || value === 'true') return true
  if (value === false || value === 0 || value === '0' || value === 'false') return false
  return null
}

function useProxyForSession(session, backend = null) {
  let launch
  try {
    launch = modelRegistry.launchOptionsForSession(session)
  } catch {
    // Historical sessions may reference removed models (for example old Sonnet ids).
    // They are not launchable, but admin/status views should stay quiet and direct.
    return 0
  }
  if (launch.forceNoProxy) return 0
  const backendName = backend?.name || launch.backend
  const resolvedBackend = backend || agents.get(backendName)
  const runtimeUseProxy = typeof resolvedBackend.getSessionUseProxy === 'function'
    ? resolvedBackend.getSessionUseProxy(session?.session_id)
    : null
  const normalizedRuntime = normalizeUseProxy(runtimeUseProxy)
  if (normalizedRuntime !== null) return normalizedRuntime ? 1 : 0
  // 管理中心的模型级网络代理设置是唯一信源; 缺省一律直连.
  if (typeof launch.useProxy === 'boolean') return launch.useProxy ? 1 : 0
  return 0
}

function withSessionProxyState(session) {
  if (!session) return session
  let launch
  try {
    launch = modelRegistry.launchOptionsForSession(session)
  } catch {
    return {
      ...session,
      use_proxy: 0,
      agent_backend: null,
      model_label: String(session.model || ''),
    }
  }
  return {
    ...session,
    use_proxy: useProxyForSession(session),
    agent_backend: launch.backend,
    model_label: launch.label,
  }
}

function withSessionProxyStates(sessions) {
  return Array.isArray(sessions) ? sessions.map(withSessionProxyState) : []
}

module.exports = {
  useProxyForSession,
  withSessionProxyState,
  withSessionProxyStates,
}
