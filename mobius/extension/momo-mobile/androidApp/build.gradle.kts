plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.multiplatform)
    alias(libs.plugins.compose.multiplatform)
    alias(libs.plugins.compose.compiler)
}

val releaseKeystorePath = providers.gradleProperty("MOMO_ANDROID_KEYSTORE_PATH")
    .orElse(providers.environmentVariable("MOMO_ANDROID_KEYSTORE_PATH"))
val releaseKeystorePassword = providers.gradleProperty("MOMO_ANDROID_KEYSTORE_PASSWORD")
    .orElse(providers.environmentVariable("MOMO_ANDROID_KEYSTORE_PASSWORD"))
val releaseKeyAlias = providers.gradleProperty("MOMO_ANDROID_KEY_ALIAS")
    .orElse(providers.environmentVariable("MOMO_ANDROID_KEY_ALIAS"))
val releaseKeyPassword = providers.gradleProperty("MOMO_ANDROID_KEY_PASSWORD")
    .orElse(providers.environmentVariable("MOMO_ANDROID_KEY_PASSWORD"))
val releaseSigningAvailable = listOf(
    releaseKeystorePath,
    releaseKeystorePassword,
    releaseKeyAlias,
    releaseKeyPassword,
).all { it.isPresent }

kotlin {
    androidTarget()

    sourceSets {
        androidMain.dependencies {
            implementation(project(":shared"))
            implementation(compose.runtime)
            implementation(compose.foundation)
            implementation(compose.material3)
            implementation(libs.androidx.activity.compose)
        }
    }
}

android {
    namespace = "com.mobius.momo"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.mobius.momo"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    signingConfigs {
        if (releaseSigningAvailable) {
            create("release") {
                storeFile = file(releaseKeystorePath.get())
                storePassword = releaseKeystorePassword.get()
                keyAlias = releaseKeyAlias.get()
                keyPassword = releaseKeyPassword.get()
            }
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            if (releaseSigningAvailable) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }
}
