package com.mobius.momo.domain

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
data class User(
    val id: String = "",
    @SerialName("display_name") val displayName: String = "",
    val role: String = "",
    @SerialName("work_dir") val workDir: String = "",
)

@Serializable
data class Project(
    val id: String = "",
    val name: String = "",
    val description: String = "",
)

@Serializable
data class Issue(
    val id: String = "",
    @SerialName("project_id") val projectId: String = "",
    val title: String = "",
    val description: String = "",
    val status: String = "",
)

@Serializable
data class AssistantWorkspace(
    val project: Project = Project(),
    val issue: Issue = Issue(),
)

@Serializable
data class Session(
    @SerialName("session_id") val sessionId: String = "",
    val name: String = "",
    val description: String = "",
    @SerialName("assistant_role") val assistantRole: String = "",
    @SerialName("project_id") val projectId: String = "",
    @SerialName("issue_id") val issueId: String = "",
    val model: String = "",
    @SerialName("agent_status") val agentStatus: String = "",
    @SerialName("created_at") val createdAt: String = "",
    @SerialName("last_active") val lastActive: String = "",
    @SerialName("job_failed") val jobFailed: Boolean? = null,
    @SerialName("job_accomplished") val jobAccomplished: Boolean? = null,
)

@Serializable
data class LoginResult(
    val token: String = "",
    val user: User = User(),
    @SerialName("expiresAt") val expiresAt: String = "",
)

@Serializable
data class AuthConfig(
    @SerialName("password_required") val passwordRequired: Boolean = true,
)

@Serializable
data class SessionModelOption(
    val key: String = "",
    val label: String = "",
    val title: String = "",
    val sub: String = "",
    val backend: String = "",
)

@Serializable
data class AssistantMessageResult(
    val ok: Boolean = false,
    val created: Boolean = false,
    @SerialName("request_id") val requestId: String = "",
    @SerialName("session_id") val sessionId: String = "",
    @SerialName("task_id") val taskId: String = "",
    val session: Session? = null,
    val project: Project = Project(),
    val issue: Issue = Issue(),
) {
    fun resolvedSessionId(): String =
        listOf(sessionId, taskId, session?.sessionId.orEmpty()).firstOrNull { it.isNotBlank() }.orEmpty()
}

enum class MessageAuthor {
    Momo,
    User,
    System,
}

data class ChatMessage(
    val id: String,
    val author: MessageAuthor,
    val text: String,
    val time: String,
    val voiceText: String? = null,
)

data class StreamTextChunk(
    val id: String,
    val author: MessageAuthor,
    val text: String,
    val time: String,
    val voiceText: String? = null,
)

data class AssistantSnapshot(
    val session: Session = Session(),
    val messages: List<ChatMessage> = emptyList(),
    val status: AssistantSessionStatus = AssistantSessionStatus(),
)

data class AssistantSessionStatus(
    val working: Boolean = false,
    val failed: Boolean = false,
    val agentStatus: String = "",
)

data class CloneDraft(
    val projectId: String = "",
    val issueId: String = "",
    val title: String = "",
    val description: String = "",
    val model: String = "codex",
)
