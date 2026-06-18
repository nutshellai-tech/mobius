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
import com.mobius.momo.domain.StreamTextChunk
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.prepareGet
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsChannel
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
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

class MobiusApi(
    private val baseUrl: String = "https://cloud-17.agent-matrix.com",
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

    suspend fun sendAssistantMessage(content: String, route: String = "/mobile"): AssistantMessageResult {
        val body = client.post("$baseUrl/api/assistant/messages") {
            addAuth()
            contentType(ContentType.Application.Json)
            setBody(
                mapOf(
                    "content" to content,
                    "route" to route,
                    "client_context" to mapOf(
                        "source" to "momo-mobile",
                        "route" to route,
                    ),
                ),
            )
        }.body<JsonObject>()
        return decodeAssistantMessageResult(body)
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
                time = obj.string("created_at")?.toShortTime() ?: nowShortTime(),
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
        val text = findText(obj)?.trim()?.takeIf { it.isNotBlank() } ?: return null
        val author = entryAuthor(obj) ?: return null
        return StreamTextChunk(
            id = obj.string("id") ?: obj.string("uuid") ?: "event-${text.hashCode()}-${nowShortTime()}",
            author = author,
            text = text,
            time = obj.string("timestamp")?.toShortTime() ?: nowShortTime(),
        )
    }

    private fun entryAuthor(obj: JsonObject): MessageAuthor? {
        val role = obj.string("role")
        val type = obj.string("type") ?: obj.string("kind")
        if (role == "user" || type == "user" || type == "user_input") return MessageAuthor.User
        if (role == "assistant" || type == "assistant") return MessageAuthor.Momo
        val message = obj["message"] as? JsonObject
        if (message?.string("role") == "assistant") return MessageAuthor.Momo
        if (message?.string("role") == "user") return MessageAuthor.User
        val payload = obj["payload"] as? JsonObject
        if (payload?.string("role") == "assistant") return MessageAuthor.Momo
        if (payload?.string("role") == "user") return MessageAuthor.User
        if (payload?.string("type") == "message" && payload.string("role") == "assistant") return MessageAuthor.Momo
        if (payload?.string("type") == "output_text" || payload?.string("type") == "text") return MessageAuthor.Momo
        return null
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

    private fun String.toShortTime(): String {
        val match = Regex("""(\d{2}):(\d{2})""").find(this)
        return match?.value ?: nowShortTime()
    }
}
