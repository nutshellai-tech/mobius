/**
 * bash-cards.test.mjs — Claude Code Bash JSONL 卡片纯逻辑单元测试.
 *
 * 直接 import src/components/jsonl-bash-helpers.ts 的真实实现 (经 esbuild 实时转译),
 * 不重新实现一份, 避免 "测试一份, 渲染另一份" 的脱节.
 *
 * 运行: node --test tests/bash-cards.test.mjs
 *   (或: node tests/bash-cards.test.mjs, 内部用 node:assert + 计数输出)
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
const helpersPath = path.resolve(__dirname, '../src/components/jsonl-bash-helpers.ts')

// esbuild 把 .ts 实时打包成 ESM → 通过 data: URL 让 Node 直接 import.
// format: 'esm' + bundle:true 把 helper 内部 import 全部内联, 输出单文件 IIFE 友好.
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

const {
  isBashToolUseName,
  extractBashCallFromBlock,
  extractBashCalls,
  bashCallOneLineSummary,
} = helpers

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

// ── isBashToolUseName: 大小写兼容 ─────────────────────────────────────────
test('isBashToolUseName: 标准大小写 "Bash" 命中', () => {
  assert.equal(isBashToolUseName('Bash'), true)
})
test('isBashToolUseName: 全小写 "bash" 也命中 (兼容不同代理)', () => {
  assert.equal(isBashToolUseName('bash'), true)
})
test('isBashToolUseName: 全大写 "BASH" 也命中', () => {
  assert.equal(isBashToolUseName('BASH'), true)
})
test('isBashToolUseName: 非 Bash 工具名 (Edit/Write/exec_command) 不命中', () => {
  assert.equal(isBashToolUseName('Edit'), false)
  assert.equal(isBashToolUseName('Write'), false)
  assert.equal(isBashToolUseName('exec_command'), false)
})
test('isBashToolUseName: 非字符串/null/undefined 安全返回 false', () => {
  assert.equal(isBashToolUseName(null), false)
  assert.equal(isBashToolUseName(undefined), false)
  assert.equal(isBashToolUseName(42), false)
  assert.equal(isBashToolUseName({}), false)
})

// ── extractBashCallFromBlock: 单 block 解析 ───────────────────────────────
// 用户在 Issue 里给出的真实回归样例.
const regressionCommand = 'git remote -v && echo "---" && git status && echo "---" && git branch -vv'
const regressionDescription = 'Inspect git remotes, status, and branch tracking'
const regressionCwd = '/home/user/imac-test'

test('extractBashCallFromBlock: 用户提供的 git remote/status/branch 回归样例 — command 原样保留', () => {
  const block = {
    type: 'tool_use',
    name: 'Bash',
    id: 'toolu_01abc',
    input: {
      command: regressionCommand,
      description: regressionDescription,
      cwd: regressionCwd,
    },
  }
  const call = extractBashCallFromBlock(block, '')
  assert.equal(call.command, regressionCommand)
  // 引号 / && / 多命令链必须按原文本保留, 不能被转义或截断.
  assert.ok(call.command.includes('&&'), 'command 必须保留 &&')
  assert.ok(call.command.includes('echo "---"'), 'command 必须保留双引号')
  assert.ok(call.command.includes('git branch -vv'), 'command 必须保留末尾 git branch -vv')
})

test('extractBashCallFromBlock: description 与 cwd 分区提取', () => {
  const block = {
    type: 'tool_use',
    name: 'Bash',
    input: {
      command: regressionCommand,
      description: regressionDescription,
      cwd: regressionCwd,
    },
  }
  const call = extractBashCallFromBlock(block, '')
  assert.equal(call.description, regressionDescription)
  assert.equal(call.cwd, regressionCwd)
})

test('extractBashCallFromBlock: 顶层 cwd 兜底 (input.cwd 缺失时退到 entryCwd)', () => {
  const block = {
    type: 'tool_use',
    name: 'Bash',
    input: { command: 'ls' },
  }
  const call = extractBashCallFromBlock(block, '/some/session/cwd')
  assert.equal(call.cwd, '/some/session/cwd')
  assert.equal(call.description, '')
})

test('extractBashCallFromBlock: command 字段优先 (优于 cmd / script)', () => {
  const block = {
    type: 'tool_use',
    name: 'Bash',
    input: { command: 'from-command', cmd: 'from-cmd', script: 'from-script' },
  }
  const call = extractBashCallFromBlock(block, '')
  assert.equal(call.command, 'from-command')
  assert.equal(call.commandSource, 'command')
})

test('extractBashCallFromBlock: input.cmd 兜底 (command 缺失)', () => {
  const block = {
    type: 'tool_use',
    name: 'Bash',
    input: { cmd: 'from-cmd' },
  }
  const call = extractBashCallFromBlock(block, '')
  assert.equal(call.command, 'from-cmd')
  assert.equal(call.commandSource, 'cmd')
})

test('extractBashCallFromBlock: input.script 兜底 (command/cmd 缺失)', () => {
  const block = {
    type: 'tool_use',
    name: 'Bash',
    input: { script: 'from-script' },
  }
  const call = extractBashCallFromBlock(block, '')
  assert.equal(call.command, 'from-script')
  assert.equal(call.commandSource, 'script')
})

test('extractBashCallFromBlock: name 大小写兼容 ("bash" 也能识别)', () => {
  const block = { type: 'tool_use', name: 'bash', input: { command: 'pwd' } }
  const call = extractBashCallFromBlock(block, '')
  assert.equal(call.command, 'pwd')
})

test('extractBashCallFromBlock: 非 tool_use block 返回 null', () => {
  assert.equal(extractBashCallFromBlock({ type: 'text', text: 'hi' }, ''), null)
  assert.equal(extractBashCallFromBlock(null, ''), null)
  assert.equal(extractBashCallFromBlock(undefined, ''), null)
})

test('extractBashCallFromBlock: 非 Bash 工具 (Edit/Write) 返回 null', () => {
  assert.equal(
    extractBashCallFromBlock({ type: 'tool_use', name: 'Edit', input: { command: 'x' } }, ''),
    null,
  )
})

test('extractBashCallFromBlock: command/cmd/script 全部缺失 → null (不强渲染)', () => {
  const block = { type: 'tool_use', name: 'Bash', input: { description: 'just a desc' } }
  assert.equal(extractBashCallFromBlock(block, ''), null)
})

test('extractBashCallFromBlock: 多行脚本 (含单引号、双引号、heredoc、管道、重定向) 原样保留', () => {
  // 综合回归脚本: 各种 shell 特殊字符都应在卡片里按原样显示.
  const multiLineScript = [
    '#!/bin/bash',
    'set -euo pipefail',
    `echo "double quoted with $(date)"`,
    `echo 'single quoted literal $NO_EXPAND'`,
    'find . -name "*.ts" | xargs grep "TODO" > /tmp/todos.txt',
    'if [[ -f file ]]; then',
    '  cat <<EOF',
    '  heredoc body line 1',
    '  heredoc body line 2',
    'EOF',
    'fi',
  ].join('\n')
  const call = extractBashCallFromBlock(
    { type: 'tool_use', name: 'Bash', input: { command: multiLineScript } },
    '',
  )
  assert.equal(call.command, multiLineScript)
  // 关键: 字符级精确, 不丢字符不重排序.
  assert.equal(call.command.length, multiLineScript.length)
  assert.ok(call.command.includes('$(date)'))
  assert.ok(call.command.includes('$NO_EXPAND'))
  assert.ok(call.command.includes('> /tmp/todos.txt'))
  assert.ok(call.command.includes('<<EOF'))
  // 换行必须保留.
  assert.equal(call.command.split('\n').length, multiLineScript.split('\n').length)
})

// ── extractBashCalls: entry 级 (含同一 entry 多个 Bash) ──────────────────
test('extractBashCalls: assistant entry 含单个 Bash 返回 1 条', () => {
  const entry = {
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'let me check' },
        { type: 'tool_use', name: 'Bash', id: 'b1', input: { command: 'pwd', description: 'cwd' } },
      ],
    },
  }
  const calls = extractBashCalls(entry)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'pwd')
  assert.equal(calls[0].id, 'b1')
})

test('extractBashCalls: 同一 entry 多个 Bash 全部保序返回', () => {
  const entry = {
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', name: 'Bash', id: 'b1', input: { command: 'git remote -v' } },
        { type: 'text', text: 'between' },
        { type: 'tool_use', name: 'Bash', id: 'b2', input: { command: 'git status' } },
        { type: 'tool_use', name: 'Bash', id: 'b3', input: { command: 'git branch -vv' } },
      ],
    },
  }
  const calls = extractBashCalls(entry)
  assert.equal(calls.length, 3)
  assert.deepEqual(
    calls.map((c) => c.command),
    ['git remote -v', 'git status', 'git branch -vv'],
  )
  assert.deepEqual(
    calls.map((c) => c.id),
    ['b1', 'b2', 'b3'],
  )
})

test('extractBashCalls: 非 assistant entry 返回空数组', () => {
  assert.deepEqual(extractBashCalls({ type: 'user', message: { content: [] } }), [])
  assert.deepEqual(extractBashCalls({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command' } }), [])
  assert.deepEqual(extractBashCalls(null), [])
  assert.deepEqual(extractBashCalls(undefined), [])
})

test('extractBashCalls: assistant 但 content 不是数组返回空', () => {
  assert.deepEqual(extractBashCalls({ type: 'assistant', message: { content: 'string-not-array' } }), [])
  assert.deepEqual(extractBashCalls({ type: 'assistant', message: {} }), [])
})

test('extractBashCalls: 同一 entry 混合 Bash + 非 Bash 工具 — 只取 Bash', () => {
  const entry = {
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', name: 'Edit', input: { old_string: 'a', new_string: 'b' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_use', name: 'Write', input: { file_path: '/x', content: 'y' } },
      ],
    },
  }
  const calls = extractBashCalls(entry)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'ls')
})

// ── bashCallOneLineSummary: 摘要 ───────────────────────────────────────────
test('bashCallOneLineSummary: 优先 description', () => {
  const call = { description: 'Inspect git remotes', cwd: '', command: 'git remote -v', commandSource: 'command' }
  assert.equal(bashCallOneLineSummary(call), 'Inspect git remotes')
})

test('bashCallOneLineSummary: 无 description 时退到命令首行 (加 $ 前缀)', () => {
  const call = { description: '', cwd: '', command: 'git remote -v', commandSource: 'command' }
  assert.equal(bashCallOneLineSummary(call), '$ git remote -v')
})

test('bashCallOneLineSummary: 多行命令取首行 (不混入第二行)', () => {
  const call = {
    description: '',
    cwd: '',
    command: 'git remote -v\necho "---"\ngit status',
    commandSource: 'command',
  }
  assert.equal(bashCallOneLineSummary(call), '$ git remote -v')
})

test('bashCallOneLineSummary: 空命令也无 description 返回空串', () => {
  const call = { description: '', cwd: '', command: '', commandSource: 'command' }
  assert.equal(bashCallOneLineSummary(call), '')
})

test('bashCallOneLineSummary: 首行有空格时去前后空白', () => {
  const call = { description: '', cwd: '', command: '   git status   \necho done', commandSource: 'command' }
  assert.equal(bashCallOneLineSummary(call), '$ git status')
})

test('bashCallOneLineSummary: null/undefined 安全', () => {
  assert.equal(bashCallOneLineSummary(null), '')
  assert.equal(bashCallOneLineSummary(undefined), '')
})

// ── 回归保护: display_images 派生路径仍能识别 ─────────────────────────────
// 这条命令里同时包含 display_images (派生图像卡片用) — 验证我们的 Bash 解析逻辑
// 不影响 display_images 的命令字符串提取 (后者走另一套 splitShellSegments).
test('extractBashCalls: display_images 命令原样进入 BashCall.command', () => {
  const entry = {
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          name: 'Bash',
          input: { command: 'display_images /abs/path/a.png /abs/path/b.png' },
        },
      ],
    },
  }
  const calls = extractBashCalls(entry)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'display_images /abs/path/a.png /abs/path/b.png')
})

// ── 回归保护: start.py 主题判断所需的 input.command 字段未被破坏 ────────
test('extractBashCalls: input.command 包含 start.py 时仍正常解析 (gold 主题用)', () => {
  const entry = {
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', name: 'Bash', input: { command: 'python3 start.py build' } },
      ],
    },
  }
  const calls = extractBashCalls(entry)
  assert.equal(calls.length, 1)
  assert.ok(calls[0].command.includes('start.py'))
})

// ── Codex function_call (exec_command) 走另一条路径, 不应被这里误判 ──────
test('extractBashCalls: Codex response_item.function_call 不被识别为 Bash tool_use', () => {
  // Codex exec_command 是 function_call 类型, 不是 assistant tool_use, 这里应返回 [].
  // (它由 jsonl-view.tsx 里 functionCallCommand/compactCodeSummary 走另一条路径渲染.)
  const codexEntry = {
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'shell',
      arguments: JSON.stringify({ cmd: 'ls -la' }),
    },
  }
  assert.deepEqual(extractBashCalls(codexEntry), [])
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
