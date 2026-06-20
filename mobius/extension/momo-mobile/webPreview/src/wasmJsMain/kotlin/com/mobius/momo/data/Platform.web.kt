package com.mobius.momo.data

import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.HttpResponseValidator
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.defaultRequest
import io.ktor.client.plugins.logging.LogLevel
import io.ktor.client.plugins.logging.Logging
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import io.ktor.serialization.kotlinx.json.json
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi
import kotlin.js.JsString
import kotlin.js.toJsString
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

@JsFun("(key) => globalThis.MomoWebBridge.storageGet(key)")
private external fun bridgeStorageGet(key: JsString): JsString?

@JsFun("(key, value) => globalThis.MomoWebBridge.storageSet(key, value)")
private external fun bridgeStorageSet(key: JsString, value: JsString)

@JsFun("(key) => globalThis.MomoWebBridge.storageRemove(key)")
private external fun bridgeStorageRemove(key: JsString)

@JsFun("() => globalThis.MomoWebBridge.baseUrl()")
private external fun bridgeBaseUrl(): JsString

@JsFun("() => globalThis.MomoWebBridge.nowShortTime()")
private external fun bridgeNowShortTime(): JsString

@JsFun("(value) => globalThis.MomoWebBridge.formatBackendTime(value)")
private external fun bridgeFormatBackendTime(value: JsString): JsString

@JsFun("(maxFiles) => globalThis.MomoWebBridge.openFilePicker(maxFiles)")
private external fun bridgeOpenFilePicker(maxFiles: Int): JsString

@JsFun("(requestId) => globalThis.MomoWebBridge.takeFileResult(requestId)")
private external fun bridgeTakeFileResult(requestId: JsString): JsString?

@JsFun("() => globalThis.MomoWebBridge.hasMicrophonePermission()")
private external fun bridgeHasMicrophonePermission(): Boolean

@JsFun("() => globalThis.MomoWebBridge.requestMicrophonePermission()")
private external fun bridgeRequestMicrophonePermission(): JsString

@JsFun("(requestId) => globalThis.MomoWebBridge.takePermissionResult(requestId)")
private external fun bridgeTakePermissionResult(requestId: JsString): JsString?

@JsFun("() => globalThis.MomoWebBridge.startRecording()")
private external fun bridgeStartRecording(): JsString

@JsFun("(recordingId) => globalThis.MomoWebBridge.takeRecordingEvent(recordingId)")
private external fun bridgeTakeRecordingEvent(recordingId: JsString): JsString?

@JsFun("(recordingId) => globalThis.MomoWebBridge.stopRecording(recordingId)")
private external fun bridgeStopRecording(recordingId: JsString)

@JsFun("(recordingId) => globalThis.MomoWebBridge.cancelRecording(recordingId)")
private external fun bridgeCancelRecording(recordingId: JsString)

@JsFun("(text, languageTag) => globalThis.MomoWebBridge.speak(text, languageTag)")
private external fun bridgeSpeak(text: JsString, languageTag: JsString): Boolean

@JsFun("() => globalThis.MomoWebBridge.stopSpeaking()")
private external fun bridgeStopSpeaking()

private val bridgeJson = Json { ignoreUnknownKeys = true }
private val webScope = MainScope()

actual fun createSecureStorage(): SecureStorage = object : SecureStorage {
    override fun saveToken(token: String) {
        bridgeStorageSet("momo.token".toJsString(), token.toJsString())
    }

    override fun getToken(): String? =
        bridgeStorageGet("momo.token".toJsString())?.toString()

    override fun savePreference(key: String, value: String) {
        bridgeStorageSet("momo.pref.$key".toJsString(), value.toJsString())
    }

    override fun getPreference(key: String): String? =
        bridgeStorageGet("momo.pref.$key".toJsString())?.toString()

    override fun clear() {
        bridgeStorageRemove("momo.token".toJsString())
    }
}

actual fun platformBuildBaseUrl(): String = bridgeBaseUrl().toString()

actual fun createFilePicker(): FilePicker = object : FilePicker {
    override fun pickFiles(
        maxFiles: Int,
        onResult: (List<PickedFile>) -> Unit,
        onError: (String) -> Unit,
    ) {
        val requestId = bridgeOpenFilePicker(maxFiles).toString()
        webScope.launch {
            repeat(1_200) {
                val raw = bridgeTakeFileResult(requestId.toJsString())?.toString()
                if (raw != null) {
                    runCatching {
                        val result = bridgeJson.decodeFromString<WebFileResult>(raw)
                        if (result.error.isNotBlank()) error(result.error)
                        result.files.map { file ->
                            PickedFile(
                                name = file.name,
                                mimeType = file.mimeType,
                                bytes = decodeBase64(file.base64),
                            )
                        }
                    }.onSuccess(onResult).onFailure { onError(it.message ?: "读取附件失败") }
                    return@launch
                }
                delay(100)
            }
            onError("文件选择超时")
        }
    }
}

actual fun createMobiusHttpClient(
    onUnauthorized: suspend () -> Unit,
): HttpClient = HttpClient(CIO) {
    install(ContentNegotiation) {
        json(Json { ignoreUnknownKeys = true; isLenient = true; encodeDefaults = true })
    }
    install(Logging) {
        level = LogLevel.INFO
    }
    defaultRequest {
        contentType(ContentType.Application.Json)
        header(HttpHeaders.Accept, ContentType.Application.Json.toString())
    }
    HttpResponseValidator {
        validateResponse { response ->
            if (response.status.value == 401) onUnauthorized()
        }
    }
}

actual fun nowShortTime(): String = bridgeNowShortTime().toString()

actual fun formatBackendTime(value: String?): String =
    bridgeFormatBackendTime(value.orEmpty().toJsString()).toString()

actual fun createSpeechPermissionController(): SpeechPermissionController = object : SpeechPermissionController {
    override fun hasPermission(): Boolean = bridgeHasMicrophonePermission()

    override suspend fun requestPermission(): SpeechPermissionStatus {
        val requestId = bridgeRequestMicrophonePermission().toString()
        repeat(600) {
            when (bridgeTakePermissionResult(requestId.toJsString())?.toString()) {
                "granted" -> return SpeechPermissionStatus.Granted
                "denied" -> return SpeechPermissionStatus.Denied
            }
            delay(100)
        }
        return SpeechPermissionStatus.Denied
    }
}

actual fun createSpeechRecognizer(): SpeechRecognizer = WebSpeechRecognizer()

private class WebSpeechRecognizer : SpeechRecognizer {
    private var recordingId: String? = null
    private var generation = 0

    override fun start(languageTag: String, onEvent: (SpeechRecognitionEvent) -> Unit) {
        cancel()
        val currentGeneration = ++generation
        val id = bridgeStartRecording().toString()
        recordingId = id
        webScope.launch {
            repeat(1_200) {
                if (generation != currentGeneration || recordingId != id) return@launch
                val raw = bridgeTakeRecordingEvent(id.toJsString())?.toString()
                if (raw == null) {
                    delay(50)
                    return@repeat
                }
                val event = runCatching { bridgeJson.decodeFromString<WebRecordingEvent>(raw) }
                    .getOrElse {
                        onEvent(SpeechRecognitionEvent.Error(it.message ?: "录音事件解析失败"))
                        return@launch
                    }
                when (event.type) {
                    "ready" -> onEvent(SpeechRecognitionEvent.Ready)
                    "volume" -> onEvent(SpeechRecognitionEvent.Volume(event.level.coerceIn(0, 5)))
                    "audio" -> {
                        onEvent(
                            SpeechRecognitionEvent.Audio(
                                bytes = decodeBase64(event.base64),
                                mimeType = event.mimeType,
                                fileName = event.fileName,
                            ),
                        )
                        recordingId = null
                        return@launch
                    }
                    "error" -> {
                        onEvent(SpeechRecognitionEvent.Error(event.message.ifBlank { "录音失败" }))
                        recordingId = null
                        return@launch
                    }
                    "end" -> {
                        onEvent(SpeechRecognitionEvent.End)
                        recordingId = null
                        return@launch
                    }
                }
            }
        }
    }

    override fun stop() {
        recordingId?.let { bridgeStopRecording(it.toJsString()) }
    }

    override fun cancel() {
        generation += 1
        recordingId?.let { bridgeCancelRecording(it.toJsString()) }
        recordingId = null
    }

    override fun dispose() = cancel()
}

actual fun createTextToSpeech(): TextToSpeech = object : TextToSpeech {
    override fun speak(text: String, languageTag: String, onError: (String) -> Unit) {
        if (!bridgeSpeak(text.toJsString(), languageTag.toJsString())) {
            onError("当前浏览器不支持语音播报")
        }
    }

    override fun stop() = bridgeStopSpeaking()

    override fun dispose() = stop()
}

@OptIn(ExperimentalEncodingApi::class)
private fun decodeBase64(value: String): ByteArray =
    if (value.isBlank()) ByteArray(0) else Base64.decode(value)

@Serializable
private data class WebFileResult(
    val files: List<WebFile> = emptyList(),
    val error: String = "",
)

@Serializable
private data class WebFile(
    val name: String = "",
    val mimeType: String = "",
    val base64: String = "",
)

@Serializable
private data class WebRecordingEvent(
    val type: String,
    val level: Int = 0,
    val base64: String = "",
    val mimeType: String = "",
    val fileName: String = "",
    val message: String = "",
)
