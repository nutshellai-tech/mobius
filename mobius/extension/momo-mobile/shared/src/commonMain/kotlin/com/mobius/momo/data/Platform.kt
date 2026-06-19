package com.mobius.momo.data

import io.ktor.client.HttpClient

interface SecureStorage {
    fun saveToken(token: String)
    fun getToken(): String?
    fun savePreference(key: String, value: String)
    fun getPreference(key: String): String?
    fun clear()
}

data class PickedFile(
    val name: String,
    val mimeType: String,
    val bytes: ByteArray,
)

interface FilePicker {
    fun pickFiles(
        maxFiles: Int,
        onResult: (List<PickedFile>) -> Unit,
        onError: (String) -> Unit,
    )
}

expect fun createSecureStorage(): SecureStorage

expect fun createFilePicker(): FilePicker

expect fun createMobiusHttpClient(
    onUnauthorized: suspend () -> Unit,
): HttpClient

expect fun nowShortTime(): String

expect fun formatBackendTime(value: String?): String
