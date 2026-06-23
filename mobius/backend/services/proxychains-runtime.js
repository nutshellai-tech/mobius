/**
 * proxychains-runtime.js — 出网 proxychains 的运行时工具.
 *
 * 职责:
 *   - detectAvailability(): 探测本机 proxychains4 二进制 + libproxychains.so 库路径,
 *     供前端给出「未检测到 proxychains4」的友好提示.
 *   - buildSpawnEnv(kind): 给需要出网的子进程构造 LD_PRELOAD + PROXYCHAINS_CONF_FILE
 *     环境变量. 当 admin 关闭对应开关时返回 null, 调用方应当回退到不注入环境.
 *   - runTest(kind): 用当前配置通过 proxychains4 跑一次 curl https://ifconfig.me,
 *     报告成功/失败 + 耗时 + 出口 IP.
 *
 * 配置落盘在 admin-settings.js (CORE_DATA_PATH/proxychains/{model,system}.conf).
 * 这里只负责运行时探测与包装, 不读写 admin-settings.
 */
const fs = require('fs')
const { spawn, spawnSync } = require('child_process')
const { execFileSync } = require('child_process')
const adminSettings = require('./admin-settings')

// 模型测试 endpoint (默认): 任选一个稳定且返回 IP/简单 JSON 的 https 地址.
const MODEL_TEST_URL = 'https://api.anthropic.com/v1/messages'
const SYSTEM_TEST_URL = 'https://ifconfig.me/ip'

// LD_PRELOAD / PROXYCHAINS_CONF_FILE 注入: 用 LD_PRELOAD 方式比 proxychains4 包装
// 更通用 (对子进程是否启动新 SHELL 不挑食), 因此 spawnEnv 默认走 LD_PRELOAD.
function findLibProxychains() {
  const candidates = [
    '/usr/lib/x86_64-linux-gnu/libproxychains.so.4',
    '/usr/lib/x86_64-linux-gnu/libproxychains.so',
    '/usr/lib/aarch64-linux-gnu/libproxychains.so.4',
    '/usr/lib/aarch64-linux-gnu/libproxychains.so',
    '/usr/lib/libproxychains.so.4',
    '/usr/lib/libproxychains.so',
    '/lib/x86_64-linux-gnu/libproxychains.so.4',
    '/lib/aarch64-linux-gnu/libproxychains.so.4',
  ]
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p
    } catch {}
  }
  // 兜底: ldconfig 找.
  try {
    const out = execFileSync('sh', ['-c', 'ldconfig -p 2>/dev/null | grep -i "libproxychains\\.so" | head -1 | awk \'{print $NF}\''], { encoding: 'utf8' }).trim()
    if (out && fs.existsSync(out)) return out
  } catch {}
  return null
}

function findProxychainsBin() {
  for (const bin of ['proxychains4', 'proxychains']) {
    try {
      const r = spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' })
      const p = (r.stdout || '').trim()
      if (p && fs.existsSync(p)) return p
    } catch {}
  }
  return null
}

let availabilityCache = null
let availabilityCacheAt = 0
const AVAILABILITY_CACHE_TTL_MS = 60_000

function detectAvailability({ refresh = false } = {}) {
  const now = Date.now()
  if (!refresh && availabilityCache && now - availabilityCacheAt < AVAILABILITY_CACHE_TTL_MS) {
    return availabilityCache
  }
  const result = {
    ok: false,
    binPath: null,
    libPath: null,
    reason: '',
  }
  result.binPath = findProxychainsBin()
  result.libPath = findLibProxychains()
  if (!result.binPath) {
    result.reason = '未检测到 proxychains4 二进制 (PATH 中没有 proxychains4 / proxychains). 请先安装: apt install proxychains4'
  } else if (!result.libPath) {
    result.reason = '未检测到 libproxychains.so 库. 请安装: apt install libproxychains4'
  } else {
    result.ok = true
  }
  availabilityCache = result
  availabilityCacheAt = now
  return result
}

// 读取已落盘的 .conf 路径. 调用方应优先用 proxychainsConfPathForKind 拿到具体文件.
function resolveConfForKind(kind) {
  const k = adminSettings.normalizeProxychainsKind(kind)
  const cfg = adminSettings.getProxychains()
  const enabled = k === 'model' ? cfg.modelEnabled : cfg.systemEnabled
  if (!enabled) return null
  const confPath = adminSettings.proxychainsConfPathForKind(k)
  if (!confPath || !fs.existsSync(confPath)) return null
  return confPath
}

/**
 * 给子进程构造 LD_PRELOAD + PROXYCHAINS_CONF_FILE 环境.
 * 返回 null 表示当前 kind 未启用或没有 conf — 调用方应当回退到不注入环境.
 *
 * 注意: 调用方应把这个 env 与 process.env 合并, 不要直接替换.
 */
function buildSpawnEnv(kind) {
  const confPath = resolveConfForKind(kind)
  if (!confPath) return null
  const availability = detectAvailability()
  if (!availability.ok || !availability.libPath) return null
  return {
    LD_PRELOAD: availability.libPath,
    PROXYCHAINS_CONF_FILE: confPath,
    // proxychains 默认 quiet; 部分版本用 PROXYCHAINS_QUIET_MODE.
    PROXYCHAINS_QUIET_MODE: '1',
  }
}

/**
 * 是否应当给某个出网路径注入 proxychains. 提供给 launch session 之类的入口快速判断.
 */
function isEnabledForKind(kind) {
  const k = adminSettings.normalizeProxychainsKind(kind)
  const cfg = adminSettings.getProxychains()
  return k === 'model' ? !!cfg.modelEnabled : !!cfg.systemEnabled
}

/**
 * 测试当前 kind 的 proxychains 配置:
 *   - model: curl 一个 https LLM endpoint, 不需要鉴权, 期望返回 4xx 也算"通到了外网".
 *   - system: curl https://ifconfig.me/ip, 直接读出口 IP.
 *
 * 输出: { ok, elapsedMs, exitIp?, httpStatus?, error? }
 */
function runTest(kind, { timeoutMs = 15_000 } = {}) {
  const k = adminSettings.normalizeProxychainsKind(kind)
  const availability = detectAvailability({ refresh: true })
  if (!availability.ok) {
    return Promise.resolve({ ok: false, error: availability.reason || 'proxychains 不可用' })
  }
  const cfg = adminSettings.getProxychains()
  const enabled = k === 'model' ? cfg.modelEnabled : cfg.systemEnabled
  if (!enabled) {
    return Promise.resolve({ ok: false, error: `${k} proxychains 开关未启用` })
  }
  const confPath = adminSettings.proxychainsConfPathForKind(k)
  if (!confPath || !fs.existsSync(confPath)) {
    return Promise.resolve({ ok: false, error: `${k} 配置文件不存在, 请先保存配置` })
  }
  const testUrl = k === 'model' ? MODEL_TEST_URL : SYSTEM_TEST_URL
  const args = ['-q', '-f', confPath, 'curl', '-sS', '-m', String(Math.max(3, Math.floor(timeoutMs / 1000))),
    '-o', '-', '-w', '\n__HTTP_STATUS__:%{http_code}\n', testUrl]
  const startedAt = Date.now()
  return new Promise((resolve) => {
    let settled = false
    let stdoutBuf = ''
    let stderrBuf = ''
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    const proc = spawn(availability.binPath, args, {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL') } catch {}
      finish({ ok: false, error: `测试超时 (${timeoutMs}ms)`, elapsedMs: Date.now() - startedAt })
    }, timeoutMs + 1000)
    proc.stdout.on('data', (d) => { stdoutBuf += d.toString() })
    proc.stderr.on('data', (d) => { stderrBuf += d.toString() })
    proc.on('error', (e) => {
      clearTimeout(timer)
      finish({ ok: false, error: `spawn 失败: ${e.message}`, elapsedMs: Date.now() - startedAt })
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      const elapsedMs = Date.now() - startedAt
      const m = stdoutBuf.match(/__HTTP_STATUS__:(\d+)/)
      const httpStatus = m ? parseInt(m[1], 10) : null
      const body = stdoutBuf.replace(/__HTTP_STATUS__:\d+\s*$/, '').trim()
      // 解析出口 IP: ifconfig.me/ip 直接返回 IP; anthropic 返回 JSON 不暴露 IP.
      let exitIp = null
      const ipMatch = body.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/)
      if (ipMatch) exitIp = ipMatch[1]
      if (code === 0 && (httpStatus === null || httpStatus < 500)) {
        finish({ ok: true, elapsedMs, httpStatus, exitIp, body: body.slice(0, 256) })
        return
      }
      const errTail = (stderrBuf || body || '').trim().split('\n').slice(-3).join(' | ')
      finish({
        ok: false,
        elapsedMs,
        httpStatus,
        exitIp,
        error: `proxychains exit=${code}${httpStatus ? ` http=${httpStatus}` : ''}${errTail ? ` · ${errTail}` : ''}`,
      })
    })
  })
}

module.exports = {
  detectAvailability,
  buildSpawnEnv,
  isEnabledForKind,
  runTest,
  resolveConfForKind,
  MODEL_TEST_URL,
  SYSTEM_TEST_URL,
}
