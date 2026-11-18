# ACG-album 1.2.3

本版完善界面在不同显示环境下的文本适配与本地资源更新检查，继续保留个人外观选择、资料目录、人工关联和受支持的随包索引。

Standard、Lite、Full 使用相同应用功能，差异仅为随附资料。升级前正常退出程序，保留原资料目录与启动参数；安装目标应为程序目录，不能使用个人资料或原图目录。完整升级和本体更新的条件见 [安装与更新](INSTALLATION.md)。

第三方资源的版权、许可及来源见 [第三方声明](THIRD_PARTY_NOTICES.md)。本次实际验证项目及限制以发布随附的 `VALIDATION_REPORT.md` 为准，文件完整性以 `SHA256SUMS.txt` 为准。

## macOS Full 适配（待真实验证）

计划向现有 v1.2.3 Release（发布记录 ID `448449066`）追加单一 `ACG-album-Setup-1.2.3-Full-universal.dmg`，支持 Apple Silicon 与 Intel。Mac 不新增 Standard / Lite 或独立源码附件；完整索引、两架构 Sharp / libvips 与对应源码、许可，以及 HEIC / HEIF WASM 资源计划包含在同一 DMG 内。

最低系统目标为 macOS 12，依据 Electron 40.10.6 breaking changes 和固定 Chromium 144 源码依赖核对，仍须检查最终应用 `Info.plist` 与原生依赖并做真机验收。Mac 适配包含原生 Command / Dock 行为、默认 `Documents/ACG-album` 资料目录、不默认迁移 Windows 资料库，以及 Electron `safeStorage` 系统安全存储。

Mac 关闭 Windows 自动更新安装链路，后续通过发布页手动下载新 DMG，正常退出后替换 `.app`。应用计划采用 ad-hoc 签名，无 Developer ID、无 Apple 公证（notarization）；首次打开被系统拦截时，在核对来源与摘要后使用「系统设置 → 隐私与安全性」允许打开或 Finder 右键「打开」，不建议关闭 Gatekeeper。

**当前没有真实 Mac build、CI 成功记录、安装验收或已发布 DMG，也没有 Developer ID 签名与公证结果。** 构建脚本与工作流仅表示预定构建和检查入口；最终产物、最低系统声明、双架构原生模块、离线检索、HEIC 解码及源码 / 许可交付均待实际验证。Windows 已有报告不覆盖 Mac。步骤见 [安装说明](INSTALLATION.md#macos-full-完整包待真实验证) 和 [构建说明](../BUILDING.md)。
