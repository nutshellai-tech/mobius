@file:OptIn(org.jetbrains.kotlin.gradle.ExperimentalWasmDsl::class)

plugins {
    kotlin("multiplatform") version "2.3.20"
    kotlin("plugin.serialization") version "2.3.20"
    id("org.jetbrains.kotlin.plugin.compose") version "2.3.20"
    id("org.jetbrains.compose") version "1.11.1"
}

kotlin {
    wasmJs {
        outputModuleName = "momo-web-preview"
        browser {
            commonWebpackConfig {
                outputFileName = "momo-web-preview.js"
            }
        }
        binaries.executable()
    }

    sourceSets {
        commonMain {
            kotlin.srcDir("../shared/src/commonMain/kotlin")
            dependencies {
                implementation(compose.runtime)
                implementation(compose.foundation)
                implementation(compose.material3)
                implementation(compose.ui)
                implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.10.2")
                implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
                implementation("io.ktor:ktor-client-core:3.5.0")
                implementation("io.ktor:ktor-client-content-negotiation:3.5.0")
                implementation("io.ktor:ktor-client-logging:3.5.0")
                implementation("io.ktor:ktor-serialization-kotlinx-json:3.5.0")
            }
        }
        wasmJsMain.dependencies {
            implementation("io.ktor:ktor-client-cio:3.5.0")
        }
    }
}
