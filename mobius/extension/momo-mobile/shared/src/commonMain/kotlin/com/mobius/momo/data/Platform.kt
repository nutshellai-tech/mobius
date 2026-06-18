package com.mobius.momo.data

import io.ktor.client.HttpClient

interface SecureStorage {
    fun saveToken(token: String)
    fun getToken(): String?
    fun clear()
}

expect fun createSecureStorage(): SecureStorage

expect fun createMobiusHttpClient(
    onUnauthorized: suspend () -> Unit,
): HttpClient

expect fun nowShortTime(): String
