/* ⚠️  这是唯一调用 backend/agents/claude-code.js 的入口. 那个抽象层目前未接入生产
   (生产用 backend/services/tmux-agent-hub.js). 本 probe 只为验证 agents 子系统可用. */
/**
 * probe-claude-code.js — 端到端验证 ClaudeCodeBackend 的 4 个方法 + raw 流.
 * 直接用 claude 实跑, 不 mock. 用 sonnet (便宜+快).
 *
 * 序列:
 *   ① createNewSession + initialPrompt "say PING"
 *      期望: raw 流先后看到 system/init + assistant(PING) + result
 *   ② noPauseCurrentAndQueueQueryAtSession "say PONG"
 *      期望: 同一进程, raw 看到 system/init (新 turn) + assistant(PONG) + result
 *   ③ noPause "long story" → 3s 后 pauseCurrentAndResumeFromSession "say STOPPED"
 *      期望: 旧进程结束 (raw 流断), 新进程 raw 流看到 system/init + assistant(STOPPED) + result
 *   ④ terminateSession
 *      期望: isAlive=false
 */
const crypto = require('crypto')

const agents = require('../../backend/agents')

const SESSION_ID = 'probe-' + crypto.randomBytes(4).toString('hex')
const CWD = '/tmp'
const MODEL = 'sonnet'

const backend = agents.get('claude-code')

const rawLines = []
const unsub = backend.getAgentRawThoughtStream(SESSION_ID, (raw) => {
  rawLines.push(raw)
  const sub = raw.subtype ? `/${raw.subtype}` : ''
  let extra = ''
  if (raw.type === 'assistant') {
    const text = (raw.message?.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
    extra = ` text=${JSON.stringify(text.slice(0, 80))} stop_reason=${raw.message?.stop_reason}`
  } else if (raw.type === 'result') {
    extra = ` stop_reason=${raw.stop_reason} cost=${raw.total_cost_usd}`
  } else if (raw.type === 'system' && raw.subtype === 'init') {
    extra = ` agentSessionId=${raw.session_id}`
  }
  console.log(`[raw#${rawLines.length}] ${raw.type}${sub}${extra}`)
})

// 等下一条 result (turn 结束信号)
function waitForResult({ timeoutMs = 120000 } = {}) {
  const seen = rawLines.length
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('waitForResult timeout')), timeoutMs)
    const check = setInterval(() => {
      const r = rawLines.slice(seen).find(x => x.type === 'result')
      if (r) { clearInterval(check); clearTimeout(t); resolve(r) }
    }, 100)
  })
}

;(async () => {
  console.log(`\n=== ① createNewSession sessionId=${SESSION_ID} ===`)
  const handle = await backend.createNewSession({
    sessionId: SESSION_ID,
    cwd: CWD,
    model: MODEL,
    initialPrompt: 'Reply with exactly the single word PING and nothing else.',
  })
  console.log('[handle]', handle)
  let r = await waitForResult()
  console.log('[① done] result.result=', JSON.stringify(r.result))
  console.log('[① alive=]', backend.isAlive(SESSION_ID))

  console.log(`\n=== ② noPauseCurrentAndQueueQueryAtSession ===`)
  await backend.noPauseCurrentAndQueueQueryAtSession({
    sessionId: SESSION_ID,
    prompt: 'Now reply with exactly the single word PONG.',
  })
  r = await waitForResult()
  console.log('[② done] result.result=', JSON.stringify(r.result))

  console.log(`\n=== ③ kick long generation then pauseAndResume ===`)
  await backend.noPauseCurrentAndQueueQueryAtSession({
    sessionId: SESSION_ID,
    prompt: 'Write a 500-word essay about photosynthesis. Take your time.',
  })
  await new Promise(r => setTimeout(r, 3000))
  console.log('[③] firing pauseAndResume after 3s')
  await backend.pauseCurrentAndResumeFromSession({
    sessionId: SESSION_ID,
    prompt: 'Forget previous. Reply with exactly the single word STOPPED.',
  })
  r = await waitForResult()
  console.log('[③ done] result.result=', JSON.stringify(r.result))

  console.log(`\n=== ④ terminateSession ===`)
  await backend.terminateSession(SESSION_ID)
  console.log('[④ alive=]', backend.isAlive(SESSION_ID))

  console.log(`\n=== summary ===`)
  console.log(`total raw lines: ${rawLines.length}`)
  const rawCounts = {}
  for (const r of rawLines) {
    const k = `${r.type}${r.subtype ? '/' + r.subtype : ''}`
    rawCounts[k] = (rawCounts[k] || 0) + 1
  }
  console.log('raw by type:', rawCounts)

  unsub()
  process.exit(0)
})().catch(e => {
  console.error('PROBE FAILED:', e)
  unsub()
  backend.terminateSession(SESSION_ID).catch(() => {}).finally(() => process.exit(1))
})
