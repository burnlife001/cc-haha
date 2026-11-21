// Hermetic regression tests for the cc-mods engine. No real ~/.claude, no
// network, no live plugins — fixtures live in a temporary directory and the
// engine singleton is reset between tests.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import * as os from 'os'
import { tmpdir } from 'os'
import path from 'path'
import { getSessionId } from '../bootstrap/state.js'
import { ModEngine } from './engine.js'
import { normalizeClassicEvent } from './events.js'
import { __resetModsForTests, modsEmitSessionMeasure } from './index.js'
import { screenModuleSource } from './loader.js'
import {
  __resetModsNounRegistry,
  buildSessionMeasureInput,
  coreNouns,
  modsRegisteredAgents,
} from './nouns.js'

async function makeMod(
  dir: string,
  name: string,
  registerSource: string,
): Promise<string> {
  const root = path.join(dir, name)
  await mkdir(path.join(root, 'hooks'), { recursive: true })
  await mkdir(path.join(root, '.claude-plugin'), { recursive: true })
  await writeFile(
    path.join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, version: '0.0.1' }),
  )
  await writeFile(
    path.join(root, 'hooks', 'hooks.json'),
    JSON.stringify({ description: name, modules: ['./register.js'], hooks: {} }),
  )
  await writeFile(path.join(root, 'hooks', 'register.js'), registerSource)
  return root
}

function newEngine(): ModEngine {
  const engine = new ModEngine()
  engine.registerNounCore(coreNouns)
  return engine
}

async function loadFixture(
  engine: ModEngine,
  root: string,
): Promise<void> {
  const { pathToFileURL } = await import('url')
  const imported = (await import(pathToFileURL(path.join(root, 'hooks', 'register.js')).href)) as {
    register: (on: any, options?: any) => void | Promise<void>
  }
  const name = path.basename(root)
  engine.registerMod({
    identity: { name, root },
    register: imported.register,
    options: {},
  })
  const on = (event: string, matcherOrHook: any, maybeHook?: any) =>
    engine.on(name, event, matcherOrHook, maybeHook)
  await imported.register(on, {})
}

describe('mod engine chain semantics', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mods-engine-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  test('next(e) continues to the core handler', async () => {
    const engine = newEngine()
    const root = await makeMod(
      dir,
      'passthrough',
      `export const register = on => {
        on('session.start', ($, e, next) => next(e))
      }`,
    )
    await loadFixture(engine, root)
    let coreRan = false
    const outcome = await engine.emit('session.start', { cwd: '/x' }, async e => {
      coreRan = true
      return { seen: (e as any).cwd }
    })
    expect(coreRan).toBe(true)
    expect(outcome.denied).toBeNull()
    expect(outcome.value).toEqual({ seen: '/x' })
  })

  test('{deny} short-circuits and the core never runs', async () => {
    const engine = newEngine()
    const root = await makeMod(
      dir,
      'denier',
      `export const register = on => {
        on('tool.call', { tool: 'Bash' }, () => ({ deny: 'blocked' }))
      }`,
    )
    await loadFixture(engine, root)
    let coreRan = false
    const hit = await engine.emit('tool.call', { tool: 'Bash' }, async () => {
      coreRan = true
      return 'core'
    })
    expect(coreRan).toBe(false)
    expect(hit.denied).toBe('blocked')

    // Matcher miss: Edit calls fall through to core.
    const miss = await engine.emit('tool.call', { tool: 'Edit' }, async () => {
      coreRan = true
      return 'core'
    })
    expect(miss.denied).toBeNull()
    expect(miss.value).toBe('core')
    expect(coreRan).toBe(true)
  })

  test('{result} replaces the tool result without running core', async () => {
    const engine = newEngine()
    const root = await makeMod(
      dir,
      'router',
      `export const register = on => {
        on('tool.call', { tool: 'Agent' }, ($, e, next) => ({
          result: { content: [{ type: 'text', text: 'routed' }] },
        }))
      }`,
    )
    await loadFixture(engine, root)
    let coreRan = false
    const outcome = await engine.emit('tool.call', { tool: 'Agent', prompt: 'x' }, async () => {
      coreRan = true
    })
    expect(coreRan).toBe(false)
    expect(outcome.handled).toBe(true)
    expect((outcome.value as any).result.content[0].text).toBe('routed')
  })

  test('throwing hook without .catch fails closed with a deny', async () => {
    const engine = newEngine()
    const root = await makeMod(
      dir,
      'thrower',
      `export const register = on => {
        on('tool.call', () => { throw new Error('boom') })
      }`,
    )
    await loadFixture(engine, root)
    const outcome = await engine.emit('tool.call', { tool: 'Bash' }, async () => 'core')
    expect(outcome.denied).toContain('boom')
  })

  test('.catch receives next.called=false and can deny', async () => {
    const engine = newEngine()
    const root = await makeMod(
      dir,
      'guarded',
      `export const register = on => {
        on('tool.call', () => { throw new Error('inner') })
          .catch(($, e, next) =>
            next.called ? next(e) : { deny: 'guarded-deny' })
      }`,
    )
    await loadFixture(engine, root)
    const outcome = await engine.emit('tool.call', { tool: 'Bash' }, async () => 'core')
    expect(outcome.denied).toBe('guarded-deny')
  })

  test('hook that returns nothing still lets the chain continue', async () => {
    const engine = newEngine()
    const root = await makeMod(
      dir,
      'silent',
      `export const register = on => {
        on('session.start', () => {})
      }`,
    )
    await loadFixture(engine, root)
    const outcome = await engine.emit('session.start', { cwd: '/x' }, async () => 'core')
    expect(outcome.value).toBe('core')
  })

  test('$ noun dispatch reaches the core and returns its value', async () => {
    const engine = newEngine()
    const root = await makeMod(dir, 'counter', `export const register = () => {}`)
    await loadFixture(engine, root)
    const api = (engine as any).apis.get('counter')
    await api.store.set('k', 41)
    expect(await api.store.get('k')).toBe(41)
    expect(await api.clock.now()).toBeGreaterThan(0)
  })

  test('command.register + command.run matcher round-trip', async () => {
    const engine = newEngine()
    const root = await makeMod(
      dir,
      'cmdmod',
      `export const register = on => {
        on('session.start', $ => {
          $.command.register({ name: 'reload', description: 'reload things' })
        })
        on('command.run', { command: 'reload' }, () => ({ text: 'reloaded' }))
      }`,
    )
    await loadFixture(engine, root)
    await engine.emit('session.start', { cwd: '/x' })
    const outcome = await engine.emit(
      'command.run',
      { command: 'reload', args: '', source: 'slash' },
      async () => ({ text: '' }),
    )
    expect((outcome.value as any).text).toBe('reloaded')
  })

  test('module source screen refuses dynamic import and require', () => {
    expect(screenModuleSource('const m = await import("./x.js")').ok).toBe(false)
    expect(screenModuleSource('require("./x")').ok).toBe(false)
    expect(screenModuleSource('export const register = () => {}').ok).toBe(true)
    // Static imports and the word "important" are fine.
    expect(
      screenModuleSource('import { x } from "./x.js"\nexport const register = () => {}').ok,
    ).toBe(true)
    expect(screenModuleSource('// important note').ok).toBe(true)
  })
})

// --- M4: virtual noun registries, session.*, config.*, classic envelope ----

const PLUGIN = 'm4-plugin'

function m4Engine(): ModEngine {
  __resetModsNounRegistry()
  return newEngine()
}

function spyMod(engine: ModEngine, name = 'spy'): void {
  engine.registerMod({
    identity: { name, root: '/spy' },
    register: () => {},
    options: {},
  })
}

// A core refusal is the call's value (`{ deny }`), the way a hook's refusal is:
// `$` nouns answer the refusal rather than throwing.
async function denyTextOf(promise: Promise<unknown>): Promise<string> {
  const value = (await promise) as { deny?: unknown }
  expect(typeof value.deny).toBe('string')
  return value.deny as string
}

describe('M4 virtual noun registries', () => {
  afterEach(() => {
    __resetModsNounRegistry()
  })

  test('tool.register -> tool.list -> tool.describe round-trip', async () => {
    const engine = m4Engine()
    const registered = await engine.emitOp(PLUGIN, 'tool.register', [
      {
        name: 'lint_file',
        description: 'Lint one file',
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
        },
      },
    ])
    expect(registered).toEqual({ tool: 'lint_file' })

    expect(await engine.emitOp(PLUGIN, 'tool.list', [])).toEqual([
      { name: 'lint_file', description: 'Lint one file', mcp: false },
    ])

    expect(await engine.emitOp(PLUGIN, 'tool.describe', ['lint_file'])).toEqual({
      description: 'Lint one file',
    })
  })

  test('tool.register rejects a spec without a contract name', async () => {
    const engine = m4Engine()
    expect(
      await denyTextOf(
        engine.emitOp(PLUGIN, 'tool.register', [
          { name: 'bad name', description: 'x' },
        ]),
      ),
    ).toContain('tool.register requires a { name } spec')
    expect(
      await denyTextOf(
        engine.emitOp(PLUGIN, 'tool.register', [{ name: 'ok' }]),
      ),
    ).toContain('tool.register requires a string { description }')
    // Nothing was registered by the refused calls.
    expect(await engine.emitOp(PLUGIN, 'tool.list', [])).toEqual([])
  })

  test('tool.describe for an unknown tool is refused, not invented', async () => {
    const engine = m4Engine()
    expect(
      await denyTextOf(engine.emitOp(PLUGIN, 'tool.describe', ['missing'])),
    ).toContain('no tool named missing is registered')
  })

  test('agent.register stores the definition; agent.list stays honest', async () => {
    const engine = m4Engine()
    const registered = await engine.emitOp(PLUGIN, 'agent.register', [
      { name: 'reviewer', description: 'Reviews diffs', prompt: 'You review.' },
    ])
    expect(registered).toEqual({ agent: 'reviewer' })

    // AgentInfo describes running loops; a definition is not one, and cc-haha
    // exposes no live-loop registry here, so the list is empty by design.
    expect(await engine.emitOp(PLUGIN, 'agent.list', [])).toEqual([])
    expect(modsRegisteredAgents().map(a => `${a.plugin}:${a.name}`)).toEqual([
      `${PLUGIN}:reviewer`,
    ])

    await expect(
      engine.emitOp(PLUGIN, 'agent.register', [{ name: 'x', description: 'y' }]),
    ).resolves.toEqual({
      deny: 'agent.register requires a string { prompt }',
    })
  })

  test('agent.limits defaults follow the contract and the environment', async () => {
    const engine = m4Engine()
    const keys = [
      'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS',
      'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH',
      'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS',
    ] as const
    const saved = keys.map(key => process.env[key])
    try {
      for (const key of keys) delete process.env[key]
      expect(await engine.emitOp(PLUGIN, 'agent.limits', [])).toEqual({
        concurrent: 20,
        depth: 1,
        isBackgroundEnabled: true,
      })

      process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = '3'
      process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = '2'
      process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1'
      expect(await engine.emitOp(PLUGIN, 'agent.limits', [])).toEqual({
        concurrent: 3,
        depth: 2,
        isBackgroundEnabled: false,
      })
    } finally {
      keys.forEach((key, index) => {
        const value = saved[index]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      })
    }
  })

  test('command.register keeps argumentHint/immediate and lists as CommandInfo', async () => {
    const engine = m4Engine()
    const registered = await engine.emitOp(PLUGIN, 'command.register', [
      {
        name: 'scan',
        description: 'Scan the tree',
        argumentHint: '[path]',
        immediate: true,
      },
    ])
    expect(registered).toEqual({ command: 'scan' })

    expect(await engine.emitOp(PLUGIN, 'command.list', [])).toEqual([
      {
        name: 'scan',
        description: 'Scan the tree',
        source: 'plugin',
        plugin: PLUGIN,
      },
    ])

    expect(await engine.emitOp(PLUGIN, 'command.describe', ['scan'])).toEqual({
      description: 'Scan the tree',
      argumentHint: '[path]',
      isHidden: false,
    })
  })

  test('re-registering a tool refreshes the cached describe answer', async () => {
    const engine = m4Engine()
    await engine.emitOp(PLUGIN, 'tool.register', [{ name: 't', description: 'v1' }])
    expect(await engine.emitOp(PLUGIN, 'tool.describe', ['t'])).toEqual({
      description: 'v1',
    })
    await engine.emitOp(PLUGIN, 'tool.register', [{ name: 't', description: 'v2' }])
    // The engine drops tool.describe's cache on a successful registration.
    expect(await engine.emitOp(PLUGIN, 'tool.describe', ['t'])).toEqual({
      description: 'v2',
    })
  })

  test('registry reset clears every virtual noun', async () => {
    const engine = m4Engine()
    await engine.emitOp(PLUGIN, 'tool.register', [{ name: 't', description: 'd' }])
    await engine.emitOp(PLUGIN, 'agent.register', [
      { name: 'a', description: 'd', prompt: 'p' },
    ])
    await engine.emitOp(PLUGIN, 'command.register', [
      { name: 'c', description: 'd' },
    ])
    __resetModsNounRegistry()
    expect(await engine.emitOp(PLUGIN, 'tool.list', [])).toEqual([])
    expect(await engine.emitOp(PLUGIN, 'agent.list', [])).toEqual([])
    expect(await engine.emitOp(PLUGIN, 'command.list', [])).toEqual([])
  })
})

describe('M4 session.* nouns', () => {
  let dir: string
  let savedConfigDir: string | undefined

  beforeEach(async () => {
    // Keep transcript paths inside a throwaway config dir: never the real
    // ~/.claude of the developer running the suite.
    dir = await mkdtemp(path.join(tmpdir(), 'mods-session-'))
    savedConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = dir
  })

  afterEach(async () => {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
    await rm(dir, { recursive: true, force: true })
    __resetModsNounRegistry()
  })

  test('session.machine reads the real machine and PATH', async () => {
    const engine = m4Engine()
    const machine = (await engine.emitOp(PLUGIN, 'session.machine', [])) as {
      sysname: string
      release: string
      machine: string
      packageManagers: string[]
      runtimes: string[]
    }
    const expectedSysname =
      process.platform === 'win32'
        ? 'Windows_NT'
        : process.platform === 'darwin'
          ? 'Darwin'
          : 'Linux'
    expect(machine.sysname).toBe(expectedSysname)
    if (process.platform === 'win32') expect(machine.sysname).toBe('Windows_NT')
    expect(machine.release).toBe(os.release())
    expect(machine.machine.length).toBeGreaterThan(0)
    // Order is the contract's, so each list is a subsequence of it.
    expect(machine.packageManagers).toEqual(
      ['npm', 'yarn', 'pnpm'].filter(name =>
        machine.packageManagers.includes(name),
      ),
    )
    expect(machine.runtimes).toEqual(
      ['bun', 'deno', 'node'].filter(name => machine.runtimes.includes(name)),
    )
  })

  test('session.info carries platform, host flag and a transcript path', async () => {
    const engine = m4Engine()
    const info = (await engine.emitOp(PLUGIN, 'session.info', [])) as {
      transcriptPath: string
      platform?: string
      isHosted?: boolean
    }
    expect(typeof info.transcriptPath).toBe('string')
    expect(info.isHosted).toBe(false)
    expect(['macos', 'windows', 'wsl', 'linux', 'unknown']).toContain(
      info.platform as string,
    )
    if (process.platform === 'win32') expect(info.platform).toBe('windows')
  })

  test('session.surface names a contract RenderSurface', async () => {
    const engine = m4Engine()
    expect(await engine.emitOp(PLUGIN, 'session.surface', [])).toBe('terminal')
    expect(await engine.emitOp(PLUGIN, 'session.surfaces', [])).toEqual([
      'terminal',
    ])
  })

  test('session.usage reports the engine ledger without inventing a fill', async () => {
    const engine = m4Engine()
    const usage = (await engine.emitOp(PLUGIN, 'session.usage', [])) as {
      startedAt: number
      context: { window: number; tokens?: number }
      rateLimits: unknown[]
      cost?: { usd: number }
    }
    expect(usage.startedAt).toBeGreaterThan(0)
    expect(typeof usage.context.window).toBe('number')
    // No last-response seam: tokens and the breakdown stay absent.
    expect(usage.context.tokens).toBeUndefined()
    expect(usage.rateLimits).toEqual([])
    expect(typeof usage.cost?.usd).toBe('number')
  })

  test('session.measure assembles the contract input and reaches a hook', async () => {
    const engine = m4Engine()
    spyMod(engine)
    let seen: Record<string, unknown> | null = null
    engine.on('spy', 'session.measure', (_, e) => {
      seen = e as Record<string, unknown>
    })

    const input = await buildSessionMeasureInput()
    // First measurement names every unit it has a figure for.
    expect(input.changed).toContain('cost')
    expect(input.changed.length).toBeGreaterThan(0)
    expect(typeof input.context.window).toBe('number')

    await engine.emit('session.measure', input, (ev: unknown) => ({
      changed: (ev as { changed: string[] }).changed,
    }))
    expect(seen).not.toBeNull()
    expect(seen!.changed).toEqual(input.changed)
    expect(seen!.rateLimits).toEqual([])

    // Nothing moved, so the next reading names nothing: no move, no event.
    const again = await buildSessionMeasureInput()
    expect(again.changed).toEqual([])
  })

  test('modsEmitSessionMeasure returns without hooks and never throws', async () => {
    __resetModsForTests()
    try {
      // CLAUDE_CONFIG_DIR is this test's empty temp dir, so the engine loads
      // no mods and the emission has nowhere to go.
      await expect(modsEmitSessionMeasure()).resolves.toBeUndefined()
    } finally {
      __resetModsForTests()
    }
  })

  test('session.identity names the credential source; authorize keeps refusing a handle', async () => {
    const engine = m4Engine()
    const keys = [
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
      'CLAUDE_CODE_USE_AZURE_OPENAI',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_API_KEY',
    ]
    const saved = new Map(keys.map(key => [key, process.env[key]]))
    for (const key of keys) delete process.env[key]

    try {
      if (process.platform === 'darwin') {
        // No keychain read here; the noun must refuse rather than guess.
        expect(
          await denyTextOf(engine.emitOp(PLUGIN, 'session.identity', [])),
        ).toContain('keychain')
      } else {
        // Nothing readable in this empty config dir: a signed-out session.
        expect(await engine.emitOp(PLUGIN, 'session.identity', [])).toEqual({
          kind: 'none',
          isVerified: false,
        })
      }

      process.env.ANTHROPIC_API_KEY = 'test-key'
      expect(await engine.emitOp(PLUGIN, 'session.identity', [])).toEqual({
        kind: 'api-key',
        isVerified: false,
      })

      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token'
      expect(await engine.emitOp(PLUGIN, 'session.identity', [])).toEqual({
        kind: 'oauth-token',
        isVerified: false,
      })

      delete process.env.ANTHROPIC_API_KEY
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      process.env.CLAUDE_CODE_USE_BEDROCK = '1'
      expect(await engine.emitOp(PLUGIN, 'session.identity', [])).toEqual({
        kind: 'bedrock',
        isVerified: false,
      })
    } finally {
      for (const key of keys) {
        const value = saved.get(key)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }

    expect(
      await denyTextOf(engine.emitOp(PLUGIN, 'session.authorize', [])),
    ).toContain('needs a credential reader')
  })

  test('session.identity reads the login record and gates org/email on the pin', async () => {
    // A host-handed token or provider flag outranks the disk login record,
    // so clear them to isolate the record-read path.
    const keys = [
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
      'CLAUDE_CODE_USE_FOUNDRY',
      'CLAUDE_CODE_USE_AZURE_OPENAI',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'ANTHROPIC_API_KEY',
    ]
    const savedEnv = new Map(keys.map(key => [key, process.env[key]]))
    for (const key of keys) delete process.env[key]

    const configModule = await import('../utils/config.js')
    const before = { ...configModule.getGlobalConfig() }
    configModule.saveGlobalConfig(config => ({
      ...config,
      primaryApiKey: undefined,
      oauthAccount: {
        accountUuid: 'acct-1',
        emailAddress: 'dev@example.test',
        organizationUuid: 'org-1',
      },
    }))

    try {
      const engine = m4Engine()
      // The record alone names the sign-in; org and email stay off without a
      // managed pin.
      expect(await engine.emitOp(PLUGIN, 'session.identity', [])).toEqual({
        kind: 'claude.ai',
        isVerified: false,
      })

      // A pin on this account's org is the one case the contract lets the
      // org and email through.
      await writeFile(
        path.join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'),
        JSON.stringify({ forceLoginOrgUUID: 'org-1' }),
      )
      expect(await engine.emitOp(PLUGIN, 'session.identity', [])).toEqual({
        kind: 'claude.ai',
        isVerified: false,
        organizationId: 'org-1',
        email: 'dev@example.test',
      })
    } finally {
      configModule.saveGlobalConfig(() => ({ ...before }))
      for (const key of keys) {
        const value = savedEnv.get(key)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })
})

describe('M4 config.* nouns', () => {
  let dir: string
  let savedConfigDir: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mods-config-'))
    savedConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = dir
    await writeFile(
      path.join(dir, 'settings.json'),
      JSON.stringify({
        theme: 'dark',
        verbose: true,
        maxLines: 42,
        permissions: { allow: ['Bash'] },
        enabledPlugins: ['x'],
      }),
    )
  })

  afterEach(async () => {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
    await rm(dir, { recursive: true, force: true })
    __resetModsNounRegistry()
  })

  test('config.list returns contract ConfigRow shapes', async () => {
    const engine = m4Engine()
    const rows = (await engine.emitOp(PLUGIN, 'config.list', [])) as Array<{
      key: string
      label: string
      kind: string
      value: unknown
      provider: { plugin: string; tier: string }
      isLocked: boolean
    }>
    expect(rows.map(row => row.key)).toEqual(['maxLines', 'theme', 'verbose'])
    for (const row of rows) {
      expect(row.label).toBe(row.key)
      expect(row.provider).toEqual({ plugin: 'engine', tier: 'core' })
      expect(row.isLocked).toBe(false)
    }
    expect(rows.find(row => row.key === 'theme')).toMatchObject({
      kind: 'text',
      value: 'dark',
    })
    expect(rows.find(row => row.key === 'verbose')).toMatchObject({
      kind: 'boolean',
      value: true,
    })
    expect(rows.find(row => row.key === 'maxLines')).toMatchObject({
      kind: 'number',
      value: 42,
    })
    // Object/array values have no ConfigKind and stay out.
    expect(rows.some(row => row.key === 'permissions')).toBe(false)
    expect(rows.some(row => row.key === 'enabledPlugins')).toBe(false)
  })

  test('config.describe answers a row and refuses an unknown key', async () => {
    const engine = m4Engine()
    expect(await engine.emitOp(PLUGIN, 'config.describe', ['theme'])).toEqual({
      label: 'theme',
      isHidden: false,
    })
    expect(
      await denyTextOf(engine.emitOp(PLUGIN, 'config.describe', ['nope'])),
    ).toContain('no config row named nope')
  })
})

describe('M4 classic envelope', () => {
  afterEach(() => {
    __resetModsNounRegistry()
  })

  test('classic.PreToolUse carries the four engine fields and the envelope keys', async () => {
    const engine = m4Engine()
    spyMod(engine)
    let seen: Record<string, unknown> | null = null
    engine.on('spy', 'classic.PreToolUse', (_$, e) => {
      seen = e as Record<string, unknown>
    })

    const e = await normalizeClassicEvent('classic.PreToolUse', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' },
      tool_use_id: 'toolu_1',
    })
    await engine.emit('classic.PreToolUse', e)

    expect(seen).not.toBeNull()
    expect(seen!.session_id).toBe(getSessionId())
    expect(typeof seen!.transcript_path).toBe('string')
    expect(seen!.cwd).toBeTruthy()
    expect(seen!.hook_event_name).toBe('PreToolUse')
    // Raw cc-haha fields stay; the ToolCallEnvelope keys join them.
    expect(seen!.tool_name).toBe('Bash')
    expect(seen!.tool).toBe('Bash')
    expect(seen!.tool_use_id).toBe('toolu_1')
    expect(seen!.command).toBe('ls -la')
  })

  test('classic.PostToolUse keeps the stdin shape and fills missing base fields', async () => {
    const engine = m4Engine()
    spyMod(engine)
    let seen: Record<string, unknown> | null = null
    engine.on('spy', 'classic.PostToolUse', (_$, e) => {
      seen = e as Record<string, unknown>
    })

    const e = await normalizeClassicEvent('classic.PostToolUse', {
      tool_name: 'Read',
      tool_input: { file_path: '/x' },
      tool_response: { text: 'ok' },
    })
    await engine.emit('classic.PostToolUse', e)

    expect(seen!.hook_event_name).toBe('PostToolUse')
    expect(seen!.session_id).toBe(getSessionId())
    expect(seen!.tool_input).toEqual({ file_path: '/x' })
    expect(seen!.tool_response).toEqual({ text: 'ok' })
    expect(seen!.tool).toBeUndefined()
  })

  test('a caller-supplied session field wins over the engine fallback', async () => {
    const e = await normalizeClassicEvent('classic.SessionStart', {
      session_id: 'explicit-session',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/repo',
      hook_event_name: 'SessionStart',
      source: 'startup',
    })
    expect(e).toMatchObject({
      session_id: 'explicit-session',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/repo',
      hook_event_name: 'SessionStart',
      source: 'startup',
    })
  })
})

describe('M4 honest refusals', () => {
  afterEach(() => {
    __resetModsNounRegistry()
  })

  test('nouns with no seam refuse with a reason instead of placeholder data', async () => {
    const engine = m4Engine()
    expect(
      await denyTextOf(engine.emitOp(PLUGIN, 'model.fork', [{ prompt: 'x' }])),
    ).toContain('no fork seam')
    expect(
      await denyTextOf(engine.emitOp(PLUGIN, 'prompt.read', [])),
    ).toContain('planned for M3 UI surfaces')
    expect(
      await denyTextOf(engine.emitOp(PLUGIN, 'prompt.paint', [{}])),
    ).toContain('planned for M3 UI surfaces')
    expect(
      await denyTextOf(engine.emitOp(PLUGIN, 'wasm.compile', [{}])),
    ).toContain('no wasm toolchain')
  })
})

