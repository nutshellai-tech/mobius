package com.mobius.momo.viewmodel

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ComposerStateTest {
    @Test
    fun toggleKeepsDraftText() {
        val state = UiState(input = "未发送文字")

        val toggled = state.withToggledComposerMode()

        assertEquals(ComposerInputMode.Voice, toggled.composerInputMode)
        assertEquals("未发送文字", toggled.input)
    }

    @Test
    fun completedAttachmentAllowsSendWithoutText() {
        val state = UiState(
            attachments = listOf(
                PendingAttachment(
                    id = "done",
                    name = "score.pdf",
                    size = 1024,
                    mimeType = "application/pdf",
                    status = AttachmentStatus.Done,
                    path = "/uploads/score.pdf",
                ),
            ),
        )

        assertTrue(state.canSendComposerMessage())
    }

    @Test
    fun uploadingAttachmentBlocksTextSend() {
        val state = UiState(
            input = "请查看",
            attachments = listOf(
                PendingAttachment(
                    id = "uploading",
                    name = "score.pdf",
                    size = 1024,
                    mimeType = "application/pdf",
                    status = AttachmentStatus.Uploading,
                ),
            ),
        )

        assertFalse(state.canSendComposerMessage())
    }
}
