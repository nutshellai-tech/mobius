# 小莫助理移动端

Kotlin Multiplatform + Compose Multiplatform 版小莫助理移动客户端。工程放在
`mobius/extension/momo-mobile/`，同时也是一个 Mobius extension 项目，便于在
Mobius 里看到、进入和继续开发。

## 范围

第一版覆盖：

- 登录：直接采用 Mobius 账号系统，读取 `/api/auth/config` 判断是否需要密码，
  再调用 `/api/auth/login` 获取 JWT。
- 我的主小莫：HTTP 发送消息，SSE 接收 history、typing、jsonl_entry 和 server_error。
- 分身列表：读取小莫会话，创建分身 Session，并用 `/api/sessions/:id/messages` 启动。
- 设置：暗色模式、推送/播报开关占位、账号信息和退出登录。

当前版本已经支持按住说话、服务端语音识别、图片/普通文件附件上传，以及文字/语音
输入模式切换。暂不做推送通知、文件管理、离线附件缓存和多账号切换。

## 目录

```text
momo-mobile/
├── extension.json
├── backend/extension_backend_handler.js
├── frontend/                 # Mobius extension 的说明页
├── shared/                   # KMP shared module
│   └── src/commonMain/kotlin/com/mobius/momo/
│       ├── data/             # Ktor client、SSE、SecureStorage 抽象
│       ├── domain/           # User、Project、Issue、Session、Message
│       ├── ui/               # Compose 主题、页面和组件
│       └── viewmodel/        # StateFlow 状态管理
├── androidApp/               # Android applicationId com.mobius.momo
├── iosApp/                   # iOS Swift 壳入口
└── desktopPreview/           # Linux/macOS/Windows 桌面预览，复用 commonMain
```

## API 与服务器地址

正式应用不再把 `https://mobius.example.com` 作为固定服务端。服务器地址按以下顺序
解析：

1. 用户在“设置 → 服务器”中保存的地址；
2. 构建参数或运行环境中的 `MOMO_BASE_URL`；
3. 空值。此时登录页会引导用户先配置服务器地址。

Android/CI 构建时可以使用：

```bash
./gradlew -PMOMO_BASE_URL=https://mobius.your-domain.example :androidApp:assembleDebug
```

桌面端也可以在运行时使用环境变量 `MOMO_BASE_URL` 或 JVM 参数
`-Dmomo.base.url=https://mobius.your-domain.example`。服务器地址不是密码或 token，
可以存放为 GitHub repository variable；登录密码、JWT 和 API key 不会编译进客户端。

主要接口：

- `POST /api/auth/login`
- `GET /api/auth/me`
- `GET /api/assistant/workspace`
- `POST /api/assistant/messages`
- `GET /api/assistant/sessions`
- `GET /api/sessions/:id/events`
- `POST /api/issues/:issueId/sessions/`
- `POST /api/sessions/:id/messages`

注意：当前 Mobius 账号系统没有 `/api/auth/challenge`。客户端不再做 salt/challenge
兼容，始终以 Mobius `/api/auth/config` 和 `/api/auth/login` 为准；cloud-17 当前返回
`password_required=false`，输入用户名即可登录。

## 安全存储

- Android：`EncryptedSharedPreferences`。
- iOS：当前 Linux 环境无法验证 Keychain cinterop，先通过 `SecureStorage`
  抽象接入 `NSUserDefaults` 可运行实现；替换点是
  `shared/src/iosMain/kotlin/com/mobius/momo/Platform.ios.kt`。

## 构建环境

- Java 17；
- 项目自带 Gradle 8.8 Wrapper；
- Android SDK 35 和 Build Tools；
- Windows EXE/MSI 必须在 Windows 构建；
- macOS DMG 和 iOS Simulator `.app` 必须在 macOS/Xcode 构建；
- iOS 工程生成还需要 XcodeGen。

所有命令都从本目录执行，不依赖全局 Gradle。

### Android

```bash
./gradlew --no-daemon :shared:allTests
./gradlew --no-daemon :androidApp:test
./gradlew --no-daemon :androidApp:assembleDebug
```

Debug APK：

```text
androidApp/build/outputs/apk/debug/androidApp-debug.apk
```

Release 只有在 `MOMO_ANDROID_KEYSTORE_PATH`、`MOMO_ANDROID_KEYSTORE_PASSWORD`、
`MOMO_ANDROID_KEY_ALIAS` 和 `MOMO_ANDROID_KEY_PASSWORD` 全部存在时才签名。GitHub
Actions 接受 Base64 keystore secret 并在 runner 临时目录解码；仓库不保存 keystore。

### Windows 和 macOS 正式桌面应用

正式入口是 `desktopApp`，直接显示 `MomoApp()`，不会显示 `desktopPreview` 的刘海、
状态栏和 Home indicator。

Windows：

```powershell
.\gradlew.bat --no-daemon :shared:desktopTest :desktopApp:desktopTest
.\gradlew.bat --no-daemon :desktopApp:createDistributable :desktopApp:packageExe :desktopApp:packageMsi
```

macOS：

```bash
./gradlew --no-daemon :desktopApp:createDistributable :desktopApp:packageDmg
```

Compose Desktop 的 macOS 打包工具不接受主版本号为 0，因此应用产品版本仍为
`0.1.0`，DMG package version 使用 `1.0.0`。

桌面端当前语音识别是可见的 mock 流程，TTS 是空实现；文件选择器使用系统
`JFileChooser`。这些限制与安装包构建成功是两个独立概念。

### iOS Simulator

Apple Silicon：

```bash
./gradlew --no-daemon :shared:linkDebugFrameworkIosSimulatorArm64
```

Intel：

```bash
./gradlew --no-daemon :shared:linkDebugFrameworkIosX64
```

复制 `MomoShared.framework` 到 `iosApp/Frameworks/`，运行
`xcodegen generate --spec project.yml`，再用 `CODE_SIGNING_ALLOWED=NO`
构建 Simulator `.app`。Simulator `.app` 的 ZIP 不是 IPA。

真机 IPA 需要 Team ID、Distribution `.p12`、`.p12` 密码、provisioning profile
和匹配的 bundle identifier。缺少任一材料时，CI 会明确跳过 IPA。

### GitHub Actions

`.github/workflows/momo-mobile-build.yml` 支持手动触发、PR、`main` push 和
`momo-mobile-v*` tag，生成：

- `momo-android-debug-apk-*`
- `momo-android-release-*`（仅有签名 secrets 时）
- `momo-windows-exe-*`
- `momo-windows-msi-*`
- `momo-macos-dmg-*`
- `momo-ios-simulator-app-*`
- `momo-ios-ipa-*`（仅有 Apple 签名 secrets 时）

每个 artifact 包含 `checksums.txt`。编译成功只说明代码和包结构可生成；发布签名
完成还要求有效证书、私钥和 provisioning profile。

## Desktop Preview

桌面预览用于没有 Android 模拟器或 Xcode 的开发机。安装 Java 17、Xvfb/noVNC
等本地预览工具后，可以启动可交互预览：

```bash
tmux kill-session -t momo_mobile_preview 2>/dev/null || true
tmux new-session -d -s momo_mobile_preview \
  $APP_DIR/mobius/extension/momo-mobile/desktopPreview/run-local-preview.sh
```

然后在浏览器打开：

```text
http://127.0.0.1:6088/vnc.html?host=127.0.0.1&port=6088&autoconnect=true&resize=scale
```

也可以走 Mobius 同域反代，适合远程网页验证。启动脚本会生成
`.tmp/momo-mobile-preview/access-token` 并在 tmux 日志里打印完整 URL：

```text
https://mobius.example.com/momo_mobile_preview/vnc.html?host=mobius.example.com&port=443&encrypt=1&path=momo_mobile_preview/websockify&autoconnect=true&resize=scale&preview_token=<access-token>
```

停止预览：

```bash
tmux kill-session -t momo_mobile_preview
```

它直接复用 `shared/src/commonMain` 中的 `MomoApp()`、ViewModel、Ktor/SSE
逻辑，只在 `desktopPreview/src/desktopMain` 提供 JVM 平台 actual 实现。

### Tier 1：设备外观预览

Desktop Preview 使用固定的 430×900dp 设备画布，并模拟：

- 47dp 圆角设备外框和 4dp 黑色边框；
- 47dp 顶部安全区、200×30dp 刘海和每分钟刷新的状态栏；
- 使用 Compose `Path` 绘制的 Wi-Fi、电池图标；
- 34dp 底部安全区和 134×5dp Home indicator。

运行尺寸契约测试与编译检查：

```bash
cd mobius/extension/momo-mobile/desktopPreview
JAVA_HOME="$APP_DIR/.tmp/tools/jdk-deb/usr/lib/jvm/java-17-openjdk-amd64" \
  "$APP_DIR/.tmp/tools/gradle/gradle-8.8/bin/gradle" \
  --no-daemon desktopTest compileKotlinDesktop
```

### Tier 2：GitHub Actions 真模拟器截图

仓库级 workflow 位于：

```text
.github/workflows/momo-mobile-screenshot-verify.yml
```

GitHub 只加载仓库根目录下的 workflows，因此不能把可执行 YAML 放在 extension
内部。该 workflow 可通过 `workflow_dispatch` 手动运行，也会在 PR 修改以下目录时运行：

- `mobius/extension/momo-mobile/shared/**`
- `mobius/extension/momo-mobile/androidApp/**`
- `mobius/extension/momo-mobile/iosApp/**`

Android job 使用 Pixel 6 / API 34 无窗口模拟器，iOS job 使用 iPhone 15 Pro
Simulator。两者都会安装并启动应用、等待界面稳定、生成 PNG，并通过
`actions/upload-artifact@v4` 上传。

iOS 模拟器构建使用 `iosApp/project.yml` 通过 XcodeGen 生成临时
`iosApp.xcodeproj`。模拟器构建关闭代码签名，因此不需要 Apple Developer Team ID
或签名 secret；发布到真机或 App Store 时仍需另行配置 Team、证书和 provisioning
profile。

#### 首次建立基线

仓库不使用 Desktop Preview 或占位图片冒充真实平台基线。第一次运行时，如果
`screenshots/baseline/android.png` 或 `ios.png` 不存在，workflow 会把本次截图上传为
baseline candidate artifact：

```text
android-baseline-candidate-<run-id>
ios-baseline-candidate-<run-id>
```

下载并人工确认两张图片后，将它们分别提交到：

```text
mobius/extension/momo-mobile/screenshots/baseline/android.png
mobius/extension/momo-mobile/screenshots/baseline/ios.png
```

后续运行会用 ImageMagick `compare -metric AE` 统计不同像素。不同像素比例超过
5% 时，对应 job 失败；无论比较结果如何，当次截图都会作为 artifact 上传，便于审查。

## 设计对齐

参考设计稿：

- `tmp/01-login-light.png` / `tmp/02-login-dark.png`
- `tmp/03-home-light.png` / `tmp/04-home-dark.png`
- `tmp/05-list-light.png` / `tmp/06-list-dark.png`
- `tmp/07-settings-light.png` / `tmp/08-settings-dark.png`

实现采用微信式布局：顶部 56dp、输入栏 72dp、头像 36dp、气泡圆角 4/12dp、
品牌色 `#5B6CFF` 只用于主按钮、用户气泡和状态高亮。小莫头像使用与 Web 主站一致的
光场圆环视觉；输入栏文字模式为“附件 + 输入框 + 语音切换 + 发送”，语音模式为
“附件 + 按住说话 + 键盘切换”。
