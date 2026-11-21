# cc-mods 挂接点清单

与上游（NanmiCoder/cc-haha）的全部接触面。**合并上游后按此清单核对**：每处都是一行
调用或一个追加项，语义独立；若上游改动使某行失效，行为退化为“该事件不再分发”，不会
破坏核心功能。

## 上游文件改动（共 4 处）

| # | 文件 | 改动 | 用途 |
|---|------|------|------|
| 1 | `src/services/tools/toolExecution.ts` | 函数顶部 `await modsToolCall(...)` + 文件尾 `flattenModsResult` 辅助函数 + 1 行 import | `tool.call` 拦截 / `{deny}` / `{result}` 替换（唯一无现成接缝的热路径） |
| 2 | `preload.ts` | 文件尾动态 `import('./src/mods/index.js').then(m => m.installMods())`（try/catch 包裹） | 会话早期加载 mods；失败时由 #1 的静态 import 惰性兜底 |
| 3 | `src/commands.ts` | `getCommands` 内 `...modsLocalCommands()` 追加 + 1 行 import | mod 运行时注册的斜杠命令（LocalCommand 桥） |
| 4 | `src/constants/prompts.ts` | `getSystemPrompt` 返回前 `await modsComposePromptSections(...)` + 1 行 import | `prompt.compose` 事件 |

## 零改动的现成接缝（直接利用）

- `registerHookCallbacks`（`src/bootstrap/state.ts`）— `classic.*` 事件桥
  （SessionStart/End、UserPromptSubmit、PreToolUse、PostToolUse、Notification、
  PreCompact、SubagentStop），引擎加载后程序化注册。
  M4 起，桥在分发前用 `normalizeClassicEvent`（`events.ts`）补齐
  `session_id` / `transcript_path` / `cwd` / `hook_event_name`（已有的值优先），
  并把 `classic.PreToolUse` 的 `tool_name` / `tool_input` 整形为契约的
  ToolCallEnvelope（`tool` / `tool_use_id` + 平铺参数，原始字段保留）。
- `~/.claude/settings.json` 的 `enabledPlugins` + `plugins/installed_plugins.json`
  的 `installPath` — mods 加载器直接读原始 `hooks/hooks.json` 的 `modules`
  （上游 zod schema 会剥离该字段，故绕过、不改 schema）。
- `getSessionUsageSnapshot`（`src/cost-tracker.ts`）— `session.usage` /
  `session.measure` 的成本读数。
- `getTranscriptPath`（`src/utils/sessionStorage.ts`）— `session.info` 的
  `transcriptPath`，惰性 import，引擎加载时不拉起会话存储。
- `sideQuery`（`src/utils/sideQuery.ts`）— `model.complete` / `model.classify`
  的真实调用；`calculateUSDCost` + `addToTotalSessionCost` 记账。

## 挂接状态（M5 更新）

| 事件/名词 | 现状 | 后续 |
|---|---|---|
| `session.measure` | 已挂接：`claude.ts` 的 `finally` 在 usage 落账后（streaming 与 fallback 两支之后）fire-and-forget 调 `modsEmitSessionMeasure()`，每次 API 响应一次；无 hook 时零成本返回 | — |
| `session.identity` | 已接只读身份：provider env（bedrock/vertex/foundry/azure-openai）、host 手递 token（`ANTHROPIC_AUTH_TOKEN` / `CLAUDE_CODE_OAUTH_TOKEN`）、`ANTHROPIC_API_KEY`、`settings.apiKeyHelper` 是否存在、global config 的 `oauthAccount` / `primaryApiKey`。`isVerified` 恒 `false`（只有磁盘记录，没有服务器答复）；org/email 仅在 managed `forceLoginOrgUUID` 命中时给出 | 如需 macOS keychain 登录态，需引入不弹窗的读取路径 |
| `session.authorize` | 诚实 `{ deny }`：契约的 handle 要经 `$.http.fetch(url, { auth })` 花费，cc-haha 没有这条桥 | 凭据 handle 桥 |
| `model.fork` | 诚实 `{ deny }`：只有 transcript 文件路径（`getTranscriptPath`），没有主线程 last-request 快照（model/system/tools/messages）可复用缓存前缀 | fork 快照对象 |
| `prompt.read` / `prompt.paint` | 诚实 `{ deny }`：prompt box 在 UI 层 | M3 UI surfaces |
| `wasm.compile` | 诚实 `{ deny }`：进程内无 wat→wasm 编译器 | 真实编译器 |
| `agent.list` | 返回 `[]`：运行中的 loop 只存在 `AppState.tasks`（`getRunningTasks(state)`），是每个 React 树的 store，进程侧引擎拿不到；`agent.register` 注册的是类型定义 | 进程级运行中 loop 注册表 |


## 新增目录（自包含）

`src/mods/` — engine / loader / nouns / events / types / index / contract /
测试。上游无需了解内部结构，只依赖 `src/mods/index.js` 的导出。
