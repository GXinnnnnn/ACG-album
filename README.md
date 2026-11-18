# ACG-album

**给硬盘里的 ACG 收藏，一个想常常打开的相册。**

ACG-album 是一款 Windows 本地相册，适合整理游戏 CG、角色插画、动画截图、设定集和日常照片。沿用现有文件夹结构，把收藏变成封面卡片和连续瀑布流；需要时关联 Bangumi 作品与角色资料，让收藏更好看，也更好找。

**当前版本：1.2.3 · Windows x64 · MIT License**

[下载安装](#下载与版本选择) · [主要功能](#主要功能) · [开始使用](#开始使用) · [界面预览](#界面预览)

## 下载与版本选择

前往 [v1.2.3 发布页](https://github.com/GXinnnnnn/ACG-album/releases/tag/v1.2.3)，选择一种安装包即可。**日常使用推荐 Lite。**

| 版本 | 随附内容 | 适合的使用方式 |
| --- | --- | --- |
| [Standard](https://github.com/GXinnnnnn/ACG-album/releases/download/v1.2.3/ACG-album-Setup-1.2.3-Standard.exe) | 软件本体，不附带离线条目索引 | 主要联网匹配，希望下载更小 |
| [Lite](https://github.com/GXinnnnnn/ACG-album/releases/download/v1.2.3/ACG-album-Setup-1.2.3-Lite.exe) | 软件本体＋名称、别名、类型与关联索引 | 本地名称检索与日常条目匹配 |
| [Full](https://github.com/GXinnnnnn/ACG-album/releases/download/v1.2.3/ACG-album-Setup-1.2.3-Full.exe) | 软件本体＋完整索引，保留更多简介、条目信息与原始资料 | 需要更完整的离线资料 |

三版应用功能相同，可覆盖切换并沿用个人资料。Lite 与 Full 的名称覆盖及匹配规则相同，Full 不会额外提高识别准确度。**所有版本均不内置封面图片**，在线封面与资料补全需要网络及相应访问权限。

下载大小见发布页，文件校验值见 [SHA256SUMS.txt](https://github.com/GXinnnnnn/ACG-album/releases/download/v1.2.3/SHA256SUMS.txt)；安装、切换版本与备份步骤见 [安装说明](docs/INSTALLATION.md)。

### macOS 适配准备中

Mac 仅计划提供一个完整包：`ACG-album-Setup-1.2.3-Full-universal.dmg`，同一包支持 Apple Silicon 与 Intel，最低系统目标为 **macOS 12**，最终还需核验实际应用的最低系统声明并在真机测试。该包将追加到现有 [v1.2.3 发布页](https://github.com/GXinnnnnn/ACG-album/releases/tag/v1.2.3)；**当前尚无真实 Mac 构建、CI 验收或已发布附件**，现有 Windows 附件不代表 Mac 已通过验证。

预期随包提供完整离线索引、两种架构的 Sharp / libvips、HEIC / HEIF WASM 解码资源及对应源码和许可。Mac 采用原生 Command 快捷键与 Dock 行为（卡片尺寸使用 Command＋滚轮），个人资料默认保存在 `Documents/ACG-album`，不会默认迁移 Windows 资料库；Token 使用 Electron `safeStorage` 调用系统安全存储。Mac 关闭 Windows 自动更新安装链路，后续从发布页手动下载新 DMG，退出应用后替换 `.app`。

Mac 应用计划采用 ad-hoc 签名，没有 Developer ID 签名与 Apple 公证（notarization）。核对来源与摘要后，若首次打开被系统拦截，可在「系统设置 → 隐私与安全性」允许打开，或使用系统右键「打开」；不建议关闭 Gatekeeper。安装、资料备份和待验证边界见 [安装说明](docs/INSTALLATION.md#macos-full-完整包待真实验证)。

## 主要功能

### 相册与浏览

- **文件夹就是相册**：导入作品、角色或普通图片目录，保留原有层级，通过封面卡片和连续目录树浏览收藏。
- **后台导入与续作**：分批建立索引，边导入边浏览，显示扫描和资料匹配进度。正常退出后可继续未完成任务；明确取消的批次不会自动重开。
- **连续浏览**：图片、动画与视频统一呈现，支持详情模式、紧凑瀑布流和媒体筛选。长图保留顶部预览，打开后查看完整内容；相册往返时在缓存范围内恢复浏览位置。
- **搜索、排序与收藏**：按名称查找，按文件原名自然顺序、内容日期、创建时间、修改时间或大小排序，各页面独立记忆选择；收藏常看内容，也可按月份和地点浏览时间线。
- **增量刷新与重命名**：检查新增、移走和变动文件，复用未变化内容。应用内可重命名真实文件或目录，并同步关联、收藏与封面设置；不会覆盖同名目标。

### 作品资料与封面整理

- **Bangumi 自动关联**：按分类配置作品类型、探索深度与角色封面来源，结合原名、译名、别名、类型和续作信息匹配。结果不确定时留给人工选择，未匹配成功时使用本地首图。
- **手动整理优先**：可重新选择作品或角色条目，填写自定义角色名称与简介。单项关联先保存，封面和详情后台补全，后续刷新保留人工设置。
- **封面自由调整**：使用 Bangumi 封面、角色立绘或自选本地图片，拖动位置、缩放构图，也可恢复自动封面；只改变显示参数，不裁切原图。
- **封面确认**：成功关联后自动确认，也可逐项确认或批量确认当前目录的直接子文件夹，方便筛出尚未整理的内容。
- **独立资料检索**：分别查询作品、人物／团体和角色，按作品类型或所属作品 ID 缩小范围，查看可用摘要并打开官方条目。Lite／Full 提供本地索引，检索页也可进入资料库补全下载。

### 图片、动画与视频

- **多格式查看**：支持 JPEG、PNG、WebP、GIF、BMP、ICO、TIFF、AVIF，以及通过随附离线解码器预览 HEIC／HEIF；按实际内容识别格式，兼容预览不覆盖原图。
- **原图查看器**：双击打开，方向键切换、滚轮缩放、拖动平移。视频优先内播，无法播放时可交给系统默认播放器。
- **图片编辑副本**：裁剪、选择比例、旋转、调整尺寸，以及亮度、对比度和饱和度；对照预览后另存 PNG、JPEG、WebP 或 GIF，拒绝覆盖原件。
- **动画编辑**：GIF 与动态 WebP 支持播放、逐帧查看、截取帧范围、调整帧时长和循环次数。所选动画导出为 GIF，其他格式保存当前帧，也可直接导出当前帧 PNG。

### 主题、玻璃与壁纸

- **明暗主题**：月之亮面与月之暗面随时切换；可选择本机字体、字体阴影与低／中／高动效，遵循系统减少动态效果等可访问性设置。
- **可调玻璃**：切换液态玻璃与磨砂玻璃，分别调整悬浮组件和弹窗透明度。切换栏模糊下方滚动内容，内层控件保持轻半透明。
- **自定义背景**：七张内置壁纸与自定义上传，亮暗主题分别记住所选图片及每张图的位置、缩放；支持编辑、移除、恢复，遮罩和背景模糊独立可调。关闭壁纸即可恢复纯色外观，选图与构图继续保留。
- **卡片与个人主页**：小／中／大档位、连续尺寸滑杆和 Ctrl＋滚轮调节，圆角可调至方角，布局适配窄窗与宽屏。首页标题和说明可原位编辑，也能自定义昵称与头像；个人选择自动保存。

### 离线来源与资料管理

- **失联目录独立处理**：移动盘拔出或目录改名时，保留缓存和人工整理，其他在线来源与新导入仍可使用。可重新连接原路径，或重新匹配现有文件夹的新位置；重新匹配不移动磁盘原图。
- **缓存管理**：查看封面、缩略图和简介缓存的实际位置与占用，迁移存储位置、清理未使用内容或清空后重建；收藏、条目关联及封面构图等整理参数保留。
- **检查与下载更新**：读取正式发布，显示版本、资源和下载进度，校验大小与 SHA-256。满足兼容性和可信清单要求时，可仅更新本体并保留原索引；也可使用完整安装包升级或切换版型，下载与安装由用户确认。

## 开始使用

1. 安装并启动所选版本；需要本地名称检索时选择 Lite 或 Full。
2. 点击侧栏「导入」，选择目录类型和收藏根目录，按需启用 Bangumi 匹配；普通照片可以关闭匹配。
3. 浏览已经出现的相册。需要修正资料、封面或磁盘名称时，右键相应卡片选择操作。
4. 在「偏好设置」调整外观、个人资料、Bangumi Token 和缓存位置；来源失联时使用重新连接或重新匹配入口。

## 数据与使用说明

- **本地保存**：资料库、设置、收藏和人工整理保存在本机，实际路径可在「缓存与资料库」中查看。浏览、索引与封面调整不改写原件；主动重命名会修改磁盘名称，编辑结果另存副本。
- **按需联网**：Bangumi 匹配发送检索词或条目 ID，并下载资料与封面。公开条目通常可匿名查询；受限资料可能需要在「作品简介」中配置自己的 Access Token，可访问范围由账号权限决定。Token 在 Windows 本机加密保存。
- **离线与备份**：离线可浏览已索引内容及现有缓存；打开原图、播放和编辑仍需源文件可用。备份前正常退出，复制完整实际资料目录，原始图片、视频和另存缓存需分别备份。
- **格式边界**：APNG 可查看原动画，编辑仅支持静态帧；兼容预览可能取静帧。大图、特殊编码、HDR 和宽色域存在兼容与资源限制，编辑副本为 SDR sRGB 并移除 EXIF／GPS；详见 [媒体兼容说明](docs/MEDIA_COMPATIBILITY.md)。

## 界面预览

<details>
<summary>展开查看 8 张界面截图</summary>

<img width="1920" height="1044" alt="微信图片_20261103000439_666_3" src="https://github.com/user-attachments/assets/01c29c0b-5e19-44a2-82dc-a4741983586a" />

<img width="1280" height="696" alt="QQ20261031-005456" src="https://github.com/user-attachments/assets/5e58fa1a-b245-424e-939d-93fa2d7060ef" />

<img width="1920" height="1044" alt="微信图片_20261103001133_669_" src="https://github.com/user-attachments/assets/54604889-9f14-4631-89d9-2a9ada06ba2f" />

<img width="3840" height="2088" alt="微信图片_20261103000623_667_3" src="https://github.com/user-attachments/assets/9ee376c9-6ef3-494f-9745-8b105c0301e5" />

<img width="659" height="480" alt="微信图片_20261102235436_661_3" src="https://github.com/user-attachments/assets/c21819b6-e8a7-4c7e-bf44-bf55e2a7d344" />

<img width="1025" height="1977" alt="image" src="https://github.com/user-attachments/assets/a4e61102-8f08-4878-ae6c-bc18b4e086c3" />

<img width="1920" height="1044" alt="微信图片_20261102235436_660_3" src="https://github.com/user-attachments/assets/734e2763-c14d-4ed1-9501-3d865021b3fd" />

<img width="1170" height="1169" alt="dc5406ef81b8c883cbce6dee83aa52ae" src="https://github.com/user-attachments/assets/2c19cb4d-0495-4cbe-8c3f-da8e6f9a7042" />

</details>

## 文档与反馈

[安装与备份](docs/INSTALLATION.md) · [本地检索数据](docs/LOCAL_SEARCH_DATA.md) · [媒体兼容](docs/MEDIA_COMPATIBILITY.md) · [开发与构建](docs/DEVELOPMENT.md) · [更新记录](docs/CHANGELOG.md) · [反馈问题](https://github.com/GXinnnnnn/ACG-album/issues)

## 作者与许可

作者：[友利奈绪的胖次 / GXinnnnnn](https://github.com/GXinnnnnn) · [Bilibili](https://space.bilibili.com/396517775)

作者代码采用 [MIT License](LICENSE)。第三方组件、Bangumi 数据、字体和图像资源遵循各自许可，品牌、头像、赞助二维码和用户图库不因代码采用 MIT 而自动获得相同授权。详见 [第三方声明](docs/THIRD_PARTY_NOTICES.md)。
