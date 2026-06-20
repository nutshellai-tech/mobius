# momo-mobile 双层移动端模拟实施计划

**目标：** 增强 Desktop Preview，并增加 Android/iOS 真模拟器截图与基线差异门禁。

**架构：** Desktop Preview 以纯尺寸规格和三个可组合 Composable 构建设备壳。CI 使用两个独立 job 生成真实截图，并用同一套 shell 逻辑处理首次基线与 5% 像素差异。

**技术栈：** Kotlin 2.0、Compose Multiplatform 1.6.11、Gradle 8.8、GitHub Actions、Android Emulator、XcodeGen、iOS Simulator、ImageMagick。

## 全局约束

- 不使用 git worktree。
- 不修改 `shared/`、`androidApp/` 和现有 iOS UI 源码。
- 不创建更多小莫 Session。
- 不提交构建缓存、日志或模拟器产物。

## Task 1：Desktop Preview 设备壳

- [ ] 先增加 `DevicePreviewSpecTest.kt`，验证窗口、安全区、刘海和 Home indicator 尺寸契约。
- [ ] 运行测试并确认因 `DevicePreviewSpec` 不存在而失败。
- [ ] 增加 `DevicePreviewSpec.kt`、`StatusBar.kt`、`HomeIndicator.kt`，修改 `Main.kt` 完成组合。
- [ ] 运行 desktop test 与 `compileKotlinDesktop`。

## Task 2：模拟器截图 Workflow

- [ ] 增加 `iosApp/project.yml`，用 XcodeGen 包装现有 Swift 入口和 KMP framework。
- [ ] 增加 `.github/workflows/screenshot-verify.yml`，实现 Android/iOS 构建、启动、截图、artifact 和基线比较。
- [ ] 使用 Ruby YAML parser 校验 workflow 语法，并静态检查关键命令和触发路径。

## Task 3：文档与视觉验收

- [ ] 更新根 README，说明 Tier 1、Tier 2、首次基线建立和 5% 门禁。
- [ ] 启动 `run-local-preview.sh`，通过 noVNC/Playwright 截图并检查设备框、刘海、状态栏和 Home indicator。
- [ ] 运行完整 Desktop Preview 测试与构建。
- [ ] 检查 git diff，提交全部代码变更。
- [ ] 运行 `python3 start.py` 更新 Mobius。
