// Per-test engine runtime: the plugin under test is loaded into its own
// ModEngine with `register(on, options)`, and the test body gets the engine's
// own `$` plus an `on` whose hooks sit beneath every plugin. The world beneath
// them answers from memory: no fs, no processes, no network.
//
// `on` in a test body is the same mechanism as ModEngine.on — a stub hook that
// returns `{ value }` answers a `$` noun, `{ result }` answers `$.tool.call`,
// `{ deny }` refuses.

import { ModEngine, type NounCore } from '../engine.js'
import {
  shapeOpEvent,
  unwrapOpAnswer,
} from '../opEvents.js'
import type { LoadedMod, OnFn, RegisterOptions } from '../types.js'
import type { TestOptions } from './kit.js'

// The test's own caller identity: `on` registers under it, so those hooks sit
// after (beneath) every plugin's.
export const TEST_PLUGIN = '__test__'

const TEST_SESSION = {
  id: 'test-session',
  surface: 'terminal' as const,
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function unavailable(what: string): never {
  throw new Error(
    `${what} is not available in the test environment (no fs, process or network) — stub it with on(...)`,
  )
}

export type TestRuntime = {
  engine: ModEngine
  $: any
  on: OnFn
}

export type CreateTestRuntimeOptions = {
  mods: readonly LoadedMod[]
  pluginRoot: string
  testOptions: TestOptions
}

export async function createTestRuntime(
  options: CreateTestRuntimeOptions,
): Promise<TestRuntime> {
  const { mods, pluginRoot, testOptions } = options
  const store = new Map<string, Map<string, unknown>>()
  const state = new Map<string, Map<string, unknown>>()
  const registered: Array<{ name: string; description: string }> = []

  const bucket = (
    map: Map<string, Map<string, unknown>>,
    plugin: string,
  ): Map<string, unknown> => {
    let entry = map.get(plugin)
    if (!entry) {
      entry = new Map()
      map.set(plugin, entry)
    }
    return entry
  }

  // The bottom of every chain: nouns answer from memory, and a noun the test
  // environment cannot serve throws where a session's core would.
  const sandboxCore: NounCore = (event, args, plugin) => {
    const key = (index: number): string => String(args[index])
    switch (event) {
      // No filesystem, no processes, no network.
      case 'fs.read':
      case 'fs.write':
      case 'fs.list':
      case 'fs.exists':
      case 'fs.stat':
      case 'fs.ancestors':
        return unavailable(`$.${event}`)
      case 'process.run':
      case 'process.spawn':
      case 'process.hookEnv':
        return unavailable(`$.${event}`)
      case 'http.fetch':
        return unavailable('$.http.fetch')

      // In-memory nouns.
      case 'store.get':
        return bucket(store, plugin).get(key(0))
      case 'store.set':
        bucket(store, plugin).set(key(0), args[1])
        return {}
      case 'store.delete':
        return bucket(store, plugin).delete(key(0))
      case 'store.keys':
        return [...bucket(store, plugin).keys()]
      case 'state.get':
        return bucket(state, plugin).get(key(0))
      case 'state.set':
        bucket(state, plugin).set(key(0), args[1])
        return {}
      case 'clock.now':
        return Date.now()
      case 'clock.sleep':
        return {}
      case 'clock.after':
      case 'clock.every':
        return { cancel: () => {} }
      case 'env.get':
        return undefined
      case 'env.set':
        return {}

      // The session a test runs in.
      case 'session.start': {
        const input = isObject(args[0]) ? args[0] : {}
        return { cwd: typeof input.cwd === 'string' ? input.cwd : pluginRoot }
      }
      case 'session.cwd':
        return pluginRoot
      case 'session.root':
        return pluginRoot
      case 'session.id':
        return TEST_SESSION.id
      case 'session.surface':
        return TEST_SESSION.surface
      case 'session.surfaces':
        return [TEST_SESSION.surface]
      case 'session.version':
        return '2.1.328'
      case 'session.model':
        return null
      case 'session.repo':
        return null

      // Tools and commands the test draws.
      case 'tool.call':
        return { result: {} }
      case 'tool.list':
        return []
      case 'tool.describe':
        return {}
      case 'command.register': {
        const spec = isObject(args[0]) ? args[0] : {}
        if (typeof spec.name === 'string' && spec.name) {
          registered.push({
            name: spec.name,
            description: typeof spec.description === 'string' ? spec.description : '',
          })
        }
        return {}
      }
      case 'command.list':
        return registered.map(c => ({ ...c }))
      case 'command.describe':
        return { commands: registered.map(c => ({ ...c })) }
      case 'command.run':
        return { text: '' }

      // Surfaces the test does not paint.
      case 'ui.toast':
      case 'ui.status':
      case 'ui.log':
      case 'ui.notice':
      case 'ui.notify':
      case 'ui.invalidate':
      case 'ui.open':
      case 'ui.close':
        return {}

      default:
        return unavailable(`$.${event}`)
    }
  }

  const engine = new ModEngine()
  engine.registerNounCore(sandboxCore)

  // The test's own hooks need an api entry, or the chain skips them.
  engine.registerMod({
    identity: { name: TEST_PLUGIN, root: pluginRoot },
    register: () => {},
    options: {},
  })

  for (const mod of mods) {
    const merged: RegisterOptions = {
      ...mod.options,
      ...(testOptions.options ?? {}),
    }
    engine.registerMod({ ...mod, options: merged })
    const on = (event: string, matcherOrHook: any, maybeHook?: any) =>
      engine.on(mod.identity.name, event, matcherOrHook, maybeHook)
    await mod.register(on as OnFn, merged)
  }

  const on: OnFn = (event: string, matcherOrHook: any, maybeHook?: any) =>
    engine.on(TEST_PLUGIN, event, matcherOrHook, maybeHook)

  const emit = async (
    event: string,
    e: unknown,
    args: unknown[],
  ): Promise<{ value: unknown; denied: string | null }> => {
    const outcome = await engine.emit(event, e, () =>
      sandboxCore(event, args, TEST_PLUGIN),
    )
    return { value: unwrapOpAnswer(outcome), denied: outcome.denied }
  }

  // `$.tool.call` answers the way a tool call does: a deny is the result's
  // `{ deny }`, not a thrown error.
  const toolCall = async (input: unknown) => {
    const outcome = await emit('tool.call', input, [input])
    if (outcome.denied) return { deny: outcome.denied }
    return outcome.value
  }

  // `$.ui.mount` paints a drawing on a surface; this runtime has no surface,
  // so it refuses rather than pretending to draw.
  const mount = async () => {
    throw new Error(
      '$.ui.mount needs a surface, and cc-haha\'s test runtime draws none yet',
    )
  }

  const NOUNS = [
    'theme',
    'model',
    'audio',
    'mcp',
    'session',
    'turn',
    'prompt',
    'tool',
    'command',
    'config',
    'telemetry',
    'agent',
    'attribution',
    'skill',
    'fs',
    'store',
    'state',
    'clock',
    'http',
    'process',
    'settings',
    'env',
  ]

  const nounProxy = (noun: string, overrides: Record<string, unknown> = {}) =>
    new Proxy(overrides, {
      get(target, prop) {
        if (typeof prop !== 'string') return undefined
        if (prop in target) return target[prop]
        return (...args: unknown[]) => {
          const event = `${noun}.${prop}`
          return emit(event, shapeOpEvent(TEST_PLUGIN, event, args), args).then(
            outcome => {
              if (outcome.denied) throw new Error(outcome.denied)
              return outcome.value
            },
          )
        }
      },
      has() {
        return true
      },
    })

  const $: any = {
    plugin: { name: TEST_PLUGIN, root: pluginRoot },
    tool: nounProxy('tool', { call: toolCall }),
    ui: nounProxy('ui', { mount }),
    classic: new Proxy(
      {},
      {
        get(_target, prop) {
          if (typeof prop !== 'string') return undefined
          return async (input: unknown) => {
            const event = `classic.${prop}`
            const e = {
              hook_event_name: prop,
              session_id: TEST_SESSION.id,
              transcript_path: '',
              cwd: pluginRoot,
              ...(isObject(input) ? input : {}),
            }
            const outcome = await engine.emit(event, e, () => {
              throw new Error(`no hook answered ${event}`)
            })
            if (outcome.denied) throw new Error(outcome.denied)
            return outcome.value
          }
        },
      },
    ),
  }
  for (const noun of NOUNS) {
    if (noun in $) continue
    $[noun] = nounProxy(noun)
  }

  return { engine, $, on }
}
