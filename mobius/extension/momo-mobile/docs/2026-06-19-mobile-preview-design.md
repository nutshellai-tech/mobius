# momo-mobile 双层移动端模拟设计

## 目标

为 `momo-mobile` 提供两层视觉验证：

1. `desktopPreview` 在本地快速呈现设备外框、安全区、状态栏、刘海和 Home indicator。
2. GitHub Actions 在 Android Emulator 与 iOS Simulator 中生成真实平台截图，并在基线存在时执行像素差异门禁。

## Tier 1：Desktop Preview

`DevicePreviewSpec` 集中定义 430×900dp 画布、47dp 顶部安全区、34dp 底部安全区、47dp 设备圆角、4dp 边框、200×30dp 刘海和 134×5dp Home indicator。`Main.kt` 只负责组合设备壳、状态栏、`MomoApp()` 和 Home indicator。

状态栏使用 `Canvas` 和 `Path` 绘制 Wi-Fi 与电池，不使用 emoji。时间按本地时区显示 `HH:mm`，并在每个分钟边界刷新。设备壳使用黑色背景，状态栏为白色；应用内容保持 `MomoApp()` 原有主题。

## Tier 2：真实模拟器截图

Android job 使用 API 34 Google APIs x86_64 镜像、Pixel 6 AVD、Gradle 8.8 和无窗口模拟器。它安装 `androidApp` debug 包、启动 `com.mobius.momo/.MainActivity`，等待 UI 稳定后截取 PNG。

iOS job 使用 macOS 14、XcodeGen 和现有 Swift 壳生成最小 Xcode project。Gradle 先为模拟器构建 `MomoShared` framework，Xcode 再构建、安装并启动 `com.mobius.momo.iosApp`，随后通过 `simctl` 截图。

每个平台始终上传当前截图。若对应基线存在，则使用 ImageMagick 计算绝对差异像素比例，超过 5% 时失败；若基线不存在，则把本次截图复制到 Actions 工作区的 `screenshots/baseline/` 并上传为 `baseline-candidates` artifact，供人工审阅后提交。CI 不自动向仓库写回基线。

## 边界

- 不修改 `shared/`、`androidApp/` 或现有 `iosApp/iosApp/` UI 源码。
- 不依赖 Apple Developer Team；模拟器构建关闭代码签名。
- 本机只验证 Desktop Preview。真实 Android/iOS job 由 GitHub hosted runners 验证。
- 基线必须来自真实模拟器截图，不提交占位 PNG。

## 验收

- Desktop Preview 编译并显示设备框、刘海、状态栏、应用内容和 Home indicator。
- Workflow YAML 可解析，路径触发规则覆盖 `shared/**`、`androidApp/**` 和 `iosApp/**`。
- Android 与 iOS job 均上传截图，基线存在时启用 5% 差异门禁。
- README 记录本地预览、手动触发、首次基线建立和后续比较流程。
