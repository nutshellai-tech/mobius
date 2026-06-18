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
import java.util.Date
import java.util.Locale
import java.util.prefs.Preferences

actual fun createSecureStorage(): SecureStorage = DesktopSecureStorage()

private class DesktopSecureStorage : SecureStorage {
    private val prefs = Preferences.userRoot().node("com.mobius.momo.preview")

    override fun saveToken(token: String) {
        prefs.put("token", token)
    }

    override fun getToken(): String? = prefs.get("token", null)

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

actual fun nowShortTime(): String =
    SimpleDateFormat("HH:mm", Locale.getDefault()).format(Date())
