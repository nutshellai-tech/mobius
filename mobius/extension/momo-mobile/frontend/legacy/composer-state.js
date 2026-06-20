(function initComposerState(root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  root.MomoComposerState = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function createComposerState() {
  function normalizeInputMode(value) {
    return value === 'voice' ? 'voice' : 'text'
  }

  function toggleInputMode(value) {
    return normalizeInputMode(value) === 'text' ? 'voice' : 'text'
  }

  function limitAttachments(current, incoming, max = 6) {
    return [...(current || []), ...(incoming || [])].slice(0, max)
  }

  function composerCanSend({ input = '', attachments = [], sending = false } = {}) {
    if (sending || attachments.some((item) => item?.status === 'uploading')) return false
    return String(input).trim().length > 0
      || attachments.some((item) => item?.status === 'done' && item?.path)
  }

  function normalizeThemeMode(value) {
    return value === 'light' || value === 'dark' ? value : 'system'
  }

  function resolveDarkTheme(value, systemDark = false) {
    const mode = normalizeThemeMode(value)
    if (mode === 'dark') return true
    if (mode === 'light') return false
    return Boolean(systemDark)
  }

  function toggleThemeMode(value, systemDark = false) {
    return resolveDarkTheme(value, systemDark) ? 'light' : 'dark'
  }

  function chatRenderSignature(messages = [], typing = false) {
    return JSON.stringify({
      typing: Boolean(typing),
      messages: messages.map((message) => [
        message?.id || '',
        message?.author || '',
        message?.text || '',
        message?.voiceText || '',
        message?.time || '',
      ]),
    })
  }

  function captureChatScroll(element, bottomThreshold = 80) {
    if (!element) return null
    const scrollTop = Number(element.scrollTop) || 0
    const clientHeight = Number(element.clientHeight) || 0
    const scrollHeight = Number(element.scrollHeight) || 0
    return {
      nearBottom: scrollHeight - (scrollTop + clientHeight) <= bottomThreshold,
      scrollTop,
    }
  }

  function restoreChatScroll(element, snapshot) {
    if (!element) return
    if (!snapshot || snapshot.nearBottom) {
      element.scrollTop = element.scrollHeight
      return
    }
    element.scrollTop = snapshot.scrollTop
  }

  function captureInputSelection(element, activeElement) {
    if (!element || element !== activeElement) return null
    return {
      focused: true,
      start: Number.isInteger(element.selectionStart) ? element.selectionStart : 0,
      end: Number.isInteger(element.selectionEnd) ? element.selectionEnd : 0,
      direction: element.selectionDirection || 'none',
    }
  }

  function restoreInputSelection(element, snapshot) {
    if (!element || !snapshot?.focused) return
    element.focus({ preventScroll: true })
    if (typeof element.setSelectionRange === 'function') {
      element.setSelectionRange(snapshot.start, snapshot.end, snapshot.direction)
    }
  }

  return {
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
  }
})
