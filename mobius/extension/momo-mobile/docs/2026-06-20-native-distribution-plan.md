# 小莫助理原生分发实施计划

## 目标

把 `momo-mobile` 建设为可重复构建的 Kotlin Multiplatform 应用，并由原生
GitHub-hosted runner 生成 Android APK、Windows EXE/MSI、macOS DMG 和无签名
iOS Simulator `.app`。所有产物必须校验文件类型、大小和 SHA-256，下载后归档到
仓库根目录 `data/`。

## 全局约束

- 只在当前 `main` 分支工作，不使用 git worktree。
- Gradle 版本固定为 8.8，Java 版本固定为 17。
- Android applicationId 保持 `com.mobius.momo`。
- 三端应用版本保持 `0.1.0`，构建号保持 `1`。
- 正式桌面入口直接显示 `MomoApp()`，不显示 Desktop Preview 的设备外框。
- Windows 原生产物只能在 Windows runner 生成；DMG 和 iOS `.app` 只能在 macOS
  runner 生成。
- 没有签名 secrets 时，Android Debug 和 iOS Simulator 构建必须成功；不得生成假
  Release 包或假 IPA。
- `MOMO_BASE_URL` 是非敏感构建配置；运行时保存的用户配置优先于构建默认值。
- 不提交证书、keystore、provisioning profile、token、构建缓存或原生构建产物。
- 保留 Desktop Preview，并恢复 Android/iOS 真模拟器截图验证。

## Task 1：构建契约与 Gradle Wrapper

- 先增加静态构建契约测试，检查 Wrapper、模块、版本、原生格式和 workflow。
- 运行测试，确认它因缺少上述配置而失败。
- 加入 Gradle 8.8 Wrapper，并将 `desktopPreview`、`desktopApp` 纳入统一根工程。
- 再次运行静态测试，确认基础构建契约通过。

## Task 2：跨平台配置与正式桌面应用

- 为 Base URL 解析增加 commonTest，覆盖构建默认值、持久化覆盖、空值和尾部斜杠。
- 在 commonMain 增加配置模型，在各平台提供构建默认值。
- 把 JVM actual 实现放入 `shared/src/desktopMain`，由 Preview 和正式 Desktop 共用。
- 增加正式 `desktopApp`，配置 `Exe`、`Msi`、`Dmg` 和应用镜像，入口直接加载
  `MomoApp()`。
- 文档明确桌面语音识别为 mock、TTS 为空实现。

## Task 3：Android 构建与可选签名

- 保留 Debug 构建和测试。
- Android Release 签名只读取 `MOMO_ANDROID_*` Gradle property 或环境变量。
- 无签名材料时不执行 Release；有完整材料时构建 APK 和 AAB。
- CI 安装 Debug APK、启动登录页、执行包验证并生成 SHA-256。

## Task 4：iOS Simulator 与可选 IPA

- 使用 XcodeGen 生成工程，按 runner 架构构建 KMP framework。
- 关闭 Simulator 签名，生成、安装并启动真实 `.app`。
- 把 `.app` 打包为 ZIP，但不重命名为 IPA。
- 只有 Apple secrets 完整时才使用临时 keychain 执行 archive/export IPA。

## Task 5：GitHub Actions、文档和归档

- 恢复并兼容截图 workflow，统一改用项目 Wrapper。
- 增加 Android、Windows、macOS、iOS Simulator 和可选签名发布 jobs。
- 每个平台上传独立 artifact、日志和 `checksums.txt`。
- 更新 README，记录环境、命令、产物路径、Base URL 和签名边界。
- 推送 GitHub，等待原生 jobs 完成，下载 artifacts 到 `data/`。
- 校验真实文件类型、大小、SHA-256 和平台 smoke-test 结果。

