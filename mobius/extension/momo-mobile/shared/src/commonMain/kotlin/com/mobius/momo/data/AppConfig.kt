package com.mobius.momo.data

const val SERVER_BASE_URL_PREFERENCE = "server_base_url"

fun normalizeMobiusBaseUrl(value: String): String {
    val normalized = value.trim().trimEnd('/')
    if (normalized.isBlank()) return ""
    require(normalized.startsWith("https://") || normalized.startsWith("http://")) {
        "服务器地址必须以 http:// 或 https:// 开头"
    }
    return normalized
}

fun resolveMobiusBaseUrl(buildDefault: String, savedValue: String?): String =
    normalizeMobiusBaseUrl(savedValue?.takeIf { it.isNotBlank() } ?: buildDefault)

expect fun platformBuildBaseUrl(): String
