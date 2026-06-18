const TUI_CONTACT_TIMEOUT_MESSAGE = '任务失败，与后台TUI联络超时，请尝试继续提问，或者重建session。'

function rawErrorMessage(error) {
  if (error && typeof error.message === 'string' && error.message) return error.message
  return String(error || '')
}

function isTuiContactTimeout(errorOrMessage) {
  const message = typeof errorOrMessage === 'string' ? errorOrMessage : rawErrorMessage(errorOrMessage)
  return /TUI was not ready within \d+ms/i.test(message)
}

function formatBackendSendFailure(error) {
  const rawMessage = `backend send 失败: ${rawErrorMessage(error)}`
  const userMessage = isTuiContactTimeout(error) ? TUI_CONTACT_TIMEOUT_MESSAGE : rawMessage
  return { userMessage, rawMessage }
}

module.exports = {
  TUI_CONTACT_TIMEOUT_MESSAGE,
  isTuiContactTimeout,
  formatBackendSendFailure,
}
