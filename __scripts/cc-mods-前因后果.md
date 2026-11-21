# cc-mods 移植 · 前因后果

## 前因

`@command://ccc` 委派 `__scripts/cc-mods-交接.md`，要求「先 M5，后 M3」。目标：把官方 Claude Code v2.1.328 的 cc-mods 插件 API 移植成 cc-haha 的进程内引擎。M1/M2/M4 已验收。

## M5（完成并保留）

5 个 seam 落地。按需访问的文件链：

- `src/services/api/claude.ts` — 唯一上游改动，usage 落账后 fire-and-forget 调 `modsEmitSessionMeasure()`
- `src/mods/nouns.ts` — `session.identity` 只读实现；`session.authorize`/`model.fork`/`agent.list`/`wasm.compile` 诚实 deny
- `src/mods/mods.test.ts`、`src/mods/INTEGRATION.md` — 配套断言与挂接状态表

验收：50 pass / tsc 非 tauri 0 错误。

## M3（委派后完整回退）

P0 surface 桥完成、P1 terminal 最小可用、P2 desktop 未做，验收 57 pass。判定方向错误：cc-mods UI 契约照抄 Claude Code 自身 UI，cc-haha 的 Ink/Electron 没有对应宿主，投入产出不成比例。

回退动作：

- 删除 `src/mods/surfaces.ts`、`elements.ts`、`terminal.ts`、`terminal-host.tsx`
- 还原 `engine.ts`、`index.ts`、`events.ts`、`opEvents.ts`、`REPL.tsx`
- 从 `nouns.ts`、`mods.test.ts`、`INTEGRATION.md` 逐段剥离 M3 改动、保留 M5

回到 50 pass / tsc 0 / git 干净。M3 报告留 `D:/tmp/ccc-mods-M3-report.md` 备查。

## 调试基线

`tsc --noEmit` 热跑 4.4–4.8 秒、冷启 16 秒；`bun test` 2 秒。

## 脚本菜单

`__scripts/__cc-haha-op.sh` 新增 `5. dev-ide`，命令行别名 `dev-ide|ide|5`，执行 `cd desktop && bun run electron:dev`。早先的 `bun run start` CLI 项已删除。语法校验通过。

2026-11-21 追加：新增 `6. rebuild-sidecars`（别名 `sidecars|6`，`cd desktop && bun run build:sidecars`，全量非增量，改 `src/mods` 后桌面要重编才生效）；菜单 5 启动前自动检查 `src/`、`desktop/sidecars/`、`preload.ts`、`bunfig.toml` 是否比 sidecar exe 新，新则黄字提示先跑 6。

## 版本 / exe

CLI 实际 `999.0.0-local`（非 999.9）；桌面 `0.7.8`。Exe：`desktop/build-artifacts/windows-x64/win-unpacked/Claude Code Haha.exe`。

## electron:dev 报错修复

报 `Electron executable not found`。根因：`electron@42.7.0` 只装了 npm 包、`dist` 为空（postinstall 被跳过）。用本地 `E:/__work/BaseTools/electron/electron-v42.7.0-win32-x64.zip`（SHA-256 与官方 `checksums.json` 一致）解压到 `node_modules/electron/dist` 并写 `path.txt`，`electron.exe --version` → `v42.7.0`。菜单 5 可重跑。若 `bun install` 再次清空 dist，可在 `dev_ide` 中加自检恢复逻辑。

## 按需访问原则

每步只读相关文件：M5 读 `claude.ts`/`nouns.ts`；M3 回退读 `engine.ts`/`index.ts`/`opEvents.ts`/`REPL.tsx`；脚本只读 `__cc-haha-op.sh`；Electron 修复只读 `install.js` 与本地 zip。未碰无关源码。所有改动留在 working tree，未 commit。

## 2026-11-21 排查：子代理仍显示原模型

**现象**：`subagentmods` 插件（hook `tool.call {tool:'Agent'}` → `$.process.run(['ccc','minimax-m3.1-flash','-p',task])`）预期把 Agent 调用换成 MiniMax worker，实际子代理仍以原模型运行。

**结论（证据链闭合）**：

1. 工作树代码无缺陷。进程内 repro（`d:/tmp/mods-repro.ts`，加载真实插件 + 真实 `modsToolCall`）真实拉起 `ccc minimax-m3.1-flash` 并返回 `resolvedModel: 'MiniMax-M3.1-Flash'`。
2. 真实 CLI 端到端通过：新增 mock-LLM 场景 `mock-mods-agent-intercept`（`scripts/quality-gate/mock-llm/scenarios.ts`），fixture 插件在沙箱 `CLAUDE_CONFIG_DIR` staging，断言 Agent 调用被替换、无原生子代理上游请求 → `{"intercepted": true, "nativeSubagentSpawned": false}`。
3. **根因（用户侧）**：打包版 `E:/__work/BaseTools/Claude Code Haha/resources/app.asar` 中 `modsToolCall`/`cc-mods` 零命中 —— 安装版不含 mods 代码；在打包版里跑子代理必然不生效。**dev CLI（`bun run start`）已验证生效**（e2e 场景走的就是 `bun run src/server/index.ts` + `bin/claude-haha` 源码路径）。

**更正（2026-11-21 追加）**：`electron:dev`（菜单 5）**不含 mods**。桌面 dev 的 Electron 壳是工作树新代码，但它经 `serverRuntime → createServerPlan → resolveSidecarExecutable` 拉起的 server 与每个会话的 CLI 都是编译产物 `desktop/src-tauri/binaries/claude-sidecar-x86_64-pc-windows-msvc.exe`（2026-11-19 17:32 构建；`modsToolCall`/`modsEmitSessionMeasure`/`subagentmods` 等唯一字符串零命中）。`electron:dev` 脚本不含 `build:sidecars`，不会重编。桌面要用 mods 必须先 `cd desktop && bun run build:sidecars` 重编该 exe，再跑菜单 5。

**改动**：

- `scripts/quality-gate/mock-llm/scenarios.ts`：新场景 `mock-mods-agent-intercept` + 场景注册。
- `src/mods/mods.test.ts`：`session.identity` 测试补 env 隔离（宿主 `CLAUDE_CODE_OAUTH_TOKEN` 曾使本机跑出 `oauth-token` 而非 `claude.ai`）。50 pass。

**环境坑**：

- 该 lane 在本机 teardown 必挂起（既有问题，非本次引入）；场景断言错误会被吞，场景内已加 `mods-agent-intercept.error.txt` 落盘兜底。验证方式：盯 `artifacts/agent-e2e/mods-agent-intercept.json` 出现即 kill harness。
- kill harness bun 会孤儿化 `src/server/index.ts` 子进程，需手动清。
