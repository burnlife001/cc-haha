// `claude-code/testing` — the kit a plugin's *.test.ts files import under
// `claude plugin test <dir>`. See kit.ts for the exports; runtime.ts builds the
// per-test engine, and runner.ts is the per-file process entry.

export {
  describe,
  expect,
  mock,
  test,
  tier,
  __collectTests,
  __declaredTier,
  __resetKit,
  __timeoutOf,
  type AsymmetricMatcher,
  type CollectedTest,
  type Expecting,
  type MatcherSet,
  type PluginOptions,
  type TestBody,
  type TestOptions,
} from './kit.js'

// --- runtime surfaces a hooks module may import from 'claude-code' ----------
// The runtime import is empty in a session (the module only carries types), so
// a JSX test file needs the two globals a hooks module compiles against.

export type RenderNode =
  | string
  | { type: unknown; props: Record<string, unknown>; children?: RenderNode[] }

export function h(
  type: unknown,
  props: Record<string, unknown> | null,
  ...children: unknown[]
): RenderNode {
  const flat: RenderNode[] = []
  const push = (value: unknown): void => {
    if (value === null || value === undefined || value === false) return
    if (Array.isArray(value)) {
      for (const item of value) push(item)
      return
    }
    flat.push(typeof value === 'number' ? String(value) : (value as RenderNode))
  }
  push(children)
  return { type, props: { ...(props ?? {}) }, children: flat }
}

export function Fragment(props: { children?: unknown }): RenderNode {
  return h('Fragment', null, props?.children)
}
