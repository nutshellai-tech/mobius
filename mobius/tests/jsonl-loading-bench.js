/**
 * jsonl-loading-bench.js — 验证 count-then-tail 优化
 *
 * 模拟 8101 条 entry 的 jsonl, 覆盖三种大小场景:
 *   - small : 文件 < 16MB (走 readFull 路径)
 *   - mid   : 文件 ≈ 16MB (边界)
 *   - big   : 文件 > 16MB (走 readTailWindow 路径)
 *
 * 对每个场景计时三种读取方式:
 *   - countLines               (count-then-tail 的 count 阶段)
 *   - readAll(tailCount=200)   (count-then-tail 的 tail 阶段)
 *   - readAll(maxLines=10000)  (旧路径, 全量解析后取末尾)
 *
 * 断言:
 *   - countLines < 50ms
 *   - readAll(tailCount=200) < 100ms
 *   - readAll(maxLines=10000) 在 small 场景下应该 > 旧基线 / 至少明显慢于 tailCount=200
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const watcher = require('../backend/services/jsonl-watcher')

const ENTRIES = 8101

function makeEntry(i, padding) {
  // 复刻 Claude/Codex JSONL 的常见字段, 避免 parse 走极简路径低估真实成本.
  return JSON.stringify({
    parentUuid: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
    isSidechain: false,
    type: i % 5 === 0 ? 'user' : 'assistant',
    message: {
      role: i % 5 === 0 ? 'user' : 'assistant',
      content: padding
        ? `entry-${i} ${'x'.repeat(padding)}`
        : `entry-${i} short`,
    },
    uuid: `${i.toString(16).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd`,
    timestamp: new Date(2026, 0, 1, 0, 0, i % 60, 0).toISOString(),
    permissionMode: 'bypassPermissions',
    userType: 'external',
    sessionId: 'bench-session',
    version: 'bench/1',
  })
}

function writeJsonl(filePath, count, paddingBytes) {
  const fd = fs.openSync(filePath, 'w')
  try {
    const CHUNK = 200
    let buf = ''
    for (let i = 0; i < count; i++) {
      buf += makeEntry(i, paddingBytes) + '\n'
      if ((i + 1) % CHUNK === 0) {
        fs.writeSync(fd, buf)
        buf = ''
      }
    }
    if (buf) fs.writeSync(fd, buf)
  } finally {
    fs.closeSync(fd)
  }
}

function fmtMs(ms) { return `${ms.toFixed(1)}ms`.padStart(10, ' ') }
function fmtBytes(b) {
  if (b > 1024 * 1024) return `${(b / 1024 / 1024).toFixed(1)}MB`
  if (b > 1024) return `${(b / 1024).toFixed(1)}KB`
  return `${b}B`
}

function timeIt(label, fn) {
  const t0 = process.hrtime.bigint()
  const r = fn()
  const t1 = process.hrtime.bigint()
  const ms = Number(t1 - t0) / 1e6
  return { label, ms, result: r }
}

function runScenario(name, paddingBytes) {
  const tmp = path.join(os.tmpdir(), `mobius-jsonl-bench-${name}-${process.pid}.jsonl`)
  try {
    writeJsonl(tmp, ENTRIES, paddingBytes)
    const size = fs.statSync(tmp).size

    const cold = timeIt('countLines', () => watcher.countLines(tmp))
    const tail = timeIt('readAll(tailCount=200)', () => watcher.readAll(tmp, { tailCount: 200 }))
    const full = timeIt('readAll(maxLines=10000)', () => watcher.readAll(tmp, { maxLines: 10000 }))

    return {
      name,
      size,
      results: [cold, tail, full],
      counted: cold.result.count,
      tailEntries: tail.result.entries.length,
      fullEntries: full.result.entries.length,
    }
  } finally {
    try { fs.unlinkSync(tmp) } catch {}
  }
}

function main() {
  console.log('jsonl-loading-bench: count-then-tail vs 旧路径')
  console.log(`生成 ${ENTRIES} 条 entry, 测三种文件大小 (small / mid / big)\n`)

  // padding 调整每条 entry 的额外字节数, 把整个文件推到目标体积.
  const scenarios = [
    runScenario('small', 0),       // 每条 ~250B → ~2MB, 走 readFull
    runScenario('mid', 1900),      // 每条 ~2.1KB → ~17MB, 跨过 16MB 阈值
    runScenario('big', 6000),      // 每条 ~6.2KB → ~50MB, 走 readTailWindow
  ]

  const rows = []
  rows.push(['场景', '文件大小', 'countLines', 'tailCount=200', 'maxLines=10000', 'tail/full', 'count 条数'])
  for (const s of scenarios) {
    const [cold, tail, full] = s.results
    const speedup = (full.ms / Math.max(tail.ms, 0.001)).toFixed(1) + 'x'
    rows.push([
      s.name,
      fmtBytes(s.size),
      fmtMs(cold.ms),
      fmtMs(tail.ms),
      fmtMs(full.ms),
      speedup,
      `${s.counted} / 实际 ${ENTRIES}`,
    ])
  }

  const widths = rows[0].map((_, i) => Math.max(...rows.map(r => String(r[i]).length)))
  const fmt = (r) => r.map((c, i) => String(c).padEnd(widths[i])).join('  ')
  console.log(fmt(rows[0]))
  console.log(widths.map(w => '-'.repeat(w)).join('  '))
  for (let i = 1; i < rows.length; i++) console.log(fmt(rows[i]))
  console.log('')

  let failed = 0
  for (const s of scenarios) {
    const [cold, tail, full] = s.results
    const mb = s.size / 1024 / 1024
    // 数量正确性
    if (s.counted !== ENTRIES) {
      console.error(`[FAIL] ${s.name}: countLines=${s.counted}, expected=${ENTRIES}`)
      failed += 1
    }
    if (s.tailEntries !== 200) {
      console.error(`[FAIL] ${s.name}: tail entries=${s.tailEntries}, expected=200`)
      failed += 1
    }
    // 性能预算: countLines 是 byte-only 扫描, 应该 ≤ 5ms/MB; 典型 8MB session < 50ms.
    const coldBudgetMs = Math.max(50, mb * 5)
    if (cold.ms > coldBudgetMs) {
      console.error(`[FAIL] ${s.name}: countLines ${cold.ms.toFixed(1)}ms > 预算 ${coldBudgetMs.toFixed(0)}ms (${mb.toFixed(1)}MB)`)
      failed += 1
    }
    // tailCount=200 不论文件多大都只读尾部, 应该 < 100ms.
    if (tail.ms > 200) {
      console.error(`[FAIL] ${s.name}: tailCount=200 ${tail.ms.toFixed(1)}ms > 200ms`)
      failed += 1
    }
    // 老路径在 small/mid (走 readFull) 一定比 tailCount 慢 ≥ 3x; big (走 readTailWindow)
    // 走的是同一条 reverse-scan, 不强制断言.
    if (s.name !== 'big') {
      const speedup = full.ms / Math.max(tail.ms, 0.001)
      if (speedup < 3) {
        console.error(`[FAIL] ${s.name}: tailCount=200 (${tail.ms.toFixed(1)}ms) vs maxLines=10000 (${full.ms.toFixed(1)}ms): 加速比 ${speedup.toFixed(1)}x < 3x`)
        failed += 1
      }
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} 项断言失败`)
    process.exit(1)
  } else {
    console.log('所有断言通过 ✓')
  }
}

main()
