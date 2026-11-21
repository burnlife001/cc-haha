// `claude plugin validate <dir>` for mods: reads the plugin the way the engine
// loads it — hooks/hooks.json -> modules -> register — and refuses what the
// engine would refuse (a missing module, no `register` export, a dynamic
// import or require), naming the event and `$` noun calls it finds.

import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import path from 'path'
import { ENGINE_EVENTS, CLASSIC_EVENTS } from '../events.js'
import { screenModuleSource } from '../loader.js'

export type ModIssue = { path: string; message: string }

export type ModValidation = {
  success: boolean
  errors: ModIssue[]
  warnings: ModIssue[]
  notes: string[]
  filePath: string
  fileType: 'hooks'
}

const EVENTS = new Set<string>([...ENGINE_EVENTS, ...CLASSIC_EVENTS, '*'])
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

// `on('event', ...)` / `on("event", ...)`, skipping a non-literal pattern.
const ON_CALL = /\bon\s*\(\s*(['"`])([^'"`\n]+)\1/g
// `$.noun.method(` — a `$` noun call as the contract names it.
const NOUN_CALL = /\$\s*\.\s*([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g
// Nouns that are values, not events.
const VALUE_ONLY_NOUNS = new Set(['plugin'])

const REGISTER_EXPORT =
  /export\s+(?:async\s+)?function\s+register\b|export\s+(?:const|let|var)\s+register\b|export\s*\{[^}]*\bregister\b[^}]*\}/

export function scanModuleSource(source: string): {
  events: string[]
  nouns: string[]
} {
  const events = new Set<string>()
  const nouns = new Set<string>()
  for (const hit of source.matchAll(ON_CALL)) {
    events.add(hit[2])
  }
  for (const hit of source.matchAll(NOUN_CALL)) {
    const noun = hit[1]
    if (VALUE_ONLY_NOUNS.has(noun)) continue
    nouns.add(`${noun}.${hit[2]}`)
  }
  return { events: [...events], nouns: [...nouns] }
}

export function hasRegisterExport(source: string): boolean {
  return REGISTER_EXPORT.test(source)
}

/**
 * Validates a plugin folder as a mod. Returns null when the folder has no
 * hooks/hooks.json `modules`, i.e. it is not a mod and the manifest/content
 * validation is all there is to say about it.
 */
export async function validateModDir(
  pluginDir: string,
): Promise<ModValidation | null> {
  const hooksPath = path.join(pluginDir, 'hooks', 'hooks.json')
  if (!existsSync(hooksPath)) return null

  const result: ModValidation = {
    success: true,
    errors: [],
    warnings: [],
    notes: [],
    filePath: hooksPath,
    fileType: 'hooks',
  }
  const error = (at: string, message: string): void => {
    result.errors.push({ path: at, message })
  }

  let raw: unknown
  try {
    raw = JSON.parse(await readFile(hooksPath, 'utf-8'))
  } catch (thrown) {
    error('hooks/hooks.json', `cannot read hooks.json: ${messageOf(thrown)}`)
    result.success = false
    return result
  }

  const modules =
    raw && typeof raw === 'object' && Array.isArray((raw as any).modules)
      ? ((raw as any).modules as unknown[]).filter(
          (m): m is string => typeof m === 'string',
        )
      : []

  if (modules.length === 0) return null

  for (const moduleRef of modules) {
    const modulePath = path.resolve(pluginDir, 'hooks', moduleRef)
    const rel = path
      .relative(pluginDir, modulePath)
      .split(path.sep)
      .join('/')

    if (!existsSync(modulePath)) {
      error(rel, `module listed in hooks.json does not exist`)
      continue
    }
    if (!ALLOWED_MODULE_EXTENSIONS.has(path.extname(modulePath).toLowerCase())) {
      error(rel, `module extension ${path.extname(modulePath) || '(none)'} is not loadable`)
      continue
    }

    let source: string
    try {
      source = await readFile(modulePath, 'utf-8')
    } catch (thrown) {
      error(rel, `cannot read module: ${messageOf(thrown)}`)
      continue
    }

    const screen = screenModuleSource(source)
    if (!screen.ok) {
      error(rel, `module uses ${screen.reason}, which the engine refuses`)
    }
    if (!hasRegisterExport(source)) {
      error(rel, 'module does not export a register function')
    }

    const scan = scanModuleSource(source)
    for (const event of scan.events) {
      if (!EVENTS.has(event)) {
        error(rel, `unknown hook event "${event}"`)
      }
    }
    for (const noun of scan.nouns) {
      if (!EVENTS.has(noun)) {
        error(rel, `unknown $ noun call "${noun}"`)
      }
    }
    result.notes.push(
      `${rel}: hooks ${scan.events.join(', ') || '(none)'}` +
        (scan.nouns.length ? ` · calls ${scan.nouns.join(', ')}` : ''),
    )
  }

  result.success = result.errors.length === 0
  return result
}

function messageOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown)
}
