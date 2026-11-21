// Single entry point for cc-mods integration. Upstream files call exactly one
// function from this module per integration point — see INTEGRATION.md.

import { registerHookCallbacks } from '../bootstrap/state.js'
import type { Command, LocalCommandResult } from '../types/command.js'
import type { HookEvent } from '../types/hooks.js'
import { CLASSIC_EVENT_MAP, type ClassicEventName, normalizeClassicEvent } from './events.js'
import { ModEngine } from './engine.js'
import { loadAllMods } from './loader.js'
import {
  buildSessionMeasureInput,
  coreNouns,
  modsRegisteredCommands,
} from './nouns.js'
import type { ToolCallOutcome } from './types.js'

let engine: ModEngine | null = null
let enginePromise: Promise<ModEngine> | null = null

export function getModsEngine(): ModEngine {
  if (!engine) {
    engine = new ModEngine()
    engine.registerNounCore(coreNouns)
  }
  return engine
}

async function ensureEngineLoaded(): Promise<ModEngine> {
  const e = getModsEngine()
  if (enginePromise) return enginePromise
  enginePromise = (async () => {
    const { mods, failures } = await loadAllMods()
    for (const failure of failures) {
      console.warn(
        `[mods] ${failure.plugin}/${failure.module}: ${failure.reason}`,
      )
    }
    for (const mod of mods) {
      if (e.loadedMods.some(m => m.identity.name === mod.identity.name))
        continue
      e.registerMod(mod)
      const on = (event: string, matcherOrHook: any, maybeHook?: any) =>
        e.on(mod.identity.name, event, matcherOrHook, maybeHook)
      try {
        await mod.register(on, mod.options)
      } catch (ex) {
        console.warn(
          `[mods] ${mod.identity.name}: register() failed: ${ex instanceof Error ? ex.message : ex}`,
        )
      }
    }
    registerClassicBridge(e)
    return e
  })()
  return enginePromise
}

// The one hot-path integration: called at the top of
// checkPermissionsAndCallTool. Returns null when no mod intercepted.
export async function modsToolCall(args: {
  tool: string
  toolUseID: string
  input: Record<string, unknown>
}): Promise<ToolCallOutcome> {
  await ensureEngineLoaded()
  const e = getModsEngine()
  // Fast path: no mod watches tool.call — return without emitting.
  if (!e.hasHooksFor('tool.call')) return null
  const event = {
    tool: args.tool,
    tool_use_id: args.toolUseID,
    ...args.input,
  }
  const outcome = await e.emit('tool.call', event)
  if (outcome.denied) {
    return { kind: 'deny', reason: outcome.denied }
  }
  if (
    outcome.handled &&
    outcome.value &&
    typeof outcome.value === 'object' &&
    'result' in (outcome.value as Record<string, unknown>)
  ) {
    return {
      kind: 'result',
      result: (outcome.value as Record<string, unknown>).result as Record<
        string,
        unknown
      >,
    }
  }
  return null
}

// Fire-and-forget early load; call once from the CLI entry (see
// INTEGRATION.md). Idempotent.
export function installMods(): void {
  void ensureEngineLoaded().catch(ex => {
    console.warn(`[mods] engine load failed: ${ex instanceof Error ? ex.message : ex}`)
  })
}

// Remaining lifecycle emissions, used by the classic bridge and M2+ hooks.
// The input is normalized first so every branch sees the same four engine
// fields (session_id / transcript_path / cwd / hook_event_name).
export async function modsEmitClassic(
  event: ClassicEventName,
  input: unknown,
): Promise<void> {
  await ensureEngineLoaded()
  await getModsEngine().emit(event, await normalizeClassicEvent(event, input))
}

export async function modsEmit(event: string, e: unknown): Promise<unknown> {
  await ensureEngineLoaded()
  return (await getModsEngine().emit(event, e)).value
}

// `session.measure` is a lifecycle event, not a `$` noun, so nothing in this
// module can raise it on a schedule: the turn loop owns the reading. M4 ships
// the assembly and dispatch seam; M5 calls it from the API response path (see
// INTEGRATION.md, "尚未挂接" section). Hooks that watch the event already see
// the contract shape when it is raised.
export async function modsEmitSessionMeasure(): Promise<void> {
  await ensureEngineLoaded()
  const e = getModsEngine()
  if (!e.hasHooksFor('session.measure')) return
  const input = await buildSessionMeasureInput()
  // The contract says `changed` is never empty: no move, no measurement.
  if (input.changed.length === 0) return
  await e.emit('session.measure', input, (ev: unknown) => ({
    changed: (ev as { changed: string[] }).changed,
  }))
}

// --- classic bridge -------------------------------------------------------

function registerClassicBridge(e: ModEngine): void {
  const byHookEvent = new Map<HookEvent, ClassicEventName[]>()
  for (const [classic, hookEvent] of Object.entries(CLASSIC_EVENT_MAP)) {
    const list = byHookEvent.get(hookEvent as HookEvent) ?? []
    list.push(classic as ClassicEventName)
    byHookEvent.set(hookEvent as HookEvent, list)
  }

  const registrations: Partial<
    Record<HookEvent, Array<{ matcher?: string; hooks: any[] }>>
  > = {}

  for (const [hookEvent, classics] of byHookEvent) {
    if (!classics.some(c => e.hasHooksFor(c))) continue
    const callback = {
      type: 'callback' as const,
      callback: async (input: unknown) => {
        for (const classic of classics) {
          await e.emit(classic, await normalizeClassicEvent(classic, input))
        }
        return {
          continue: true,
          suppressOutput: true,
        }
      },
      internal: true,
    }
    registrations[hookEvent] = [
      { hooks: [callback] },
    ]
  }

  if (Object.keys(registrations).length > 0) {
    registerHookCallbacks(registrations as any)
  }
}

// prompt.compose emission at the system-prompt assembly point. Returns the
// sections unchanged when no mod watches the event.
export async function modsComposePromptSections(
  sections: string[],
): Promise<string[]> {
  await ensureEngineLoaded()
  const e = getModsEngine()
  if (!e.hasHooksFor('prompt.compose')) return sections
  const outcome = await e.emit(
    'prompt.compose',
    { sections },
    async (ev: unknown) => (ev as { sections: string[] }).sections,
  )
  return Array.isArray(outcome.value) ? (outcome.value as string[]) : sections
}

// Mod-registered slash commands (e.g. readonly-guard's /readonly-reload)
// surfaced as local commands so getCommands needs a one-line append only.
// Running one emits command.run through the chain; the mod's `{ text }`
// return value is what the user sees.
export function modsLocalCommands(): Command[] {
  if (!enginePromise) return []
  const e = getModsEngine()
  if (!e.hasHooksFor('command.run')) return []
  return modsRegisteredCommands().map(
    (c): Command =>
      ({
        type: 'local',
        name: c.name,
        description: c.description,
        supportsNonInteractive: true,
        load: () =>
          Promise.resolve({
            call: async (args: string): Promise<LocalCommandResult> => {
              const outcome = await e.emit(
                'command.run',
                { command: c.name, args, source: 'slash' },
                async () => ({ text: '' }),
              )
              const text =
                outcome.denied ??
                (outcome.value && typeof outcome.value === 'object'
                  ? String((outcome.value as { text?: unknown }).text ?? '')
                  : '')
              return { type: 'text', value: text }
            },
          }),
      }) as Command,
  )
}

// Test seam: reset the singleton between hermetic tests.
export function __resetModsForTests(): void {
  engine = null
  enginePromise = null
}
