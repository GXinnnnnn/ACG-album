# 随附本地检索数据

ACG-album 1.1.1 提供软件本体（Standard）、软件本体＋精简索引包（Lite）与软件本体＋完整索引包（Full），三版共用相册功能和用户数据格式。Standard 不附带离线数据库，可使用联网匹配；下表比较 Lite 与 Full 的随附资料。选择一版安装即可；切换版本采用相同应用身份覆盖升级。软件内「本地资料检索 → 资料库补全 / 下载」连接 [官方 GitHub 仓库](https://github.com/GXinnnnnn/ACG-album)，提供与当前应用版本一致的 Lite / Full 安装包和发布说明；更新仓库的自定义设置不会改变官方索引的下载来源。

| 项目                                       | 精简检索版                   | 完整检索版                   |
| ------------------------------------------ | ---------------------------- | ---------------------------- |
| 索引数据版本                               | 2026-10-13.210353Z           | 2026-10-13.210353Z           |
| 数据库字节数                               | 1,051,807,744（约 1.052 GB） | 4,734,013,440（约 4.734 GB） |
| 作品数                                     | 695,909                      | 695,909                      |
| 人物 / 团体数                              | 103,653                      | 103,653                      |
| 角色数                                     | 223,927                      | 223,927                      |
| 已展开直接关联数                           | 4,614,852                    | 4,614,852                    |
| 名称、别名、类型、日期、收藏统计与关联检索 | 保留                         | 保留                         |
| 长简介、完整原始 infobox、原始 JSON        | 不保留实际内容               | 保留                         |
| 章节和原始关系记录                         | 不保留，直接检索关联仍保留   | 保留                         |
| 封面图片                                   | 不包含                       | 不包含                       |

GB 按十进制表示，以上为数据库本身占用，另需程序、缩略图缓存和相册索引空间。安装包大小以交付清单为准；完整库不会因此获得更多名称覆盖或更高名称匹配准确度。完整保留的原始字段不表示所有字段均在界面展开。

## 来源与归属

本地检索数据来自 Bangumi 社区及其官方公开 Archive。原始条目、人物、角色与关联资料由 Bangumi 社区贡献；ACG-album 为本地检索派生索引，不宣称对上游内容拥有独占权利，与 Bangumi 官方无隶属关系。

- Bangumi：https://bgm.tv/
- 官方 Archive：https://github.com/bangumi/Archive
- 固定源文件：https://github.com/bangumi/Archive/releases/download/archive/dump-2026-10-13.210353Z.zip
- 官方 ZIP 字节数：445,853,444
- 官方 ZIP SHA-256：`19d12d42502fefeb4a2b14561cc978986a554320b06ca4bbf454d1830b101f90`
- 索引读取 schema：1
- 精简数据库 SHA-256：`d627f0dd20120aa56c60298e286c6ab8dd0eb235e12b72368b9f56e396ca5b81`
- 完整数据库 SHA-256：`d4aea4e16c0b2aacf00c2947c66fb8d78428a4a9103f257f4f458e67c77787ff`

数据库置于安装目录 `resources/local-index/subjects.sqlite`，同目录 manifest 记录当前版本、构建来源、记录数和校验值。应用以只读方式打开，不将个人相册、账号或 Token 写入随附数据库。数据是固定日期快照，更新滞后于网站；仅名称索引不提供当前在线评分、封面或访问授权。

本说明保留来源归属，不为上游数据另行授予许可；应用代码许可不替代上游数据权利条款。公开分发时应继续保留来源并遵循上游适用条款。源码仓库不包含数据库，随附索引通过 Releases 安装包提供。

## 已核验名称补充

应用可通过小型、可审计的名称补充表弥补快照中的个别别名缺失，不修改随附只读数据库。2026-10-27 核验的一项补充仅适用于作品类型 4、Bangumi ID 172612，且归档原名必须为「千恋＊万花」：补充官方英文名称「Senren＊Banka」，由既有标点归一化自然支持 `SenrenBanka`。ID、类型或原名不符时不生效，其他条目及未知外文后缀不借用此别名。

核验依据为 [Steam 同一商品的中文页](https://store.steampowered.com/app/1144400/?l=schinese)、[英文页](https://store.steampowered.com/app/1144400/?l=english) 及 [NekoNyan 官方发行博客](https://www.nekonyansoft.com/blog/senren-banka-release-date-new-announcements-and-other-news) 的检索索引标题；本次核验环境未能获取页面正文，不据此声称已阅读全文。证据与适用条件记录在 [已核验别名表](../src/verified-title-aliases.cjs)，运行时不访问这些网址。

## 构建与安装

开发环境运行 `pnpm run package:search` 构建 Lite / Full。通过 `ACG_INDEX_SOURCE` 指定预处理索引目录，其中需有 `subjects-lite.sqlite`、`subjects.sqlite` 与 `packages/manifest.draft.json`；维护者本机默认目录为同级资料归档的 `local-index-pilot-2026-10-20`。构建前核对数据库字节数与 SHA-256，将真实数据库作为 extraResources 随安装包分发，不复制到 app.asar 中。

```powershell
$env:ACG_INDEX_SOURCE = 'D:\BangumiIndex'
pnpm run package:search
```

构建带 Standard 文件名且不附数据库的官方软件本体安装包可运行 `pnpm run package:standard`。安装包保存在被 Git 忽略的 `release/` 中，通过 GitHub Releases 发布，不加入源码历史。

安装前退出正在运行的相册。安装器默认保留用户数据，卸载也不删除应用数据。切换检索版只更换程序与随附只读索引；个人相册数据库、收藏、人工关联、封面裁切和 Token 位于应用数据目录，正式安装前仍建议备份自己的应用数据。安装器未签名，Windows 的发布者提示属于未签名构建的正常状态。
