package com.mobius.momo.viewmodel

import com.mobius.momo.data.MobiusApi
import com.mobius.momo.data.SecureStorage
import com.mobius.momo.data.createSecureStorage
import com.mobius.momo.data.nowShortTime
import com.mobius.momo.domain.AssistantSnapshot
import com.mobius.momo.domain.AssistantWorkspace
import com.mobius.momo.domain.ChatMessage
import com.mobius.momo.domain.MessageAuthor
import com.mobius.momo.domain.Project
import com.mobius.momo.domain.Session
import com.mobius.momo.domain.StreamTextChunk
import com.mobius.momo.domain.User
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

enum class AppScreen {
    Login,
    Home,
    Clones,
    Settings,
}

enum class LoginStep {
    Username,
    Password,
}

enum class ThemeMode {
    System,
    Light,
    Dark,
}

data class UiState(
    val screen: AppScreen = AppScreen.Login,
    val loginStep: LoginStep = LoginStep.Username,
    val username: String = "",
    val password: String = "",
    val user: User? = null,
    val workspace: AssistantWorkspace? = null,
    val messages: List<ChatMessage> = sampleMessages(),
    val clones: List<Session> = emptyList(),
    val projects: List<Project> = emptyList(),
    val activeSessionId: String = "",
    val activeSessionTitle: String = "我的主小莫",
    val input: String = "",
    val loading: Boolean = false,
    val typing: Boolean = false,
    val menuOpen: Boolean = false,
    val cloneSheetOpen: Boolean = false,
    val cloneTitle: String = "",
    val cloneDescription: String = "",
    val cloneModel: String = "codex",
    val toast: String? = null,
    val themeMode: ThemeMode = ThemeMode.System,
    val pushEnabled: Boolean = true,
    val ttsEnabled: Boolean = true,
    val passwordRequired: Boolean = false,
)

private fun sampleMessages(): List<ChatMessage> = listOf(
    ChatMessage("hello-momo", MessageAuthor.Momo, "你好呀，我是小莫。有什么可以帮你的吗？", "10:23"),
)

private const val WAITING_ASSISTANT_TEXT = "小莫正在回复..."

class MomoAppViewModel(
    private val storage: SecureStorage = createSecureStorage(),
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val api = MobiusApi(storage = storage, onUnauthorized = { logoutFrom401() })
    private var streamJob: Job? = null
    private var toastJob: Job? = null
    private var snapshotPollJob: Job? = null
    private var sseHistoryMessages: List<ChatMessage> = emptyList()
    private var sseJsonlMessages: List<ChatMessage> = emptyList()
    private var pendingUserMessages: List<ChatMessage> = emptyList()
    private var inFlightAssistantId: String? = null
    private var inFlightAssistantText: String = ""
    private var inFlightAssistantTime: String = ""
    private var snapshotLoadedForSessionId: String = ""

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state

    init {
        refreshAuthConfig()
        restoreToken()
    }

    fun dispose() {
        streamJob?.cancel()
        toastJob?.cancel()
        snapshotPollJob?.cancel()
        scope.cancel()
    }

    fun setUsername(value: String) = _state.update { it.copy(username = value, toast = null) }

    fun setPassword(value: String) = _state.update { it.copy(password = value, toast = null) }

    fun setInput(value: String) = _state.update { it.copy(input = value) }

    fun nextLoginStep() {
        val username = state.value.username.trim()
        if (username.isBlank()) {
            showToast("请输入用户名")
            return
        }
        if (state.value.passwordRequired) {
            _state.update { it.copy(loginStep = LoginStep.Password, toast = null) }
        } else {
            loginWith(username, "")
        }
    }

    fun backToUsername() = _state.update { it.copy(loginStep = LoginStep.Username, password = "", toast = null) }

    fun login() {
        val username = state.value.username.trim()
        val password = state.value.password
        if (username.isBlank() || (state.value.passwordRequired && password.isBlank())) {
            showToast("请输入用户名和密码")
            return
        }
        loginWith(username, password)
    }

    private fun loginWith(username: String, password: String) {
        scope.launch {
            _state.update { it.copy(loading = true, toast = null) }
            runCatching {
                val result = api.login(username, password)
                _state.update {
                    it.copy(
                        user = result.user,
                        screen = AppScreen.Home,
                        loginStep = LoginStep.Password,
                        password = "",
                        loading = false,
                    )
                }
                loadWorkspaceAndClones()
            }.onFailure { e ->
                _state.update { it.copy(loading = false) }
                showToast(e.message ?: "登录失败")
            }
        }
    }

    fun navigate(screen: AppScreen) {
        _state.update { it.copy(screen = screen, menuOpen = false, toast = null) }
        if (screen == AppScreen.Clones) refreshClones()
    }

    fun toggleMenu() = _state.update { it.copy(menuOpen = !it.menuOpen) }

    fun openCloneSheet() {
        val nextNumber = (state.value.clones.count { it.name.startsWith("分身小莫") } + 1).coerceAtLeast(1)
        _state.update {
            it.copy(
                cloneSheetOpen = true,
                cloneTitle = "分身小莫 #$nextNumber",
                cloneDescription = "",
                cloneModel = "codex",
            )
        }
    }

    fun closeCloneSheet() = _state.update { it.copy(cloneSheetOpen = false) }

    fun setCloneTitle(value: String) = _state.update { it.copy(cloneTitle = value) }

    fun setCloneDescription(value: String) = _state.update { it.copy(cloneDescription = value) }

    fun setCloneModel(value: String) = _state.update { it.copy(cloneModel = value) }

    fun sendHomeMessage() {
        val content = state.value.input.trim()
        if (content.isBlank()) return
        val userMessage = ChatMessage("user-${content.hashCode()}-${nowShortTime()}", MessageAuthor.User, content, nowShortTime())
        pendingUserMessages = appendMessage(pendingUserMessages, userMessage)
        startWaitingForAssistant()
        rebuildMessages()
        _state.update {
            it.copy(
                input = "",
                typing = true,
            )
        }
        scope.launch {
            runCatching {
                val activeSession = state.value.clones.firstOrNull { it.sessionId == state.value.activeSessionId }
                if (activeSession != null && !activeSession.isMainAssistant()) {
                    api.sendSessionMessage(activeSession.sessionId, content)
                    connectStream(activeSession.sessionId)
                    startSnapshotPolling(activeSession.sessionId)
                } else {
                    val result = api.sendAssistantMessage(content)
                    val sessionId = result.resolvedSessionId()
                    if (sessionId.isNotBlank()) {
                        _state.update {
                            it.copy(
                                activeSessionId = sessionId,
                                activeSessionTitle = result.session?.name?.takeIf { name -> name.isNotBlank() } ?: "我的主小莫",
                                workspace = AssistantWorkspace(result.project, result.issue),
                            )
                        }
                        connectStream(sessionId)
                        startSnapshotPolling(sessionId)
                    } else {
                        error("服务端未返回可用的 Session ID")
                    }
                }
            }.onFailure { e ->
                inFlightAssistantId = null
                inFlightAssistantText = ""
                inFlightAssistantTime = ""
                val systemMessage = ChatMessage("send-error-${nowShortTime()}", MessageAuthor.System, "消息发送失败，请稍后重试。", nowShortTime())
                _state.update {
                    it.copy(
                        typing = false,
                        messages = appendMessage(it.messages, systemMessage),
                    )
                }
                showToast(e.message ?: "消息发送失败")
            }
        }
    }

    fun refreshClones() {
        scope.launch {
            runCatching {
                val workspace = state.value.workspace ?: api.assistantWorkspace()
                val snapshots = api.assistantSnapshots()
                val sessions = snapshots.map { it.session }.filter { it.sessionId.isNotBlank() }
                _state.update { it.copy(workspace = workspace, clones = sessions) }
            }.onFailure { e ->
                showToast(e.message ?: "分身列表读取失败")
            }
        }
    }

    fun openSession(session: Session) {
        if (session.sessionId.isBlank()) return
        clearStreamState()
        _state.update {
            it.copy(
                screen = AppScreen.Home,
                menuOpen = false,
                activeSessionId = session.sessionId,
                activeSessionTitle = session.name.ifBlank { "小莫会话" },
                messages = sampleMessages(),
                loading = true,
                toast = null,
            )
        }
        scope.launch {
            runCatching {
                val snapshot = api.assistantSnapshot(session.sessionId)
                applySnapshot(snapshot)
                connectStream(session.sessionId)
            }.onFailure { e ->
                _state.update { it.copy(loading = false) }
                showToast(e.message ?: "打开小莫会话失败")
                connectStream(session.sessionId)
            }
        }
    }

    fun createClone() {
        val workspace = state.value.workspace
        val issueId = workspace?.issue?.id.orEmpty()
        val title = state.value.cloneTitle.trim()
        val description = state.value.cloneDescription.trim()
        if (issueId.isBlank()) {
            showToast("未找到小莫任务单")
            return
        }
        if (title.isBlank() || description.isBlank()) {
            showToast("请填写分身名称和任务描述")
            return
        }
        scope.launch {
            _state.update { it.copy(loading = true, toast = null) }
            runCatching {
                val session = api.createClone(issueId, title, description, state.value.cloneModel)
                api.startSession(session.sessionId, description)
                val sessions = api.assistantSessions()
                _state.update {
                    it.copy(
                        loading = false,
                        cloneSheetOpen = false,
                        clones = sessions.ifEmpty { appendSession(it.clones, session) },
                        screen = AppScreen.Clones,
                    )
                }
                showToast("分身已创建并启动")
            }.onFailure { e ->
                _state.update { it.copy(loading = false) }
                showToast(e.message ?: "创建分身失败")
            }
        }
    }

    fun setThemeMode(value: ThemeMode) = _state.update { it.copy(themeMode = value) }

    fun togglePush() = _state.update { it.copy(pushEnabled = !it.pushEnabled) }

    fun toggleTts() = _state.update { it.copy(ttsEnabled = !it.ttsEnabled) }

    fun logout() {
        scope.launch {
            streamJob?.cancel()
            snapshotPollJob?.cancel()
            storage.clear()
            clearStreamState()
            _state.value = UiState(username = state.value.username, passwordRequired = state.value.passwordRequired)
        }
    }

    private fun restoreToken() {
        scope.launch {
            val token = storage.getToken()
            if (token.isNullOrBlank()) return@launch
            _state.update { it.copy(loading = true) }
            runCatching {
                val user = api.me()
                _state.update { it.copy(user = user, screen = AppScreen.Home, loading = false) }
                loadWorkspaceAndClones()
            }.onFailure {
                storage.clear()
                _state.update { it.copy(loading = false, screen = AppScreen.Login) }
            }
        }
    }

    private fun refreshAuthConfig() {
        scope.launch {
            runCatching { api.authConfig() }
                .onSuccess { config -> _state.update { it.copy(passwordRequired = config.passwordRequired) } }
        }
    }

    private suspend fun loadWorkspaceAndClones() {
        val workspace = api.assistantWorkspace()
        val snapshots = api.assistantSnapshots()
        val clones = snapshots.map { it.session }.filter { it.sessionId.isNotBlank() }
        val projects = runCatching { api.projects() }.getOrDefault(emptyList())
        val currentSnapshot = snapshots.firstOrNull { it.session.isMainAssistant() }
            ?: snapshots.firstOrNull { it.session.sessionId.isNotBlank() }
        val current = currentSnapshot?.session
        _state.update {
            it.copy(
                workspace = workspace,
                clones = clones,
                projects = projects,
                activeSessionId = current?.sessionId.orEmpty(),
                activeSessionTitle = current?.name?.ifBlank { "我的主小莫" } ?: "我的主小莫",
                loading = false,
            )
        }
        currentSnapshot?.let { applySnapshot(it) }
        current?.sessionId?.takeIf { it.isNotBlank() }?.let { connectStream(it) }
    }

    private fun applySnapshot(snapshot: AssistantSnapshot) {
        val session = snapshot.session
        val messages = snapshot.messages
        if (messages.isNotEmpty()) {
            sseHistoryMessages = messages
            sseJsonlMessages = emptyList()
            pendingUserMessages = emptyList()
            snapshotLoadedForSessionId = session.sessionId
            if (messages.hasAssistantAfterLatestUser()) {
                inFlightAssistantId = null
                inFlightAssistantText = ""
                inFlightAssistantTime = ""
            }
        }
        _state.update {
            it.copy(
                loading = false,
                activeSessionId = session.sessionId.ifBlank { it.activeSessionId },
                activeSessionTitle = session.name.ifBlank { it.activeSessionTitle },
                clones = upsertSession(it.clones, session).filter { item -> item.sessionId.isNotBlank() },
                typing = snapshot.status.working || inFlightAssistantText == WAITING_ASSISTANT_TEXT,
            )
        }
        rebuildMessages()
    }

    private fun connectStream(sessionId: String) {
        streamJob?.cancel()
        streamJob = scope.launch {
            var reconnectDelayMs = 1_000L
            while (state.value.screen != AppScreen.Login && state.value.activeSessionId == sessionId) {
                var connected = false
                var emittedError = false
                try {
                    api.streamSession(
                        sessionId = sessionId,
                        onConnected = {
                            connected = true
                            reconnectDelayMs = 1_000L
                        },
                        onTyping = { active -> handleTyping(active) },
                        onHistory = { history ->
                            if (snapshotLoadedForSessionId != sessionId && history.isNotEmpty()) {
                                sseHistoryMessages = history
                                rebuildMessages()
                            }
                        },
                        onJsonlHistory = { chunks, reset, _ ->
                            if (snapshotLoadedForSessionId != sessionId) {
                                val messages = chunks.map { chunkToMessage(it) }
                                if (reset) {
                                    sseHistoryMessages = sseHistoryMessages.filter { it.author != MessageAuthor.Momo }
                                }
                                sseJsonlMessages = if (reset) messages else mergeMessages(sseJsonlMessages, messages)
                                rebuildMessages()
                            }
                        },
                        onChunk = { chunk -> handleStreamChunk(chunk) },
                        onError = { message ->
                            emittedError = true
                            showToast(message)
                        },
                    )
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Throwable) {
                    emittedError = true
                    showToast(e.message ?: "SSE 连接中断")
                }

                if (state.value.screen == AppScreen.Login || state.value.activeSessionId != sessionId) break
                if (!emittedError && connected) showToast("连接中断，正在重连")
                delay(reconnectDelayMs)
                reconnectDelayMs = (reconnectDelayMs * 2).coerceAtMost(30_000L)
            }
        }
    }

    private suspend fun logoutFrom401() {
        if (state.value.screen == AppScreen.Login) return
        streamJob?.cancel()
        snapshotPollJob?.cancel()
        storage.clear()
        clearStreamState()
        _state.value = UiState(
            username = state.value.username,
            passwordRequired = state.value.passwordRequired,
            toast = "登录已过期，请重新登录",
        )
        scheduleToastClear("登录已过期，请重新登录")
    }

    private fun handleTyping(active: Boolean) {
        if (!active) {
            val liveId = inFlightAssistantId
            if (!liveId.isNullOrBlank() && inFlightAssistantText.isNotBlank() && inFlightAssistantText != WAITING_ASSISTANT_TEXT) {
                sseJsonlMessages = upsertMessage(
                    sseJsonlMessages,
                    ChatMessage(liveId, MessageAuthor.Momo, inFlightAssistantText, inFlightAssistantTime.ifBlank { nowShortTime() }),
                )
            }
            inFlightAssistantId = null
            inFlightAssistantText = ""
            inFlightAssistantTime = ""
        }
        _state.update { it.copy(typing = active) }
        if (!active) rebuildMessages()
    }

    private fun handleStreamChunk(chunk: StreamTextChunk) {
        if (chunk.text.isBlank()) return
        if (chunk.author == MessageAuthor.User) {
            pendingUserMessages = appendMessage(pendingUserMessages, chunkToMessage(chunk))
            rebuildMessages()
            return
        }

        val messageId = inFlightAssistantId ?: "assistant-live-${nowShortTime()}-${chunk.id.hashCode()}".also {
            inFlightAssistantId = it
            inFlightAssistantTime = chunk.time
        }
        inFlightAssistantText = combineAssistantText(inFlightAssistantText.takeUnless { it == WAITING_ASSISTANT_TEXT }.orEmpty(), chunk.text)
        val message = ChatMessage(messageId, MessageAuthor.Momo, inFlightAssistantText, inFlightAssistantTime.ifBlank { chunk.time })
        _state.update { it.copy(messages = upsertMessage(it.messages, message)) }
    }

    private fun rebuildMessages() {
        val historical = mergeMessages(sseHistoryMessages, sseJsonlMessages)
        pendingUserMessages = pendingUserMessages.filterNot { pending ->
            historical.any { it.author == pending.author && it.text == pending.text }
        }
        var messages = mergeMessages(historical, pendingUserMessages)
        if (messages.isEmpty()) messages = sampleMessages()
        val liveId = inFlightAssistantId
        if (!liveId.isNullOrBlank() && inFlightAssistantText.isNotBlank()) {
            messages = upsertMessage(
                messages,
                ChatMessage(liveId, MessageAuthor.Momo, inFlightAssistantText, inFlightAssistantTime.ifBlank { nowShortTime() }),
            )
        }
        _state.update { it.copy(messages = messages.takeLast(120)) }
    }

    private fun clearStreamState(keepPendingUsers: Boolean = false) {
        sseHistoryMessages = emptyList()
        sseJsonlMessages = emptyList()
        if (!keepPendingUsers) pendingUserMessages = emptyList()
        inFlightAssistantId = null
        inFlightAssistantText = ""
        inFlightAssistantTime = ""
        snapshotLoadedForSessionId = ""
    }

    private fun startSnapshotPolling(sessionId: String) {
        snapshotPollJob?.cancel()
        snapshotPollJob = scope.launch {
            repeat(48) {
                delay(2_500L)
                if (state.value.screen == AppScreen.Login || state.value.activeSessionId != sessionId) return@launch
                val snapshot = runCatching { api.assistantSnapshot(sessionId) }.getOrNull() ?: return@repeat
                applySnapshot(snapshot)
                if (!snapshot.status.working && snapshot.messages.hasAssistantAfterLatestUser()) return@launch
            }
        }
    }

    private fun startWaitingForAssistant() {
        inFlightAssistantId = "assistant-waiting-${nowShortTime()}"
        inFlightAssistantText = WAITING_ASSISTANT_TEXT
        inFlightAssistantTime = nowShortTime()
    }

    private fun chunkToMessage(chunk: StreamTextChunk): ChatMessage =
        ChatMessage(chunk.id, chunk.author, chunk.text, chunk.time)

    private fun showToast(message: String) {
        _state.update { it.copy(toast = message) }
        scheduleToastClear(message)
    }

    private fun scheduleToastClear(message: String) {
        toastJob?.cancel()
        toastJob = scope.launch {
            delay(3_000L)
            _state.update { if (it.toast == message) it.copy(toast = null) else it }
        }
    }
}

private fun appendMessage(messages: List<ChatMessage>, message: ChatMessage): List<ChatMessage> {
    if (message.text.isBlank()) return messages
    if (messages.any { it.id == message.id || (it.author == message.author && it.text == message.text && it.time == message.time) }) {
        return messages
    }
    return (messages + message).takeLast(120)
}

private fun mergeMessages(prefix: List<ChatMessage>, history: List<ChatMessage>): List<ChatMessage> {
    return (prefix + history).fold(emptyList()) { acc, item -> appendMessage(acc, item) }
}

private fun upsertMessage(messages: List<ChatMessage>, message: ChatMessage): List<ChatMessage> {
    if (message.text.isBlank()) return messages
    val index = messages.indexOfFirst { it.id == message.id }
    return if (index >= 0) {
        messages.toMutableList().also { it[index] = message }
    } else {
        appendMessage(messages, message)
    }
}

private fun combineAssistantText(current: String, next: String): String {
    val chunk = next.trim()
    if (chunk.isBlank()) return current
    if (current.isBlank()) return chunk
    if (chunk == current || current.endsWith(chunk)) return current
    if (chunk.startsWith(current)) return chunk
    return current + chunk
}

private fun appendSession(sessions: List<Session>, session: Session): List<Session> {
    return if (sessions.any { it.sessionId == session.sessionId }) sessions else sessions + session
}

private fun List<ChatMessage>.hasAssistantAfterLatestUser(): Boolean {
    val latestUserIndex = indexOfLast { it.author == MessageAuthor.User }
    if (latestUserIndex < 0) return any { it.author == MessageAuthor.Momo }
    return drop(latestUserIndex + 1).any { it.author == MessageAuthor.Momo }
}

private fun upsertSession(sessions: List<Session>, session: Session): List<Session> {
    if (session.sessionId.isBlank()) return sessions
    val index = sessions.indexOfFirst { it.sessionId == session.sessionId }
    return if (index >= 0) {
        sessions.toMutableList().also { it[index] = session }
    } else {
        sessions + session
    }
}

private fun Session.isMainAssistant(): Boolean =
    assistantRole == "main" || name == "我的主小莫" || name.contains("主小莫")
