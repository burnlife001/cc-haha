# 本分支（burnlife001）与上游（NanmiCoder/cc-haha main）的差异说明

## 一、修了两个"设置不生效"的真 Bug（最重要的改动）

上游代码里，桌面端把权限模式和思考强度存错了字段名，导致 CLI 根本读不到：

- **权限模式**：上游存在顶层的 `defaultMode`，但 CLI 只认 `permissions.defaultMode`——所以你在界面上改了权限模式，实际运行完全没变化。现在改成写入 `permissions.defaultMode`。
- **思考强度（effort）**：上游存在 `effort`，CLI 只认 `effortLevel`——同理，改了不生效。现在统一用 `effortLevel`。

配套做了一次**存量数据自动迁移**：启动时检查 `settings.json`，把旧的 `defaultMode`、`effort` 搬到新字段（已有新字段的不会被旧值覆盖），老用户升级后设置无缝衔接。

涉及文件：`src/server/services/settingsService.ts`、`persistentStorageMigrations.ts`、`api/models.ts`、`ws/handler.ts`，外加迁移和设置的回归测试。

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

## 五、飞书适配器：兼容单语言 Post 消息

飞书富文本（post 类型）上游只解析多语言结构（`zh_cn`/`en_us` 包裹），遇到单语言直出的 `{title, content}` 结构会解析出空内容。现在两种结构都兼容。

## 六、个人工具脚本（不属于产品改动）

- `__scripts/__cc-haha-op.sh`：个人的仓库操作菜单脚本（同步 upstream、构建 Windows 包等）。
- `__scripts/fix-cc-haha-h5-admin.ps1`（未提交）：手动配防火墙的补救脚本，自动提权 + 探测端口，供安装程序没配成功时用。
- `preview-agent.js`：本地重新打包的压缩产物，仅压缩变量名重排，无逻辑变化。
- `.gitignore`：放行测试用的回环 TLS 证书文件（`__fixtures__/*.pem/*.key`）。

## 一句话总结

这个分支相对上游干了三件事：
**修了权限模式和思考强度"改了不生效"的设置字段 bug（含老数据自动迁移）
**、**让系统代理能处理非 CONNECT 的 HTTPS 请求**、
**让 Windows 装完就能用手机访问 H5（自动防火墙规则）**，外加一些构建环境和飞书消息兼容的小修。
