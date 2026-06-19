package com.mobius.momo.data

enum class SpeechPermissionStatus {
    Granted,
    Denied,
    NotDetermined,
}

interface SpeechPermissionController {
    fun hasPermission(): Boolean
    suspend fun requestPermission(): SpeechPermissionStatus
}

sealed interface SpeechRecognitionEvent {
    data object Ready : SpeechRecognitionEvent
    data class Partial(val text: String) : SpeechRecognitionEvent
    data class Final(val text: String) : SpeechRecognitionEvent
    data class Audio(val bytes: ByteArray, val mimeType: String, val fileName: String) : SpeechRecognitionEvent
    data class Volume(val level: Int) : SpeechRecognitionEvent
    data class Error(val message: String) : SpeechRecognitionEvent
    data object End : SpeechRecognitionEvent
}

interface SpeechRecognizer {
    fun start(
        languageTag: String = "zh-CN",
        onEvent: (SpeechRecognitionEvent) -> Unit,
    )

    fun stop()
    fun cancel()
    fun dispose()
}

interface TextToSpeech {
    fun speak(
        text: String,
        languageTag: String = "zh-CN",
        onError: (String) -> Unit = {},
    )

    fun stop()
    fun dispose()
}

expect fun createSpeechPermissionController(): SpeechPermissionController

expect fun createSpeechRecognizer(): SpeechRecognizer

expect fun createTextToSpeech(): TextToSpeech
