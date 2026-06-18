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
import platform.Foundation.NSDate
import platform.Foundation.NSDateFormatter
import platform.Foundation.NSUserDefaults

actual fun createSecureStorage(): SecureStorage = IosSecureStorage()

private class IosSecureStorage : SecureStorage {
    private val defaults = NSUserDefaults.standardUserDefaults

    override fun saveToken(token: String) {
        defaults.setObject(token, forKey = "momo.secure.token")
        defaults.synchronize()
    }

    override fun getToken(): String? =
        defaults.stringForKey("momo.secure.token")

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
