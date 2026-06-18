package com.mobius.momo.data

import android.content.Context
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
import java.util.Date
import java.util.Locale

object AndroidContext {
    lateinit var application: Context
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

        override fun clear() {
            prefs.edit().clear().apply()
        }
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
