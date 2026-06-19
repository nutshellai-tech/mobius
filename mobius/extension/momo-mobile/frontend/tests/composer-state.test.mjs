import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  captureChatScroll,
  captureInputSelection,
  chatRenderSignature,
  composerCanSend,
  limitAttachments,
  normalizeInputMode,
  normalizeThemeMode,
  resolveDarkTheme,
  restoreChatScroll,
  restoreInputSelection,
  toggleThemeMode,
  toggleInputMode,
} = require('../composer-state.js')

test('toggles between text and voice input modes', () => {
  assert.equal(toggleInputMode('text'), 'voice')
  assert.equal(toggleInputMode('voice'), 'text')
  assert.equal(normalizeInputMode('unknown'), 'text')
})

test('limits total attachments to six', () => {
  assert.deepEqual(
    limitAttachments([1, 2, 3, 4], [5, 6, 7], 6),
    [1, 2, 3, 4, 5, 6],
  )
})

test('allows text or completed attachments to send', () => {
  assert.equal(composerCanSend({ input: '你好', attachments: [], sending: false }), true)
  assert.equal(composerCanSend({
    input: '',
    attachments: [{ status: 'done', path: '/uploads/a.pdf' }],
    sending: false,
  }), true)
})

test('blocks sending while an attachment uploads or a message sends', () => {
  assert.equal(composerCanSend({
    input: '你好',
    attachments: [{ status: 'uploading', path: '' }],
    sending: false,
  }), false)
  assert.equal(composerCanSend({ input: '你好', attachments: [], sending: true }), false)
})

test('does not treat failed attachments as sendable content', () => {
  assert.equal(composerCanSend({
    input: '',
    attachments: [{ status: 'error', path: '', error: '上传失败' }],
    sending: false,
  }), false)
})

test('normalizes and resolves system, light, and dark theme modes', () => {
  assert.equal(normalizeThemeMode('system'), 'system')
  assert.equal(normalizeThemeMode('light'), 'light')
  assert.equal(normalizeThemeMode('dark'), 'dark')
  assert.equal(normalizeThemeMode('unknown'), 'system')

  assert.equal(resolveDarkTheme('system', true), true)
  assert.equal(resolveDarkTheme('system', false), false)
  assert.equal(resolveDarkTheme('light', true), false)
  assert.equal(resolveDarkTheme('dark', false), true)
})

test('toggles the effective theme into an explicit light or dark choice', () => {
  assert.equal(toggleThemeMode('system', false), 'dark')
  assert.equal(toggleThemeMode('system', true), 'light')
  assert.equal(toggleThemeMode('light', true), 'dark')
  assert.equal(toggleThemeMode('dark', false), 'light')
})

test('creates stable render signatures and detects relevant chat changes', () => {
  const messages = [
    { id: 'a', author: 'momo', text: '你好', time: '10:00' },
    { id: 'b', author: 'user', text: '继续', time: '10:01' },
  ]
  const sameMessages = messages.map((message) => ({ ...message }))

  assert.equal(
    chatRenderSignature(messages, false),
    chatRenderSignature(sameMessages, false),
  )
  assert.notEqual(
    chatRenderSignature(messages, false),
    chatRenderSignature([...messages, { id: 'c', author: 'momo', text: '收到', time: '10:02' }], false),
  )
  assert.notEqual(
    chatRenderSignature(messages, false),
    chatRenderSignature(messages, true),
  )
})

test('captures whether chat is near the bottom and restores the correct position', () => {
  const nearBottom = { scrollTop: 720, clientHeight: 240, scrollHeight: 1000 }
  const readingHistory = { scrollTop: 300, clientHeight: 240, scrollHeight: 1000 }

  assert.deepEqual(captureChatScroll(nearBottom), { nearBottom: true, scrollTop: 720 })
  assert.deepEqual(captureChatScroll(readingHistory), { nearBottom: false, scrollTop: 300 })

  const newChatAtBottom = { scrollTop: 0, clientHeight: 240, scrollHeight: 1400 }
  restoreChatScroll(newChatAtBottom, { nearBottom: true, scrollTop: 720 })
  assert.equal(newChatAtBottom.scrollTop, 1400)

  const newChatAtHistory = { scrollTop: 0, clientHeight: 240, scrollHeight: 1400 }
  restoreChatScroll(newChatAtHistory, { nearBottom: false, scrollTop: 300 })
  assert.equal(newChatAtHistory.scrollTop, 300)
})

test('captures and restores focused text input selection', () => {
  const original = {
    id: 'messageInput',
    selectionStart: 2,
    selectionEnd: 4,
    selectionDirection: 'forward',
  }
  assert.deepEqual(
    captureInputSelection(original, original),
    { focused: true, start: 2, end: 4, direction: 'forward' },
  )

  let focused = false
  let restoredSelection = null
  const replacement = {
    focus() { focused = true },
    setSelectionRange(start, end, direction) {
      restoredSelection = { start, end, direction }
    },
  }
  restoreInputSelection(replacement, { focused: true, start: 2, end: 4, direction: 'forward' })
  assert.equal(focused, true)
  assert.deepEqual(restoredSelection, { start: 2, end: 4, direction: 'forward' })
})
