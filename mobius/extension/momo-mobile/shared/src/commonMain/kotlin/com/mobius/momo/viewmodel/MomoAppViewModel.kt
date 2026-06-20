package com.mobius.momo.viewmodel

import com.mobius.momo.data.FilePicker
import com.mobius.momo.data.AssistantPromptAttachment
import com.mobius.momo.data.MobiusApi
import com.mobius.momo.data.PickedFile
import com.mobius.momo.data.SERVER_BASE_URL_PREFERENCE
import com.mobius.momo.data.SecureStorage
import com.mobius.momo.data.SpeechPermissionController
import com.mobius.momo.data.SpeechPermissionStatus
import com.mobius.momo.data.SpeechRecognitionEvent
import com.mobius.momo.data.SpeechRecognizer
import com.mobius.momo.data.TextToSpeech
import com.mobius.momo.data.createFilePicker
import com.mobius.momo.data.createSecureStorage
import com.mobius.momo.data.createSpeechPermissionController
import com.mobius.momo.data.createSpeechRecognizer
import com.mobius.momo.data.createTextToSpeech
import com.mobius.momo.data.normalizeMobiusBaseUrl
import com.mobius.momo.data.nowShortTime
import com.mobius.momo.data.platformBuildBaseUrl
import com.mobius.momo.data.resolveMobiusBaseUrl
import com.mobius.momo.domain.AssistantSnapshot
import com.mobius.momo.domain.AssistantWorkspace
import com.mobius.momo.domain.ChatMessage
import com.mobius.momo.domain.MessageAuthor
import com.mobius.momo.domain.Project
import com.mobius.momo.domain.Session
import com.mobius.momo.domain.SessionModelOption
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

enum class ThemePalette(val label: String) {
    Default("默认蓝紫"),
    Aurora("极光"),
    Mint("薄荷"),
    Coral("珊瑚"),
    Gold("金色"),
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
    val composerInputMode: ComposerInputMode = ComposerInputMode.Text,
    val attachments: List<PendingAttachment> = emptyList(),
    val loading: Boolean = false,
    val typing: Boolean = false,
    val menuOpen: Boolean = false,
    val cloneSheetOpen: Boolean = false,
    val cloneTitle: String = "",
    val cloneDescription: String = "",
    val cloneModel: String = "codex",
    val cloneModelOptions: List<SessionModelOption> = listOf(
        SessionModelOption("codex", "GPT-5.5 (Codex)", sub = "默认代码任务模型", backend = "tmux-codex"),
        SessionModelOption("opus", "Opus", sub = "Claude Code 高能力模型", backend = "tmux-claude-code"),
    ),
    val toast: String? = null,
    val themeMode: ThemeMode = ThemeMode.System,
    val themePalette: ThemePalette = ThemePalette.Default,
    val pushEnabled: Boolean = true,
    val ttsEnabled: Boolean = true,
    val sendingMessage: Boolean = false,
    val speechPermissionGranted: Boolean = false,
    val speechPermissionDenied: Boolean = false,
    val voiceRecording: Boolean = false,
    val voiceTranscribing: Boolean = false,
    val voiceCanceling: Boolean = false,
    val voiceTranscript: String = "",
    val voiceVolumeLevel: Int = 0,
    val ttsSpeakingMessageId: String? = null,
    val passwordRequired: Boolean = false,
    val serverBaseUrl: String = "",
)

private fun sampleMessages(): List<ChatMessage> = listOf(
    ChatMessage("hello-momo", MessageAuthor.Momo, "你好呀，我是小莫。有什么可以帮你的吗？", "10:23"),
)

class MomoAppViewModel(
    private val storage: SecureStorage = createSecureStorage(),
    private val filePicker: FilePicker = createFilePicker(),
    private val speechPermissionController: SpeechPermissionController = createSpeechPermissionController(),
    private val speechRecognizer: SpeechRecognizer = createSpeechRecognizer(),
    private val textToSpeech: TextToSpeech = createTextToSpeech(),
    private val buildBaseUrl: String = platformBuildBaseUrl(),
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var currentBaseUrl = resolveMobiusBaseUrl(
        buildDefault = buildBaseUrl,
        savedValue = storage.getPreference(SERVER_BASE_URL_PREFERENCE),
    )
    private var api = createApi(currentBaseUrl)
    private var streamJob: Job? = null
    private var toastJob: Job? = null
    private var snapshotPollJob: Job? = null
    private var voiceTimeoutJob: Job? = null
    private var voiceCommitJob: Job? = null
    private var sseHistoryMessages: List<ChatMessage> = emptyList()
    private var sseJsonlMessages: List<ChatMessage> = emptyList()
    private var pendingUserMessages: List<ChatMessage> = emptyList()
    private var inFlightAssistantId: String? = null
    private var inFlightAssistantText: String = ""
    private var inFlightAssistantTime: String = ""
    private var snapshotLoadedForSessionId: String = ""
    private var pendingVoiceCommit: Boolean = false
    private var pendingVoiceAudio: Boolean = false
    private var lastSpokenAssistantId: String = ""
    private var inFlightAssistantVoiceText: String? = null
    private var pendingVoiceOnlyText: String? = null

    private val _state = MutableStateFlow(UiState(serverBaseUrl = currentBaseUrl))
    val state: StateFlow<UiState> = _state

    init {
        restoreThemePreferences()
        refreshAuthConfig()
        restoreToken()
    }

    fun dispose() {
        streamJob?.cancel()
        toastJob?.cancel()
        snapshotPollJob?.cancel()
        voiceTimeoutJob?.cancel()
        voiceCommitJob?.cancel()
        speechRecognizer.dispose()
        textToSpeech.dispose()
        api.close()
        scope.cancel()
    }

    fun setUsername(value: String) = _state.update { it.copy(username = value, toast = null) }

    fun setPassword(value: String) = _state.update { it.copy(password = value, toast = null) }

    fun setInput(value: String) = _state.update { it.copy(input = value) }

    fun setServerBaseUrl(value: String) = _state.update { it.copy(serverBaseUrl = value, toast = null) }

    fun saveServerBaseUrl() {
        val normalized = runCatching { normalizeMobiusBaseUrl(state.value.serverBaseUrl) }
            .onFailure { showToast(it.message ?: "服务器地址无效") }
            .getOrNull() ?: return
        if (normalized.isBlank()) {
            showToast("请输入 Mobius 服务器地址")
            return
        }
        storage.savePreference(SERVER_BASE_URL_PREFERENCE, normalized)
        if (normalized != currentBaseUrl) {
            api.close()
            currentBaseUrl = normalized
            api = createApi(normalized)
            storage.clear()
            clearStreamState()
        }
        _state.update {
            it.copy(
                serverBaseUrl = normalized,
                screen = AppScreen.Login,
                user = null,
                loading = false,
            )
        }
        refreshAuthConfig()
        showToast("服务器地址已保存")
    }

    fun toggleComposerMode() {
        if (state.value.voiceRecording || state.value.voiceTranscribing) return
        _state.update { it.withToggledComposerMode() }
    }

    fun pickAttachments() {
        val remaining = 6 - state.value.attachments.size
        if (remaining <= 0) {
            showToast("最多添加 6 个附件")
            return
        }
        filePicker.pickFiles(
            maxFiles = remaining,
            onResult = { files -> files.take(remaining).forEach(::uploadPickedFile) },
            onError = { showToast(it) },
        )
    }

    fun removeAttachment(id: String) {
        _state.update { current -> current.copy(attachments = current.attachments.filterNot { it.id == id }) }
    }

    private fun uploadPickedFile(file: PickedFile) {
        val id = "attachment-${file.name.hashCode()}-${nowShortTime()}-${state.value.attachments.size}"
        val pending = PendingAttachment(
            id = id,
            name = file.name.ifBlank { "未命名文件" },
            size = file.bytes.size.toLong(),
            mimeType = file.mimeType,
            status = AttachmentStatus.Uploading,
        )
        _state.update { current ->
            current.copy(attachments = (current.attachments + pending).take(6))
        }
        scope.launch {
            runCatching { api.uploadAttachment(file) }
                .onSuccess { uploaded ->
                    _state.update { current ->
                        current.copy(
                            attachments = current.attachments.map { item ->
                                if (item.id == id) {
                                    item.copy(
                                        name = uploaded.name,
                                        size = uploaded.size,
                                        status = AttachmentStatus.Done,
                                        path = uploaded.path,
                                        error = "",
                                    )
                                } else {
                                    item
                                }
                            },
                        )
                    }
                }
                .onFailure { error ->
                    _state.update { current ->
                        current.copy(
                            attachments = current.attachments.map { item ->
                                if (item.id == id) {
                                    item.copy(status = AttachmentStatus.Error, error = error.message ?: "上传失败")
                                } else {
                                    item
                                }
                            },
                        )
                    }
                    showToast(error.message ?: "附件上传失败")
                }
        }
    }

    fun nextLoginStep() {
        if (currentBaseUrl.isBlank()) {
            _state.update { it.copy(screen = AppScreen.Settings) }
            showToast("请先配置 Mobius 服务器地址")
            return
        }
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
                ensureSpeechPermission()
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
                cloneModel = state.value.cloneModelOptions.firstOrNull()?.key ?: "codex",
            )
        }
    }

    fun closeCloneSheet() = _state.update { it.copy(cloneSheetOpen = false) }

    fun setCloneTitle(value: String) = _state.update { it.copy(cloneTitle = value) }

    fun setCloneDescription(value: String) = _state.update { it.copy(cloneDescription = value) }

    fun setCloneModel(value: String) = _state.update { it.copy(cloneModel = value) }

    fun sendHomeMessage() {
        sendTextMessage(state.value.input.trim())
    }

    private fun sendTextMessage(content: String) {
        val current = state.value
        if (current.attachments.any { it.status == AttachmentStatus.Uploading }) {
            showToast("附件还在上传，请稍候")
            return
        }
        val completedAttachments = current.attachments.filter { it.status == AttachmentStatus.Done && it.path.isNotBlank() }
        if (content.isBlank() && completedAttachments.isEmpty()) return
        val visibleContent = content.ifBlank { "请查看我上传的附件。" }
        val attachmentLines = completedAttachments.joinToString(separator = "\n", prefix = if (completedAttachments.isEmpty()) "" else "\n") {
            "附件：${it.name}"
        }
        val userMessage = ChatMessage(
            "user-${visibleContent.hashCode()}-${nowShortTime()}",
            MessageAuthor.User,
            visibleContent + attachmentLines,
            nowShortTime(),
        )
        pendingUserMessages = appendMessage(pendingUserMessages, userMessage)
        rebuildMessages()
        _state.update {
            it.copy(
                input = "",
                attachments = emptyList(),
                voiceTranscript = "",
                sendingMessage = true,
            )
        }
        scope.launch {
            runCatching {
                val activeSession = state.value.clones.firstOrNull { it.sessionId == state.value.activeSessionId }
                if (activeSession != null && !activeSession.isMainAssistant() && completedAttachments.isEmpty()) {
                    api.sendSessionMessage(activeSession.sessionId, visibleContent)
                    connectStream(activeSession.sessionId)
                    startSnapshotPolling(activeSession.sessionId)
                } else {
                    if (activeSession != null && !activeSession.isMainAssistant() && completedAttachments.isNotEmpty()) {
                        showToast("附件消息已转给主小莫处理")
                    }
                    val result = api.sendAssistantMessage(
                        content = visibleContent,
                        attachments = completedAttachments.map {
                            AssistantPromptAttachment(
                                path = it.path,
                                name = it.name,
                                size = it.size,
                                type = if (it.mimeType.startsWith("image/")) "image" else "file",
                                mimeType = it.mimeType,
                            )
                        },
                    )
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
                _state.update { it.copy(sendingMessage = false) }
            }.onFailure { e ->
                inFlightAssistantId = null
                inFlightAssistantText = ""
                inFlightAssistantTime = ""
                pendingUserMessages = pendingUserMessages.filterNot { it.id == userMessage.id }
                val systemMessage = ChatMessage("send-error-${nowShortTime()}", MessageAuthor.System, "消息发送失败，请稍后重试。", nowShortTime())
                _state.update {
                    it.copy(
                        typing = false,
                        sendingMessage = false,
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
                applySnapshot(snapshot, allowAutoSpeech = false)
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

    fun setThemeMode(value: ThemeMode) {
        storage.savePreference(THEME_MODE_KEY, value.name)
        _state.update { it.copy(themeMode = value) }
    }

    fun setThemePalette(value: ThemePalette) {
        storage.savePreference(THEME_PALETTE_KEY, value.name)
        _state.update { it.copy(themePalette = value) }
    }

    fun togglePush() = _state.update { it.copy(pushEnabled = !it.pushEnabled) }

    fun toggleTts() {
        val nextEnabled = !state.value.ttsEnabled
        if (!nextEnabled) {
            textToSpeech.stop()
            _state.update { it.copy(ttsEnabled = false, ttsSpeakingMessageId = null) }
        } else {
            _state.update { it.copy(ttsEnabled = true) }
        }
    }

    fun beginVoiceInput() {
        if (state.value.voiceRecording) return
        if (!state.value.speechPermissionGranted && !speechPermissionController.hasPermission()) {
            _state.update { it.copy(speechPermissionGranted = false, speechPermissionDenied = true) }
            showToast("请先允许麦克风权限")
            return
        }

        textToSpeech.stop()
        voiceTimeoutJob?.cancel()
        voiceCommitJob?.cancel()
        pendingVoiceCommit = false
        pendingVoiceAudio = false
        _state.update {
            it.copy(
                voiceRecording = true,
                voiceTranscribing = false,
                voiceCanceling = false,
                voiceTranscript = "",
                voiceVolumeLevel = 1,
                ttsSpeakingMessageId = null,
                toast = null,
            )
        }
        speechRecognizer.start(languageTag = "zh-CN") { event -> handleSpeechEvent(event) }
        voiceTimeoutJob = scope.launch {
            delay(60_000L)
            if (state.value.voiceRecording) finishVoiceInput(forceCommit = true)
        }
    }

    fun updateVoiceDrag(totalDragY: Float) {
        if (!state.value.voiceRecording) return
        _state.update { it.copy(voiceCanceling = totalDragY < -72f) }
    }

    fun finishVoiceInput(forceCommit: Boolean = false) {
        if (!state.value.voiceRecording) return
        val shouldCancel = state.value.voiceCanceling && !forceCommit
        voiceTimeoutJob?.cancel()
        voiceCommitJob?.cancel()
        if (shouldCancel) {
            pendingVoiceCommit = false
            speechRecognizer.cancel()
            _state.update {
                it.copy(
                    voiceRecording = false,
                    voiceTranscribing = false,
                    voiceCanceling = false,
                    voiceTranscript = "",
                    voiceVolumeLevel = 0,
                )
            }
            showToast("已取消语音输入")
            return
        }

        pendingVoiceCommit = true
        pendingVoiceAudio = false
        _state.update { it.copy(voiceTranscribing = true, voiceVolumeLevel = 0) }
        speechRecognizer.stop()
        voiceCommitJob = scope.launch {
            delay(2_500L)
            if (!pendingVoiceAudio) commitVoiceTranscriptIfPending()
        }
    }

    fun cancelVoiceInput() {
        if (!state.value.voiceRecording) return
        voiceTimeoutJob?.cancel()
        voiceCommitJob?.cancel()
        pendingVoiceCommit = false
        pendingVoiceAudio = false
        speechRecognizer.cancel()
        _state.update {
            it.copy(
                voiceRecording = false,
                voiceTranscribing = false,
                voiceCanceling = false,
                voiceTranscript = "",
                voiceVolumeLevel = 0,
            )
        }
    }

    fun replayAssistantMessage(message: ChatMessage) {
        if (message.author != MessageAuthor.Momo || message.text.isBlank()) return
        speakAssistant(message, markAsAutomatic = false)
    }

    fun logout() {
        scope.launch {
            streamJob?.cancel()
            snapshotPollJob?.cancel()
            voiceTimeoutJob?.cancel()
            voiceCommitJob?.cancel()
            pendingVoiceAudio = false
            speechRecognizer.cancel()
            textToSpeech.stop()
            storage.clear()
            clearStreamState()
            _state.value = UiState(username = state.value.username, passwordRequired = state.value.passwordRequired)
        }
    }

    private fun restoreToken() {
        if (currentBaseUrl.isBlank()) return
        scope.launch {
            val token = storage.getToken()
            if (token.isNullOrBlank()) return@launch
            _state.update { it.copy(loading = true) }
            runCatching {
                val user = api.me()
                _state.update { it.copy(user = user, screen = AppScreen.Home, loading = false) }
                ensureSpeechPermission()
                loadWorkspaceAndClones()
            }.onFailure {
                storage.clear()
                _state.update { it.copy(loading = false, screen = AppScreen.Login) }
            }
        }
    }

    private fun restoreThemePreferences() {
        val mode = storage.getPreference(THEME_MODE_KEY)
            ?.let { raw -> ThemeMode.entries.firstOrNull { it.name == raw } }
            ?: ThemeMode.System
        val palette = storage.getPreference(THEME_PALETTE_KEY)
            ?.let { raw -> ThemePalette.entries.firstOrNull { it.name == raw } }
            ?: ThemePalette.Default
        _state.update { it.copy(themeMode = mode, themePalette = palette) }
    }

    private fun refreshAuthConfig() {
        if (currentBaseUrl.isBlank()) return
        scope.launch {
            runCatching { api.authConfig() }
                .onSuccess { config -> _state.update { it.copy(passwordRequired = config.passwordRequired) } }
        }
    }

    private fun ensureSpeechPermission() {
        scope.launch {
            if (speechPermissionController.hasPermission()) {
                _state.update { it.copy(speechPermissionGranted = true, speechPermissionDenied = false) }
                return@launch
            }
            val status = runCatching { speechPermissionController.requestPermission() }
                .getOrDefault(SpeechPermissionStatus.Denied)
            _state.update {
                it.copy(
                    speechPermissionGranted = status == SpeechPermissionStatus.Granted,
                    speechPermissionDenied = status == SpeechPermissionStatus.Denied,
                )
            }
            if (status == SpeechPermissionStatus.Denied) showToast("麦克风权限未开启，仍可文字输入")
        }
    }

    private suspend fun loadWorkspaceAndClones() {
        val workspace = runCatching { api.assistantWorkspace() }
            .onFailure { showToast(it.message ?: "读取小莫工作区失败") }
            .getOrNull()
        val snapshots = api.assistantSnapshots()
        val clones = snapshots.map { it.session }.filter { it.sessionId.isNotBlank() }
        val projects = runCatching { api.projects() }.getOrDefault(emptyList())
        val modelOptions = runCatching { api.sessionModelOptions() }
            .getOrDefault(state.value.cloneModelOptions)
            .filter { it.key.isNotBlank() }
        val currentSnapshot = snapshots.firstOrNull { it.session.isMainAssistant() }
            ?: snapshots.firstOrNull { it.session.sessionId.isNotBlank() }
        val current = currentSnapshot?.session
        _state.update {
            it.copy(
                workspace = workspace,
                clones = clones,
                projects = projects,
                cloneModelOptions = modelOptions,
                cloneModel = if (modelOptions.any { option -> option.key == it.cloneModel }) {
                    it.cloneModel
                } else {
                    modelOptions.firstOrNull()?.key ?: "codex"
                },
                activeSessionId = current?.sessionId.orEmpty(),
                activeSessionTitle = current?.name?.ifBlank { "我的主小莫" } ?: "我的主小莫",
                loading = false,
            )
        }
        currentSnapshot?.let { applySnapshot(it, allowAutoSpeech = false) }
        current?.sessionId?.takeIf { it.isNotBlank() }?.let { connectStream(it) }
    }

    private fun applySnapshot(snapshot: AssistantSnapshot, allowAutoSpeech: Boolean) {
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
                typing = snapshot.status.working,
            )
        }
        rebuildMessages()
        if (allowAutoSpeech) speakLatestSettledAssistantIfNeeded()
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
                                val messages = chunks
                                    .filter { it.author == MessageAuthor.Momo && it.text.isNotBlank() }
                                    .map { chunkToMessage(it) }
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
            val voiceText = inFlightAssistantVoiceText?.takeIf { it.isNotBlank() }
            if (!liveId.isNullOrBlank() && inFlightAssistantText.isNotBlank()) {
                sseJsonlMessages = upsertMessage(
                    sseJsonlMessages,
                    ChatMessage(
                        id = liveId,
                        author = MessageAuthor.Momo,
                        text = inFlightAssistantText,
                        time = inFlightAssistantTime.ifBlank { nowShortTime() },
                        voiceText = voiceText,
                    ),
                )
            } else if (voiceText != null) {
                pendingVoiceOnlyText = voiceText
            }
            inFlightAssistantId = null
            inFlightAssistantText = ""
            inFlightAssistantTime = ""
            inFlightAssistantVoiceText = null
        }
        _state.update { it.copy(typing = active) }
        if (!active) {
            rebuildMessages()
            speakLatestSettledAssistantIfNeeded()
        }
    }

    private fun handleStreamChunk(chunk: StreamTextChunk) {
        if (chunk.author == MessageAuthor.User) return
        val cleanedText = chunk.text.trim()
        val chunkVoice = chunk.voiceText?.takeIf { it.isNotBlank() }
        if (cleanedText.isBlank() && chunkVoice == null) return

        if (chunkVoice != null) {
            inFlightAssistantVoiceText = combineVoiceText(inFlightAssistantVoiceText, chunkVoice)
        }
        if (cleanedText.isBlank()) {
            return
        }

        val messageId = inFlightAssistantId ?: "assistant-live-${nowShortTime()}-${chunk.id.hashCode()}".also {
            inFlightAssistantId = it
            inFlightAssistantTime = chunk.time
        }
        inFlightAssistantText = combineAssistantText(inFlightAssistantText, cleanedText)
        val voiceText = inFlightAssistantVoiceText?.takeIf { it.isNotBlank() }
        val message = ChatMessage(
            id = messageId,
            author = MessageAuthor.Momo,
            text = inFlightAssistantText,
            time = inFlightAssistantTime.ifBlank { chunk.time },
            voiceText = voiceText,
        )
        _state.update { it.copy(messages = upsertMessage(it.messages, message)) }
    }

    private fun handleSpeechEvent(event: SpeechRecognitionEvent) {
        when (event) {
            SpeechRecognitionEvent.Ready -> {
                _state.update { it.copy(voiceVolumeLevel = it.voiceVolumeLevel.coerceAtLeast(1)) }
            }
            is SpeechRecognitionEvent.Partial -> {
                _state.update { it.copy(voiceTranscript = event.text) }
            }
            is SpeechRecognitionEvent.Final -> {
                _state.update { it.copy(voiceTranscript = event.text) }
                if (pendingVoiceCommit) commitVoiceTranscriptIfPending()
            }
            is SpeechRecognitionEvent.Audio -> {
                if (!pendingVoiceCommit) return
                pendingVoiceAudio = true
                voiceCommitJob?.cancel()
                _state.update {
                    it.copy(
                        voiceTranscribing = true,
                        voiceTranscript = "",
                        voiceVolumeLevel = 0,
                    )
                }
                voiceCommitJob = scope.launch {
                    delay(30_000L)
                    if (pendingVoiceCommit && pendingVoiceAudio) {
                        failVoiceInput("语音识别超时，请稍后重试")
                    }
                }
                scope.launch {
                    runCatching {
                        api.transcribeAssistantAudio(event.bytes, event.mimeType, event.fileName)
                    }.onSuccess { text ->
                        pendingVoiceAudio = false
                        _state.update { it.copy(voiceTranscript = text) }
                        if (pendingVoiceCommit) commitVoiceTranscriptIfPending()
                    }.onFailure { error ->
                        pendingVoiceAudio = false
                        failVoiceInput(error.message ?: "语音识别失败，请重新录制")
                    }
                }
            }
            is SpeechRecognitionEvent.Volume -> {
                if (!state.value.voiceTranscribing) {
                    _state.update { it.copy(voiceVolumeLevel = event.level.coerceIn(0, 5)) }
                }
            }
            is SpeechRecognitionEvent.Error -> {
                if (pendingVoiceCommit && state.value.voiceTranscript.isNotBlank()) {
                    commitVoiceTranscriptIfPending()
                    return
                }
                failVoiceInput(event.message)
            }
            SpeechRecognitionEvent.End -> {
                _state.update { it.copy(voiceVolumeLevel = 0) }
            }
        }
    }

    private fun commitVoiceTranscriptIfPending() {
        if (!pendingVoiceCommit) return
        pendingVoiceCommit = false
        pendingVoiceAudio = false
        voiceTimeoutJob?.cancel()
        voiceCommitJob?.cancel()
        val text = state.value.voiceTranscript.trim()
        _state.update {
            it.copy(
                voiceRecording = false,
                voiceTranscribing = false,
                voiceCanceling = false,
                voiceTranscript = "",
                voiceVolumeLevel = 0,
            )
        }
        if (text.isBlank()) {
            showToast("没有识别到语音")
        } else {
            sendTextMessage(text)
        }
    }

    private fun failVoiceInput(message: String) {
        pendingVoiceCommit = false
        pendingVoiceAudio = false
        voiceTimeoutJob?.cancel()
        voiceCommitJob?.cancel()
        _state.update {
            it.copy(
                voiceRecording = false,
                voiceTranscribing = false,
                voiceCanceling = false,
                voiceTranscript = "",
                voiceVolumeLevel = 0,
            )
        }
        showToast(message)
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

    private fun speakLatestSettledAssistantIfNeeded() {
        if (!state.value.ttsEnabled || state.value.typing || state.value.voiceRecording) return
        val pendingVoice = pendingVoiceOnlyText
        if (!pendingVoice.isNullOrBlank()) {
            pendingVoiceOnlyText = null
            speakRawVoice(pendingVoice)
            return
        }
        val message = state.value.messages.lastOrNull {
            it.author == MessageAuthor.Momo &&
                (it.text.isNotBlank() || !it.voiceText.isNullOrBlank())
        } ?: return
        if (message.id == lastSpokenAssistantId) return
        speakAssistant(message, markAsAutomatic = true)
    }

    private fun speakAssistant(message: ChatMessage, markAsAutomatic: Boolean) {
        val text = message.voiceText?.takeIf { it.isNotBlank() } ?: message.text
        if (text.isBlank()) return
        textToSpeech.stop()
        if (markAsAutomatic) lastSpokenAssistantId = message.id
        _state.update { it.copy(ttsSpeakingMessageId = message.id) }
        textToSpeech.speak(
            text = text,
            languageTag = "zh-CN",
            onError = { error ->
                _state.update { it.copy(ttsSpeakingMessageId = null) }
                showToast(error)
            },
        )
    }

    private fun speakRawVoice(text: String) {
        if (text.isBlank()) return
        textToSpeech.stop()
        val syntheticId = "voice-only-${nowShortTime()}-${text.hashCode()}"
        lastSpokenAssistantId = syntheticId
        _state.update { it.copy(ttsSpeakingMessageId = null) }
        textToSpeech.speak(
            text = text,
            languageTag = "zh-CN",
            onError = { error ->
                _state.update { it.copy(ttsSpeakingMessageId = null) }
                showToast(error)
            },
        )
    }

    private fun clearStreamState(keepPendingUsers: Boolean = false) {
        sseHistoryMessages = emptyList()
        sseJsonlMessages = emptyList()
        if (!keepPendingUsers) pendingUserMessages = emptyList()
        inFlightAssistantId = null
        inFlightAssistantText = ""
        inFlightAssistantTime = ""
        inFlightAssistantVoiceText = null
        pendingVoiceOnlyText = null
        snapshotLoadedForSessionId = ""
    }

    private fun startSnapshotPolling(sessionId: String) {
        snapshotPollJob?.cancel()
        snapshotPollJob = scope.launch {
            repeat(48) {
                delay(2_500L)
                if (state.value.screen == AppScreen.Login || state.value.activeSessionId != sessionId) return@launch
                val snapshot = runCatching { api.assistantSnapshot(sessionId) }.getOrNull() ?: return@repeat
                applySnapshot(snapshot, allowAutoSpeech = true)
                if (!snapshot.status.working && snapshot.messages.hasAssistantAfterLatestUser()) return@launch
            }
        }
    }

    private fun chunkToMessage(chunk: StreamTextChunk): ChatMessage =
        ChatMessage(chunk.id, chunk.author, chunk.text, chunk.time, chunk.voiceText)

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

    private fun createApi(baseUrl: String): MobiusApi =
        MobiusApi(
            baseUrl = baseUrl,
            storage = storage,
            onUnauthorized = { logoutFrom401() },
        )
}

private const val THEME_MODE_KEY = "theme_mode"
private const val THEME_PALETTE_KEY = "theme_palette"

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

private fun combineVoiceText(current: String?, next: String): String? {
    val piece = next.trim()
    if (piece.isBlank()) return current
    if (current.isNullOrBlank()) return piece
    if (piece == current || current.endsWith(piece)) return current
    if (current.startsWith(piece)) return current
    return current + "\n" + piece
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
