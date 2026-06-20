# 小莫助理共享 Web 调试入口设计

## 目标

`https://cloud-17.agent-matrix.com/extension/momo-mobile/` 必须作为 Android/iOS 小莫助理的开发期可视化入口，真实反映当前共享 UI、业务逻辑、图标按钮、附件、分身、主题、语音输入和语音播报。

## 架构

Android/iOS 主工程保持现有稳定工具链，不因 Web 预览升级依赖。新增独立 `webPreview/` Gradle build，使用支持 Compose Multiplatform Web 的工具链，并把 `../shared/src/commonMain/kotlin` 直接注册为 commonMain 源目录。

因此三个入口共用：

- `MomoApp.kt`
- `MomoAppViewModel.kt`
- `MobiusApi.kt`
- domain models 和 composer state

Web 只实现平台差异：

- localStorage 存储登录 token 和偏好；
- 浏览器文件选择与二进制读取；
- 浏览器 HTTP/SSE 请求引擎；
- MediaRecorder 录音并调用现有服务端转写接口；
- Web Speech Synthesis 自动播报和单条重播；
- 浏览器本地时间格式；
- Web 版 logo painter。

## 部署

`webPreview` 的 production browser distribution 同步到 `frontend/dist/`，Mobius extension 正式 URL 继续保持不变。旧 `preview.js + preview.css` 调试实现保留到 `frontend/legacy/`，仅作为迁移排障入口，不再是产品事实源。

## 平台一致性

完全共享：

- 页面结构、文案、图标和按钮；
- 登录、会话、消息、附件和分身逻辑；
- 主题和设置；
- 自动播报触发条件、voice marker 处理；
- loading、错误、录音状态和发送条件。

平台实现不同但语义一致：

- Android 使用 MediaRecorder + Android TTS；
- iOS 使用 AVFoundation/Speech；
- Web 使用 MediaRecorder + SpeechSynthesis；
- 文件选择和安全存储分别使用平台原生能力。

## 验收

- Web distribution 从 shared commonMain 编译，禁止独立复制 `MomoApp` 或 ViewModel。
- 正式 extension URL 加载 Compose Canvas/Wasm 产物。
- 登录、消息发送、SSE、附件、分身、主题、录音转写、自动播报可在浏览器验证。
- Android/iOS 原工程的现有测试和构建契约不因 Web 工具链改变。
- README 明确 Web 是调试入口，Android/iOS 是最终发布平台。
