// Op-event shapes: how a `$` noun call's arguments cross to a hook as `e`.
//
// The contract (src/mods/contract/claude-code-2.1.328.d.ts, `OpEventOf`) types
// `e` as the call's own argument: `$.process.run(argv, init)` raises
// `{ argv, init }`, `$.ui.toast(text, { timeoutMs })` raises
// `{ text, timeoutMs }`, and a one-object argument (`$.command.register(spec)`)
// crosses as that object. A hook answers with `{ value }` to answer the call in
// core's place, which the caller receives as the call's result.

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// Positional nouns whose argument list is not a single object.
const POSITIONAL: Record<string, (args: readonly unknown[]) => Record<string, unknown>> = {
  'fs.read': a => ({ path: a[0], as: 'text', ...(isObject(a[1]) ? a[1] : {}) }),
  'fs.write': a => ({ path: a[0], text: a[1] }),
  'fs.list': a => ({ path: a[0] }),
  'fs.exists': a => ({ path: a[0] }),
  'fs.stat': a => ({ path: a[0] }),
  'fs.ancestors': a => ({ path: a[0] }),
  'process.run': a => ({ argv: a[0], init: a[1] }),
  'env.get': a => ({ name: a[0] }),
  'env.set': a => ({ name: a[0], value: a[1] }),
  'ui.toast': a => ({ text: a[0], ...(isObject(a[1]) ? a[1] : {}) }),
  'ui.status': a => ({ text: a[0] }),
  'ui.log': a => ({ text: a[0], ...(isObject(a[1]) ? a[1] : {}) }),
  'ui.notice': a => ({ tool_use_id: a[0], text: a[1] }),
  'store.get': a => ({ key: a[0] }),
  'store.set': a => ({ key: a[0], value: a[1] }),
  'store.delete': a => ({ key: a[0] }),
  'state.get': a => ({ key: a[0] }),
  'state.set': a => ({ key: a[0], value: a[1] }),
  'http.fetch': a => ({ url: a[0], init: a[1] }),
  // Describe nouns take the subject alone; the contract's `e` names it
  // (`ToolDescribeInput.tool`, `CommandDescribeInput.command`,
  // `ConfigDescribeInput.key`) rather than carrying a bare argument list.
  'tool.describe': a => ({ tool: a[0] }),
  'command.describe': a => ({ command: a[0] }),
  'config.describe': a => ({ key: a[0] }),
}

export function shapeOpEvent(
  plugin: string,
  event: string,
  args: readonly unknown[],
): Record<string, unknown> {
  // command.run carries its subject in `command`, not `args`, so a
  // `{ command: 'x' }` matcher sees the same shape whether the event came
  // from a typed slash command or another mod's `$.command.run('x')`.
  if (event === 'command.run') {
    return { plugin, command: args[0], args: args[1] }
  }
  const positional = POSITIONAL[event]
  if (positional) return { plugin, ...positional(args) }
  if (args.length === 0) return { plugin }
  if (args.length === 1 && isObject(args[0])) return { plugin, ...args[0] }
  return { plugin, args }
}

/**
 * The value a `$` call resolves to: a hook's `{ value }` answer is the call's
 * result, anything else (core's own answer) passes through untouched.
 */
export function unwrapOpAnswer(outcome: {
  value: unknown
  handled: boolean
}): unknown {
  if (
    outcome.handled &&
    isObject(outcome.value) &&
    Object.prototype.hasOwnProperty.call(outcome.value, 'value')
  ) {
    return outcome.value.value
  }
  return outcome.value
}
