/**
 * rounds.test.mjs — JSONL 对话轮次分组纯逻辑单元测试.
 *
 * 直接 import src/components/jsonl-round-helpers.ts 的真实实现 (经 esbuild 实时转译),
 * 不重新实现一份, 避免 "测试一份, 渲染另一份" 的脱节.
 *
 * 运行: node --test tests/rounds.test.mjs
 *   (或: node tests/rounds.test.mjs, 内部用 node:assert + 计数输出)
 *
 * 不引入新依赖: esbuild 是 vite 的 transitive dep, 已存在 node_modules/.bin/esbuild.
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const helpersPath = path.resolve(__dirname, '../src/components/jsonl-round-helpers.ts')

// esbuild 把 .ts 实时打包成 ESM → 通过 data: URL 让 Node 直接 import.
const bundled = await build({
  entryPoints: [helpersPath],
  bundle: true,
  format: 'esm',
  target: 'node18',
  write: false,
  logLevel: 'silent',
})
const code = bundled.outputFiles[0].text
const dataUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')
const helpers = await import(dataUrl)

const { BLACKBOARD_MARKER, isBlackboardReminder, isNewRound } = helpers

let passed = 0
let failed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    console.error(`  ✗ ${name}`)
    console.error(`    ${err.message}`)
    if (process.env.VERBOSE) console.error(err.stack)
  }
}

// ── BLACKBOARD_MARKER 常量 ─────────────────────────────────────────────────
test('BLACKBOARD_MARKER: 与后端 research-blackboard.js 提醒前缀一致', () => {
  assert.equal(BLACKBOARD_MARKER, '[Research Blackboard 更新提醒]')
})

// ── Issue 必须兼容的两个样例: 不能开新轮 ─────────────────────────────────
test('Issue 样例 1: event_msg.user_message + Blackboard 提醒 → 不开新轮', () => {
  const entry = {
    type: 'event_msg',
    payload: {
      type: 'user_message',
      message: '[Research Blackboard 更新提醒]\n本轮新增 3 条研究启发, 请查阅.',
    },
  }
  assert.equal(isNewRound(entry), false, 'Blackboard 提醒不应触发新 Round')
})

test('Issue 样例 2: type:user + message.content 字符串含 Blackboard 提醒 → 不开新轮', () => {
  const entry = {
    type: 'user',
    message: {
      role: 'user',
      content: '[Research Blackboard 更新提醒] 检测到新论文, 已加入候选库.',
    },
  }
  assert.equal(isNewRound(entry), false, 'Blackboard 提醒不应触发新 Round')
})

// ── 同样语义但响应位置不同: response_item.message[role=user] 也覆盖 ──────
test('Blackboard 提醒以 response_item.message[role=user] 形式出现 → 不开新轮', () => {
  const entry = {
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: '[Research Blackboard 更新提醒] via response_item',
    },
  }
  assert.equal(isNewRound(entry), false)
})

test('Blackboard 提醒以 type:user 数组 (text 块) 形式出现 → 不开新轮', () => {
  const entry = {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: '[Research Blackboard 更新提醒] 数组形态也要识别' },
      ],
    },
  }
  assert.equal(isNewRound(entry), false)
})

test('Blackboard 提醒以 event_msg.payload.content 形式出现 → 不开新轮', () => {
  // 某些后端会把消息塞到 payload.content 而非 payload.message, 也要识别.
  const entry = {
    type: 'event_msg',
    payload: {
      type: 'user_message',
      content: '[Research Blackboard 更新提醒] via payload.content',
    },
  }
  assert.equal(isNewRound(entry), false)
})

test('Blackboard 提醒嵌在 user.content 数组的 input_text 块里 → 不开新轮', () => {
  const entry = {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'input_text', input_text: '[Research Blackboard 更新提醒] input_text 形态' },
      ],
    },
  }
  assert.equal(isNewRound(entry), false)
})

// ── 普通用户消息仍要开新轮 (不能误杀) ─────────────────────────────────────
test('普通 event_msg.user_message 文本 → 开新轮', () => {
  const entry = {
    type: 'event_msg',
    payload: { type: 'user_message', message: '请帮我修一下这个 bug' },
  }
  assert.equal(isNewRound(entry), true)
})

test('普通 type:user 字符串 content → 开新轮', () => {
  const entry = {
    type: 'user',
    message: { role: 'user', content: '继续上一步' },
  }
  assert.equal(isNewRound(entry), true)
})

test('普通 type:user 数组含 text 块 → 开新轮', () => {
  const entry = {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text: '再试一次' }],
    },
  }
  assert.equal(isNewRound(entry), true)
})

test('普通 response_item.message[role=user] 文本 → 开新轮', () => {
  const entry = {
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: '下一题' },
  }
  assert.equal(isNewRound(entry), true)
})

// ── tool_result 仍不算新轮 (回归保护) ─────────────────────────────────────
test('type:user 数组只含 tool_result 块 → 不开新轮 (工具回调)', () => {
  const entry = {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_x', content: 'done' },
      ],
    },
  }
  assert.equal(isNewRound(entry), false)
})

// ── isBlackboardReminder 直接测试 ──────────────────────────────────────────
test('isBlackboardReminder: event_msg.user_message 命中', () => {
  assert.equal(isBlackboardReminder({
    type: 'event_msg',
    payload: { type: 'user_message', message: '[Research Blackboard 更新提醒] hi' },
  }), true)
})

test('isBlackboardReminder: type:user 字符串命中', () => {
  assert.equal(isBlackboardReminder({
    type: 'user',
    message: { role: 'user', content: '[Research Blackboard 更新提醒] hi' },
  }), true)
})

test('isBlackboardReminder: 普通用户消息不命中', () => {
  assert.equal(isBlackboardReminder({
    type: 'event_msg',
    payload: { type: 'user_message', message: '普通提问' },
  }), false)
  assert.equal(isBlackboardReminder({
    type: 'user',
    message: { role: 'user', content: '普通提问' },
  }), false)
})

test('isBlackboardReminder: null/undefined 安全返回 false', () => {
  assert.equal(isBlackboardReminder(null), false)
  assert.equal(isBlackboardReminder(undefined), false)
  assert.equal(isBlackboardReminder({}), false)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
