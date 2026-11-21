// Core implementations for the non-UI `$` nouns. Each noun method is
// dispatched by the engine as an op event; this module is the innermost
// (core) handler — see ModEngine.registerNounCore.

import { promises as fsp, statSync } from 'fs'
import * as os from 'os'
import { homedir } from 'os'
import path from 'path'
import {
  getOriginalCwd,
  getProjectRoot,
  getSessionId,
  getTotalDuration,
} from '../bootstrap/state.js'
import type { NounCore } from './engine.js'

const MAX_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024

// Per-plugin, per-process memory. Officially `$.store` persists across
// sessions; persistence lands with the M2 storage seam.
const pluginStore = new Map<string, Map<string, unknown>>()
const pluginState = new Map<string, Map<string, unknown>>()

function storeFor(plugin: string): Map<string, unknown> {
  let m = pluginStore.get(plugin)
  if (!m) {
    m = new Map()
    pluginStore.set(plugin, m)
  }
  return m
}

function stateFor(plugin: string): Map<string, unknown> {
  let m = pluginState.get(plugin)
  if (!m) {
    m = new Map()
    pluginState.set(plugin, m)
  }
  return m
}

// --- virtual noun registry ------------------------------------------------
//
// `tool.register`, `agent.register` and `command.register` keep process-local
// definitions. They are the plugin's declarations, not live objects: no tool
// runs from this map and no agent loop starts from it. The engine's own tool
// pool is untouched, so `$.tool.call` still reaches cc-haha's tools.

type RegisteredCommand = {
  plugin: string
  name: string
  description: string
  argumentHint?: string
  immediate?: true
}

type RegisteredTool = {
  plugin: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
  isDeferred?: boolean
}

type RegisteredAgent = {
  plugin: string
  name: string
  description: string
  prompt: string
  spec: Record<string, unknown>
}

const registeredCommands = new Map<string, RegisteredCommand>()
const registeredTools = new Map<string, RegisteredTool>()
const registeredAgents = new Map<string, RegisteredAgent>()

// Contract names: letters, digits, `_` and `-`, up to 64 (ToolSpec.name,
// AgentSpec.name, CommandSpec.name all state the same rule).
const NOUN_NAME = /^[A-Za-z0-9_-]{1,64}$/

export function modsRegisteredCommands(): RegisteredCommand[] {
  return [...registeredCommands.values()]
}

export function modsRegisteredTools(): RegisteredTool[] {
  return [...registeredTools.values()]
}

export function modsRegisteredAgents(): RegisteredAgent[] {
  return [...registeredAgents.values()]
}

export function clearModsRegisteredCommands(): void {
  registeredCommands.clear()
}

/** Test seam: empties every virtual noun registry and the measure baseline. */
export function __resetModsNounRegistry(): void {
  registeredCommands.clear()
  registeredTools.clear()
  registeredAgents.clear()
  lastMeasure = null
}

// Tools are keyed `<plugin>:<name>`: the model-facing name is
// `mcp__<plugin>__<name>`, so two plugins may both declare `lint` without one
// silently replacing the other.
function toolKey(plugin: string, name: string): string {
  return `${plugin}:${name}`
}

function findTool(plugin: string, name: string): RegisteredTool | undefined {
  return (
    registeredTools.get(toolKey(plugin, name)) ??
    [...registeredTools.values()].find(tool => tool.name === name)
  )
}

async function runProcess(
  cmd: string[],
  options?: { timeoutMs?: number; cwd?: string },
): Promise<{
  exitCode: number
  stdout: string
  stderr: string
  isStdoutTruncated: boolean
  isStderrTruncated: boolean
}> {
  const proc = Bun.spawn(cmd, {
    cwd: options?.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  })
  const timeoutMs = options?.timeoutMs ?? 600_000
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  try {
    const [stdoutBuf, stderrBuf, exitCode] = await Promise.all([
      cappedRead(proc.stdout, MAX_PROCESS_OUTPUT_BYTES),
      cappedRead(proc.stderr, MAX_PROCESS_OUTPUT_BYTES),
      proc.exited,
    ])
    return {
      exitCode,
      stdout: stdoutBuf.text,
      stderr: stderrBuf.text,
      isStdoutTruncated: stdoutBuf.truncated,
      isStderrTruncated: stderrBuf.truncated,
    }
  } finally {
    clearTimeout(timer)
  }
}

async function cappedRead(
  stream: ReadableStream<Uint8Array> | null,
  max: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!stream) return { text: '', truncated: false }
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      if (size + value.length > max) {
        chunks.push(value.slice(0, max - size))
        truncated = true
        size = max
        // Drain without retaining so the process is not blocked on a full
        // pipe, then stop.
        void reader.cancel().catch(() => {})
        break
      }
      chunks.push(value)
      size += value.length
    }
  }
  const decoder = new TextDecoder()
  return { text: chunks.map(c => decoder.decode(c)).join(''), truncated }
}

function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude')
}

async function readSettings(): Promise<Record<string, unknown>> {
  const merge = (
    target: Record<string, unknown>,
    source: Record<string, unknown>,
  ) => {
    for (const [k, v] of Object.entries(source)) target[k] = v
  }
  const out: Record<string, unknown> = {}
  try {
    merge(out, JSON.parse(await fsp.readFile(path.join(claudeHome(), 'settings.json'), 'utf-8')))
  } catch {
    // missing settings is fine
  }
  try {
    merge(out, JSON.parse(await fsp.readFile(path.join(claudeHome(), 'settings.local.json'), 'utf-8')))
  } catch {
    // missing local settings is fine
  }
  return out
}

const deny = (reason: string) => ({ deny: reason })

// --- session helpers ------------------------------------------------------

type SessionPlatform = 'macos' | 'windows' | 'wsl' | 'linux' | 'unknown'

// Contract SessionInfo.platform: `wsl` is Linux under Windows.
function currentPlatform(): SessionPlatform {
  if (process.platform === 'win32') return 'windows'
  if (process.platform === 'darwin') return 'macos'
  if (process.platform === 'linux') {
    return process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP
      ? 'wsl'
      : 'linux'
  }
  return 'unknown'
}

// getTranscriptPath() lives in sessionStorage.ts, which reaches commands.ts
// and therefore back into this module; import it only when a caller asks, so
// loading the engine never pulls the session store. A session that keeps no
// transcript on this machine answers '' as the contract allows.
async function safeTranscriptPath(): Promise<string> {
  try {
    const { getTranscriptPath } = await import('../utils/sessionStorage.js')
    return getTranscriptPath()
  } catch {
    return ''
  }
}

// PATH lookup for `session.machine`. Commands are read from disk, never run.
function isOnPath(name: string): boolean {
  const dirs = (process.env.PATH ?? '').split(path.delimiter)
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
          .split(';')
          .filter(Boolean)
          .map(ext => ext.toLowerCase())
      : ['']
  for (const dir of dirs) {
    if (!dir) continue
    for (const ext of exts) {
      try {
        if (statSync(path.join(dir, name + ext)).isFile()) return true
      } catch {
        // not here; keep looking
      }
    }
  }
  return false
}

function machineArch(): string {
  const raw =
    typeof os.machine === 'function' ? os.machine() : process.arch
  switch (raw) {
    case 'x64':
      return 'x86_64'
    case 'ia32':
      return 'i386'
    case 'arm':
      return 'armv7l'
    default:
      return raw
  }
}

// Contract SessionMachine: six developer tools, each list in its stated order.
// Bun's `os` has no sysname(); the uname name is derived from the platform.
function unameSysname(): string {
  switch (process.platform) {
    case 'win32':
      return 'Windows_NT'
    case 'darwin':
      return 'Darwin'
    case 'linux':
      return 'Linux'
    default:
      return os.type()
  }
}

function sessionMachine() {
  return {
    sysname: unameSysname(),
    release: os.release(),
    machine: machineArch(),
    packageManagers: ['npm', 'yarn', 'pnpm'].filter(isOnPath),
    runtimes: ['bun', 'deno', 'node'].filter(isOnPath),
  }
}

type SessionContextUsage = {
  tokens?: number
  window: number
  percent?: number
}

type SessionUsageShape = {
  startedAt: number
  context: SessionContextUsage
  rateLimits: Array<{ kind: string; percentUsed: number; resetsAt?: string }>
  cost?: { usd: number; hasUnknownPrice?: true }
}

// The engine's cost ledger is the only usage seam cc-haha exposes here: it has
// totals and per-model rows, but no reading of the last response's context
// fill or of the account's rate-limit windows. Those stay absent rather than
// invented — `tokens`/`percent` and `rateLimits` are optional in the contract.
async function sessionUsage(): Promise<SessionUsageShape> {
  let window = 0
  try {
    const { getMainLoopModel } = await import('../utils/model/model.js')
    const { getContextWindowForModel } = await import('../utils/context.js')
    window = getContextWindowForModel(getMainLoopModel())
  } catch {
    // no model resolved yet (early load); window stays 0
  }

  const { getSessionUsageSnapshot } = await import('../cost-tracker.js')
  const snapshot = getSessionUsageSnapshot()

  return {
    // STATE.startTime is not exported; the engine's own elapsed wall time is.
    startedAt: Date.now() - getTotalDuration(),
    context: { window },
    rateLimits: [],
    cost: {
      usd: snapshot.totalCostUSD,
      ...(snapshot.hasUnknownModelCost ? { hasUnknownPrice: true as const } : {}),
    },
  }
}

// `session.measure` diffs against the last measurement this process raised.
// First call names every unit it has a figure for; afterwards only units that
// moved. Never empty while any figure exists, as the contract requires.
type UsageUnit = 'context' | 'rateLimits' | 'cost'
let lastMeasure: { tokens?: number; rateLimits: string; costUsd?: number } | null =
  null

export async function buildSessionMeasureInput(): Promise<{
  context: SessionContextUsage
  rateLimits: SessionUsageShape['rateLimits']
  cost?: SessionUsageShape['cost']
  changed: UsageUnit[]
}> {
  const usage = await sessionUsage()
  const rateLimits = JSON.stringify(usage.rateLimits)
  const current = {
    tokens: usage.context.tokens,
    rateLimits,
    costUsd: usage.cost?.usd,
  }
  const changed: UsageUnit[] = []
  if (lastMeasure === null) {
    if (usage.context.window > 0 || usage.context.tokens !== undefined) {
      changed.push('context')
    }
    if (usage.rateLimits.length > 0) changed.push('rateLimits')
    if (usage.cost !== undefined) changed.push('cost')
  } else {
    if (current.tokens !== lastMeasure.tokens) changed.push('context')
    if (current.rateLimits !== lastMeasure.rateLimits) changed.push('rateLimits')
    if (current.costUsd !== lastMeasure.costUsd) changed.push('cost')
  }
  lastMeasure = current
  return {
    context: usage.context,
    rateLimits: usage.rateLimits,
    ...(usage.cost !== undefined ? { cost: usage.cost } : {}),
    changed,
  }
}

// --- config helpers -------------------------------------------------------

type ConfigKind = 'boolean' | 'choice' | 'text' | 'number'

type ConfigRowShape = {
  key: string
  label: string
  description?: string
  kind: ConfigKind
  value: boolean | string | number | readonly string[]
  options?: readonly string[]
  provider: { plugin: string; tier: string }
  isLocked: boolean
}

// Settings values that have no /config row kind (objects, arrays, null) are
// left out; the contract's ConfigKind covers only these four.
function configKindOf(value: unknown): ConfigKind | null {
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'string') return 'text'
  return null
}

async function configRows(): Promise<ConfigRowShape[]> {
  const settings = await readSettings()
  const rows: ConfigRowShape[] = []
  for (const key of Object.keys(settings).sort()) {
    const value = settings[key]
    const kind = configKindOf(value)
    if (kind === null) continue
    rows.push({
      key,
      label: key,
      kind,
      value: value as boolean | string | number,
      provider: { plugin: 'engine', tier: 'core' },
      isLocked: false,
    })
  }
  return rows
}

// --- agent helpers --------------------------------------------------------

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? NaN : Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function envTruthy(value: string | undefined): boolean {
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

// --- identity helpers -----------------------------------------------------
//
// `session.identity` answers only what this process already holds in plain
// form: the provider env flags, a token its host handed it, settings, and the
// login record global config keeps. It never reads the platform keychain (a
// macOS read spawns `security`) and never makes a request, so `isVerified`
// stays false: no server answered this process here.
async function sessionIdentity(): Promise<Record<string, unknown>> {
  // Third-party providers authenticate through the environment, not a login.
  if (envTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)) {
    return { kind: 'bedrock', isVerified: false }
  }
  if (envTruthy(process.env.CLAUDE_CODE_USE_VERTEX)) {
    return { kind: 'vertex', isVerified: false }
  }
  if (envTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)) {
    return { kind: 'foundry', isVerified: false }
  }
  if (envTruthy(process.env.CLAUDE_CODE_USE_AZURE_OPENAI)) {
    return { kind: 'azure-openai', isVerified: false }
  }

  // A token the host handed this process (ssh proxy, CCR, setup-token).
  if (process.env.ANTHROPIC_AUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { kind: 'oauth-token', isVerified: false }
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { kind: 'api-key', isVerified: false }
  }

  // apiKeyHelper is a command, so only its presence is read; it is not run.
  const settings = await readSettings()
  if (typeof settings.apiKeyHelper === 'string' && settings.apiKeyHelper) {
    return { kind: 'api-key', isVerified: false }
  }

  try {
    const { getGlobalConfig } = await import('../utils/config.js')
    const config = getGlobalConfig()
    const account = config.oauthAccount
    if (account) {
      // Contract privacy gate: the organization and email leave the engine
      // only when a managed forceLoginOrgUUID names this account's org.
      const pin =
        typeof settings.forceLoginOrgUUID === 'string'
          ? settings.forceLoginOrgUUID
          : undefined
      const isPinned = pin !== undefined && pin === account.organizationUuid
      return {
        kind: 'claude.ai',
        isVerified: false,
        ...(isPinned
          ? {
              organizationId: account.organizationUuid,
              email: account.emailAddress,
            }
          : {}),
      }
    }
    if (config.primaryApiKey) return { kind: 'api-key', isVerified: false }
  } catch {
    return deny('session.identity could not read the login record')
  }

  // macOS keeps a console login's key in the keychain; reading it would spawn
  // `security`, so the engine refuses instead of claiming a signed-out
  // session it cannot see into.
  if (process.platform === 'darwin') {
    return deny(
      'session.identity cannot read the macOS keychain; no plain credential record names the login',
    )
  }
  return { kind: 'none', isVerified: false }
}

// Defaults follow the contract's own wording: 20 concurrent agents, and depth
// 1 (an agent started by the main conversation starts none).
function agentLimits() {
  return {
    concurrent: positiveInt(process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS, 20),
    depth: positiveInt(process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH, 1),
    isBackgroundEnabled: !envTruthy(
      process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS,
    ),
  }
}

// --- model helpers --------------------------------------------------------

type ModelUsageShape = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

function modelUsageShape(usage: {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
} | null | undefined): ModelUsageShape {
  return {
    input_tokens: usage?.input_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
    cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
  }
}

// Every answered `$.model` call joins the session's cost ledger, as /cost
// counts a mod's calls. Pricing is the CLI's own local estimate.
async function recordModelCall(
  model: string,
  usage: Parameters<typeof modelUsageShape>[0],
  rawUsage: unknown,
): Promise<ModelUsageShape> {
  const shaped = modelUsageShape(usage)
  try {
    const { addToTotalSessionCost } = await import('../cost-tracker.js')
    const { calculateUSDCost } = await import('../utils/modelCost.js')
    const cost = calculateUSDCost(model, rawUsage as never)
    if (cost > 0) addToTotalSessionCost(cost, rawUsage as never, model)
  } catch {
    // accounting is best-effort; the call's own result stands
  }
  return shaped
}

function modelApiError(status: number | null): string {
  switch (status) {
    case 401:
    case 403:
      return 'authentication_failed'
    case 400:
      return 'invalid_request'
    case 404:
      return 'model_not_found'
    case 429:
      return 'rate_limit'
    case 529:
      return 'overloaded'
    default:
      return status !== null && status >= 500 ? 'server_error' : 'unknown'
  }
}

function textOfBlocks(
  blocks: readonly { type?: string; text?: string }[] | undefined,
): string {
  return (blocks ?? [])
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('')
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function joinPrompt(prompt: unknown): string | null {
  if (typeof prompt === 'string') return prompt
  if (Array.isArray(prompt)) {
    const isTextBlock = (block: unknown): boolean =>
      typeof block === 'object' &&
      block !== null &&
      typeof (block as { text?: unknown }).text === 'string'
    if (!prompt.every(isTextBlock)) return null
    return (prompt as Array<{ text: string }>).map(block => block.text).join('')
  }
  return null
}

export const coreNouns: NounCore = async (event, args, plugin) => {
  switch (event) {
    // --- fs ---
    case 'fs.read':
      return await fsp.readFile(String(args[0]), 'utf-8')
    case 'fs.write':
      await fsp.writeFile(String(args[0]), String(args[1]))
      return {}
    case 'fs.list': {
      const entries = await fsp.readdir(String(args[0]), { withFileTypes: true })
      return entries.map(e => ({
        name: e.name,
        kind: e.isDirectory() ? 'directory' : 'file',
      }))
    }
    case 'fs.exists':
      return await fsp.access(String(args[0])).then(
        () => true,
        () => false,
      )
    case 'fs.stat': {
      const st = await fsp.stat(String(args[0]))
      return {
        kind: st.isDirectory() ? 'directory' : 'file',
        size: st.size,
        mtimeMs: st.mtimeMs,
        isLink: st.isSymbolicLink(),
      }
    }
    case 'fs.ancestors': {
      const out: string[] = []
      let cur = path.resolve(String(args[0]))
      for (;;) {
        out.push(cur)
        const parent = path.dirname(cur)
        if (parent === cur) break
        cur = parent
      }
      return out
    }

    // --- store / state ---
    case 'store.get':
      return storeFor(plugin).get(String(args[0]))
    case 'store.set':
      storeFor(plugin).set(String(args[0]), args[1])
      return {}
    case 'store.delete':
      return storeFor(plugin).delete(String(args[0]))
    case 'store.keys':
      return [...storeFor(plugin).keys()]
    case 'state.get':
      return stateFor(plugin).get(String(args[0]))
    case 'state.set':
      stateFor(plugin).set(String(args[0]), args[1])
      return {}

    // --- clock ---
    case 'clock.now':
      return Date.now()
    case 'clock.sleep':
      await new Promise(resolve => setTimeout(resolve, Number(args[0])))
      return {}
    case 'clock.after':
    case 'clock.every': {
      const ms = Number(args[0])
      const fn = args[1] as () => unknown
      const timer = setInterval(() => void fn(), ms)
      timer.unref?.()
      return { cancel: () => clearInterval(timer) }
    }

    // --- http ---
    case 'http.fetch': {
      const input = args[0] as RequestInfo | URL
      const init = args[1] as RequestInit | undefined
      const res = await fetch(input, init)
      return {
        status: res.status,
        ok: res.ok,
        headers: Object.fromEntries(res.headers.entries()),
        text: await res.text(),
      }
    }

    // --- process ---
    case 'process.run':
      return await runProcess(
        (args[0] as string[]).map(String),
        args[1] as { timeoutMs?: number; cwd?: string } | undefined,
      )
    case 'process.spawn': {
      const cmd = (args[0] as string[]).map(String)
      const proc = Bun.spawn(cmd, {
        stdout: 'inherit',
        stderr: 'inherit',
        stdin: 'inherit',
      })
      return {
        pid: proc.pid,
        kill: () => proc.kill(),
        done: proc.exited.then(exitCode => ({ exitCode })),
      }
    }
    case 'process.hookEnv':
      return deny('process.hookEnv is not implemented in this runtime yet')

    // --- env / settings ---
    case 'env.get':
      return process.env[String(args[0])]
    case 'env.set': {
      const key = String(args[0])
      const value = args[1]
      if (value === undefined || value === null) delete process.env[key]
      else process.env[key] = String(value)
      return {}
    }
    case 'settings.read': {
      const settings = await readSettings()
      const key = args[0]
      if (typeof key === 'string' && key) return settings[key]
      return settings
    }

    // --- session ---
    case 'session.cwd':
      return getOriginalCwd() ?? process.cwd()
    case 'session.root':
      return getProjectRoot() ?? process.cwd()
    case 'session.id':
      return getSessionId()
    case 'session.version':
      return process.env.CC_HAHA_VERSION ?? 'cc-haha'
    case 'session.surface':
      // Contract RenderSurface is 'terminal' | 'desktop' | 'mobile' | 'vscode'.
      // cc-haha attaches the terminal surface; desktop/mobile/vscode bridges
      // are M3. Claiming one here would make `$.ui.open` look drawable.
      return 'terminal'
    case 'session.surfaces':
      return ['terminal']
    case 'session.model':
      return process.env.ANTHROPIC_MODEL ?? null
    case 'session.repo': {
      try {
        const { execSync } = await import('child_process')
        return execSync('git rev-parse --show-toplevel', {
          encoding: 'utf-8',
        }).trim()
      } catch {
        return null
      }
    }
    case 'session.turns':
    case 'session.messages':
      return deny(`${event} is not implemented in this runtime yet`)
    case 'session.usage':
      return await sessionUsage()
    case 'session.info': {
      const cwd = getOriginalCwd() ?? process.cwd()
      const root = getProjectRoot()
      return {
        transcriptPath: await safeTranscriptPath(),
        platform: currentPlatform(),
        isHosted: false,
        // Only when settings are read from a folder other than where the
        // session stands, per SessionInfo.configRoot.
        ...(root && root !== cwd ? { configRoot: root } : {}),
      }
    }
    case 'session.machine':
      return sessionMachine()
    case 'session.identity':
      // Read-only: provider env flags, settings and the login record in
      // global config; see sessionIdentity above.
      return await sessionIdentity()
    case 'session.authorize':
      // The contract's handle is spent through `$.http.fetch(url, { auth })`.
      // cc-haha has no such bridge, and a handle nothing can spend would be a
      // fiction, so this noun stays refused even though identity answers.
      return deny(
        'session.authorize needs a credential reader with a spendable handle; cc-haha exposes no http.auth bridge yet',
      )

    // --- command ---
    case 'command.register': {
      const spec = args[0] as {
        name?: string
        description?: string
        argumentHint?: string
        immediate?: true
      }
      if (!spec || typeof spec.name !== 'string' || !NOUN_NAME.test(spec.name)) {
        return deny(
          'command.register requires a { name } spec of letters, digits, _ or - (up to 64)',
        )
      }
      if (typeof spec.description !== 'string') {
        return deny('command.register requires a string { description }')
      }
      registeredCommands.set(spec.name, {
        plugin,
        name: spec.name,
        description: spec.description,
        ...(typeof spec.argumentHint === 'string'
          ? { argumentHint: spec.argumentHint }
          : {}),
        ...(spec.immediate === true ? { immediate: true as const } : {}),
      })
      return { command: spec.name }
    }
    case 'command.list':
      // Contract CommandInfo: a plugin's commands carry source `plugin` and
      // the registering plugin's name.
      return modsRegisteredCommands().map(c => ({
        name: c.name,
        description: c.description,
        source: 'plugin' as const,
        plugin: c.plugin,
      }))
    case 'command.run': {
      // Reached only when no mod handled the run — the chain's hooks own the
      // normal path (see engine.emitOp's command.run event shape).
      return { text: '' }
    }
    case 'command.describe': {
      const name =
        typeof args[0] === 'string'
          ? args[0]
          : (args[0] as { command?: string } | undefined)?.command
      const command = name ? registeredCommands.get(name) : undefined
      if (!command) {
        return deny(`command.describe: no command named ${String(name)} is registered`)
      }
      // CommandDescribeResult: description, hint and hidden flag; name,
      // immediate and provider stay as the engine had them.
      return {
        description: command.description,
        ...(command.argumentHint !== undefined
          ? { argumentHint: command.argumentHint }
          : {}),
        isHidden: false,
      }
    }

    // --- tool ---
    case 'tool.list':
      // ToolInfo for tools the session lists: no inputSchema (the contract
      // keeps it for entries a tool.list hook adds), mcp false because a
      // plugin tool is not an MCP server's.
      return modsRegisteredTools().map(t => ({
        name: t.name,
        description: t.description,
        mcp: false,
      }))
    case 'tool.register': {
      const spec = args[0] as {
        name?: string
        description?: string
        inputSchema?: Record<string, unknown>
        isDeferred?: boolean
      }
      if (!spec || typeof spec.name !== 'string' || !NOUN_NAME.test(spec.name)) {
        return deny(
          'tool.register requires a { name } spec of letters, digits, _ or - (up to 64)',
        )
      }
      if (typeof spec.description !== 'string') {
        return deny('tool.register requires a string { description }')
      }
      const schema = spec.inputSchema
      if (
        schema !== undefined &&
        (typeof schema !== 'object' || schema === null || Array.isArray(schema))
      ) {
        return deny('tool.register: inputSchema must be a JSON schema object')
      }
      registeredTools.set(toolKey(plugin, spec.name), {
        plugin,
        name: spec.name,
        description: spec.description,
        // ToolSpec: an omitted schema becomes `{ type: "object" }`.
        inputSchema: spec.inputSchema ?? { type: 'object' },
        ...(typeof spec.isDeferred === 'boolean'
          ? { isDeferred: spec.isDeferred }
          : {}),
      })
      return { tool: spec.name }
    }
    case 'tool.describe': {
      const name =
        typeof args[0] === 'string'
          ? args[0]
          : (args[0] as { tool?: string } | undefined)?.tool
      const tool = name ? findTool(plugin, name) : undefined
      if (!tool) {
        return deny(`tool.describe: no tool named ${String(name)} is registered`)
      }
      // ToolDescribeResult: the description the model sees, and placement
      // only when the registration moved it.
      return {
        description: tool.description,
        ...(tool.isDeferred === true ? { isDeferred: true } : {}),
      }
    }

    // --- config ---
    case 'config.list':
      // ConfigRow[] from the merged settings. A key whose value has no /config
      // kind here (object, array, null) is left out rather than mislabelled;
      // labels are the keys themselves because cc-haha has no /config panel
      // metadata to draw richer ones from.
      return configRows()
    case 'config.describe': {
      const key =
        typeof args[0] === 'string'
          ? args[0]
          : (args[0] as { key?: string } | undefined)?.key
      const row = key
        ? (await configRows()).find(candidate => candidate.key === key)
        : undefined
      if (!row) {
        return deny(`config.describe: no config row named ${String(key)}`)
      }
      // ConfigDescribeResult; the engine caches this answer until
      // `$.ui.invalidate('config.describe')`.
      return {
        label: row.label,
        ...(row.description !== undefined
          ? { description: row.description }
          : {}),
        isHidden: false,
      }
    }

    // --- model / turn / prompt / agent / mcp / misc ---
    case 'model.complete': {
      const request = args[0] as {
        model?: string
        prompt?: unknown
        system?: unknown
        maxTokens?: number
      }
      if (!request || typeof request.model !== 'string' || !request.model) {
        throw new Error('model.complete requires a { model }')
      }
      const prompt = joinPrompt(request.prompt)
      if (prompt === null) {
        throw new Error('model.complete requires prompt text or text blocks')
      }
      const system = request.system === undefined ? undefined : joinPrompt(request.system)
      if (system === null) {
        throw new Error('model.complete: system must be text or text blocks')
      }
      const maxTokens = request.maxTokens ?? 1024
      try {
        // sideQuery carries the CLI's attribution headers, betas and model
        // normalization; there is no per-message effort seam here, so a
        // request's `effort` is not sent rather than faked.
        const { sideQuery } = await import('../utils/sideQuery.js')
        const response = await sideQuery({
          model: request.model,
          ...(system !== undefined ? { system } : {}),
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxTokens,
          querySource: 'mods_model_complete',
        })
        const usage = await recordModelCall(
          request.model,
          response.usage as never,
          response.usage,
        )
        const text = textOfBlocks(response.content as never)
        if (!text) return { isAnswered: false, reason: 'empty-reply', usage }
        return { isAnswered: true, text, usage }
      } catch (ex) {
        const status =
          typeof (ex as { status?: unknown })?.status === 'number'
            ? ((ex as { status: number }).status)
            : null
        return {
          isAnswered: false,
          reason: 'api-error',
          status,
          error: modelApiError(status),
          usage: modelUsageShape(undefined),
        }
      }
    }
    case 'model.classify': {
      const request = args[0] as {
        text?: unknown
        labels?: unknown
        options?: { model?: string }
      }
      if (!request || typeof request.text !== 'string') {
        throw new Error('model.classify requires { text }')
      }
      if (
        !Array.isArray(request.labels) ||
        request.labels.length === 0 ||
        !request.labels.every(label => typeof label === 'string')
      ) {
        throw new Error('model.classify requires a non-empty { labels } list')
      }
      const labels = request.labels as string[]
      const { getSmallFastModel } = await import('../utils/model/model.js')
      const model = request.options?.model ?? getSmallFastModel()
      const system =
        'You are a strict text classifier. Reply with exactly one of the allowed ' +
        'labels, verbatim, and nothing else. If none fits, reply NONE.'
      try {
        const { sideQuery } = await import('../utils/sideQuery.js')
        const response = await sideQuery({
          model,
          system,
          messages: [
            {
              role: 'user',
              content: `Allowed labels: ${labels.join(', ')}\n\nText:\n${request.text}`,
            },
          ],
          max_tokens: 32,
          temperature: 0,
          querySource: 'mods_model_classify',
        })
        await recordModelCall(model, response.usage as never, response.usage)
        const reply = textOfBlocks(response.content as never)
          .trim()
          .replace(/^["'`]+|["'`]+$/g, '')
        // Exact match first, then a line that names one label.
        const exact = labels.find(label => label.toLowerCase() === reply.toLowerCase())
        if (exact !== undefined) return exact
        const embedded = labels.find(label =>
          new RegExp(`(^|[^\\w-])${escapeRegExp(label)}([^\\w-]|$)`, 'i').test(reply),
        )
        return embedded
      } catch {
        // The contract's classifier answers undefined when it has no verdict
        // (an outage included); it never invents a label.
        return undefined
      }
    }
    case 'model.fork':
      // A fork needs the main thread's last request itself (model, system
      // prompt, tools, messages) to reuse the API's cache prefix. M5 found
      // only the transcript file path (sessionStorage.getTranscriptPath);
      // the request object is rebuilt per call inside claude.ts and never
      // kept, so a fork here would be a fresh request wearing the name.
      return deny(
        'model.fork needs a main-thread transcript snapshot; cc-haha exposes no fork seam yet',
      )
    case 'turn.abort':
      return deny('no active turn handle in this context')
    case 'prompt.read':
    case 'prompt.paint':
      // The prompt box is drawn by the Ink composer (terminal) or the desktop
      // editor; neither is reachable from the engine's process-side hooks.
      // M3 delivers the UI surfaces these nouns need.
      return deny(`${event} needs a prompt surface; planned for M3 UI surfaces`)
    case 'agent.list':
      // Contract AgentInfo describes *running loops* (id, status, taskStatus,
      // tokenCount, ...). M5 found the live rows only in AppState.tasks
      // (`getRunningTasks(state)`), a per-React-tree store this process-side
      // engine cannot reach; `agent.register` only declares a type. Listing a
      // definition as a loop would fabricate state, so the list stays empty.
      return []
    case 'agent.register': {
      const spec = args[0] as {
        name?: string
        description?: string
        prompt?: string
      }
      if (!spec || typeof spec.name !== 'string' || !NOUN_NAME.test(spec.name)) {
        return deny(
          'agent.register requires a { name } spec of letters, digits, _ or - (up to 64)',
        )
      }
      if (typeof spec.description !== 'string' || !spec.description) {
        return deny('agent.register requires a string { description }')
      }
      if (typeof spec.prompt !== 'string' || !spec.prompt) {
        return deny('agent.register requires a string { prompt }')
      }
      registeredAgents.set(`${plugin}:${spec.name}`, {
        plugin,
        name: spec.name,
        description: spec.description,
        prompt: spec.prompt,
        spec: spec as Record<string, unknown>,
      })
      return { agent: spec.name }
    }
    case 'agent.limits':
      return agentLimits()
    case 'agent.spawn':
    case 'agent.offer':
    case 'agent.call':
      return deny(`${event} needs the agent loop; planned for M5`)
    case 'mcp.call':
    case 'mcp.connect':
      return deny(`${event} has no MCP transport bridge in this runtime yet`)
    case 'attribution.text':
      return { text: String((args[0] as { text?: string })?.text ?? '') }
    case 'skill.prompt':
      return deny('skill.prompt is not implemented in this runtime yet')

    // --- ui (M1: transcript/debug sinks; real surfaces land in M3) ---
    case 'ui.toast':
    case 'ui.log':
    case 'ui.status':
    case 'ui.notify':
      // Transcript-visible notices. Desktop bridge (M3) upgrades these to
      // real toasts; until then a debug line keeps the mod contract.
      console.debug(`[mod ${plugin}] ${event}:`, String(args[0] ?? ''))
      return {}
    case 'ui.notice':
      return {}
    case 'ui.open':
    case 'ui.close':
    case 'ui.panes':
    case 'ui.place':
    case 'ui.blit':
    case 'ui.cancelNotify':
    case 'ui.resolve':
    case 'ui.selection':
    case 'ui.copy':
    case 'ui.view':
      return deny(`${event} has no surface bridge in this runtime yet`)
    case 'theme.set':
    case 'theme.clear':
      return {}

    // --- telemetry ---
    case 'telemetry.log':
    case 'telemetry.mark':
      console.debug(`[mod ${plugin}] ${event}:`, JSON.stringify(args[0] ?? null))
      return {}

    case 'wasm.compile':
      // 2.1.328 declares the noun (OpEventOf['wasm.compile']), but cc-haha
      // ships no wasm toolchain seam; a stub compile would return bytes that
      // only look like a module. Refuse until a real compiler is wired.
      return deny('wasm.compile has no wasm toolchain in this runtime yet')

    default:
      return deny(`${event} has no core implementation`)
  }
}
