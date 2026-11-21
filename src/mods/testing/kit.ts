// `claude-code/testing` — the kit a plugin's *.test.ts files import under
// `claude plugin test <dir>`. Mirrors the contract's testing module
// (src/mods/contract/claude-code-2.1.328.d.ts, `declare module
// 'claude-code/testing'`): test / describe / expect / tier / mock.
//
// The kit only collects; runtime.ts builds a per-test engine over the plugin
// under test, and runner.ts prints the verdicts.

export type PluginOptions = Record<string, unknown>

export type TestOptions = {
  // Inline plugins loaded beside the one under test (not implemented yet;
  // accepted so a test file written for the official kit still loads).
  plugins?: readonly unknown[]
  // How long the test may run; 5000 ms when not given.
  timeoutMs?: number
  // The plugin under test's userConfig values, as `register(on, options)`
  // receives them.
  options?: PluginOptions
}

export type TestBody = ($: any, on: any) => unknown

export type CollectedTest = {
  title: string
  options: TestOptions
  body: TestBody
}

const DEFAULT_TIMEOUT_MS = 5000
const collected: CollectedTest[] = []
const groups: string[] = []

/**
 * A group of tests: its name leads the title of each test declared inside,
 * and its body runs at once, while the file loads.
 */
export function describe(name: string, body: () => void): void {
  groups.push(name)
  try {
    body()
  } finally {
    groups.pop()
  }
}

/**
 * One test: `test(name, body)` or `test(name, options, body)`.
 */
export function test(
  name: string,
  ...rest: [TestBody] | [TestOptions, TestBody]
): void {
  const body = rest[rest.length - 1] as TestBody
  const options = rest.length === 2 ? (rest[0] as TestOptions) : {}
  if (typeof body !== 'function') {
    throw new TypeError(`test("${name}") needs a body function`)
  }
  collected.push({
    title: [...groups, name].join(' > '),
    options,
    body,
  })
}

/**
 * Says which tier the plugin under test loads in. The kit runs every plugin
 * as the person's own, so this only records the file's choice.
 */
let declaredTier = 'user'
export function tier(value: string): void {
  declaredTier = value
}

export function __declaredTier(): string {
  return declaredTier
}

export function __collectTests(): readonly CollectedTest[] {
  return collected
}

export function __resetKit(): void {
  collected.length = 0
  groups.length = 0
  declaredTier = 'user'
}

export function __timeoutOf(options: TestOptions): number {
  return options.timeoutMs && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS
}

// --- expect ---------------------------------------------------------------

export type AsymmetricMatcher = {
  readonly text: string
  readonly __asymmetric: true
  matches(value: unknown): boolean
}

function asymmetric(
  text: string,
  matches: (value: unknown) => boolean,
): AsymmetricMatcher {
  return { text, __asymmetric: true, matches }
}

export type MatcherSet = {
  toBe(expected: unknown): void
  toEqual(expected: unknown): void
  toStrictEqual(expected: unknown): void
  toMatchObject(expected: object): void
  toContain(item: unknown): void
  toContainEqual(item: unknown): void
  toHaveLength(length: number): void
  toHaveProperty(path: string | readonly string[], value?: unknown): void
  toBeUndefined(): void
  toBeDefined(): void
  toBeNull(): void
  toBeTruthy(): void
  toBeFalsy(): void
  toBeNaN(): void
  toBeGreaterThan(bound: number | bigint): void
  toBeGreaterThanOrEqual(bound: number | bigint): void
  toBeLessThan(bound: number | bigint): void
  toBeLessThanOrEqual(bound: number | bigint): void
  toMatch(pattern: string | RegExp): void
  toStartWith(prefix: string): void
  toEndWith(suffix: string): void
  toBeInstanceOf(expected: new (...args: never[]) => unknown): void
  toThrow(expected?: string | RegExp | (new (...args: never[]) => unknown)): void
}

export type Expecting = ((received: unknown, message?: string) => MatcherSet) & {
  any(constructor: new (...args: never[]) => unknown): AsymmetricMatcher
  anything(): AsymmetricMatcher
  objectContaining(subset: Record<string, unknown>): AsymmetricMatcher
  arrayContaining(items: readonly unknown[]): AsymmetricMatcher
  stringContaining(text: string): AsymmetricMatcher
  stringMatching(pattern: string | RegExp): AsymmetricMatcher
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isAsymmetric(value: unknown): value is AsymmetricMatcher {
  return isObject(value) && (value as any).__asymmetric === true
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (isAsymmetric(b)) return b.matches(a)
  if (isAsymmetric(a)) return a.matches(b)
  if (Object.is(a, b)) return true
  if (typeof a !== typeof b) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false
    }
    return true
  }
  if (a instanceof Date || b instanceof Date) {
    return (
      a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
    )
  }
  if (isObject(a) && isObject(b)) {
    const ak = Object.keys(a)
    const bk = Object.keys(b)
    if (ak.length !== bk.length) return false
    for (const key of ak) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false
      if (!deepEqual(a[key], b[key])) return false
    }
    return true
  }
  return false
}

function show(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`
  if (typeof value === 'bigint') return `${value}n`
  if (value === undefined) return 'undefined'
  try {
    const text = (globalThis as any).Bun?.inspect?.(value, { depth: 4 })
    if (typeof text === 'string') return text
  } catch {
    // fall through to JSON
  }
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

class ExpectationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExpectationError'
  }
}

function propertyAt(
  value: unknown,
  path: string | readonly string[],
): { found: boolean; value: unknown } {
  const parts = Array.isArray(path) ? path : String(path).split('.')
  let cur: unknown = value
  for (const part of parts) {
    if (!isObject(cur) && !Array.isArray(cur)) return { found: false, value: undefined }
    if (!Object.prototype.hasOwnProperty.call(cur, part)) {
      return { found: false, value: undefined }
    }
    cur = (cur as any)[part]
  }
  return { found: true, value: cur }
}

export const expect: Expecting = Object.assign(
  (received: unknown, message?: string): MatcherSet => {
    const where = message ? ` — ${message}` : ''
    const fail = (detail: string): never => {
      throw new ExpectationError(`${detail}${where}`)
    }
    const check = (ok: boolean, detail: () => string): void => {
      if (!ok) fail(detail())
    }
    return {
      toBe(expected) {
        check(
          Object.is(received, expected),
          () => `expected ${show(received)} to be ${show(expected)}`,
        )
      },
      toEqual(expected) {
        check(
          deepEqual(received, expected),
          () => `expected ${show(received)} to equal ${show(expected)}`,
        )
      },
      toStrictEqual(expected) {
        check(
          deepEqual(received, expected),
          () => `expected ${show(received)} to strictly equal ${show(expected)}`,
        )
      },
      toMatchObject(expected) {
        const ok = isObject(received) && isObject(expected)
          ? Object.entries(expected).every(([k, v]) => deepEqual((received as any)[k], v))
          : false
        check(
          ok,
          () => `expected ${show(received)} to match object ${show(expected)}`,
        )
      },
      toContain(item) {
        const ok =
          typeof received === 'string'
            ? received.includes(String(item))
            : Array.isArray(received) && received.includes(item)
        check(ok, () => `expected ${show(received)} to contain ${show(item)}`)
      },
      toContainEqual(item) {
        const ok = Array.isArray(received) && received.some(v => deepEqual(v, item))
        check(ok, () => `expected ${show(received)} to contain equal ${show(item)}`)
      },
      toHaveLength(length) {
        const got = (received as { length?: unknown })?.length
        check(
          got === length,
          () => `expected length ${show(got)} to be ${length}`,
        )
      },
      toHaveProperty(path, value) {
        const hit = propertyAt(received, path)
        const ok = arguments.length > 1 || value !== undefined
          ? hit.found && deepEqual(hit.value, value)
          : hit.found
        check(
          ok,
          () => `expected ${show(received)} to have property ${show(path)}${
            value === undefined ? '' : ` = ${show(value)}`
          }`,
        )
      },
      toBeUndefined() {
        check(received === undefined, () => `expected ${show(received)} to be undefined`)
      },
      toBeDefined() {
        check(received !== undefined, () => 'expected value to be defined')
      },
      toBeNull() {
        check(received === null, () => `expected ${show(received)} to be null`)
      },
      toBeTruthy() {
        check(Boolean(received), () => `expected ${show(received)} to be truthy`)
      },
      toBeFalsy() {
        check(!received, () => `expected ${show(received)} to be falsy`)
      },
      toBeNaN() {
        check(Number.isNaN(received), () => `expected ${show(received)} to be NaN`)
      },
      toBeGreaterThan(bound) {
        check((received as number) > bound, () => `expected ${show(received)} > ${bound}`)
      },
      toBeGreaterThanOrEqual(bound) {
        check((received as number) >= bound, () => `expected ${show(received)} >= ${bound}`)
      },
      toBeLessThan(bound) {
        check((received as number) < bound, () => `expected ${show(received)} < ${bound}`)
      },
      toBeLessThanOrEqual(bound) {
        check((received as number) <= bound, () => `expected ${show(received)} <= ${bound}`)
      },
      toMatch(pattern) {
        const ok =
          typeof received === 'string' &&
          (typeof pattern === 'string'
            ? received.includes(pattern)
            : pattern.test(received))
        check(ok, () => `expected ${show(received)} to match ${show(pattern)}`)
      },
      toStartWith(prefix) {
        check(
          typeof received === 'string' && received.startsWith(prefix),
          () => `expected ${show(received)} to start with ${show(prefix)}`,
        )
      },
      toEndWith(suffix) {
        check(
          typeof received === 'string' && received.endsWith(suffix),
          () => `expected ${show(received)} to end with ${show(suffix)}`,
        )
      },
      toBeInstanceOf(expected) {
        check(
          received instanceof expected,
          () => `expected ${show(received)} to be an instance of ${expected.name}`,
        )
      },
      toThrow(expected) {
        let thrown: unknown
        let didThrow = false
        try {
          ;(received as () => unknown)()
        } catch (error) {
          didThrow = true
          thrown = error
        }
        if (!didThrow) fail('expected the function to throw, but it returned')
        const message =
          thrown instanceof Error ? thrown.message : String(thrown ?? '')
        if (expected === undefined) return
        if (typeof expected === 'string') {
          check(
            message.includes(expected),
            () => `expected thrown message ${show(message)} to contain ${show(expected)}`,
          )
          return
        }
        if (expected instanceof RegExp) {
          check(
            expected.test(message),
            () => `expected thrown message ${show(message)} to match ${show(expected)}`,
          )
          return
        }
        check(
          thrown instanceof expected,
          () => `expected the thrown value to be an instance of ${expected.name}`,
        )
      },
    }
  },
  {
    any: (constructor: new (...args: never[]) => unknown) =>
      asymmetric(`any(${constructor.name})`, value => {
        // `expect.any(String)` takes the primitive too, as the contract's
        // matcher does.
        if (constructor === String) return typeof value === 'string'
        if (constructor === Number) return typeof value === 'number'
        if (constructor === Boolean) return typeof value === 'boolean'
        if (constructor === Function) return typeof value === 'function'
        return value instanceof constructor
      }),
    anything: () => asymmetric('anything()', value => value !== null && value !== undefined),
    objectContaining: (subset: Record<string, unknown>) =>
      asymmetric(`objectContaining(${show(subset)})`, value =>
        isObject(value) &&
        Object.entries(subset).every(([k, v]) => deepEqual((value as any)[k], v)),
      ),
    arrayContaining: (items: readonly unknown[]) =>
      asymmetric(`arrayContaining(${show(items)})`, value =>
        Array.isArray(value) &&
        items.every(item => value.some(entry => deepEqual(entry, item))),
      ),
    stringContaining: (text: string) =>
      asymmetric(`stringContaining(${show(text)})`, value =>
        typeof value === 'string' && value.includes(text),
      ),
    stringMatching: (pattern: string | RegExp) =>
      asymmetric(`stringMatching(${show(pattern)})`, value =>
        typeof value === 'string' &&
        (typeof pattern === 'string' ? value.includes(pattern) : pattern.test(value)),
      ),
  },
)

// --- mock -----------------------------------------------------------------

type MockOn = (
  event: string,
  handler: ($: any, e: any) => unknown,
) => unknown

const answer = (value: unknown) => ({ value })

/**
 * The world beneath the plugins, mocked noun by noun: `mock.clock`,
 * `mock.store`, `mock.env` and `mock.session`, each registering hooks of the
 * test's `on` and answering its noun from memory.
 */
export const mock = {
  clock(
    on: MockOn,
    options?: { now?: number },
  ): { now(): number; advance(ms: number): void; set(ms: number): void } {
    let now = options?.now ?? 0
    on('clock.now', () => answer(now))
    on('clock.sleep', (_: any, e: any) => {
      now += sleepMs(e)
      return answer({})
    })
    on('clock.after', (_: any, e: any) => {
      now += sleepMs(e)
      return answer({ cancel: () => {} })
    })
    on('clock.every', () => answer({ cancel: () => {} }))
    return {
      now: () => now,
      advance(ms: number) {
        now += ms
      },
      set(ms: number) {
        now = ms
      },
    }
  },

  store(on: MockOn, entries?: Readonly<Record<string, unknown>>): void {
    const store = new Map<string, unknown>(Object.entries(entries ?? {}))
    const keyOf = (e: any): string => {
      const key = e?.key ?? e?.name ?? e?.args?.[0]
      return String(key)
    }
    on('store.get', (_: any, e: any) => answer(store.get(keyOf(e))))
    on('store.set', (_: any, e: any) => {
      store.set(keyOf(e), e?.value ?? e?.args?.[1])
      return answer({})
    })
    on('store.delete', (_: any, e: any) => answer(store.delete(keyOf(e))))
    on('store.keys', () => answer([...store.keys()]))
  },

  env(on: MockOn, variables: Readonly<Record<string, string>>): void {
    on('env.get', (_: any, e: any) =>
      answer(variables[String(e?.name ?? e?.args?.[0])]),
    )
  },

  session(on: MockOn): { rows: unknown[] } {
    const rows: unknown[] = []
    on('session.append', (_: any, e: any) => {
      rows.push(e?.row ?? e?.args?.[0] ?? e)
      return answer({})
    })
    return { rows }
  },
}

function sleepMs(e: any): number {
  const value = e?.ms ?? e?.args?.[0]
  const ms = Number(value)
  return Number.isFinite(ms) && ms > 0 ? ms : 0
}
