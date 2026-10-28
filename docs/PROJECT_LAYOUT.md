# 项目结构与职责

ACG-album 1.1.0 是本地优先的 Windows Electron 应用。主进程与 worker 使用 CommonJS，界面使用原生 HTML、CSS、JavaScript。数据库扫描、图像处理与导出在后台工作线程运行；界面通过明确的 IPC 接口访问应用能力。

## 源码边界

入口和后台模块位于 `src/`，界面模块位于 `src/ui/`，静态资源位于 `src/assets/`。按功能拆分文件，保持相邻模块的依赖方向清晰。

| 职责           | 现有位置                                                                                                          | 维护边界                                                                                                                                                               |
| -------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 主进程入口     | `src/main.cjs`                                                                                                    | 窗口、生命周期、单实例、系统对话框、自定义协议、worker 通信、系统权限及凭据加密；不把数据库扫描放进渲染进程                                                            |
| 应用与外部服务 | `src/application.cjs`                                                                                             | 应用信息、作者与致谢数据、外部链接入口；集中校验可访问的 HTTPS 主机                                                                                                    |
| 仓库元数据辅助 | `src/repository.cjs`                                                                                              | 验证可配置的仓库信息；缺省使用官方仓库，保留用户已保存的自定义更新来源                                                                                                                   |
| 后台工作线程   | `src/library-worker.cjs`                                                                                          | 使用 `node:sqlite` 维护本地索引、扫描、查询、缩略图与条目信息；通过消息与主进程协作                                                                                    |
| 媒体能力       | `src/media.cjs`                                                                                                   | 图片元数据、视频信息、Sharp 图像处理、编辑副本与导出；EXIF 使用 exifr                                                                                                  |
| 预加载桥       | `src/preload.cjs`                                                                                                 | 使用 `contextBridge` 暴露明确的 IPC 能力；界面不直接取得 Node.js、文件系统或数据库访问权                                                                               |
| 共享领域规则   | `src/model.cjs`                                                                                                   | 扩展名、路径 / ID、多语言检索词、作品名称、通用目录名过滤和最新图片选择等可独立测试的规则                                                                              |
| 导入匹配策略   | `src/matching-policy.cjs`                                                                                         | 校验 `{ onlineMatch, subjectTypes, directoryKind, characterCover }` 白名单；明确关闭与缺省选项语义不同，供主进程和 worker 共用                                         |
| 官方搜索召回   | `src/bangumi-search.cjs`                                                                                          | 有界相关度 / 热度分页、ID 去重与搜索完整性证据，供 worker 查询缓存复用                                                                                                 |
| 作品候选选择   | `src/matching.cjs`                                                                                                | 名称可信度、所选类型、收藏热度、近分候选按收藏人数与最新有效发行日期选择及有界查询缓存；不把跨类型同名作品合并成系列                                                                   |
| 角色资料       | `src/character-matching.cjs`、`src/character-library.cjs`                                                         | 角色唯一精确名称判定、独立 ID 与资料表、首图 / 立绘策略、手动关联和自定义资料                                                                                          |
| 缓存目录       | `src/cache-directory.cjs`、`src/ui/cache-settings.js`、`cache-settings.css`                                       | 真实路径与占用、目录迁移和回滚、维护锁、清空与重建，以及设置页状态反馈                                                                                                 |
| 主进程辅助     | `src/icons.cjs`、`src/file-response.cjs`、`src/clipboard.cjs`                                                     | 系统文件夹图标、文件 Range 流与剪贴板位图写入读回确认；保持有限资源与重试边界                                                                                          |
| 界面入口       | `src/ui/index.html`、`src/ui/app.js`                                                                              | 页面结构、交互编排、硬编码 SVG 图标及组件联动                                                                                                                          |
| 界面功能模块   | `src/ui/theme.js`、`navigation.js`、`display.js`、`masonry.js`、`media-ui.js`、`editor.js`、`crop.js`、`about.js` | 主题、导航、展示模式、瀑布流、媒体查看、编辑裁剪与关于页；遵循现有模块边界                                                                                             |
| 增量索引       | `src/indexing.cjs`                                                                                                | 缓存扫描 SQL、批量提交 FTS 与媒体初始记录、分页清理已完成扫描目录的缺失子树；取消或未读完的目录不清理                                                                  |
| 资料兼容       | `src/profile-path.cjs`                                                                                            | 改名前选择旧数据库及 Chromium 配置，显式测试目录保持隔离                                                                                                               |
| 应用内控件     | `src/ui/controls.js`、`controls.css`                                                                              | 自定义可访问下拉列表、键盘操作、完整胶囊选中态                                                                                                                         |
| 静态资源与许可 | `src/assets/`                                                                                                     | 应用图标、作者提供素材、Bangumi 默认用户头像 `default-avatar.jpg`、`credits.json` 与 `licenses/`；默认头像来源和图像权利见第三方通知，第三方许可原文与素材授权分开说明 |
| 演示资料       | `src/demo/`                                                                                                       | 演示样本，打包时作为独立 demo 资源；不指向用户真实图库                                                                                                                 |

新增媒体适配位于 `src/image-preview.cjs`、`src/heif-decoder.cjs`、`src/heif-worker.cjs`；独立解码器及其对应源码在 `src/vendor/libheif/`，打包至 ASAR 外。`src/fonts.cjs` 与 `src/ui/typography.js` 负责本机字体选择；公开构建排除专有字体二进制。`src/home-copy.cjs` 与 `src/ui/home-copy.js` 负责首页文案校验、原位编辑与保存；`src/root-removal.cjs` 管理移除分类时的保护规则。

## 根目录

| 位置                                      | 用途                                                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `package.json`、`pnpm-lock.yaml`          | 应用版本、入口、脚本与已锁定依赖；升级原生依赖后同步复核许可资料                                |
| `scripts/`                                | 演示 / 图标生成、静态或自动化检查、性能验证与许可证收集；GUI 检查须显式运行，许可收集不启动 GUI |
| `tests/`                                  | Node.js 自动化测试；运行 `npm test`，具体测试范围以当前文件为准                                 |
| `docs/`                                   | 项目边界、第三方通知与交付说明；本文不替代用户使用说明                                          |
| `README.md`                               | 使用、开发与构建入口                                                                            |
| `LICENSE`                                 | 作者代码的 MIT 许可；第三方软件、个人图库、头像和收款码另受各自权利约束                         |
| `release/`、`artifacts/`、`.review-data/` | 本地构建、检查产物或测试资料；忽略提交                                                          |

## 运行数据与常用操作

新资料默认保存在系统「文档」的 `ACG-album` 目录；实际位置由 `src/profile-path.cjs` 解析。缓存设置通过 `cacheInfo` 展示正在使用的真实路径，通过 `openData` 打开资料目录。`src/cache-directory.cjs` 仅管理 `thumbnails`、`covers`、`metadata` 三类缓存；迁移会复制并核验目录、提交数据库路径后再移除旧副本，失败时回滚。更换缓存位置不搬迁资料库、凭据或收藏原件。

开发 / 自动化检查应通过 `ACG_DATA_DIR` 指定独立资料目录；该覆盖同时将 Electron / Chromium 配置放在指定目录的 `chromium-profile/` 下，避免与个人图库、真实 Token 混用。

- 启动应用：`npm start`。
- 单元测试：`npm test`。
- 生成目录包 / 安装器：`npm run package:dir` / `npm run package:installer`。
- 收集与核验许可：`node scripts/collect-licenses.cjs`；默认复用已经保存的上游原文并重新核对已安装 npm 包与哈希，`--refresh-upstream` 才重新下载全部列明的上游原文。

## 导入与联网阶段

`src/ui/app.js` 在导入窗口收集目录类型、联网策略、作品分类和角色封面来源。作品分类支持动画（2）、漫画 / Bangumi 书籍（1）、游戏（4）、三次元（6）；角色目录支持自然顺序的首张本地图片或 Bangumi 角色头像。`api('import', { onlineMatch, subjectTypes, directoryKind, characterCover })` 通过白名单校验后才打开原生目录选择器，再将路径与策略交给 worker。取消任一选择均不扫描，也不导航。

worker 保存根分类的目录类型、封面来源和联网策略，供刷新、重启和增量扫描复用。扫描先提交本地索引与本地封面；角色首图按自然顺序选择可用图片，跳过视频。网络匹配进入独立异步队列，不延长扫描的完成条件。`src/character-matching.cjs` 与 `src/character-library.cjs` 分别负责角色名称判定和资料持久化，使用独立角色 ID，不把角色写入作品 ID。选择本地首图时仍可匹配简介，在线头像不会覆盖本地封面。人工封面、关联与裁切继续保留。

`src/bangumi-search.cjs` 负责官方搜索召回，每页请求 20 条，按实际响应条数推进偏移，每个词最多两页相关度与一页热度。搜索完整性独立于候选数量：截断、重复 ID、偏移 / 总数矛盾或无效响应不能证明唯一；即使相关度分页重复或为空，仍保留预算内的热度回退。`src/matching.cjs` 负责类型与 ID 准入、原名 / 中文名 / 官方别名评分，同分优先正式主标题。完整类型搜索中的单个候选，主标题完整覆盖并处于分隔边界、归一化长度至少 4、收藏状态合计至少 1000，才允许低于通常置信度的副标题匹配；各名称中的明确续作 / 外传标记均可阻止该放宽。worker 对最终详情独立重排整个候选池，胜出 ID 改变时继续验证，最多请求 6 个不同 ID，保留类型、缓存消费者与过期请求保护。

手动 `match` 只返回 `{ node, candidates, needs_selection: true, searchAccess: { tokenPresent } }`，不会解绑、保存作品、下载封面或写入 Markdown；只有明确的 `bind` 保存手动选择。自动扫描 / 补全队列继续按高置信度关联。手动 `fullCandidates` 召回不会因精确主标题提前结束，仍遵守原搜索 / 详情预算；手动与自动的候选完整性判断和聚合缓存分离，允许同一权限命名空间复用完全相同的原始 API 页。`src/bangumi-cache.cjs` 将原始响应保存到 SQLite，按 Token 指纹、端点和规范化请求隔离；空搜索 6 小时，非空搜索 / 详情 / 制作人员 7 天，最多 8192 项与 64MiB JSON，单项最多 2MiB。Token 变化使权限代次失效、清空内存查询 / 详情 / 制作人员缓存并终止旧网络请求；磁盘响应保留在各自命名空间。`tokenPresent` 仅说明凭据存在，不代表认证和权限有效。受限条目提示来自官方 API 权限契约，搜索不设置错误的 `nsfw: true` 或字符串值。

`model.searchPlan(name)` 返回主体 `{terms,titleGroups}` 和独立 `fallbacks`；`searchTerms` 只返回主体词。单语和交错混排名称保留完整标题，较完整的跨语言前后标题才提供多个独立名称；`titleGroups` 要求所有部分均由各自检索召回且被独立详情支持，完整正式名称精确一致仍有效。括号备注只有主体无高匹配候选时依次检索，歧义不触发备注覆盖。各阶段合计最多 6 个归一化去重词、6 个独立详情 ID；详情核验预算为后续阶段预留至少一项。手动检索只返回合并候选，不修改已有绑定。

`match_frontier` 保存每个根目录的发现游标，`match_pending` 保存未确认任务及其策略 / 关联指纹，`match_resume` 保存访问暂停或重试期限；一页发现与游标推进在同一事务提交，内存最多 64 个任务。成功或不可重试结果才确认删除；正常退出保留持久任务，主动取消与根目录失效则清除。启动和 Token 切换时重新校验当前资格与原任务指纹。401/403 等待权限变更，网络错误指数退避，429 兼容秒数与 HTTP 日期的 Retry-After。封面补修也须使用当前权限与未过期详情，不能把旧账号的资料当作新账号的检索证据。界面从初始化快照和事件显示完整待处理数、发现阶段与暂停原因。

`src/ui/about.js` 从设置或现有信息窗口打开新层时创建独立原生 `dialog`，保留设置 DOM / 控制器 / 代次；关闭当前层后回到父层并恢复焦点。父窗口关闭或底层内容被替换时递归清理子窗口，异步结果继续检查连接状态和代次。`node scripts/check-manual-navigation.cjs [--packaged]` 使用全新合成资料测试上述返回路径与手动候选确认；检索 / 保存 IPC 为确定性夹具，真实后台行为由 worker 和联网测试独立核验。

`node scripts/check-import-matching.cjs` 与 `--packaged` 使用各自全新的 `artifacts/import-matching/<模式>-<时间>-<UUID>/`，只生成小 PNG / JPEG 样本，分别隔离应用资料与 Chromium 配置，比较源文件 SHA256、大小与修改时间。测试只替代原生目录选择器，观察并转发真实 worker 消息，不伪造扫描、进度或联网结果；启用联网的 GUI 样本只使用通用目录名，不要求真实网络请求。真实候选匹配的请求 / 响应选择由后端独立测试负责。

`check-live-import.cjs` 保持源码专用，点击真实导入按钮并明确关闭联网，在确认选项后计时；保留原有脱敏、原件检查与扫描期间交互验证。`check-release-ui.cjs` 的模拟较新 Release 从当前版本递增补丁号，继续检查更新可用 / 已最新 / 错误状态。新增检查准备完成与实际运行通过分开记录；全部 GUI 和性能脚本由协调任务串行执行，不同时启动。

## 维护约定

- 使用 `pnpm run format` 与 `pnpm run format:check` 维护作者源码的统一格式；第三方许可原文和图像素材保持原始字节。
- GUI、剪贴板和性能检查串行执行；后续界面检查通过 `fixture-profile.cjs` 选择最近成功的合成媒体资料。先运行 `check-media.cjs`，再运行 `check-release-ui.cjs`。
- `src/assets/credits.json` 驱动关于页致谢。升级依赖时同步核对版本、完整许可、`licenses/manifest.json` 和第三方通知。
- 构建只收集应用源码、生产依赖、独立演示资源及明确列出的说明。Prettier、Playwright、检查脚本、真实图库与本地测试资料不进入应用运行时。
- 安装目录包含 `README.md`、`LICENSE.app.txt`、`docs/`、Electron `LICENSES.chromium.html`；应用 ASAR 内保留 `src/assets/licenses/`。LGPL 原生库解包在 `resources/app.asar.unpacked/`，便于在 ABI 兼容条件下替换。
- 项目源码由 Git 管理并同步至 [GitHub 仓库](https://github.com/GXinnnnnn/ACG-album)；安装包、索引数据和原生组件源码附件通过 Releases 发布。构建命令固定 `--publish never`，构建本身不会上传或发布。
