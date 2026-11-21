// Event catalog for the cc-mods engine, extracted from the official
// Claude Code 2.1.328 plugin API declarations
// (src/mods/contract/claude-code-2.1.328.d.ts). Keep in sync with that file;
// regenerate the list from its `EngineEventOf` / `OpEventOf` keys on update.

import { getOriginalCwd, getSessionId } from '../bootstrap/state.js'

export const ENGINE_EVENTS = [
  'tool.call',
  'tool.check',
  'tool.judge',
  'tool.offer',
  'tool.run',
  'tool.describe',
  'tool.list',
  'tool.register',
  'ui.render',
  'ui.resolve',
  'ui.press',
  'ui.input',
  'ui.select',
  'ui.message',
  'ui.fault',
  'ui.scroll',
  'ui.focus',
  'ui.pointer',
  'agent.offer',
  'agent.spawn',
  'agent.call',
  'agent.limits',
  'agent.list',
  'agent.register',
  'prompt.submit',
  'prompt.fill',
  'prompt.suggest',
  'prompt.edit',
  'prompt.change',
  'prompt.autocomplete',
  'prompt.section',
  'prompt.context',
  'prompt.compose',
  'prompt.attachment',
  'prompt.mention',
  'prompt.read',
  'prompt.paint',
  'command.run',
  'command.describe',
  'command.list',
  'command.register',
  'config.set',
  'config.describe',
  'config.list',
  'telemetry.log',
  'telemetry.mark',
  'skill.prompt',
  'attribution.text',
  'session.start',
  'session.receive',
  'session.append',
  'session.send',
  'session.compact',
  'session.attach',
  'session.detach',
  'session.measure',
  'session.end',
  'session.stop',
  'session.info',
  'session.machine',
  'session.cwd',
  'session.root',
  'session.model',
  'session.turns',
  'session.id',
  'session.messages',
  'session.repo',
  'session.surface',
  'session.surfaces',
  'session.authorize',
  'session.identity',
  'session.usage',
  'session.version',
  'plugin.register',
  'turn.start',
  'turn.step',
  'turn.complete',
  'turn.abort',
  'engine.create',
  'model.complete',
  'model.classify',
  'model.fork',
  'audio.play',
  'audio.speak',
  'mcp.call',
  'mcp.connect',
  'ui.toast',
  'ui.status',
  'ui.log',
  'ui.notice',
  'ui.invalidate',
  'ui.open',
  'ui.close',
  'ui.panes',
  'ui.place',
  'theme.set',
  'theme.clear',
  'ui.selection',
  'ui.copy',
  'ui.view',
  'ui.notify',
  'ui.cancelNotify',
  'ui.blit',
  'fs.read',
  'fs.write',
  'fs.list',
  'fs.exists',
  'fs.stat',
  'fs.ancestors',
  'store.get',
  'store.set',
  'store.delete',
  'store.keys',
  'state.get',
  'state.set',
  'clock.now',
  'clock.sleep',
  'clock.after',
  'clock.every',
  'http.fetch',
  'process.run',
  'process.spawn',
  'process.hookEnv',
  'settings.read',
  'env.get',
  'env.set',
  'wasm.compile',
] as const

export type EngineEventName = (typeof ENGINE_EVENTS)[number]

// Classic hook events bridgeable without editing upstream executor code, via
// registerHookCallbacks (src/bootstrap/state.ts). Maps a mods `classic.*`
// event to the cc-haha HookEvent it mirrors.
export const CLASSIC_EVENT_MAP = {
  'classic.PreToolUse': 'PreToolUse',
  'classic.PostToolUse': 'PostToolUse',
  'classic.UserPromptSubmit': 'UserPromptSubmit',
  'classic.SessionStart': 'SessionStart',
  'classic.SessionEnd': 'SessionEnd',
  'classic.Notification': 'Notification',
  'classic.PreCompact': 'PreCompact',
  'classic.SubagentStop': 'SubagentStop',
} as const

export type ClassicEventName = keyof typeof CLASSIC_EVENT_MAP

export const CLASSIC_EVENTS = Object.keys(CLASSIC_EVENT_MAP) as ClassicEventName[]

export type ModEventName = EngineEventName | ClassicEventName

// The surfaces the contract compiles against (keyof Elements). cc-haha's
// `$.session.surface` answers `terminal`; the rest are named here so a later
// surface bridge can answer without re-deriving the list from the .d.ts.
export const RENDER_SURFACES = [
  'terminal',
  'desktop',
  'mobile',
  'vscode',
] as const

export type RenderSurfaceName = (typeof RENDER_SURFACES)[number]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// A classic hook's `e` is its whole stdin input. cc-haha builds that input
// with createBaseHookInput(), which already carries session_id,
// transcript_path, cwd and hook_event_name; the engine fills only what a
// caller left out, so a session's own values always win.
//
// `classic.PreToolUse` is the one event whose `e` is not the stdin shape: the
// contract types it as ToolCallEnvelope (`{ tool, tool_use_id, ...args }`).
// cc-haha's input carries `tool_name` / `tool_input`, so that event is
// reshaped additively: the raw fields stay, and the envelope keys join them.
async function classicTranscriptPath(
  raw: Record<string, unknown>,
): Promise<string> {
  if (typeof raw.transcript_path === 'string') return raw.transcript_path
  try {
    const { getTranscriptPath } = await import('../utils/sessionStorage.js')
    return getTranscriptPath()
  } catch {
    // Contract: '' in a session that keeps no transcript on this machine.
    return ''
  }
}

export async function normalizeClassicEvent(
  classic: ClassicEventName,
  input: unknown,
): Promise<Record<string, unknown>> {
  const raw = isRecord(input) ? input : {}
  const hookEventName = CLASSIC_EVENT_MAP[classic]
  const sessionId =
    typeof raw.session_id === 'string' && raw.session_id
      ? raw.session_id
      : getSessionId()
  const cwd =
    typeof raw.cwd === 'string' && raw.cwd
      ? raw.cwd
      : getOriginalCwd() || process.cwd()

  const envelope: Record<string, unknown> = {
    ...raw,
    session_id: sessionId,
    transcript_path: await classicTranscriptPath(raw),
    cwd,
    hook_event_name:
      typeof raw.hook_event_name === 'string'
        ? raw.hook_event_name
        : hookEventName,
  }

  if (classic !== 'classic.PreToolUse') return envelope

  const toolInput = isRecord(raw.tool_input) ? raw.tool_input : {}
  return {
    ...toolInput,
    ...envelope,
    tool:
      typeof raw.tool === 'string'
        ? raw.tool
        : typeof raw.tool_name === 'string'
          ? raw.tool_name
          : '',
    tool_use_id:
      typeof raw.tool_use_id === 'string' ? raw.tool_use_id : '',
  }
}
