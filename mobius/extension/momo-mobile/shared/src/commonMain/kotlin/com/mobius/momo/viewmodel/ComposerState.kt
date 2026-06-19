package com.mobius.momo.viewmodel

enum class ComposerInputMode {
    Text,
    Voice,
}

enum class AttachmentStatus {
    Uploading,
    Done,
    Error,
}

data class PendingAttachment(
    val id: String,
    val name: String,
    val size: Long,
    val mimeType: String,
    val status: AttachmentStatus,
    val path: String = "",
    val error: String = "",
)

fun UiState.withToggledComposerMode(): UiState = copy(
    composerInputMode = if (composerInputMode == ComposerInputMode.Text) {
        ComposerInputMode.Voice
    } else {
        ComposerInputMode.Text
    },
)

fun UiState.canSendComposerMessage(): Boolean {
    if (sendingMessage || attachments.any { it.status == AttachmentStatus.Uploading }) return false
    return input.isNotBlank() || attachments.any { it.status == AttachmentStatus.Done && it.path.isNotBlank() }
}
