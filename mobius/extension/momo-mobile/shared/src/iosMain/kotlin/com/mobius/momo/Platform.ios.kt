package com.mobius.momo.data

import io.ktor.client.HttpClient
import io.ktor.client.engine.darwin.Darwin
import io.ktor.client.plugins.HttpResponseValidator
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.defaultRequest
import io.ktor.client.plugins.logging.LogLevel
import io.ktor.client.plugins.logging.Logging
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import io.ktor.serialization.kotlinx.json.json
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.serialization.json.Json
import platform.AVFoundation.AVAudioEngine
import platform.AVFoundation.AVAudioSession
import platform.AVFoundation.AVAudioSessionCategoryPlayAndRecord
import platform.AVFoundation.AVAudioSessionModeMeasurement
import platform.AVFoundation.AVSpeechBoundaryImmediate
import platform.AVFoundation.AVSpeechSynthesisVoice
import platform.AVFoundation.AVSpeechSynthesizer
import platform.AVFoundation.AVSpeechUtterance
import platform.Foundation.NSDate
import platform.Foundation.NSDateFormatter
import platform.Foundation.NSBundle
import platform.Foundation.NSLocale
import platform.Foundation.NSTimeZone
import platform.Foundation.NSUserDefaults
import platform.Foundation.dateWithTimeIntervalSince1970
import platform.Speech.SFSpeechAudioBufferRecognitionRequest
import platform.Speech.SFSpeechRecognizer
import platform.Speech.SFSpeechRecognizerAuthorizationStatusAuthorized
import platform.Speech.SFSpeechRecognizerAuthorizationStatusDenied
import platform.Speech.SFSpeechRecognizerAuthorizationStatusNotDetermined
import platform.Speech.SFSpeechRecognizerAuthorizationStatusRestricted
import platform.Speech.SFSpeechRecognitionTask
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine

actual fun createSecureStorage(): SecureStorage = IosSecureStorage()

actual fun platformBuildBaseUrl(): String =
    NSBundle.mainBundle.objectForInfoDictionaryKey("MOMO_BASE_URL") as? String ?: ""

actual fun createFilePicker(): FilePicker = object : FilePicker {
    override fun pickFiles(
        maxFiles: Int,
        onResult: (List<PickedFile>) -> Unit,
        onError: (String) -> Unit,
    ) {
        onError("iOS 文件选择器需要在 Xcode 壳中授权后使用")
    }
}

private class IosSecureStorage : SecureStorage {
    private val defaults = NSUserDefaults.standardUserDefaults

    override fun saveToken(token: String) {
        defaults.setObject(token, forKey = "momo.secure.token")
        defaults.synchronize()
    }

    override fun getToken(): String? =
        defaults.stringForKey("momo.secure.token")

    override fun savePreference(key: String, value: String) {
        defaults.setObject(value, forKey = "momo.pref.$key")
        defaults.synchronize()
    }

    override fun getPreference(key: String): String? =
        defaults.stringForKey("momo.pref.$key")

    override fun clear() {
        defaults.removeObjectForKey("momo.secure.token")
        defaults.synchronize()
    }
}

actual fun createMobiusHttpClient(
    onUnauthorized: suspend () -> Unit,
): HttpClient = HttpClient(Darwin) {
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

@OptIn(ExperimentalForeignApi::class)
actual fun nowShortTime(): String {
    val formatter = NSDateFormatter()
    formatter.dateFormat = "HH:mm"
    return formatter.stringFromDate(NSDate())
}

actual fun formatBackendTime(value: String?): String {
    val raw = value?.takeIf { it.isNotBlank() } ?: return ""
    val date = listOf(
        "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
        "yyyy-MM-dd'T'HH:mm:ss'Z'",
    ).firstNotNullOfOrNull { pattern ->
        val parser = NSDateFormatter()
        parser.locale = NSLocale.localeWithLocaleIdentifier("en_US_POSIX")
        parser.timeZone = NSTimeZone.timeZoneForSecondsFromGMT(0)
        parser.dateFormat = pattern
        parser.dateFromString(raw)
    } ?: return ""
    val diffSeconds = NSDate().timeIntervalSince1970 - date.timeIntervalSince1970
    if (diffSeconds < 60.0) return "刚刚"
    if (diffSeconds < 3600.0) return "${kotlin.math.max(1, (diffSeconds / 60.0).toInt())}分钟前"
    if (diffSeconds < 86400.0) return "${kotlin.math.max(1, (diffSeconds / 3600.0).toInt())}小时前"
    val formatter = NSDateFormatter()
    formatter.dateFormat = "MM-dd HH:mm"
    return formatter.stringFromDate(NSDate.dateWithTimeIntervalSince1970(date.timeIntervalSince1970))
}

actual fun createSpeechPermissionController(): SpeechPermissionController = IosSpeechPermissionController()

private class IosSpeechPermissionController : SpeechPermissionController {
    override fun hasPermission(): Boolean =
        SFSpeechRecognizer.authorizationStatus() == SFSpeechRecognizerAuthorizationStatusAuthorized

    override suspend fun requestPermission(): SpeechPermissionStatus = suspendCoroutine { continuation ->
        SFSpeechRecognizer.requestAuthorization { status ->
            if (status != SFSpeechRecognizerAuthorizationStatusAuthorized) {
                continuation.resume(
                    when (status) {
                        SFSpeechRecognizerAuthorizationStatusNotDetermined -> SpeechPermissionStatus.NotDetermined
                        SFSpeechRecognizerAuthorizationStatusDenied, SFSpeechRecognizerAuthorizationStatusRestricted -> SpeechPermissionStatus.Denied
                        else -> SpeechPermissionStatus.Denied
                    },
                )
                return@requestAuthorization
            }
            AVAudioSession.sharedInstance().requestRecordPermission { granted ->
                continuation.resume(if (granted) SpeechPermissionStatus.Granted else SpeechPermissionStatus.Denied)
            }
        }
    }
}

actual fun createSpeechRecognizer(): SpeechRecognizer = IosSystemSpeechRecognizer()

private class IosSystemSpeechRecognizer : SpeechRecognizer {
    private var audioEngine: AVAudioEngine? = null
    private var request: SFSpeechAudioBufferRecognitionRequest? = null
    private var task: SFSpeechRecognitionTask? = null

    override fun start(languageTag: String, onEvent: (SpeechRecognitionEvent) -> Unit) {
        cancel()
        val recognizer = SFSpeechRecognizer(locale = NSLocale(localeIdentifier = languageTag))
        if (recognizer == null || recognizer.available.not()) {
            onEvent(SpeechRecognitionEvent.Error("当前系统不支持语音识别"))
            return
        }
        val session = AVAudioSession.sharedInstance()
        runCatching {
            session.setCategory(AVAudioSessionCategoryPlayAndRecord, error = null)
            session.setMode(AVAudioSessionModeMeasurement, error = null)
            session.setActive(true, error = null)
        }.onFailure {
            onEvent(SpeechRecognitionEvent.Error("麦克风启动失败"))
            return
        }

        val engine = AVAudioEngine()
        val recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        recognitionRequest.shouldReportPartialResults = true
        val inputNode = engine.inputNode
        val format = inputNode.outputFormatForBus(0u)
        inputNode.installTapOnBus(
            bus = 0u,
            bufferSize = 1024u,
            format = format,
        ) { buffer, _ ->
            if (buffer != null) recognitionRequest.appendAudioPCMBuffer(buffer)
            onEvent(SpeechRecognitionEvent.Volume(3))
        }
        engine.prepare()
        if (!engine.startAndReturnError(null)) {
            onEvent(SpeechRecognitionEvent.Error("录音启动失败"))
            return
        }
        audioEngine = engine
        request = recognitionRequest
        onEvent(SpeechRecognitionEvent.Ready)
        task = recognizer.recognitionTaskWithRequest(recognitionRequest) { result, error ->
            if (error != null) {
                onEvent(SpeechRecognitionEvent.Error(error.localizedDescription ?: "语音识别失败"))
                return@recognitionTaskWithRequest
            }
            val transcription = result?.bestTranscription?.formattedString.orEmpty()
            if (transcription.isNotBlank()) {
                if (result?.final == true) onEvent(SpeechRecognitionEvent.Final(transcription))
                else onEvent(SpeechRecognitionEvent.Partial(transcription))
            }
        }
    }

    override fun stop() {
        audioEngine?.stop()
        audioEngine?.inputNode?.removeTapOnBus(0u)
        request?.endAudio()
    }

    override fun cancel() {
        audioEngine?.stop()
        audioEngine?.inputNode?.removeTapOnBus(0u)
        request?.endAudio()
        task?.cancel()
        audioEngine = null
        request = null
        task = null
    }

    override fun dispose() = cancel()
}

actual fun createTextToSpeech(): TextToSpeech = IosSystemTextToSpeech()

private class IosSystemTextToSpeech : TextToSpeech {
    private val synthesizer = AVSpeechSynthesizer()

    override fun speak(text: String, languageTag: String, onError: (String) -> Unit) {
        if (text.isBlank()) return
        stop()
        val utterance = AVSpeechUtterance.speechUtteranceWithString(text)
        utterance.voice = AVSpeechSynthesisVoice.voiceWithLanguage(languageTag)
        utterance.rate = 0.48f
        synthesizer.speakUtterance(utterance)
    }

    override fun stop() {
        if (synthesizer.speaking) synthesizer.stopSpeakingAtBoundary(AVSpeechBoundaryImmediate)
    }

    override fun dispose() = stop()
}
