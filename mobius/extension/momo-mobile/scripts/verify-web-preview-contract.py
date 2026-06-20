#!/usr/bin/env python3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "webPreview"
DIST = ROOT / "frontend" / "dist"
LEGACY = ROOT / "frontend" / "legacy"


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def main() -> None:
    build = (WEB / "build.gradle.kts").read_text(encoding="utf-8")
    require(
        '../shared/src/commonMain/kotlin' in build,
        "webPreview must compile shared/src/commonMain directly",
    )
    require("wasmJs" in build, "webPreview must use a wasmJs browser target")

    main = (WEB / "src/wasmJsMain/kotlin/com/mobius/momo/web/Main.kt").read_text(encoding="utf-8")
    require("MomoApp()" in main, "Web entry must mount the shared MomoApp")

    platform = (WEB / "src/wasmJsMain/kotlin/com/mobius/momo/data/Platform.web.kt").read_text(encoding="utf-8")
    for symbol in (
        "createSecureStorage",
        "createFilePicker",
        "createMobiusHttpClient",
        "platformBuildBaseUrl",
        "createSpeechRecognizer",
        "createTextToSpeech",
    ):
        require(symbol in platform, f"Web platform actual is missing {symbol}")

    index = (DIST / "index.html").read_text(encoding="utf-8")
    require("preview.js" not in index, "production extension must not load the legacy preview.js")
    require(
        ".wasm" in index or "composeApp.js" in index or "momo-web-preview.js" in index,
        "production extension must load a Kotlin/Wasm bootstrap",
    )

    require((LEGACY / "preview.js").is_file(), "legacy preview must remain available for migration diagnostics")
    print("momo-mobile shared web preview contract: PASS")


if __name__ == "__main__":
    main()
