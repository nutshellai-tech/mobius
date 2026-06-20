import org.jetbrains.compose.desktop.application.dsl.TargetFormat

plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.compose.multiplatform)
    alias(libs.plugins.compose.compiler)
}

dependencies {
    implementation(project(":shared"))
    implementation(compose.desktop.currentOs)
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
            }
        }
    }
}
