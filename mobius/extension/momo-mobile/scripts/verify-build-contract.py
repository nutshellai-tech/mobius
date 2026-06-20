#!/usr/bin/env python3
from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parents[2]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def read(path: Path) -> str:
    require(path.is_file(), f"missing file: {path.relative_to(REPO_ROOT)}")
    return path.read_text(encoding="utf-8")


def main() -> int:
    require((ROOT / "gradlew").is_file(), "missing Gradle wrapper script")
    require((ROOT / "gradlew.bat").is_file(), "missing Windows Gradle wrapper script")
    require(
        (ROOT / "gradle/wrapper/gradle-wrapper.jar").is_file(),
        "missing Gradle wrapper jar",
    )
    properties = read(ROOT / "gradle/wrapper/gradle-wrapper.properties")
    require("gradle-8.8-bin.zip" in properties, "wrapper must use Gradle 8.8")

    settings = read(ROOT / "settings.gradle.kts")
    for module in (":shared", ":androidApp", ":desktopPreview", ":desktopApp"):
        require(
            re.search(rf'include\(\s*"{re.escape(module)}"\s*\)', settings) is not None,
            f"settings must include {module}",
        )

    android = read(ROOT / "androidApp/build.gradle.kts")
    require('applicationId = "com.mobius.momo"' in android, "Android applicationId changed")
    require('versionName = "0.1.0"' in android, "Android versionName must be 0.1.0")
    require("versionCode = 1" in android, "Android versionCode must be 1")

    desktop = read(ROOT / "desktopApp/build.gradle.kts")
    for target in ("TargetFormat.Exe", "TargetFormat.Msi", "TargetFormat.Dmg"):
        require(target in desktop, f"desktop native distribution missing {target}")
    require('packageVersion = "0.1.0"' in desktop, "desktop version must be 0.1.0")
    require("compose.desktop.currentOs" in desktop, "desktop must use currentOs dependency")

    plist = read(ROOT / "iosApp/iosApp/Info.plist")
    require("<string>0.1.0</string>" in plist, "iOS short version must be 0.1.0")
    require("<string>1</string>" in plist, "iOS build number must be 1")

    workflow = read(REPO_ROOT / ".github/workflows/momo-mobile-build.yml")
    for runner in ("ubuntu-22.04", "windows-2022", "macos-14"):
        require(runner in workflow, f"workflow missing runner {runner}")
    for artifact in (
        "momo-android-debug-apk",
        "momo-windows-exe",
        "momo-windows-msi",
        "momo-macos-dmg",
        "momo-ios-simulator-app",
    ):
        require(artifact in workflow, f"workflow missing artifact {artifact}")
    require("./gradlew" in workflow, "Unix jobs must use the project wrapper")
    require("gradlew.bat" in workflow, "Windows jobs must use the project wrapper")

    api = read(ROOT / "shared/src/commonMain/kotlin/com/mobius/momo/data/MobiusApi.kt")
    require(
        '"https://mobius.example.com"' not in api,
        "MobiusApi still hard-codes the placeholder base URL",
    )

    print("momo-mobile build contract: OK")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AssertionError as error:
        print(f"build contract failed: {error}", file=sys.stderr)
        raise SystemExit(1)
