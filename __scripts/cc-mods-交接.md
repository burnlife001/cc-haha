# cc-mods 引擎移植 — 交接文档

> 仓库：`E:/__work/__github/__cc_opc/02.cc-haha`（NanmiCoder/cc-haha 上游 + 本地改动，分支 `burnlife001`）
> 目标：与官方 Claude Code **v2.1.328** 源码兼容的进程内 cc-mods 引擎，让官方 cc-mods 插件（`E:/__work/BaseTools/codingTools/cc-mods`）零修改运行。
> 更新日期：2026-11-20

---

## 1. 状态总览

| 里程碑 | 状态 |
|---|---|
| M1 引擎核心 + 非 UI 事件 | ✅ 完成并验收（9 test） |
| M2 测试/校验闭环（`claude plugin test/validate`） | ✅ 完成并验收（+19 test） |
| M4 进阶名词（虚拟名词/session/config/classic 信封） | ✅ 完成并验收（+20 test，现共 **48 test**） |
| M3 UI surfaces（terminal + desktop） | ⬜ 未开始（下一步主线） |
| M5 待接 seam | ⬜ 见第 4 节清单 |

- **全部改动未提交**（仓库 AGENTS.md 规定未经明确要求不 commit）。
- 测试基线：`bun test src/mods/mods.test.ts src/mods/testing/mod-testing.test.ts` = 48 pass / 0 fail；`bunx tsc --noEmit` 非 tauri 错误 0。

## 2. 已完成（验收通过，无需再动）

- **M1**：`src/mods/`（engine/loader/nouns/events/types/index + contract d.ts + INTEGRATION.md）。上游仅 4 处单行挂接：`toolExecution.ts`（tool.call 拦截）、`preload.ts`、`commands.ts`、`constants/prompts.ts`。
- **M2**：`src/mods/testing/` + `src/mods/opEvents.ts`。`claude plugin test/validate`、`--write-types` 闭环。关键：`emitOp` 的 hook 侧 `e` 改为契约 `OpEventOf` 形。
- **M4**：进阶名词。tool/agent/command 虚拟名词注册表、`session.info/machine/usage`、`config.list/describe`、classic 完整信封（`events.ts` `normalizeClassicEvent`）、surface 桩；`model.classify/complete` 经 `sideQuery` 真实调用；`session.measure` 组装+分发 seam。

## 3. 未完成 — M3 UI surfaces（下一步主线）

当前 `$.ui.mount` 明确抛错、所有 UI 名词无 surface 桥。计划范围：

- **元素表**：`Elements['terminal'|'desktop'|'mobile'|'vscode']`（`RENDER_SURFACES` 已定义于 `events.ts`）。
- **全链路**：`ui.render` / `ui.resolve` / `ui.press` / `ui.input` / `ui.select` / `ui.scroll` / `ui.focus` / `ui.message` / `ui.fault`。
- **Terminal Ink 桥**：AbovePrompt 横条、ToolUse 卡片、Pane、状态栏、toast；`ui.blit` Raster ~60fps 预算。
- **Desktop**：server 事件 → `desktop/src` React 组件（pane host/toast/status），交互事件回传引擎。
- **其余 UI 名词**：`theme.set/clear`、`ui.notify/cancelNotify`、`ui.log/notice/invalidate`、`ui.copy/selection/view`、`audio.play/speak`。
- **prompt.read / prompt.paint**：prompt box 在 UI 层（Ink composer / 桌面原生编辑器），M4 已诚实 deny，在此里程碑实现。
- **验收**：`mods功能全景.md` 中 P1 UI 类 mod（AbovePrompt 状态条、工具行卡片、右键菜单、watchdog 面板）在桌面端运行。

## 4. 未完成 — M5 待接 seam 清单（`src/mods/INTEGRATION.md`「尚未挂接」表）

| 事件/名词 | 现状 | 需要的挂接 |
|---|---|---|
| `session.measure` | 组装+分发已就绪，无生产调用点 | turn 循环在 API 响应落账后加 1 行 `void modsEmitSessionMeasure()`；**勿从 `cost-tracker.ts` 反向 import**（与 `nouns.ts` 成环） |
| `session.identity` / `session.authorize` | 诚实 `{ deny }` | 凭据读取器（keychain/OAuth）只读封装 |
| `model.fork` | 诚实 `{ deny }` | 主线程 transcript 快照对象 |
| `agent.list` | 返回 `[]` | 运行中 agent 的注册表 |
| `wasm.compile` | 诚实 `{ deny }` | 真实编译器 |
| `prompt.read` / `prompt.paint` | 诚实 `{ deny }` | M3 UI surfaces |

M4 范围外仍 deny 的名词（未扩大改动面）：`config.set`、`mcp.call/connect`、`skill.prompt`、`process.hookEnv`、`session.turns/messages`、`agent.spawn/offer/call`。

## 5. 需要 review 的未决项（M4 报告第 5 节，供人决策）

1. **`agent.list` 契约冲突（最需拍板）**：契约 `AgentInfo` 描述「运行中的 agent loop」（必填 `id/status/taskStatus/label/startTime/tokenCount/...`），而 `agent.register` 注册的是「类型定义」。M4 选择 `agent.list()` 返回 `[]`（不编造运行时字段），注册项经导出的 `modsRegisteredAgents()` 读取。若要求回显注册项，需先决定哪些字段做「定义态占位」（如 `status:'pending'`、`tokenCount:0`）。
2. **`session.usage` 缺字段**：`context.tokens/percent`、`rateLimits` 无 seam，按契约可选字段省略。若要补，最小接缝是 API 层把最后响应 usage 暴露到 `bootstrap/state`。
3. **`model.classify/complete` 无 live 证据**：是真实调用路径（`sideQuery`），但未消耗真实模型配额验证；形状/分支未 mock 伪造。
4. **`command.describe` 返回形状变更**：M1/M2 是 `{commands:[...]}`，M4 改为契约 `CommandDescribeResult`（`{description, argumentHint?, isHidden}`）。已 `rg` 确认仓库内无其他消费者，但若上游合并后有消费者需注意。
5. **`session.surfaces` 去掉 `'desktop'`**：M4 从 `['terminal','desktop']` 改为 `['terminal']`（桌面桥尚未存在，声称已挂载会让 `$.ui.open` 误判）。M3 桌面桥落地后恢复。
6. **校验变严**：`tool.register` 名称须匹配 `/^[A-Za-z0-9_-]{1,64}$/`、`agent.register` 要求非空 `prompt`、`command.register` 要求字符串 `description`——比 M1 更严，契约本就如此。

## 6. 环境硬约束（必须遵守）

- **跑 bun 前先清 CALLER_DIR**：PowerShell `Remove-Item Env:CALLER_DIR`；bash `unset CALLER_DIR`（bunfig preload chdir 陷阱，见 `~/.claude/windows-pitfalls.md` #37）。
- **不 commit**（AGENTS.md 规定）。
- **测试排除**（既存失败，与本工作无关）：`src/server/__tests__/diagnostics-service.test.ts`（Windows EBUSY/超时）；`bun run check:agent-e2e` 会挂起。
- 工作区既有 git status（勿动）：`M desktop/src-tauri/resources/preview-agent.js`、`?? __scripts/`。

## 7. 关键文件 / 路径

| 项 | 路径 |
|---|---|
| 完整计划 | `C:\Users\yg\.claude\plans\moonlit-singing-treasure.md` |
| 契约 d.ts（唯一权威） | `src/mods/contract/claude-code-2.1.328.d.ts` |
| 挂接点清单 | `src/mods/INTEGRATION.md` |
| M2 / M4 交付报告 | `D:/tmp/ccc-mods-m2-report.md`、`D:/tmp/ccc-mods-m4-report.md` |
| 项目记忆 | `C:\Users\yg\.claude\projects\D--Downloads\memory\project-cc-haha-cc-mods.md` |

## 8. 如何继续（委派方式，M2/M4 已跑通）

1. 写自包含任务书（`D:/tmp/ccc-mods-<M3>-todolist.md`），必写：验收标准、交付绝对路径双形态、环境硬约束（CALLER_DIR）、止损规则。
2. 委派：`bash "C:/Users/yg/.claude/skills/ccc/scripts/ccc.sh" run --quiet --profile cb:DeepSeek-V4.1-Flash --prompt-file <任务书> --work-dir E:/__work/__github/__cc_opc/02.cc-haha`
3. **陷阱**：`src/mods/` 未纳入 git，ccc 用 git-diff 判断「子代理是否改了文件」，检测不到 untracked 目录 → 误报 `blocked`。委派前先 `git add -N src/mods/`（intent-to-add）或在任务书里写明「改动落在 untracked 目录」。
4. 终态 `blocked` 别急着重跑：先 `git status` + 交付文件 `test -f` + 回归测试自己验，区分真失败与误报。
5. 验收清单：测试全绿 → tsc 非 tauri 0 → 交付文件落盘 → 关键断言抽样核验 → git status 仅允许文件。通过删任务书，失败写 `todolist-problem.md`。
