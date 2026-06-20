package com.mobius.momo.data

import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.HttpResponseValidator
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.defaultRequest
import io.ktor.client.plugins.logging.LogLevel
import io.ktor.client.plugins.logging.Logging
import io.ktor.client.request.header
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
import java.util.Locale
import java.util.prefs.Preferences
import javax.swing.JFileChooser

actual fun createSecureStorage(): SecureStorage = DesktopSecureStorage()

actual fun createFilePicker(): FilePicker = object : FilePicker {
    override fun pickFiles(
        maxFiles: Int,
        onResult: (List<PickedFile>) -> Unit,
        onError: (String) -> Unit,
    ) {
        runCatching {
            val chooser = JFileChooser().apply {
                isMultiSelectionEnabled = maxFiles > 1
                fileSelectionMode = JFileChooser.FILES_ONLY
            }
            if (chooser.showOpenDialog(null) != JFileChooser.APPROVE_OPTION) return
            val files = if (chooser.isMultiSelectionEnabled) {
                chooser.selectedFiles.toList()
            } else {
                listOfNotNull(chooser.selectedFile)
            }
            onResult(
                files.take(maxFiles).map { file ->
                    PickedFile(
                        name = file.name,
                        mimeType = java.nio.file.Files.probeContentType(file.toPath()).orEmpty(),
                        bytes = file.readBytes(),
                    )
                },
            )
        }.onFailure { onError(it.message ?: "读取附件失败") }
    }
}

private class DesktopSecureStorage : SecureStorage {
    private val prefs = Preferences.userRoot().node("com.mobius.momo")

    override fun saveToken(token: String) {
        prefs.put("token", token)
    }

    override fun getToken(): String? = prefs.get("token", null)

    override fun savePreference(key: String, value: String) {
        prefs.put("pref.$key", value)
    }

    override fun getPreference(key: String): String? = prefs.get("pref.$key", null)

    override fun clear() {
        prefs.remove("token")
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

actual fun platformBuildBaseUrl(): String =
    System.getProperty("momo.base.url")
        ?: System.getenv("MOMO_BASE_URL")
        ?: ""

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
