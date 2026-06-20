# 小莫助理共享 Web 调试入口实施计划

## Task 1：构建契约测试

- [ ] 增加脚本测试，要求 `webPreview` 直接引用 shared commonMain。
- [ ] 要求正式 `frontend/dist` 包含 Wasm/JS bootstrap，不再引用 legacy `preview.js`。
- [ ] 要求 Web 平台实现覆盖存储、文件、HTTP、录音和 TTS。
- [ ] 先运行测试并确认因 Web Preview 尚不存在而失败。

## Task 2：独立 Web Preview build

- [ ] 新增独立 Gradle settings/build。
- [ ] 配置 wasmJs browser target 和 Compose Web distribution。
- [ ] 直接注册 `../shared/src/commonMain/kotlin`。
- [ ] 增加浏览器入口并挂载同一个 `MomoApp()`。

## Task 3：浏览器平台 actual

- [ ] 实现 localStorage 和基础 URL。
- [ ] 实现浏览器文件选择。
- [ ] 配置 Ktor Web/Wasm HTTP 客户端。
- [ ] 实现 MediaRecorder 音频事件。
- [ ] 实现 SpeechSynthesis TTS。
- [ ] 实现时间格式和 logo painter。

## Task 4：extension 正式入口

- [ ] 将旧前端复制到 `frontend/legacy/`。
- [ ] 增加 production distribution 同步脚本。
- [ ] 生成并提交 `frontend/dist`。
- [ ] 更新 README 和构建 workflow。

## Task 5：验证与上线

- [ ] 运行 Web 构建契约测试。
- [ ] 运行 Web production build。
- [ ] 运行 shared desktop tests，确认原生共享代码未回归。
- [ ] 本地启动 Mobius 并用浏览器验证正式 extension URL。
- [ ] 提交全部工作区变更，运行 `python3 start.py`。
- [ ] 验证 cloud-17 正式 URL。
