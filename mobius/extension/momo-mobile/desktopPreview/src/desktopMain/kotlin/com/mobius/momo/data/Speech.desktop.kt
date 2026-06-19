package com.mobius.momo.data

import javax.swing.SwingUtilities
import kotlin.concurrent.thread

actual fun createSpeechPermissionController(): SpeechPermissionController =
    object : SpeechPermissionController {
        override fun hasPermission(): Boolean = true
        override suspend fun requestPermission(): SpeechPermissionStatus = SpeechPermissionStatus.Granted
    }

actual fun createSpeechRecognizer(): SpeechRecognizer = DesktopMockSpeechRecognizer()

private class DesktopMockSpeechRecognizer : SpeechRecognizer {
    @Volatile
    private var active = false
    private var onEventRef: ((SpeechRecognitionEvent) -> Unit)? = null

    override fun start(languageTag: String, onEvent: (SpeechRecognitionEvent) -> Unit) {
        active = true
        onEventRef = onEvent
        thread(name = "momo-mock-speech") {
            emit { onEvent(SpeechRecognitionEvent.Ready) }
            val parts = listOf("测试", "测试语音", "测试语音识别结果")
            parts.forEachIndexed { index, part ->
                Thread.sleep(360L)
                if (!active) return@thread
                emit {
                    onEvent(SpeechRecognitionEvent.Volume((index + 2).coerceAtMost(5)))
                    onEvent(SpeechRecognitionEvent.Partial(part))
                }
            }
        }
    }

    override fun stop() {
        if (!active) return
        active = false
        emit {
            onEventRef?.invoke(SpeechRecognitionEvent.Final("测试语音识别结果"))
            onEventRef?.invoke(SpeechRecognitionEvent.End)
        }
    }

    override fun cancel() {
        active = false
    }

    override fun dispose() {
        active = false
        onEventRef = null
    }

    private fun emit(block: () -> Unit) {
        SwingUtilities.invokeLater(block)
    }
}

actual fun createTextToSpeech(): TextToSpeech =
    object : TextToSpeech {
        override fun speak(text: String, languageTag: String, onError: (String) -> Unit) = Unit
        override fun stop() = Unit
        override fun dispose() = Unit
    }
