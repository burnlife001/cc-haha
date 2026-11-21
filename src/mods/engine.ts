// cc-mods engine core: mod registry, hook chain, and per-plugin `$` API.
// Semantics mirror the official Claude Code 2.1.328 mods runtime as observed
// from cc-mods plugins (next(e) / {deny} / {result} / handle.catch) and the
// contract in src/mods/contract/claude-code-2.1.328.d.ts.

import type {
  EmitOutcome,
  HookHandle,
  LoadedMod,
  ModCatchHook,
  ModEngineApi,
  ModHook,
  ModMatcher,
  NextFunction,
  RegisterOptions,
} from './types.js'
import { shapeOpEvent, unwrapOpAnswer } from './opEvents.js'

type HookEntry = {
  plugin: string
  matcher: ModMatcher | null
  hook: ModHook
  catchHook: ModCatchHook | null
}

// Events whose core answers are cached until invalidate(), per the contract
// (tool.describe, command.describe, config.describe, prompt.section,
// prompt.context, prompt.attachment, ui.render).
const CACHEABLE_EVENTS = new Set([
  'tool.describe',
  'command.describe',
  'config.describe',
  'prompt.section',
  'prompt.context',
  'prompt.attachment',
  'ui.render',
])

// A successful registration (or config write) changes what later list /
// describe answers must say, so their cached answers are dropped.
const REGISTRATION_INVALIDATES: Record<string, string[]> = {
  'tool.register': ['tool.list', 'tool.describe'],
  'agent.register': ['agent.list'],
  'command.register': ['command.list', 'command.describe'],
  'config.set': ['config.list', 'config.describe'],
}

function matcherMatches(matcher: ModMatcher | null, event: string, e: any): boolean {
  if (matcher === null) return true
  if (typeof matcher === 'string') return event === matcher
  for (const [key, want] of Object.entries(matcher)) {
    const got = e?.[key]
    if (Array.isArray(want)) {
      if (!want.includes(got)) return false
    } else if (got !== want) {
      return false
    }
  }
  return true
}

export type NounCore = (
  event: string,
  args: unknown[],
  plugin: string,
) => Promise<unknown> | unknown

export class ModEngine {
  private mods: LoadedMod[] = []
  private hooks = new Map<string, HookEntry[]>()
  private apis = new Map<string, ModEngineApi>()
  private nounCore: NounCore | null = null
  private describeCache = new Map<string, unknown>()

  registerNounCore(core: NounCore): void {
    this.nounCore = core
  }

  registerMod(mod: LoadedMod): void {
    if (this.mods.some(m => m.identity.name === mod.identity.name)) return
    this.mods.push(mod)
    this.apis.set(mod.identity.name, this.buildApi(mod))
  }

  get loadedMods(): readonly LoadedMod[] {
    return this.mods
  }

  hasHooksFor(event: string): boolean {
    return (this.hooks.get(event) ?? []).length > 0
  }

  on(
    plugin: string,
    event: string,
    matcherOrHook: ModMatcher | ModHook,
    maybeHook?: ModHook,
  ): HookHandle {
    const matcher =
      typeof maybeHook === 'function' ? (matcherOrHook as ModMatcher) : null
    const hook =
      typeof maybeHook === 'function' ? maybeHook : (matcherOrHook as ModHook)
    const entry: HookEntry = { plugin, matcher, hook, catchHook: null }
    const list = this.hooks.get(event) ?? []
    list.push(entry)
    this.hooks.set(event, list)
    return {
      catch: (catchHook: ModCatchHook) => {
        entry.catchHook = catchHook
      },
    }
  }

  invalidate(event: string): void {
    for (const key of [...this.describeCache.keys()]) {
      if (key.startsWith(`${event}:`) || key === event) {
        this.describeCache.delete(key)
      }
    }
  }

  async emit(
    event: string,
    initial: unknown,
    core?: (e: unknown) => Promise<unknown> | unknown,
  ): Promise<EmitOutcome> {
    const entries = (this.hooks.get(event) ?? []).filter(entry =>
      matcherMatches(entry.matcher, event, initial),
    )
    const cacheable = CACHEABLE_EVENTS.has(event) && core !== undefined
    const cacheKey = cacheable ? `${event}:${safeJson(initial)}` : null
    if (cacheKey !== null && this.describeCache.has(cacheKey)) {
      return {
        value: this.describeCache.get(cacheKey),
        handled: false,
        denied: null,
      }
    }

    let denied: string | null = null
    let ranCore = false

    const step = async (i: number, current: any): Promise<any> => {
      if (denied) return undefined
      if (i >= entries.length) {
        ranCore = true
        return core ? await core(current) : current
      }
      const entry = entries[i]
      const api = this.apis.get(entry.plugin)
      if (!api) return step(i + 1, current)

      const state = { called: false, error: null as { kind: string } | null }
      const next = (async (ne?: unknown) => {
        state.called = true
        if (denied) return undefined
        return step(i + 1, ne === undefined ? current : ne)
      }) as NextFunction
      Object.defineProperty(next, 'called', { get: () => state.called })
      Object.defineProperty(next, 'error', { get: () => state.error })

      let ret: unknown
      try {
        ret = await entry.hook(api, current, next)
      } catch (ex) {
        state.error = {
          kind: ex instanceof Error ? `${ex.name}: ${ex.message}` : String(ex),
        }
        if (entry.catchHook) {
          try {
            ret = await entry.catchHook(api, current, next)
          } catch (ex2) {
            denied = denyText(
              entry.plugin,
              event,
              ex2 instanceof Error ? ex2.message : String(ex2),
            )
            return undefined
          }
        } else {
          // Fail closed: an unguarded throwing hook denies the call, the
          // same posture readonly-guard documents for its own .catch.
          denied = denyText(entry.plugin, event, state.error.kind)
          return undefined
        }
      }

      if (denied) return undefined
      if (ret !== undefined && ret !== null && isObject(ret) && typeof (ret as any).deny === 'string') {
        denied = (ret as any).deny
        return undefined
      }
      if (ret === undefined && !state.called) {
        // Tolerate a hook that neither returns next(e) nor a value: continue.
        return step(i + 1, current)
      }
      return ret
    }

    const value = await step(0, initial)
    if (cacheKey !== null && !denied) {
      this.describeCache.set(cacheKey, value)
    }
    return { value, handled: !ranCore && denied === null, denied }
  }

  // `$` noun methods dispatch as op events through the chain, so a mod can
  // observe or override another mod's `$.fs.read(...)` the way the official
  // engine routes every `$` call through its event. `e` is the call's own
  // argument object (OpEventOf), and a hook's `{ value }` answers the call.
  async emitOp(plugin: string, nounEvent: string, args: unknown[]): Promise<any> {
    const core = this.nounCore
    const e = shapeOpEvent(plugin, nounEvent, args)
    const outcome = await this.emit(
      nounEvent,
      e,
      core ? () => core(nounEvent, args, plugin) : undefined,
    )
    if (outcome.denied) {
      throw new Error(outcome.denied)
    }
    // A successful registration changes what the describe/list answers say;
    // drop the cached answers so the next call reads the new registry. A
    // refusal (core's `{ deny }`, or a hook's) leaves the cache alone.
    const invalidates = REGISTRATION_INVALIDATES[nounEvent]
    if (
      invalidates &&
      !(typeof outcome.value === 'object' &&
        outcome.value !== null &&
        typeof (outcome.value as { deny?: unknown }).deny === 'string')
    ) {
      for (const event of invalidates) this.invalidate(event)
    }
    return unwrapOpAnswer(outcome)
  }

  private buildApi(mod: LoadedMod): ModEngineApi {
    const engine = this
    const name = mod.identity.name
    const call = (nounEvent: string) => (...args: unknown[]) =>
      engine.emitOp(name, nounEvent, args)

    // Noun tables follow CoreEngineInterface in the contract d.ts. UI nouns
    // live behind the same dispatch; their core implementation renders via
    // the active surface bridge (terminal Ink / desktop), filled in by the
    // ui noun module — missing cores deny until wired.
    const api: ModEngineApi = {
      plugin: { ...mod.identity },
      ui: {
        toast: call('ui.toast'),
        status: call('ui.status'),
        log: call('ui.log'),
        notice: call('ui.notice'),
        invalidate: (event: string) => engine.invalidate(event),
        open: call('ui.open'),
        close: call('ui.close'),
        panes: call('ui.panes'),
        place: call('ui.place'),
        blit: call('ui.blit'),
        notify: call('ui.notify'),
        cancelNotify: call('ui.cancelNotify'),
        resolve: call('ui.resolve'),
        selection: call('ui.selection'),
        copy: call('ui.copy'),
        view: call('ui.view'),
      },
      theme: { set: call('theme.set'), clear: call('theme.clear') },
      model: {
        complete: call('model.complete'),
        classify: call('model.classify'),
        fork: call('model.fork'),
      },
      audio: { play: call('audio.play'), speak: call('audio.speak') },
      mcp: { call: call('mcp.call'), connect: call('mcp.connect') },
      session: {
        cwd: call('session.cwd'),
        root: call('session.root'),
        model: call('session.model'),
        turns: call('session.turns'),
        id: call('session.id'),
        messages: call('session.messages'),
        repo: call('session.repo'),
        surface: call('session.surface'),
        surfaces: call('session.surfaces'),
        authorize: call('session.authorize'),
        identity: call('session.identity'),
        usage: call('session.usage'),
        version: call('session.version'),
        info: call('session.info'),
        machine: call('session.machine'),
      },
      turn: { abort: call('turn.abort') },
      prompt: {
        read: call('prompt.read'),
        paint: call('prompt.paint'),
      },
      tool: {
        list: call('tool.list'),
        register: call('tool.register'),
        describe: call('tool.describe'),
      },
      command: {
        list: call('command.list'),
        register: call('command.register'),
        run: call('command.run'),
        describe: call('command.describe'),
      },
      config: {
        list: call('config.list'),
        set: call('config.set'),
        describe: call('config.describe'),
      },
      telemetry: { log: call('telemetry.log'), mark: call('telemetry.mark') },
      agent: {
        list: call('agent.list'),
        register: call('agent.register'),
        offer: call('agent.offer'),
        spawn: call('agent.spawn'),
        call: call('agent.call'),
        limits: call('agent.limits'),
      },
      attribution: { text: call('attribution.text') },
      skill: { prompt: call('skill.prompt') },
      fs: {
        read: call('fs.read'),
        write: call('fs.write'),
        list: call('fs.list'),
        exists: call('fs.exists'),
        stat: call('fs.stat'),
        ancestors: call('fs.ancestors'),
      },
      store: {
        get: call('store.get'),
        set: call('store.set'),
        delete: call('store.delete'),
        keys: call('store.keys'),
      },
      state: { get: call('state.get'), set: call('state.set') },
      clock: {
        now: call('clock.now'),
        sleep: call('clock.sleep'),
        after: call('clock.after'),
        every: call('clock.every'),
      },
      http: { fetch: call('http.fetch') },
      process: {
        run: call('process.run'),
        spawn: call('process.spawn'),
        hookEnv: call('process.hookEnv'),
      },
      settings: { read: call('settings.read') },
      env: { get: call('env.get'), set: call('env.set') },
    }
    return api
  }
}

function denyText(plugin: string, event: string, kind: string): string {
  return `${plugin}: ${event} hook failed (${kind})`
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? 'undefined'
  } catch {
    return String(v)
  }
}

export type { RegisterOptions }
