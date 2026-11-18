# 构建与分发

## 构建入口

正式三版构建及验收入口：

```powershell
pnpm run package:standard
pnpm run package:search
pnpm run verify:standard
pnpm run verify:search
```

Standard 不附带离线数据库；Lite / Full 需准备 `ACG_INDEX_SOURCE`，详见 [本地数据说明](docs/LOCAL_SEARCH_DATA.md)。基础 `package:dir`、`package:installer` 和正式三版、运行时本体载荷执行同一字体分发边界：不包含专有字体二进制。获准分发的字体与完整许可作为应用资源提供；第三方许可和来源记录见 [第三方声明](docs/THIRD_PARTY_NOTICES.md)。用户已安装字体仅通过系统调用，不从应用目录的旧副本加载。

构建配置沿用 `package.json` 的基础资源映射，仅传必要覆盖项，避免重复合并 `extraResources` 或 `extraFiles`。三版应来自同一份冻结的源码与文档；逐一验收最终安装载荷、实际离线检索、完整文件校验以及没有本机指定字体时的显示。正式附件名称以构建清单为准，不把旧文件改名充当新构建。

## macOS 单 Full universal DMG（待真实验证）

Mac 仅构建 `ACG-album-Setup-1.2.3-Full-universal.dmg`，一个完整包覆盖 Apple Silicon（arm64）和 Intel（x64），计划追加到现有 v1.2.3 Release（ID `448449066`）。Windows 三版入口继续独立使用。**当前尚无真实 Mac 构建、CI 成功记录、安装验收或已发布 DMG；以下为构建目标与预期检查步骤。**

### 工具、输入与命令

使用原生 macOS 构建环境、Node.js 24、pnpm 10.11.0（与 Mac 工作流固定版本一致）、Xcode Command Line Tools 及 PATH 中的 `7zz`。命令从仓库根目录执行。最低运行系统目标为 macOS 12.0：[Electron 40.10.6 breaking changes](https://github.com/electron/electron/blob/v40.10.6/docs/breaking-changes.md) 明确 Electron 38 及以后要求 macOS 12，其 [固定 DEPS](https://github.com/electron/electron/blob/v40.10.6/DEPS) 指向 Chromium 144.0.7559.236，对应 [mac_sdk.gni](https://chromium.googlesource.com/chromium/src/+/refs/tags/144.0.7559.236/build/config/mac/mac_sdk.gni) 的 deployment target / minimum system version 均为 12.0。最终仍需读取成品 `Info.plist` 的 `LSMinimumSystemVersion`，并核对原生依赖与真机运行结果。

```sh
pnpm install --frozen-lockfile --ignore-scripts
node --test tests/mac-*.test.cjs
node scripts/build-mac-full.cjs
```

构建前还应在每台原生 Mac 上运行文件系统检查：Intel 使用 `ACG_MAC_EXPECT_ARCH=x64 node scripts/check-mac-filesystems.cjs`，Apple Silicon 使用 `ACG_MAC_EXPECT_ARCH=arm64 node scripts/check-mac-filesystems.cjs`。该脚本编译实际重命名 helper，运行全部 `tests/mac-*.test.cjs`，再创建临时 APFS 与区分大小写的 APFSX 卷，确认卷的实际大小写行为后分别运行 `mac-data*.test.cjs`；通过 `ACG_MAC_RENAME_HELPER` 与 `ACG_MAC_TEST_ROOT` 向测试传入 helper 和隔离资料位置。`ACG_MAC_FS_EVIDENCE` 可指定新的 JSON 证据路径。CI 已配置这些入口，真实运行结果仍待验证。

`build-mac-full.cjs` 仅允许在 darwin 上运行，不接受 Windows 交叉构建。默认输出为全新的 `release/mac-1.2.3`；已有目录会拒绝覆盖，需要保留旧证据并选择新的目录，可通过 `ACG_MAC_OUTPUT` 指定 `release/` 下的新子目录。`ACG_MAC_7ZIP` 可指定 `7zz` 路径。首次构建需要联网下载固定输入；脚本的来源记录与完整性检查不能替代最终成品验收。

脚本从现有 1.2.3 Full Windows 安装包中选择性提取已经固定身份的只读索引，核对安装包及数据库大小 / SHA-256，不执行或复制 Windows 运行载荷。依赖按锁文件完整性准备 macOS arm64 / x64 的 Sharp 与 libvips；由 `mac-support.cjs` 定义平台包、资源映射、最低系统目标和 universal 合并规则。Full 数据库目标是在合并后的 `.app` 中只保留一份，位于 ASAR 外。

### 预期资源与分发边界

| 内容                                         | 最终应用内的预期位置                                                                               |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 完整只读索引与来源                           | `ACG-album.app/Contents/Resources/local-index/`                                                    |
| HEIC / HEIF 工厂、WASM、来源、许可与对应源码 | `ACG-album.app/Contents/Resources/codecs/libheif/`，源码在其 `sources/` 下                         |
| 两架构 Sharp / libvips 原生模块              | `ACG-album.app/Contents/Resources/app.asar.unpacked/node_modules/@img/`                            |
| macOS 原生组件的对应源码、构建材料与清单     | `ACG-album.app/Contents/Resources/native-sources/` 下的 `shared/` 与 `darwin/`                     |
| Mac 文件系统重命名辅助程序与应用源码         | `ACG-album.app/Contents/Resources/bin/acg-fs-rename`；源码 `src/native/macos-rename.c` 随应用 ASAR |
| macOS 原生包原始许可与清单                   | `ACG-album.app/Contents/Resources/licenses/mac-runtime/`                                           |
| 其他应用许可与获准分发字体                   | 应用 ASAR 内 `src/assets/licenses/` 与 `src/assets/fonts/source-han-sans/`                         |
| 项目许可、README 与用户文档                  | `ACG-album.app/Contents/` 下相应文件与 `docs/`                                                     |

Sharp / libvips 的 macOS 对应源码须覆盖实际使用的组件、构建树、补丁及所需依赖；Windows 对应源码不能代替 Mac 对应源码。HEIC WASM 与其源码继续随包提供。上述内容全部计划放入同一 Full DMG，不另增 Mac Standard / Lite、架构拆分包或独立源码附件；是否齐全必须以最终 DMG 检查为准。保留思源黑体及 OFL，排除专有字体二进制。

应用签名目标为 ad-hoc，没有 Developer ID 与 Apple 公证（notarization）；DMG 本身不作 Developer ID 签名。首次系统拦截的用户操作见 [安装说明](docs/INSTALLATION.md#macos-full-完整包待真实验证)。ad-hoc 结构签名检查不等于 Gatekeeper 信任或公证通过。

### 同一成品的双架构验收与发布

构建后，将同一 DMG 及其配套 `build-report.json`、`SHA256SUMS.mac.txt` 放入两台原生 Mac 的相应输出目录。以下命令分别在匹配架构的原生 Node.js 环境执行，GUI 和构建检查串行：

```sh
# Intel Mac
ACG_MAC_EXPECT_ARCH=x64 node scripts/check-mac-full.cjs
# Apple Silicon Mac
ACG_MAC_EXPECT_ARCH=arm64 node scripts/check-mac-full.cjs
```

如构建使用自定义目录，检查时设置相同的 `ACG_MAC_OUTPUT`；`ACG_MAC_EVIDENCE` 可指定新的验收证据目录。`check-mac-full.cjs` 的目标包括挂载实际 DMG、核对哈希与最低系统声明、验证 ad-hoc 签名、两套 Mach-O / 原生模块与对应源码 / 许可、离线 Full 检索及隔离 GUI。两架构必须各自原生加载和运行；Rosetta 不能代替双机验收。HEIC 解码、Command / Dock、手动更新以及首次系统拦截流程也需真实 Mac 验证并如实记录覆盖范围。

`.github/workflows/mac-full.yml` 是 Mac 构建和双架构检查的 CI 入口，计划在 macOS 15 的 Intel 与 Apple Silicon runner 上运行；工作流文件存在不代表已经执行或通过，未来的 macOS 15 结果也不能表述为已在 macOS 12 真机测试。构建与检查不自动发布附件。只有实际构建、原生双架构验收、源码与许可审查以及发布附件回读完成后，才可把状态改为已验证 / 已上线，并附真实大小、SHA-256 与 Mac 验收报告。当前所有这些结果均待真实验证。

## 本机交付

本机日常程序固定为 `C:\ACG\当前版本`。部署完整 Full 载荷，保留受支持索引、运行库、原生模块、locales、演示资源及许可。两个启动入口与 `C:\ACG\.review-data` 保持原位，个人字体选择不重置；个人资料、图库、缓存、授权文件不得进入公开安装器。

旧应用自带专有字体只在原始路径、大小与 SHA-256 全部匹配既有所有权记录时迁出运行目录，保存到私有恢复备份，不复制到新运行载荷。未知用户文件不按名称推定所有权，也不删除系统已安装字体。更新事务失败须能恢复应用和已迁出的已知文件。

## 本体与资源分开更新

运行时本体载荷必须提供与版本一致的逐文件所有权记录，核验发布身份、平台、资源身份、数据与读取兼容性，并按大小和 SHA-256 校验安装及回滚。普通 Standard 安装器不能冒充可保留 Full 资源的本体包。缺少可信清单、存在未知文件或资源不兼容时停止自动安装，提供手动下载完整安装器的入口。

客户端仅对严格更高版本提示更新。验收报告应明确区分最终安装器解包、成品启动、隔离环境测试与真实 Windows NSIS / UAC / 系统重启测试，不能相互替代。依赖安装、开发命令及脚本说明见 [开发说明](docs/DEVELOPMENT.md)。
