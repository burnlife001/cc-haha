const version = process.env.CLAUDE_CODE_LOCAL_VERSION ?? '999.0.0-local';
const packageUrl = process.env.CLAUDE_CODE_LOCAL_PACKAGE_URL ?? 'claude-code-local';
const buildTime = process.env.CLAUDE_CODE_LOCAL_BUILD_TIME ?? new Date().toISOString();

process.env.CLAUDE_CODE_LOCAL_SKIP_REMOTE_PREFETCH ??= '1';

Object.assign(globalThis, {
  MACRO: {
    VERSION: version,
    PACKAGE_URL: packageUrl,
    NATIVE_PACKAGE_URL: packageUrl,
    BUILD_TIME: buildTime,
    FEEDBACK_CHANNEL: 'local',
    VERSION_CHANGELOG: '',
    ISSUES_EXPLAINER: '',
  },
});
// Switch to the current workspace
if (process.env.CALLER_DIR) {
  process.chdir(process.env.CALLER_DIR);
}

// cc-mods: start loading enabled mods early so tool.call interception and
// classic event bridging are live before the session's first events.
// Dynamic import after chdir so bootstrap state captures the real cwd.
// Fire-and-forget: modsToolCall (static import in toolExecution.ts)
// self-initializes the engine lazily even if this early load never runs.
try {
  void import('./src/mods/index.js')
    .then(m => m.installMods())
    .catch(() => {
      // mods are additive — never block startup on them
    })
} catch {
  // mods are additive — never block startup on them
}