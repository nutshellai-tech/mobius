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

## API

默认基础 URL 是：

```text
https://mobius.example.com
```

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

## 构建

当前机器没有 JDK、Android SDK 和 Xcode，无法在本机完成真实移动端构建。具备
移动端环境后：

```bash
cd mobius/extension/momo-mobile
./gradlew :androidApp:assembleDebug
./gradlew :shared:embedAndSignAppleFrameworkForXcode
```

如果没有 Gradle wrapper，可在 Android Studio 中直接打开本目录，让 IDE 使用本机
Gradle/JDK 同步；或先在有 Java 的机器上执行：

```bash
gradle wrapper --gradle-version 8.8
```

桌面预览用于没有 Android 模拟器或 Xcode 的开发机。当前 imac-test 机器已把
JDK、Gradle、TigerVNC、noVNC 和 `proot` 安装到项目局部目录 `.tmp/tools/`
下，不需要 sudo。启动可交互预览：

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
