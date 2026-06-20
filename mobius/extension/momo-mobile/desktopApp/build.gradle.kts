import org.jetbrains.compose.desktop.application.dsl.TargetFormat

plugins {
    alias(libs.plugins.kotlin.multiplatform)
    alias(libs.plugins.compose.multiplatform)
    alias(libs.plugins.compose.compiler)
}

kotlin {
    jvm("desktop")

    sourceSets {
        val desktopMain by getting {
            dependencies {
                implementation(project(":shared"))
                implementation(compose.desktop.currentOs)
            }
        }
        val desktopTest by getting {
            dependencies {
                implementation(kotlin("test"))
            }
        }
    }
}

compose.desktop {
    application {
        mainClass = "com.mobius.momo.desktop.MainKt"

        nativeDistributions {
            targetFormats(TargetFormat.Exe, TargetFormat.Msi, TargetFormat.Dmg)
            packageName = "MomoAssistant"
            packageVersion = "0.1.0"
            description = "小莫助理"
            vendor = "Mobius"
            includeAllModules = true

            windows {
                menuGroup = "Mobius"
                shortcut = true
                dirChooser = true
                perUserInstall = true
            }

            macOS {
                bundleID = "com.mobius.momo.desktop"
                dockName = "小莫助理"
                // Apple's package tooling rejects a zero major version. The
                // product version remains 0.1.0; this is the DMG package version.
                packageVersion = "1.0.0"
                dmgPackageVersion = "1.0.0"
            }
        }
    }
}
