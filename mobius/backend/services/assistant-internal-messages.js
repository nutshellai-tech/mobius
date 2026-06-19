const ASSISTANT_INTERNAL_NOTIFICATION_PROMPT_PREFIX = '[[mobius:assistant-internal-notification-prompt]]';

function markAssistantInternalNotificationPrompt(content) {
  return `${ASSISTANT_INTERNAL_NOTIFICATION_PROMPT_PREFIX}\n${String(content || '')}`;
}

module.exports = {
  ASSISTANT_INTERNAL_NOTIFICATION_PROMPT_PREFIX,
  markAssistantInternalNotificationPrompt,
};
