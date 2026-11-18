# 开发与构建

本文面向开发者。软件功能与下载入口见 [项目介绍](../README.md)，普通用户的安装、升级和备份步骤见 [安装说明](INSTALLATION.md)。

## 环境与启动

建议使用 Windows x64、Node.js 24 和 pnpm 11。当前主要依赖为 Electron 40.10.6、Sharp 0.34.5、exifr 7.1.3；索引使用 SQLite WAL 与 trigram FTS5。模块分工见 [项目结构](PROJECT_LAYOUT.md)。

```powershell
pnpm install --frozen-lockfile --ignore-scripts
node node_modules/electron/install.js
pnpm start
```

Electron 安装脚本会下载所需运行时。若环境设置了 `ELECTRON_RUN_AS_NODE`，启动 GUI 前需移除。开发时使用独立测试资料目录，不要把个人图库或正在使用的资料库作为测试夹具。

## 检查与基础构建

```powershell
pnpm test
pnpm run format:check
pnpm run package:dir
pnpm run package:installer
```

`package:installer` 构建基础程序，不会自动下载离线资料库。构建默认使用 `--publish never`，提交源码不会自动发布安装包。

## 构建三种发行版

| 目标 | 构建命令 | 隔离验收命令 |
| --- | --- | --- |
| Standard | `pnpm run package:standard` | `pnpm run verify:standard` |
| Lite / Full | `pnpm run package:search` | `pnpm run verify:search` |

Lite / Full 构建读取预处理的 Archive 数据与校验清单。先按 [本地检索数据说明](LOCAL_SEARCH_DATA.md) 准备数据，再通过 `ACG_INDEX_SOURCE` 指定目录。源码仓库不包含大型数据库、安装包、个人图库或维护者的完整诊断报告。

所有构建统一排除专有字体二进制；获准分发的字体与完整许可按原样随应用提供。分发包含原生组件的二进制时，需同时履行许可通知和对应源码提供义务，见 [第三方声明](THIRD_PARTY_NOTICES.md) 及源码中的 `src/assets/licenses/`。

## macOS 开发与 Full 构建目标

Mac 适配以 Electron 40.10.6 为基础，最低系统目标为 macOS 12.0，覆盖 Apple Silicon 与 Intel。开发使用原生 macOS、Node.js 24 和 pnpm 10.11.0（与 Mac 工作流固定版本一致）；正式包只有 `ACG-album-Setup-1.2.3-Full-universal.dmg`。当前没有真实 Mac build / CI 验收或已发布 DMG，不能把源码检查或 Windows 结果表述为 Mac 成品通过。

Mac 构建、资源与证据步骤见仓库根 [构建说明](../BUILDING.md#macos-单-full-universal-dmg待真实验证)。入口为 `scripts/build-mac-full.cjs`、`scripts/check-mac-full.cjs`、`scripts/check-mac-filesystems.cjs`、`scripts/mac-support.cjs` 与 `.github/workflows/mac-full.yml`；构建脚本在原生 darwin 上运行，需要 `7zz`，默认使用全新的 `release/mac-1.2.3`。不使用 Windows `package:installer` / NSIS 生成 Mac 安装包。

```sh
pnpm install --frozen-lockfile --ignore-scripts
node --test tests/mac-*.test.cjs
node scripts/build-mac-full.cjs
# 在对应的原生 Intel / Apple Silicon Mac 上分别检查同一 DMG
ACG_MAC_EXPECT_ARCH=x64 node scripts/check-mac-full.cjs
ACG_MAC_EXPECT_ARCH=arm64 node scripts/check-mac-full.cjs
```

每个原生 CI runner 还计划在构建或成品验收前运行 `scripts/check-mac-filesystems.cjs`，设置匹配的 `ACG_MAC_EXPECT_ARCH=x64` 或 `arm64`。脚本先编译重命名 helper、执行全部 Mac 契约测试，再创建并检查真实 APFS / APFSX 卷，借助 `ACG_MAC_RENAME_HELPER` 与 `ACG_MAC_TEST_ROOT` 在两种卷上分别执行 Mac 数据测试。可用 `ACG_MAC_FS_EVIDENCE` 指定新的 JSON 证据路径；这些 CI 入口尚无实际运行结果。

Mac 测试应使用独立资料目录，保留默认系统「文稿 / Documents」下 `ACG-album`、显式 `ACG_DATA_DIR`、Windows 资料不默认迁移以及 `safeStorage` 系统安全存储的边界。窗口与快捷键适配需遵循原生 Command / Dock 行为；真机应检查 Command＋O 导入、Command＋逗号偏好设置、Command＋R 刷新、Command＋K 搜索、Command＋[ 返回、Command＋滚轮调整卡片，以及查看器中的 Command＋C 复制图片（输入框焦点下仍为文字复制）。Command＋W 关闭窗口后由 Dock 重开，Command＋Q 退出时完成后台 worker 收尾；这些目标均须实际运行验证。

Mac 关闭 Windows 自动下载安装、本体更新和 NSIS 安装事务，用户从发布页手动下载 DMG，正常退出后替换 `.app`。Full 索引、两种架构的 Sharp / libvips 与相应源码 / 许可、HEIC WASM 及其源码计划全部随一个 DMG 提供；最低系统声明、原生加载、离线功能、签名和分发完整性都须对实际成品验收。ad-hoc 签名没有 Developer ID 身份，也不代表通过 Apple 公证；详见 [安装说明](INSTALLATION.md#macos-full-完整包待真实验证) 和 [第三方声明](THIRD_PARTY_NOTICES.md)。

## 验证范围与运行约定

- 根据改动选择检查范围，记录本轮实际执行与通过的项目；以对应 Release 的 `VALIDATION_REPORT.md` 说明正式产物的验证结果，历史结果不能代替本轮验收。
- GUI、构建与性能脚本串行运行，使用隔离资料和生成素材；检查脚本中的目标路径后再执行。
- `check-installer.cjs` 涉及临时安装与卸载，不能在已有同名正式安装的机器上直接运行。解包和隔离启动通过不等于真实 UAC、注册表与重启流程通过。
- 十万文件占位用例只测文件系统索引与数据库响应，不代表真实图片解码或联网同步速度，也不能外推百万真实图片的处理时间。复现范围见 [性能说明](PERFORMANCE.md)。
- 媒体格式、解码预算、动画及视频限制见 [媒体兼容说明](MEDIA_COMPATIBILITY.md)，不承诺任意图库规模、固定启动耗时或固定 4K 帧率。

版本变化保留在 [更新记录](CHANGELOG.md) 与对应版本说明中；面向用户的项目介绍只描述当前功能。
