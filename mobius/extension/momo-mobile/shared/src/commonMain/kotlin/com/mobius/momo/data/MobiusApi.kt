package com.mobius.momo.data

import com.mobius.momo.domain.AssistantMessageResult
import com.mobius.momo.domain.AssistantSessionStatus
import com.mobius.momo.domain.AssistantSnapshot
import com.mobius.momo.domain.AssistantWorkspace
import com.mobius.momo.domain.AuthConfig
import com.mobius.momo.domain.ChatMessage
import com.mobius.momo.domain.LoginResult
import com.mobius.momo.domain.MessageAuthor
import com.mobius.momo.domain.Project
import com.mobius.momo.domain.Session
import com.mobius.momo.domain.SessionModelOption
import com.mobius.momo.domain.StreamTextChunk
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.forms.MultiPartFormDataContent
import io.ktor.client.request.forms.formData
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.prepareGet
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsChannel
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.Headers
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.utils.io.readUTF8Line
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive

data class UploadedAttachment(
    val path: String,
    val name: String,
    val size: Long,
)

data class AssistantPromptAttachment(
    val path: String,
    val name: String,
    val size: Long,
    val type: String,
    val mimeType: String,
)

class MobiusApi(
    private val baseUrl: String = "https://mobius.example.com",
    private val storage: SecureStorage,
    private val onUnauthorized: suspend () -> Unit,
) {
    private val json = Json {
        ignoreUnknownKeys = true
        isLenient = true
        encodeDefaults = true
    }

    private val client: HttpClient = createMobiusHttpClient(
        onUnauthorized = onUnauthorized,
    )

    suspend fun authConfig(): AuthConfig =
        client.get("$baseUrl/api/auth/config").body()

    suspend fun login(username: String, password: String = ""): LoginResult {
        val requestBody = buildMap {
            put("username", username)
            if (password.isNotBlank()) put("password", password)
        }
        val response = client.post("$baseUrl/api/auth/login") {
            contentType(ContentType.Application.Json)
            setBody(requestBody)
        }
        if (response.status.value !in 200..299) error(parseErrorMessage(response.bodyAsText()))
        val result = decodeLogin(response.body())
        storage.saveToken(result.token)
        return result
    }

    suspend fun me() = client.get("$baseUrl/api/auth/me") { addAuth() }.body<com.mobius.momo.domain.User>()

    suspend fun assistantWorkspace(): AssistantWorkspace =
        client.get("$baseUrl/api/assistant/workspace") { addAuth() }.body()

    suspend fun assistantSessions(limit: Int = 60): List<Session> {
        val obj = client.get("$baseUrl/api/assistant/sessions?limit=$limit") { addAuth() }.body<JsonObject>()
        return parseAssistantSnapshots(obj["sessions"] as? JsonArray).map { it.session }
    }

    suspend fun assistantSnapshots(limit: Int = 60): List<AssistantSnapshot> {
        val obj = client.get("$baseUrl/api/assistant/sessions?limit=$limit") { addAuth() }.body<JsonObject>()
        return parseAssistantSnapshots(obj["sessions"] as? JsonArray)
    }

    suspend fun assistantSnapshot(sessionId: String): AssistantSnapshot {
        val obj = client.get("$baseUrl/api/assistant/sessions/$sessionId") { addAuth() }.body<JsonObject>()
        return parseAssistantSnapshot(obj)
    }

    suspend fun issueSessions(issueId: String): List<Session> =
        client.get("$baseUrl/api/issues/$issueId/sessions/") { addAuth() }.body()

    suspend fun projects(): List<Project> =
        client.get("$baseUrl/api/projects/") { addAuth() }.body()

    suspend fun sessionModelOptions(): List<SessionModelOption> =
        client.get("$baseUrl/api/sessions/model-options") { addAuth() }.body()

    suspend fun uploadAttachment(file: PickedFile): UploadedAttachment {
        val safeName = file.name.ifBlank { "attachment" }.replace("\"", "")
        val response = client.post("$baseUrl/api/upload") {
            addAuth()
            setBody(
                MultiPartFormDataContent(
                    formData {
                        append(
                            "file",
                            file.bytes,
                            Headers.build {
                                append(HttpHeaders.ContentType, file.mimeType.ifBlank { "application/octet-stream" })
                                append(HttpHeaders.ContentDisposition, "form-data; name=\"file\"; filename=\"$safeName\"")
                            },
                        )
                    },
                ),
            )
        }
        val raw = response.bodyAsText()
        val obj = runCatching { json.parseToJsonElement(raw) as? JsonObject }.getOrNull()
        if (response.status.value !in 200..299) {
            error(obj?.string("error") ?: obj?.string("message") ?: "附件上传失败")
        }
        return UploadedAttachment(
            path = obj?.string("path").orEmpty(),
            name = obj?.string("name")?.ifBlank { safeName } ?: safeName,
            size = (obj?.get("size") as? JsonPrimitive)?.contentOrNull?.toLongOrNull() ?: file.bytes.size.toLong(),
        ).also {
            if (it.path.isBlank()) error("服务端未返回附件路径")
        }
    }

    suspend fun sendAssistantMessage(
        content: String,
        attachments: List<AssistantPromptAttachment> = emptyList(),
        route: String = "/mobile",
    ): AssistantMessageResult {
        val attachmentJson = JsonArray(
            attachments.map { attachment ->
                JsonObject(
                    mapOf(
                        "path" to JsonPrimitive(attachment.path),
                        "name" to JsonPrimitive(attachment.name),
                        "size" to JsonPrimitive(attachment.size),
                        "type" to JsonPrimitive(attachment.type),
                        "mime_type" to JsonPrimitive(attachment.mimeType),
                    ),
                )
            },
        )
        val body = client.post("$baseUrl/api/assistant/messages") {
            addAuth()
            contentType(ContentType.Application.Json)
            setBody(
                JsonObject(
                    mapOf(
                        "content" to JsonPrimitive(content),
                        "input_text" to JsonPrimitive(content),
                        "attachments" to attachmentJson,
                        "route" to JsonPrimitive(route),
                        "client_context" to JsonObject(
                            mapOf(
                                "source" to JsonPrimitive("momo-mobile"),
                                "route" to JsonPrimitive(route),
                            ),
                        ),
                    ),
                ),
            )
        }.body<JsonObject>()
        return decodeAssistantMessageResult(body)
    }

    suspend fun transcribeAssistantAudio(bytes: ByteArray, mimeType: String, fileName: String): String {
        val safeFileName = fileName.ifBlank { "momo-voice.m4a" }.replace("\"", "")
        val response = client.post("$baseUrl/api/assistant/transcribe") {
            addAuth()
            setBody(
                MultiPartFormDataContent(
                    formData {
                        append(
                            "audio",
                            bytes,
                            Headers.build {
                                append(HttpHeaders.ContentType, mimeType.ifBlank { "application/octet-stream" })
                                append(HttpHeaders.ContentDisposition, "form-data; name=\"audio\"; filename=\"$safeFileName\"")
                            },
                        )
                    },
                ),
            )
        }
        val raw = response.bodyAsText()
        val obj = runCatching { json.parseToJsonElement(raw) as? JsonObject }.getOrNull()
        if (response.status.value !in 200..299) {
            error(
                obj?.string("error")
                    ?: obj?.string("message")
                    ?: "语音识别失败，请重新录制",
            )
        }
        return obj?.string("text")?.trim().orEmpty()
    }

    suspend fun createClone(issueId: String, title: String, description: String, model: String): Session {
        return client.post("$baseUrl/api/issues/$issueId/sessions/") {
            addAuth()
            contentType(ContentType.Application.Json)
            setBody(
                mapOf(
                    "name" to title,
                    "description" to description,
                    "model" to model,
                    "language" to "zh",
                    "excluded_skill_ids" to emptyList<String>(),
                    "excluded_memory_ids" to emptyList<String>(),
                ),
            )
        }.body()
    }

    suspend fun startSession(sessionId: String, content: String) {
        client.post("$baseUrl/api/sessions/$sessionId/messages") {
            addAuth()
            contentType(ContentType.Application.Json)
            setBody(mapOf("content" to content, "input_text" to content))
        }
    }

    suspend fun sendSessionMessage(sessionId: String, content: String, requestId: String = "momo-mobile-${nowShortTime()}-${content.hashCode()}") {
        client.post("$baseUrl/api/sessions/$sessionId/messages") {
            addAuth()
            contentType(ContentType.Application.Json)
            setBody(
                mapOf(
                    "content" to content,
                    "input_text" to content,
                    "request_id" to requestId,
                ),
            )
        }
    }

    suspend fun terminate(sessionId: String) {
        client.post("$baseUrl/api/sessions/$sessionId/terminate") { addAuth() }
    }

    suspend fun stop(sessionId: String) {
        client.post("$baseUrl/api/sessions/$sessionId/stop") { addAuth() }
    }

    suspend fun streamSession(
        sessionId: String,
        onConnected: suspend () -> Unit,
        onTyping: suspend (Boolean) -> Unit,
        onHistory: suspend (List<ChatMessage>) -> Unit,
        onJsonlHistory: suspend (List<StreamTextChunk>, Boolean, Boolean) -> Unit,
        onChunk: suspend (StreamTextChunk) -> Unit,
        onError: suspend (String) -> Unit,
    ) {
        var eventName = "message"
        val dataLines = mutableListOf<String>()
        try {
            client.prepareGet("$baseUrl/api/sessions/$sessionId/events") {
                addAuth()
                header(HttpHeaders.Accept, "text/event-stream")
                header("Cache-Control", "no-cache")
            }.execute { response ->
                if (response.status.value !in 200..299) {
                    if (response.status == HttpStatusCode.Unauthorized) {
                        onUnauthorized()
                        throw CancellationException("unauthorized")
                    }
                    onError("SSE 连接失败: HTTP ${response.status.value}")
                    return@execute
                }
                onConnected()
                val channel = response.bodyAsChannel()
                while (true) {
                    val line = channel.readUTF8Line() ?: break
                    when {
                        line.isBlank() -> {
                            val raw = dataLines.joinToString("\n")
                            if (raw.isNotBlank()) {
                                handleSseEvent(eventName, raw, onTyping, onHistory, onJsonlHistory, onChunk, onError)
                            }
                            eventName = "message"
                            dataLines.clear()
                        }
                        line.startsWith(":") -> Unit
                        line.startsWith("event:") -> eventName = line.removePrefix("event:").trim()
                        line.startsWith("data:") -> dataLines += line.removePrefix("data:").trimStart()
                    }
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Throwable) {
            onError(e.message ?: "SSE 连接中断")
        }
    }

    private suspend fun handleSseEvent(
        eventName: String,
        raw: String,
        onTyping: suspend (Boolean) -> Unit,
        onHistory: suspend (List<ChatMessage>) -> Unit,
        onJsonlHistory: suspend (List<StreamTextChunk>, Boolean, Boolean) -> Unit,
        onChunk: suspend (StreamTextChunk) -> Unit,
        onError: suspend (String) -> Unit,
    ) {
        val element = runCatching { json.parseToJsonElement(raw) }.getOrNull() ?: return
        val obj = element as? JsonObject ?: return
        when (eventName) {
            "history" -> onHistory(parseMessages(obj["messages"] as? JsonArray))
            "jsonl_history" -> {
                val entries = obj["entries"] as? JsonArray
                val chunks = entries?.mapNotNull { parseJsonlChunk(it) }.orEmpty()
                onJsonlHistory(
                    chunks,
                    obj["reset"]?.jsonPrimitive?.booleanOrNull == true,
                    obj["done"]?.jsonPrimitive?.booleanOrNull == true,
                )
            }
            "typing" -> onTyping(obj["active"]?.jsonPrimitive?.booleanOrNull == true)
            "jsonl_entry" -> parseJsonlChunk(obj["entry"])?.let { onChunk(it) }
            "server_error" -> onError(obj.string("message") ?: "服务端错误")
        }
    }

    private fun parseMessages(array: JsonArray?): List<ChatMessage> {
        if (array == null) return emptyList()
        return array.mapIndexedNotNull { index, item ->
            val obj = item as? JsonObject ?: return@mapIndexedNotNull null
            val content = obj.string("content") ?: obj.string("text") ?: return@mapIndexedNotNull null
            val role = obj.string("role") ?: obj.string("type") ?: ""
            val author = when {
                role.contains("user", ignoreCase = true) -> MessageAuthor.User
                role.contains("system", ignoreCase = true) -> MessageAuthor.System
                else -> MessageAuthor.Momo
            }
            ChatMessage(
                id = obj.string("id") ?: "history-$index",
                author = author,
                text = content,
                time = formatBackendTime(obj.string("created_at")).ifBlank { nowShortTime() },
            )
        }
    }

    private fun parseAssistantSnapshots(array: JsonArray?): List<AssistantSnapshot> {
        if (array == null) return emptyList()
        return array.mapNotNull { item -> (item as? JsonObject)?.let { parseAssistantSnapshot(it) } }
    }

    private fun parseAssistantSnapshot(obj: JsonObject): AssistantSnapshot {
        val sessionObj = obj["session"] as? JsonObject
        val session = parseSession(sessionObj ?: obj)
        val messages = parseMessages(obj["messages"] as? JsonArray)
        val statusObj = obj["status"] as? JsonObject
        val status = AssistantSessionStatus(
            working = statusObj?.get("working")?.jsonPrimitive?.booleanOrNull == true,
            failed = statusObj?.get("failed")?.jsonPrimitive?.booleanOrNull == true,
            agentStatus = statusObj?.string("agent_status").orEmpty(),
        )
        return AssistantSnapshot(
            session = session.copy(
                agentStatus = status.agentStatus.ifBlank { session.agentStatus },
                jobFailed = session.jobFailed ?: status.failed,
            ),
            messages = messages,
            status = status,
        )
    }

    private fun parseSession(obj: JsonObject): Session =
        Session(
            sessionId = obj.string("session_id").orEmpty(),
            name = obj.string("name").orEmpty(),
            description = obj.string("description").orEmpty(),
            assistantRole = obj.string("assistant_role").orEmpty(),
            projectId = obj.string("project_id").orEmpty(),
            issueId = obj.string("issue_id").orEmpty(),
            model = obj.string("model").orEmpty(),
            agentStatus = obj.string("agent_status").orEmpty(),
            createdAt = obj.string("created_at").orEmpty(),
            lastActive = obj.string("last_active").orEmpty(),
            jobFailed = obj["job_failed"]?.jsonPrimitive?.booleanOrNull,
            jobAccomplished = obj["job_accomplished"]?.jsonPrimitive?.booleanOrNull,
        )

    private fun parseJsonlChunk(entry: JsonElement?): StreamTextChunk? {
        val obj = entry as? JsonObject ?: return null
        val rawText = findText(obj)?.trim()?.takeIf { it.isNotBlank() } ?: return null
        val author = entryAuthor(obj) ?: return null
        val (cleanedText, voiceText) = extractVoiceMarker(rawText)
        if (author == MessageAuthor.Momo && cleanedText.isBlank() && voiceText.isNullOrBlank()) return null
        return StreamTextChunk(
            id = obj.string("id") ?: obj.string("uuid") ?: "event-${rawText.hashCode()}-${nowShortTime()}",
            author = author,
            text = if (author == MessageAuthor.User) rawText else cleanedText,
            voiceText = voiceText,
            time = formatBackendTime(obj.string("timestamp") ?: obj.string("created_at") ?: ((obj["payload"] as? JsonObject)?.string("timestamp"))).ifBlank { nowShortTime() },
        )
    }

    private fun entryAuthor(obj: JsonObject): MessageAuthor? {
        val role = obj.string("role")
        val type = obj.string("type") ?: obj.string("kind")
        if (role == "user" || type == "user" || type == "user_input") return MessageAuthor.User
        if (isProcessOnlyType(role, type)) return null
        if (role == "assistant" || type == "assistant") return MessageAuthor.Momo
        val message = obj["message"] as? JsonObject
        val messageRole = message?.string("role")
        val messageType = message?.string("type")
        if (messageRole == "assistant" && !isProcessOnlyType(messageRole, messageType)) return MessageAuthor.Momo
        if (messageRole == "user") return MessageAuthor.User
        val payload = obj["payload"] as? JsonObject
        val payloadRole = payload?.string("role")
        val payloadType = payload?.string("type")
        if (payloadRole == "assistant" && !isProcessOnlyType(payloadRole, payloadType)) return MessageAuthor.Momo
        if (payloadRole == "user") return MessageAuthor.User
        if (payloadType == "message" && payloadRole == "assistant") return MessageAuthor.Momo
        if (payloadType == "output_text" || payloadType == "text") return MessageAuthor.Momo
        return null
    }

    private fun isProcessOnlyType(role: String?, type: String?): Boolean {
        val t = type?.lowercase()?.trim().orEmpty()
        if (t in PROCESS_ONLY_TYPES) return true
        val r = role?.lowercase()?.trim().orEmpty()
        if (r in PROCESS_ONLY_ROLES) return true
        return false
    }

    private fun extractVoiceMarker(raw: String): Pair<String, String?> {
        val matches = VOICE_MARKER_REGEX.findAll(raw).toList()
        if (matches.isEmpty()) return raw to null
        val voiceText = matches.mapNotNull { it.groupValues.getOrNull(2)?.trim()?.takeIf { it.isNotBlank() } }
            .joinToString("\n")
            .takeIf { it.isNotBlank() }
        val cleaned = VOICE_MARKER_REGEX.replace(raw, "")
            .replace(VOICE_TRAILING_WS_PER_LINE, "\n")
            .replace(VOICE_MULTI_SPACE, " ")
            .replace(VOICE_MARKER_BLANK_LINES_REGEX, "\n")
            .trim()
        return cleaned to voiceText
    }

    private fun findText(obj: JsonObject): String? {
        val direct = obj.string("content") ?: obj.string("text") ?: obj.string("message")
        if (!direct.isNullOrBlank() && !direct.trim().startsWith("{")) return direct
        val msg = obj["message"] as? JsonObject
        val nested = msg?.string("content") ?: msg?.string("text") ?: contentBlocksText(msg?.get("content"))
        if (!nested.isNullOrBlank()) return nested
        val payload = obj["payload"] as? JsonObject
        val payloadText = payload?.string("text")
            ?: payload?.string("output_text")
            ?: payload?.string("content")
            ?: contentBlocksText(payload?.get("content"))
        if (!payloadText.isNullOrBlank()) return payloadText
        return null
    }

    private fun contentBlocksText(content: JsonElement?): String? {
        if (content == null) return null
        if (content is JsonPrimitive) return content.contentOrNull
        val array = content as? JsonArray ?: return null
        return array.mapNotNull { item ->
            val obj = item as? JsonObject ?: return@mapNotNull (item as? JsonPrimitive)?.contentOrNull
            val type = obj.string("type")
            if (type != null && type != "text" && type != "output_text") return@mapNotNull null
            obj.string("text") ?: obj.string("output_text")
        }.filter { it.isNotBlank() }.joinToString("\n").takeIf { it.isNotBlank() }
    }

    private fun decodeLogin(obj: JsonObject): LoginResult =
        json.decodeFromJsonElement(LoginResult.serializer(), obj)

    private fun decodeAssistantMessageResult(obj: JsonObject): AssistantMessageResult {
        val direct = runCatching { json.decodeFromJsonElement(AssistantMessageResult.serializer(), obj) }
            .getOrDefault(AssistantMessageResult())
        val sessionObj = findObject(obj, "session")
        val projectObj = findObject(obj, "project")
        val issueObj = findObject(obj, "issue")
        val nestedSession = sessionObj?.let { runCatching { json.decodeFromJsonElement(Session.serializer(), it) }.getOrNull() }
        val nestedProject = projectObj?.let { runCatching { json.decodeFromJsonElement(Project.serializer(), it) }.getOrNull() }
        val nestedIssue = issueObj?.let { runCatching { json.decodeFromJsonElement(com.mobius.momo.domain.Issue.serializer(), it) }.getOrNull() }
        return direct.copy(
            sessionId = direct.sessionId.ifBlank { findString(obj, "session_id") },
            taskId = direct.taskId.ifBlank { findString(obj, "task_id") },
            session = direct.session ?: nestedSession,
            project = if (direct.project.id.isNotBlank()) direct.project else nestedProject ?: direct.project,
            issue = if (direct.issue.id.isNotBlank()) direct.issue else nestedIssue ?: direct.issue,
        )
    }

    private fun parseErrorMessage(raw: String): String {
        val obj = runCatching { json.parseToJsonElement(raw) as? JsonObject }.getOrNull()
        return obj?.string("error")
            ?: obj?.string("message")
            ?: "用户名或密码不正确"
    }

    private fun io.ktor.client.request.HttpRequestBuilder.addAuth() {
        storage.getToken()?.takeIf { it.isNotBlank() }?.let { bearerAuth(it) }
    }

    private fun JsonObject.string(key: String): String? =
        (this[key] as? JsonPrimitive)?.contentOrNull

    private fun findString(obj: JsonObject, key: String): String {
        obj.string(key)?.takeIf { it.isNotBlank() }?.let { return it }
        for (value in obj.values) {
            val child = value as? JsonObject ?: continue
            val found = findString(child, key)
            if (found.isNotBlank()) return found
        }
        return ""
    }

    private fun findObject(obj: JsonObject, key: String): JsonObject? {
        (obj[key] as? JsonObject)?.let { return it }
        for (value in obj.values) {
            val child = value as? JsonObject ?: continue
            val found = findObject(child, key)
            if (found != null) return found
        }
        return null
    }

}

private val VOICE_MARKER_REGEX = Regex("""PushVoiceToUser\s*\(\s*(["'])([\s\S]*?)(?<!\\)\1\s*\)""")
private val VOICE_MARKER_LINE_REGEX = Regex(
    """^[ \t]*PushVoiceToUser\s*\(\s*(["'])([\s\S]*?)(?<!\\)\1\s*\)[ \t]*;?[ \t]*$""",
    RegexOption.MULTILINE,
)
private val VOICE_MARKER_BLANK_LINES_REGEX = Regex("""\n{3,}""")
private val VOICE_TRAILING_WS_PER_LINE = Regex("""[ \t]+\n""")
private val VOICE_MULTI_SPACE = Regex("""[ \t]{2,}""")

private val PROCESS_ONLY_TYPES = setOf(
    "thinking",
    "thought",
    "reasoning",
    "reasoning_summary",
    "tool_use",
    "tool_call",
    "tool_result",
    "tool_output",
    "function_call",
    "function_call_output",
    "web_search_call",
    "file_search_call",
    "computer_call",
    "computer_call_output",
    "image_generation_call",
    "code_interpreter_call",
    "local_shell_call",
    "mcp_call",
    "custom_tool_call",
    "redacted_thinking",
)
private val PROCESS_ONLY_ROLES = setOf("tool", "function")
