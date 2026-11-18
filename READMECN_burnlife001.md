# 本分支（burnlife001）与上游（NanmiCoder/cc-haha main）的差异说明

> 最近一次同步：上游 v0.7.8（`79b1bf9b`）。本分支已在 v0.7.8 基础上重新落地下列改动。
> 逐项核对清单见 `BURNFILE-CUSTOMIZATIONS.md`（未跟踪文件）。

## 一、默认权限模式与新会话默认值

上游 v0.7.8 已经把桌面端的设置字段名统一成 CLI 能识别的写法（顶层 `defaultMode`、`effort` / `effortLevel` 双键），之前"改了设置不生效"的字段名 bug 在上游已修复，本分支不再重复改字段名，也不再做 `defaultMode → permissions.defaultMode` 的存量迁移。

本分支保留的是**默认行为**上的差异：

- `SettingsService.getPermissionMode()` 的缺省值从 `default` 改成 `bypassPermissions`：没有显式配置过的用户默认放开权限。
- 新会话启动时强制 `bypassPermissions` + `effort: 'high'`（`ConversationService.startSession`）。显式传了非 `default` 的权限模式（例如 `plan`）就尊重调用方。

## 二、系统代理支持"绝对路径形式的 HTTPS 请求"

桌面端的系统代理桥（SystemProxyBridge）原来只支持 HTTP 的绝对 URI 转发，遇到 HTTPS 绝对 URI 直接回 400 让客户端走 CONNECT。现在新增 `forwardAbsoluteUriHttps`：直接对目标主机建 TLS 连接、把请求改写成标准形式转发、响应原样写回。附带一批 TLS 测试证书和 195 行测试。

> 简单说：某些客户端发 HTTPS 请求时不走 CONNECT 隧道，以前会挂，现在能正常通了。

## 三、Windows 安装包：自动配防火墙，手机才能访问 H5

上游装完后，手机连局域网访问桌面的 H5 页面会被 Windows 防火墙拦掉，得手动手动加规则。现在安装程序（NSIS）自动完成：

- 新增 `desktop/build/firewall.nsh`，安装时通过 `netsh advfirewall` 给主程序和内置的 claude-sidecar 可执行文件建**入站放行规则**，范围仅限局域网（localsubnet），卸载时自动删除。
- 因为 H5 端口是运行时随机选的，所以规则按"程序"而不是按"端口"来配——程序监听哪个端口都放行。
- 失败不阻断安装（普通用户没管理员权限时装完也能用，只是手机访问不了），并提示可以事后用 `__scripts/fix-cc-haha-h5-admin.ps1` 补配。
- 有专门的安装器防火墙规则测试（`scripts/pr/windows-installer-firewall.test.ts`）。

## 四、Windows 构建脚本：绕开 bun 的坑

`desktop/scripts/build-windows-x64.ps1` 里原来用 `bunx` 跑 electron-builder，但 bun 在 NodeModuleCollector 遍历时会静默崩溃。改成直接用 `node` 调 electron-builder 的 CLI 入口。纯构建环境问题修复，不影响功能。

`desktop/package.json` 里 `electron-builder` 升到 `^26.18.0`，并配置了本机 electron 下载缓存（`electronDownload.cache`，仅本机路径，换机器要删）。

## 五、飞书适配器：兼容单语言 Post 消息

飞书富文本（post 类型）上游只解析多语言结构（`zh_cn`/`en_us` 包裹），遇到单语言直出的 `{title, content}` 结构会解析出空内容。现在两种结构都兼容。

## 六、工具 schema 与隧道地址自动放行

- `src/utils/zodToJsonSchema.ts`：工具入参是 union 且每个分支都是 object 时，把 `type: "object"` 提升到顶层（Anthropic API 要求顶层声明 object）。
- 隧道地址自动进 H5 白名单：`PublicAccessSettings` 在隧道上线后，把 `publicUrl` 的 origin 自动加进 H5 访问的 `allowedOrigins`，通过隧道访问的 H5 页面因此不会被 Origin 校验拦住。同步是尽力而为，失败不影响隧道本身。

## 七、个人工具脚本（不属于产品改动）

- `__scripts/__cc-haha-op.sh`：个人的仓库操作菜单脚本（同步 upstream、构建 Windows 包等）。
- `__scripts/fix-cc-haha-h5-admin.ps1`：手动配防火墙的补救脚本，自动提权 + 探测端口，供安装程序没配成功时用。
- `__scripts/cloudflared-service-instal-admin.ps1`：cloudflared 服务注册（管理员）。
- `preview-agent.js`：本地重新打包的产物，含预览页的缩放控件 UI。
- `.gitignore`：放行测试用的回环 TLS 证书文件（`__fixtures__/*.pem/*.key`）。

## 本次同步记录（2026-11-18）

- `main` 合并上游 `upstream/main`（v0.7.8，`79b1bf9b`），冲突按 `BURNFILE-CUSTOMIZATIONS.md` 处理：
  - 丢弃本地已过期的 `effort` 键位改动与 `defaultMode → permissions.defaultMode` 搬家（上游已实现）。
  - 保留默认权限模式 `bypassPermissions`、新会话 `effort: high`、系统代理 absolute-URI HTTPS、飞书单语言 post、Windows 防火墙规则、构建脚本改用 node 等本分支特性。
  - `desktop/package.json` 的顶层 `artifactName` 丢弃（上游已改为按平台分别配置），保留本机 electron 缓存与 electron-builder 版本升级。
- `burnlife001` 已 rebase 到最新的 `main`，两者内容一致。

## 一句话总结

这个分支相对上游干了三件事：
**把默认权限放开（默认 `bypassPermissions`、新会话 `effort=high`）**、
**让系统代理能处理非 CONNECT 的 HTTPS 请求**、
**让 Windows 装完就能用手机访问 H5（自动防火墙规则 + 隧道地址自动进白名单）**，外加一些构建环境、工具 schema 和飞书消息兼容的小修。
