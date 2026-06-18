const ASSISTANT_SESSION_KEY_PREFIX = 'assistant-question';

function assistantSessionKeyPrefixForUser(userId) {
  return `${ASSISTANT_SESSION_KEY_PREFIX}:${userId}:`;
}

function assistantSessionKeyLike(userId) {
  return `${assistantSessionKeyPrefixForUser(userId)}%`;
}

function isAssistantSession(session, user = null) {
  if (!session || typeof session.session_key !== 'string') return false;
  if (user?.id) {
    return session.user_id === user.id
      && session.session_key.startsWith(assistantSessionKeyPrefixForUser(user.id));
  }
  return session.session_key.startsWith(`${ASSISTANT_SESSION_KEY_PREFIX}:`);
}

module.exports = {
  ASSISTANT_SESSION_KEY_PREFIX,
  assistantSessionKeyLike,
  isAssistantSession,
};
