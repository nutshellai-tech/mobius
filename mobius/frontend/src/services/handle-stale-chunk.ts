// 检测 Vite 动态 import 失败（典型场景：后端跑 start.py 重新构建后，
// chunk 文件名 hash 变了，但浏览器还拿着旧 index.html 里的旧 hash 去拉，
// 拉不到就抛 "Failed to fetch dynamically imported module"）。
// 这种情况下应用已经不可用，直接弹原生 confirm 问用户是否立即刷新。

const FAILURE_PATTERNS = [
  'failed to fetch dynamically imported module',
  'error loading dynamically imported module',
  'importing a module script failed',
  'failed to load module script',
]

let confirmed = false

function isStaleChunkError(err: unknown): boolean {
  if (!err) return false
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return FAILURE_PATTERNS.some(p => msg.includes(p))
}

function shouldReload(): boolean {
  if (confirmed) return false
  confirmed = true
  return window.confirm('Mobius似乎刚刚完成一次自我迭代，是否现在立即刷新？')
}

function reloadHard() {
  // 给 index.html 强制走网络，避免 304/强缓存导致继续拉旧 chunk 列表
  const url = new URL(window.location.href)
  url.searchParams.set('__mobius_refresh', String(Date.now()))
  window.location.replace(url.toString())
}

function handleErrorEvent(event: ErrorEvent) {
  if (isStaleChunkError(event.error ?? event.message) && shouldReload()) {
    reloadHard()
  }
}

function handleRejectionEvent(event: PromiseRejectionEvent) {
  if (isStaleChunkError(event.reason) && shouldReload()) {
    event.preventDefault()
    reloadHard()
  }
}

export function installStaleChunkHandler() {
  if (typeof window === 'undefined') return
  window.addEventListener('error', handleErrorEvent)
  window.addEventListener('unhandledrejection', handleRejectionEvent)
}
