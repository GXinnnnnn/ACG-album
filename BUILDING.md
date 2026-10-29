# 公开发布与本机私有构建

## 公开发布

正式上传到 GitHub 的安装器必须使用以下入口，它们统一追加 TTF 排除规则：

```powershell
pnpm run package:standard
pnpm run package:search
pnpm run verify:standard
pnpm run verify:search
```

Standard 不附带离线数据库。Lite / Full 构建需准备 `ACG_INDEX_SOURCE`，详见 [本地数据说明](docs/LOCAL_SEARCH_DATA.md)。公开源码忽略五份方正专有 TTF；来源说明和校验记录可以公开。公开包在电脑没有对应字体时使用系统字体。

## 维护者本机自用

README 中的基础命令 `package:dir`、`package:installer` 保留通用本机配置；**如果本机源码目录含私有字体，它们会一并打包，仅限本机自用，不得作为公开分发附件**。Git 忽略规则不会阻止 electron-builder 打包这些文件。

本机完整 Full 交付需在通用配置上加入 Full 离线索引，保留现有字形与个人偏好。日常程序固定为 `C:\ACG\当前版本`，两个启动入口与 `C:\ACG\.review-data` 保持原位。不得把个人资料、图库、缓存或授权文件加入任意公开安装器。

本轮正式 1.1.1 的 Standard / Lite / Full 均使用公开入口生成，并对最终安装载荷与无本机字体的回退行为进行独立验收。
