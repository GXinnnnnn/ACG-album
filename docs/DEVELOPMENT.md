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

## 验证范围与运行约定

- 根据改动选择检查范围，记录本轮实际执行与通过的项目；以对应 Release 的 `VALIDATION_REPORT.md` 说明正式产物的验证结果，历史结果不能代替本轮验收。
- GUI、构建与性能脚本串行运行，使用隔离资料和生成素材；检查脚本中的目标路径后再执行。
- `check-installer.cjs` 涉及临时安装与卸载，不能在已有同名正式安装的机器上直接运行。解包和隔离启动通过不等于真实 UAC、注册表与重启流程通过。
- 十万文件占位用例只测文件系统索引与数据库响应，不代表真实图片解码或联网同步速度，也不能外推百万真实图片的处理时间。复现范围见 [性能说明](PERFORMANCE.md)。
- 媒体格式、解码预算、动画及视频限制见 [媒体兼容说明](MEDIA_COMPATIBILITY.md)，不承诺任意图库规模、固定启动耗时或固定 4K 帧率。

版本变化保留在 [更新记录](CHANGELOG.md) 与对应版本说明中；面向用户的项目介绍只描述当前功能。
