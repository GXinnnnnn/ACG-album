# 第三方许可与致谢

本文对应 ACG-album 0.6.0 的 Windows x64 依赖；运行时依赖版本沿用 0.5.5，本次功能更新未升级这些依赖。作者代码采用 MIT，版权所有 © 2026 友利奈绪的胖次（[GXinnnnnn](https://github.com/GXinnnnnn)）；第三方组件继续适用各自许可。机器可读致谢位于 `src/assets/credits.json`，原始许可、NOTICE 和校验清单位于 `src/assets/licenses/`。

## 应用运行时

| 组件 | 已核对版本 | 许可与条文位置 |
| --- | --- | --- |
| Electron | 40.10.6 | MIT；`licenses/electron/LICENSE` |
| Chromium | 144.0.7559.236 | Chromium 的 BSD 许可及各内嵌组件许可；安装目录根 `LICENSES.chromium.html` |
| Node.js | 24.15.0 | MIT 及其第三方许可；同一 HTML 的 `Node.js` 项保留完整汇编 |
| V8 | 14.4.258.32-electron.0 | BSD-3-Clause 及内嵌组件许可；同一 HTML 的 V8 相关项 |
| SQLite | 3.51.3 | Public Domain；同一 HTML 的 `sqlite` 项含原始 blessing；本应用经 `node:sqlite` 使用 |
| Sharp | 0.34.5 | Apache-2.0；`licenses/npm/sharp/LICENSE` |
| @img/sharp-win32-x64 | 0.34.5 | 包元数据原文为 `Apache-2.0 AND LGPL-3.0-or-later`；`licenses/npm/@img__sharp-win32-x64/LICENSE` 与 `licenses/libvips/SHARP-README.md` |
| exifr | 7.1.3 | MIT，Mike Kovařík / Mutiny.cz；`licenses/npm/exifr/LICENSE` |
| @img/colour | 1.1.0 | MIT；`licenses/npm/@img__colour/LICENSE.md` 保留 color、color-convert、color-string、color-name 的各自版权通知 |
| detect-libc | 2.1.2 | Apache-2.0；`licenses/npm/detect-libc/LICENSE` |
| semver | 7.8.5 | ISC；`licenses/npm/semver/LICENSE` |

运行时版本通过 Electron 的 `ELECTRON_RUN_AS_NODE=1` 模式读取 `process.versions`，SQLite 另经 `select sqlite_version()` 核对，未启动 GUI。Electron 原始 `LICENSES.chromium.html` 为 15,997,529 字节；须保留在可执行文件旁，不以简短致谢替代该汇编，也不在源码资源中重复复制。它覆盖 Electron 随带的 Node.js、Chromium、SQLite、原生媒体相关组件等各自通知；无需另行安装 npm 版 SQLite 或 FFmpeg 才能使用这些内嵌能力。

## Sharp / libvips 原生组件

安装包实际提供 `sharp-win32-x64.node`、`libvips-42.dll` 和 `libvips-cpp-8.17.3.dll`。`licenses/libvips/SHARP-versions.json` 是从已安装包逐字保留的版本清单；下面列的是该清单中的组件，不是可选平台依赖的猜测。许可选择依照包内 README 与上游 `sharp-libvips` v1.2.4 / `build-win64-mxe` v8.17.3 的原始通知。

| 组件 | 版本 | 本预编译组合使用的许可 |
| --- | --- | --- |
| aom | 3.13.1 | BSD-2-Clause + AOM Patent License 1.0 |
| libarchive | 3.8.2 | BSD-2-Clause 及 COPYING 内逐项说明 |
| cairo | 1.18.4 | MPL-2.0；同时保留上游 COPYING 与 MPL-1.1 原文 |
| cgif | 0.5.0 | MIT |
| libexif | 0.6.25 | LGPL-3.0-or-later，经上游 any-later 条款使用 |
| expat | 2.7.3 | MIT |
| libffi | 3.5.2 | MIT |
| fontconfig | 2.17.1 | Fontconfig（BSD-like） |
| freetype | 2.14.1 | FreeType License（BSD-like） |
| fribidi | 1.0.16 | LGPL-3.0-or-later，经上游 any-later 条款使用 |
| glib | 2.86.1 | LGPL-3.0-or-later，经上游 any-later 条款使用 |
| harfbuzz | 12.1.0 | MIT |
| libheif | 1.20.2 | LGPL-3.0-or-later；COPYING 还保留其内列组件通知 |
| highway | 1.3.0 | Apache-2.0、BSD-3-Clause |
| libimagequant | 2.4.1 | BSD-2-Clause，使用上游标明的旧 BSD 分支，不能套用新版 GPL 声明 |
| lcms | 2.17 | MIT |
| mozjpeg | 0826579 | IJG、BSD-3-Clause、zlib；保留 LICENSE.md 与 README.ijg |
| pango | 1.57.0 | LGPL-3.0-or-later，经上游 any-later 条款使用 |
| pixman | 0.46.4 | MIT |
| libpng | 1.6.50 | Libpng-2.0 及 LICENSE 中历史通知 |
| proxy-libintl | 0.5 | LGPL-3.0-or-later，经上游 any-later 条款使用 |
| librsvg | 2.61.2 | LGPL-3.0-or-later，经上游 any-later 条款使用 |
| libspng | 0.7.4 | BSD-2-Clause |
| libtiff | 4.7.1 | LibTIFF（BSD-like）及 LICENSE.md 内附加通知 |
| libvips | 8.17.3 | LGPL-3.0-or-later；主体上游为 LGPL-2.1-or-later，本组合行使 later-version 选项 |
| libwebp | 1.6.0 | BSD-3-Clause + PATENTS 授权 |
| libxml2 | 2.15.1 | MIT；保留 Copyright 原文及其例外提示 |
| zlib-ng | 2.2.5 | Zlib |

原文集中保存在 `licenses/libvips/native/`；另保留 libvips 内嵌 libnsgif 的 MIT 通知。完整 LGPL-2.1 位于 `licenses/libvips/LICENSE`，LGPL-3.0 与其引用的 GPL-3.0 分别为 `LGPL-3.0.txt`、`GPL-3.0.txt`。不能只复制 GPL 补充条文或把所有原生库归为 Sharp 的 Apache 许可。

This software is based in part on the work of the Independent JPEG Group.

Portions of this software are copyright © The FreeType Project (www.freetype.org). All rights reserved.

### 对应源码、替换与再分发

本地保存了上游构建说明与 Windows 打包脚本，并记录每份资料的来源 URL、长度和 SHA-256。获取与重建入口如下：

- [Sharp v0.34.5 源码](https://github.com/lovell/sharp/tree/v0.34.5)。
- [sharp-libvips v1.2.4 Windows 打包脚本](https://github.com/lovell/sharp-libvips/blob/v1.2.4/build/win.sh)，指向下述 MXE 发行包。
- [build-win64-mxe v8.17.3 构建树](https://github.com/libvips/build-win64-mxe/tree/v8.17.3)，包含构建配置、组件来源和补丁；原始 [Windows x64 web static 发行包](https://github.com/libvips/build-win64-mxe/releases/download/v8.17.3/vips-dev-w64-web-8.17.3-static.zip)。
- [libvips v8.17.3 源码](https://github.com/libvips/libvips/tree/v8.17.3)。其他组件的确切来源见 `licenses/manifest.json` 与上述构建树。

本版本原生组件的对应源码与构建材料另通过同一 Releases 下载页的 [ACG-album-0.6.0-native-sources.zip](https://github.com/GXinnnnnn/ACG-album/releases/download/v0.6.0/ACG-album-0.6.0-native-sources.zip) 提供；文件内保留来源与校验清单。它是开发者使用的源码附件，不是第四种安装包。

本应用不附加禁止为调试 LGPL 组件修改而进行逆向工程的条件。原生模块按构建配置解包在 `resources/app.asar.unpacked/node_modules/@img/` 下；替换修改后的兼容 DLL 需保持文件名、架构与 ABI。DLL 内静态组合的组件须通过对应构建链重建；这与仅替换单个动态库不同。

已检查的 npm 原生包及官方 Windows zip 没有单独的书面源码提供承诺。本目录保存许可文本与获取入口，没有捏造发行者的 written offer。**对外分发二进制时，发行者仍须按适用的 LGPL / MPL 条款随附完整对应源码，或采用许可允许且实际可履行的源码提供方式；仅有本页上游链接不等于已交付对应源码。** 如修改依赖，必须保留版权、标记修改并同步提供对应的构建材料。本文清单依据所附版本表与上游通知；升级、换平台或启用其他编解码组件后应重新核验。

## 开发工具

`electron-builder` 26.8.1、`Prettier` 3.6.2 为 MIT；`@playwright/test`、`playwright` 与 `playwright-core` 1.58.2 为 Apache-2.0。直接工具包的 LICENSE / NOTICE / ThirdPartyNotices 原文在 `licenses/development/`；它们用于开发和验证，不据此宣称其全部开发依赖都进入运行时。Electron 虽声明在 devDependencies，桌面发行包实际包含 Electron 运行时，因此已按运行时列明。

## 图标、个人素材与外部服务

`src/ui/app.js` 的硬编码线性 SVG 中，`plus` 的 `M12 5v14M5 12h14` 与 Lucide `plus.svg` 的两条线段一致；`x` 的 `m6 6 12 12M6 18 18 6` 与 Lucide `x.svg` 一致，第二条线仅反向绘制。已保存 [Lucide 0.468.0](https://github.com/lucide-icons/lucide/tree/0.468.0) 的这两个公开 SVG 与完整 ISC 许可，按衍生图标保留致谢。该版本是复核对照基线，不表示已查明最早复制日期或整个内嵌图标集的历史来源。原许可包含 Cole Bemis / Feather（MIT）与 Lucide Contributors 的版权归属提示，未删除历史通知；另保存 Feather v4.29.2 的完整 MIT 原文 `licenses/lucide/FEATHER-LICENSE`。

默认资料头像 `src/assets/default-avatar.jpg` 来自 Bangumi 的[默认用户头像](https://lain.bgm.tv/pic/user/l/icon.jpg)。该 URL 虽以 `.jpg` 结尾，实际响应为 75×75 像素 GIF；本应用转换为 JPEG 后随包保存，显示时读取本地资源。此处记录来源与格式转换，不主张取得额外的图像授权；该图像的权利归相应权利人，不能因应用代码采用 MIT 而视为 MIT 素材。再分发或另作使用时仍须核实适用的授权与服务条款。

作者提供或授权的作者头像、品牌图、应用图标与个人收款码用于本应用展示；这项授权不把肖像、角色、支付标识或第三方图像一并转成 MIT，也不伪造它们的开源来源。用户导入的照片、视频、封面及原始收藏仍由相应权利人保留权利。

[Bangumi 番组计划](https://bgm.tv) 是可选的作品信息服务。API、封面和条目内容按其各自服务条款及权利使用；使用服务不代表与本应用存在合作或背书。本地凭据不应提交源码仓库。

## 随包本地检索数据

0.6.0 精简检索版与完整检索版随包携带从 [Bangumi Archive](https://github.com/bangumi/Archive) 快照 `2026-10-13.210353Z` 构建的只读索引，分别保留名称检索字段或额外完整原始记录。二者的作品、人物、角色与名称覆盖相同，不包含封面图片。来源、文件哈希、记录数与字段区别见 [本地检索数据说明](LOCAL_SEARCH_DATA.md)；安装目录 `resources/local-index/SOURCE.md` 也保留此说明。

索引数据及条目内容的权利归相应权利人；应用代码的 MIT 许可不重新授权这些数据。官方 Archive 仓库的代码许可不能单独作为全部数据再分发许可的依据。源码仓库不包含索引数据库，Standard 安装包也不包含；Lite / Full 安装包通过 GitHub Releases 提供，并保留固定快照的来源归属与校验值。

## 复核与打包

运行 `node scripts/collect-licenses.cjs` 会核对已安装 Windows x64 生产依赖，保留实际 LICENSE / NOTICE，记录原生 DLL 和 Electron 汇编的哈希；对不存在的列明原文才联网下载。`--refresh-upstream` 可重新获取全部已列上游资料。下载失败或缺少必须的条文会返回非零状态。所有上游许可原文保持完整，中文说明不替代原文。

发行包在安装目录保留项目 `LICENSE.app.txt`、`README.md`、`docs/` 和 Electron 根 `LICENSES.chromium.html`；`src/assets/credits.json` 与完整 `src/assets/licenses/**` 位于应用 ASAR 内。打包配置通过 `extraFiles` 携带根许可和文档，通过 `src/**/*` 携带应用资源。开发与验证工具不进入运行时依赖；原生 DLL 位于 `resources/app.asar.unpacked/`。
