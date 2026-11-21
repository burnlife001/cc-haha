// Runtime types for the cc-mods engine. The authoritative contract is
// src/mods/contract/claude-code-2.1.328.d.ts (official, written by the
// engine); these types are the slim runtime shapes the engine itself uses.

export type ModMatcher =
  | string
  | {
      tool?: string | string[]
      command?: string | string[]
      [key: string]: unknown
    }

export type NextFunction = ((e?: unknown) => Promise<unknown>) & {
  called: boolean
  error: { kind: string } | null
}

export type ModHook = ($: ModEngineApi, e: any, next: NextFunction) => unknown
export type ModCatchHook = (
  $: ModEngineApi,
  e: any,
  next: NextFunction,
) => unknown

export type RegisterOptions = Record<string, unknown>

export type RegisterFn = (
  on: OnFn,
  options?: RegisterOptions,
) => void | Promise<void>

export type OnFn = {
  (event: string, hook: ModHook): HookHandle
  (event: string, matcher: ModMatcher, hook: ModHook): HookHandle
}

export type HookHandle = {
  catch: (hook: ModCatchHook) => void
}

export type ModPluginIdentity = {
  name: string
  root: string
}

// The `$` surface handed to every hook. Nouns are built per plugin by the
// engine; the shape follows CoreEngineInterface in the contract d.ts. Kept
// structural here — the full typed surface lives in the contract file.
export type ModEngineApi = {
  plugin: ModPluginIdentity
  [noun: string]: any
}

export type ToolCallOutcome =
  | { kind: 'result'; result: Record<string, unknown> }
  | { kind: 'deny'; reason: string }
  | null

export type LoadedMod = {
  identity: ModPluginIdentity
  register: RegisterFn
  options: RegisterOptions
}

export type EmitOutcome = {
  // What the innermost (core) handler returned, or what a hook short-circuited
  // with. `handled` is true when a hook returned a value without calling next.
  value: unknown
  handled: boolean
  denied: string | null
}
