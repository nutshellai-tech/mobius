package com.mobius.momo.data

import com.mobius.momo.shared.BuildConfig

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.provider.OpenableColumns
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech as AndroidTextToSpeech
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import io.ktor.client.HttpClient
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.HttpResponseValidator
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.defaultRequest
import io.ktor.client.plugins.logging.LogLevel
import io.ktor.client.plugins.logging.Logging
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.json.Json
import java.text.SimpleDateFormat
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Date
import java.io.File
import java.util.Locale
import kotlin.coroutines.Continuation
import kotlin.coroutines.suspendCoroutine

object AndroidContext {
    private const val SPEECH_PERMISSION_REQUEST = 9021
    private const val FILE_PICK_REQUEST = 9022

    lateinit var application: Context
    var activity: Activity? = null
    private var permissionContinuation: Continuation<SpeechPermissionStatus>? = null
    private var fileResult: ((List<PickedFile>) -> Unit)? = null
    private var fileError: ((String) -> Unit)? = null
    private var maxFiles: Int = 1

    fun requestSpeechPermission(continuation: Continuation<SpeechPermissionStatus>) {
        val currentActivity = activity
        if (application.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            continuation.resumeWith(Result.success(SpeechPermissionStatus.Granted))
            return
        }
        if (currentActivity == null) {
            continuation.resumeWith(Result.success(SpeechPermissionStatus.Denied))
            return
        }
        permissionContinuation = continuation
        currentActivity.requestPermissions(arrayOf(android.Manifest.permission.RECORD_AUDIO), SPEECH_PERMISSION_REQUEST)
    }

    fun handlePermissionResult(requestCode: Int, grantResults: IntArray) {
        if (requestCode != SPEECH_PERMISSION_REQUEST) return
        val granted = grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED
        permissionContinuation?.resumeWith(Result.success(if (granted) SpeechPermissionStatus.Granted else SpeechPermissionStatus.Denied))
        permissionContinuation = null
    }

    fun pickFiles(maxFiles: Int, onResult: (List<PickedFile>) -> Unit, onError: (String) -> Unit) {
        val currentActivity = activity
        if (currentActivity == null) {
            onError("文件选择器暂不可用")
            return
        }
        this.maxFiles = maxFiles.coerceAtLeast(1)
        fileResult = onResult
        fileError = onError
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, AndroidContext.maxFiles > 1)
        }
        currentActivity.startActivityForResult(intent, FILE_PICK_REQUEST)
    }

    fun handleActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode != FILE_PICK_REQUEST) return
        val onResult = fileResult
        val onError = fileError
        fileResult = null
        fileError = null
        if (resultCode != Activity.RESULT_OK || data == null) {
            onResult?.invoke(emptyList())
            return
        }
        val uris = buildList {
            data.clipData?.let { clip ->
                repeat(minOf(clip.itemCount, maxFiles)) { index -> add(clip.getItemAt(index).uri) }
            }
            if (isEmpty()) data.data?.let(::add)
        }
        runCatching {
            uris.take(maxFiles).map { uri ->
                val resolver = application.contentResolver
                var name = "attachment"
                resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                    val index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (cursor.moveToFirst() && index >= 0) name = cursor.getString(index) ?: name
                }
                val bytes = resolver.openInputStream(uri)?.use { it.readBytes() }
                    ?: error("无法读取文件 $name")
                PickedFile(
                    name = name,
                    mimeType = resolver.getType(uri).orEmpty(),
                    bytes = bytes,
                )
            }
        }.onSuccess { onResult?.invoke(it) }
            .onFailure { onError?.invoke(it.message ?: "读取附件失败") }
    }
}

actual fun createSecureStorage(): SecureStorage {
    val context = AndroidContext.application
    val masterKey = MasterKey.Builder(context)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()
    val prefs = EncryptedSharedPreferences.create(
        context,
        "momo_secure_storage",
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )
    return object : SecureStorage {
        override fun saveToken(token: String) {
            prefs.edit().putString("token", token).apply()
        }

        override fun getToken(): String? = prefs.getString("token", null)

        override fun savePreference(key: String, value: String) {
            prefs.edit().putString("pref.$key", value).apply()
        }

        override fun getPreference(key: String): String? = prefs.getString("pref.$key", null)

        override fun clear() {
            prefs.edit().remove("token").apply()
        }
    }
}

actual fun platformBuildBaseUrl(): String = BuildConfig.MOMO_BASE_URL

actual fun createFilePicker(): FilePicker = object : FilePicker {
    override fun pickFiles(
        maxFiles: Int,
        onResult: (List<PickedFile>) -> Unit,
        onError: (String) -> Unit,
    ) {
        AndroidContext.pickFiles(maxFiles, onResult, onError)
    }
}

actual fun createMobiusHttpClient(
    onUnauthorized: suspend () -> Unit,
): HttpClient = HttpClient(OkHttp) {
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

actual fun nowShortTime(): String =
    SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date())

actual fun formatBackendTime(value: String?): String {
    val raw = value?.takeIf { it.isNotBlank() } ?: return ""
    val instant = runCatching { Instant.parse(raw) }.getOrNull() ?: return ""
    val diffMs = System.currentTimeMillis() - instant.toEpochMilli()
    if (diffMs < 60_000L) return "刚刚"
    if (diffMs < 3_600_000L) return "${(diffMs / 60_000L).coerceAtLeast(1)}分钟前"
    if (diffMs < 86_400_000L) return "${(diffMs / 3_600_000L).coerceAtLeast(1)}小时前"
    return DateTimeFormatter.ofPattern("MM-dd HH:mm", Locale.getDefault())
        .format(instant.atZone(ZoneId.systemDefault()))
}

actual fun createSpeechPermissionController(): SpeechPermissionController = AndroidSpeechPermissionController()

private class AndroidSpeechPermissionController : SpeechPermissionController {
    override fun hasPermission(): Boolean =
        AndroidContext.application.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    override suspend fun requestPermission(): SpeechPermissionStatus = suspendCoroutine { continuation ->
        AndroidContext.requestSpeechPermission(continuation)
    }
}

actual fun createSpeechRecognizer(): SpeechRecognizer = AndroidAudioRecorder()

private class AndroidAudioRecorder : SpeechRecognizer {
    private val mainHandler = Handler(Looper.getMainLooper())
    private var recorder: MediaRecorder? = null
    private var outputFile: File? = null
    private var onEvent: ((SpeechRecognitionEvent) -> Unit)? = null
    private var active = false

    private val volumePoll = object : Runnable {
        override fun run() {
            val current = recorder ?: return
            if (!active) return
            val amplitude = runCatching { current.maxAmplitude }.getOrDefault(0)
            val level = when {
                amplitude <= 200 -> 1
                amplitude <= 900 -> 2
                amplitude <= 2_500 -> 3
                amplitude <= 7_000 -> 4
                else -> 5
            }
            onEvent?.invoke(SpeechRecognitionEvent.Volume(level))
            mainHandler.postDelayed(this, 160L)
        }
    }

    override fun start(languageTag: String, onEvent: (SpeechRecognitionEvent) -> Unit) {
        cancel()
        this.onEvent = onEvent
        val context = AndroidContext.application
        val file = File.createTempFile("momo-voice-", ".m4a", context.cacheDir)
        outputFile = file
        try {
            val mediaRecorder = MediaRecorder().apply {
                setAudioSource(MediaRecorder.AudioSource.MIC)
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                setAudioSamplingRate(16_000)
                setAudioChannels(1)
                setAudioEncodingBitRate(64_000)
                setOutputFile(file.absolutePath)
                prepare()
                start()
            }
            recorder = mediaRecorder
            active = true
            onEvent(SpeechRecognitionEvent.Ready)
            mainHandler.post(volumePoll)
        } catch (e: Throwable) {
            cleanup(deleteFile = true)
            onEvent(SpeechRecognitionEvent.Error(e.message ?: "麦克风启动失败"))
        }
    }

    override fun stop() {
        if (!active) return
        active = false
        mainHandler.removeCallbacks(volumePoll)
        val file = outputFile
        try {
            recorder?.stop()
            recorder?.release()
            recorder = null
            if (file == null || !file.exists() || file.length() == 0L) {
                onEvent?.invoke(SpeechRecognitionEvent.Error("录音内容为空，请重新录制"))
                cleanup(deleteFile = true)
                return
            }
            val bytes = file.readBytes()
            onEvent?.invoke(SpeechRecognitionEvent.Audio(bytes, "audio/mp4", "momo-voice.m4a"))
            onEvent?.invoke(SpeechRecognitionEvent.End)
        } catch (e: Throwable) {
            onEvent?.invoke(SpeechRecognitionEvent.Error("录音保存失败，请重新录制"))
        } finally {
            cleanup(deleteFile = true)
        }
    }

    override fun cancel() {
        cleanup(deleteFile = true)
    }

    override fun dispose() {
        cleanup(deleteFile = true)
        onEvent = null
    }

    private fun cleanup(deleteFile: Boolean) {
        active = false
        mainHandler.removeCallbacks(volumePoll)
        runCatching { recorder?.release() }
        recorder = null
        if (deleteFile) runCatching { outputFile?.delete() }
        outputFile = null
    }
}

actual fun createTextToSpeech(): TextToSpeech = AndroidSystemTextToSpeech()

private class AndroidSystemTextToSpeech : TextToSpeech {
    private var ready = false
    private var tts: AndroidTextToSpeech? = null

    init {
        tts = AndroidTextToSpeech(AndroidContext.application) { status ->
            ready = status == AndroidTextToSpeech.SUCCESS
            if (ready) {
                tts?.language = Locale.SIMPLIFIED_CHINESE
            }
        }
    }

    override fun speak(text: String, languageTag: String, onError: (String) -> Unit) {
        val engine = tts
        if (engine == null || !ready) {
            onError("语音播报尚未就绪")
            return
        }
        engine.language = Locale.forLanguageTag(languageTag).takeUnless { it.language.isBlank() } ?: Locale.SIMPLIFIED_CHINESE
        val result = engine.speak(text, AndroidTextToSpeech.QUEUE_FLUSH, null, "momo-${text.hashCode()}")
        if (result == AndroidTextToSpeech.ERROR) onError("语音播报失败")
    }

    override fun stop() {
        tts?.stop()
    }

    override fun dispose() {
        tts?.stop()
        tts?.shutdown()
        tts = null
    }
}
