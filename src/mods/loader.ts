// cc-mods module loader: discovers enabled plugins whose hooks/hooks.json
// names `modules`, statically screens each module, imports it, and returns
// the mod's register function. Zero edits to the existing plugin pipeline —
// this reads the raw hooks.json the upstream zod schema would strip.

import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import path from 'path'
import { pathToFileURL } from 'url'
import type { LoadedMod, RegisterFn } from './types.js'

const ALLOWED_MODULE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
])

// Official rule: a module holding a dynamic import does not load. The same
// screen refuses CJS require — the mod environment is ESM-only.
const REFUSED_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\bimport\s*\(/, reason: 'dynamic import()' },
  { re: /\brequire\s*\(/, reason: 'require()' },
]

export type LoadFailure = {
  plugin: string
  module: string
  reason: string
}

export type LoadResult = {
  mods: LoadedMod[]
  failures: LoadFailure[]
}

function claudeHome(): string {
  return (
    process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude')
  )
}

type InstalledPluginEntry = {
  installPath?: string
}

// Mirror of the official enablement source: ~/.claude/settings.json
// `enabledPlugins` + installed_plugins.json install paths. Read-only.
function discoverEnabledPluginDirs(): string[] {
  const home = claudeHome()
  const dirs: string[] = []

  let enabled: Record<string, boolean> = {}
  try {
    const settings = JSON.parse(
      readFileSync(path.join(home, 'settings.json'), 'utf-8'),
    )
    enabled = settings.enabledPlugins ?? {}
  } catch {
    // no settings file — nothing enabled
  }

  let installed: Record<string, InstalledPluginEntry[]> = {}
  try {
    installed = JSON.parse(
      readFileSync(
        path.join(home, 'plugins', 'installed_plugins.json'),
        'utf-8',
      ),
    ).plugins ?? {}
  } catch {
    // no installed plugins
  }

  for (const [name, isEnabled] of Object.entries(enabled)) {
    if (!isEnabled) continue
    const pluginKey = name.split('@')[0]
    for (const [entryName, entries] of Object.entries(installed)) {
      if (entryName.split('@')[0] !== pluginKey) continue
      for (const entry of entries) {
        if (entry.installPath && existsSync(entry.installPath)) {
          dirs.push(entry.installPath)
        }
      }
    }
  }
  return [...new Set(dirs)]
}

function readModules(pluginDir: string): string[] {
  const hooksPath = path.join(pluginDir, 'hooks', 'hooks.json')
  try {
    const raw = JSON.parse(readFileSync(hooksPath, 'utf-8'))
    if (Array.isArray(raw.modules)) {
      return raw.modules.filter((m): m is string => typeof m === 'string')
    }
  } catch {
    // no hooks.json or unreadable — not a mod
  }
  return []
}

function readUserConfigDefaults(pluginDir: string): Record<string, unknown> {
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf-8'),
    )
    const userConfig = manifest.userConfig
    if (userConfig && typeof userConfig === 'object') {
      const options: Record<string, unknown> = {}
      for (const [key, spec] of Object.entries(userConfig as Record<string, any>)) {
        if (spec && typeof spec === 'object' && 'default' in spec) {
          options[key] = (spec as any).default
        }
      }
      return options
    }
  } catch {
    // no manifest — mods still load with empty options
  }
  return {}
}

export function screenModuleSource(
  source: string,
): { ok: true } | { ok: false; reason: string } {
  for (const { re, reason } of REFUSED_PATTERNS) {
    if (re.test(source)) return { ok: false, reason }
  }
  return { ok: true }
}

// Strip nothing, refuse statically: run before import so a refused module
// never executes.
async function importModule(
  pluginDir: string,
  moduleRef: string,
): Promise<{ register?: RegisterFn }> {
  // Module refs in hooks/hooks.json resolve beside that file (inside
  // hooks/), matching the official loader.
  const modulePath = path.resolve(pluginDir, 'hooks', moduleRef)
  const ext = path.extname(modulePath).toLowerCase()
  if (!ALLOWED_MODULE_EXTENSIONS.has(ext)) {
    throw new Error(`module extension ${ext || '(none)'} is not loadable`)
  }
  const { readFile } = await import('fs/promises')
  const source = await readFile(modulePath, 'utf-8')
  const screen = screenModuleSource(source)
  if (!screen.ok) {
    throw new Error(`module uses ${screen.reason}, which the engine refuses`)
  }
  const url = pathToFileURL(modulePath).href
  const imported = (await import(url)) as { register?: unknown }
  if (typeof imported.register !== 'function') {
    throw new Error('module does not export a register function')
  }
  return { register: imported.register as RegisterFn }
}

export async function loadModsFromDir(pluginDir: string): Promise<{
  mods: LoadedMod[]
  failures: LoadFailure[]
}> {
  const mods: LoadedMod[] = []
  const failures: LoadFailure[] = []
  const modules = readModules(pluginDir)
  if (modules.length === 0) return { mods, failures }

  let name = path.basename(pluginDir)
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf-8'),
    )
    if (typeof manifest.name === 'string' && manifest.name) name = manifest.name
  } catch {
    // keep directory name
  }

  for (const moduleRef of modules) {
    try {
      const { register } = await importModule(pluginDir, moduleRef)
      mods.push({
        identity: { name, root: pluginDir },
        register: register!,
        options: readUserConfigDefaults(pluginDir),
      })
    } catch (ex) {
      failures.push({
        plugin: name,
        module: moduleRef,
        reason: ex instanceof Error ? ex.message : String(ex),
      })
    }
  }
  return { mods, failures }
}

// Session plugins loaded via --plugin-dir (official flag, repeatable) also
// run their mods.
function pluginDirArgs(): string[] {
  const dirs: string[] = []
  const argv = process.argv
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--plugin-dir' && argv[i + 1]) {
      dirs.push(argv[i + 1])
      i++
    }
  }
  const env = process.env.CLAUDE_PLUGIN_DIR
  if (env) dirs.push(...env.split(path.delimiter).filter(Boolean))
  return dirs
}

export async function loadAllMods(
  extraPluginDirs: string[] = [],
): Promise<LoadResult> {
  const result: LoadResult = { mods: [], failures: [] }
  const dirs = [...discoverEnabledPluginDirs(), ...pluginDirArgs(), ...extraPluginDirs]
  for (const dir of dirs) {
    const { mods, failures } = await loadModsFromDir(dir)
    result.mods.push(...mods)
    result.failures.push(...failures)
  }
  return result
}
