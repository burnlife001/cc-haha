// `claude plugin test <dir>`: every *.test.ts / *.test.tsx under the plugin
// folder runs in its own process, with the plugin loaded into the test
// environment. One failing test fails the command (exit 1).

import { readdir, mkdtemp, rm, stat, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { loadModsFromDir } from '../loader.js'
import { writeModTypes } from './types.js'

const TEST_FILE = /\.test\.(ts|tsx)$/
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'target'])

export async function findTestFiles(root: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string): Promise<void> => {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        await walk(path.join(dir, entry.name))
      } else if (entry.isFile() && TEST_FILE.test(entry.name)) {
        found.push(path.join(dir, entry.name))
      }
    }
  }
  await walk(root)
  return found.sort()
}

export function bunBinary(): string {
  const override = process.env.CC_MODS_TEST_BUN
  if (override) return override
  try {
    const which = (globalThis as any).Bun?.which?.('bun')
    if (typeof which === 'string' && which) return which
  } catch {
    // fall through
  }
  return 'bun'
}

function runnerPath(): string {
  return fileURLToPath(new URL('./runner.ts', import.meta.url))
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/')
}

// Bun reads `paths` from the tsconfig beside the working directory, and the
// plugin folder is the working directory here — so the kit is mapped in from a
// throwaway tsconfig instead of writing into the plugin.
async function writeResolverConfig(kitPath: string): Promise<{
  dir: string
  file: string
}> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cc-mods-test-'))
  const file = path.join(dir, 'tsconfig.json')
  const target = toPosix(kitPath)
  await writeFile(
    file,
    JSON.stringify(
      {
        compilerOptions: {
          paths: {
            'claude-code': [target],
            'claude-code/testing': [target],
          },
        },
      },
      null,
      2,
    ),
  )
  return { dir, file }
}

export type PluginTestSummary = {
  files: number
  pass: number
  fail: number
  failed: boolean
}

export async function modsPluginTestHandler(
  dirArg: string | undefined,
  options: { quiet?: boolean; writeTypes?: boolean } = {},
): Promise<PluginTestSummary> {
  const pluginRoot = path.resolve(dirArg ?? '.')
  if (!existsSync(pluginRoot)) {
    throw new Error(`no such plugin folder: ${pluginRoot}`)
  }
  const info = await stat(pluginRoot)
  if (!info.isDirectory()) {
    throw new Error(`not a plugin folder: ${pluginRoot}`)
  }

  // Writing the contract beside the plugin is opt-in: a plugin checkout is
  // often read-only, and `plugin test` must not touch it otherwise.
  if (options.writeTypes) {
    await writeModTypes(pluginRoot, { log: line => console.log(line) })
  }

  const files = await findTestFiles(pluginRoot)
  if (files.length === 0) {
    console.log(`No *.test.ts files under ${pluginRoot}`)
    return { files: 0, pass: 0, fail: 0, failed: false }
  }

  // Fail fast when the plugin's hooks module cannot load at all.
  const { failures } = await loadModsFromDir(pluginRoot)
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(
        `[mods] ${failure.plugin}/${failure.module}: ${failure.reason}`,
      )
    }
    return { files: files.length, pass: 0, fail: 0, failed: true }
  }

  const kitPath = fileURLToPath(new URL('./index.ts', import.meta.url))
  const resolver = await writeResolverConfig(kitPath)
  const started = Date.now()
  let pass = 0
  let fail = 0
  let failed = false

  try {
    for (const file of files) {
      const child = Bun.spawn(
        [
          bunBinary(),
          '--tsconfig-override',
          resolver.file,
          runnerPath(),
          '--plugin',
          pluginRoot,
          '--file',
          file,
        ],
        {
          cwd: pluginRoot,
          stdout: 'pipe',
          stderr: 'pipe',
          stdin: 'ignore',
          env: childEnv(),
        },
      )
      const [stdout, stderr, exitCode] = await Promise.all([
        readStream(child.stdout),
        readStream(child.stderr),
        child.exited,
      ])
      if (stdout) process.stdout.write(stdout)
      if (stderr) process.stderr.write(stderr)
      const counts = parseCounts(stdout)
      pass += counts.pass
      fail += counts.fail
      if (exitCode !== 0) failed = true
    }
  } finally {
    await rm(resolver.dir, { recursive: true, force: true })
  }

  if (!options.quiet) {
    const seconds = ((Date.now() - started) / 1000).toFixed(2)
    console.log(`${pass} pass / ${fail} fail (${seconds}s)`)
  }
  return { files: files.length, pass, fail, failed: failed || fail > 0 }
}

// The child prints one summary line per file; the parent sums them.
function parseCounts(stdout: string): { pass: number; fail: number } {
  let pass = 0
  let fail = 0
  for (const line of stdout.split('\n')) {
    const hit = /^(\d+) pass \/ (\d+) fail\b/.exec(line.trim())
    if (!hit) continue
    pass += Number(hit[1])
    fail += Number(hit[2])
  }
  return { pass, fail }
}

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return ''
  return await new Response(stream).text()
}

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'CALLER_DIR') continue
    if (typeof value === 'string') env[key] = value
  }
  return env
}

/** CLI entry: `claude plugin test [dir]`. Failure exits 1. */
export async function pluginTestCli(
  dir: string | undefined,
  options: { writeTypes?: boolean } = {},
): Promise<never> {
  try {
    const summary = await modsPluginTestHandler(dir, options)
    process.exit(summary.failed ? 1 : 0)
  } catch (error) {
    console.error(
      `plugin test failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exit(2)
  }
  return undefined as never
}
