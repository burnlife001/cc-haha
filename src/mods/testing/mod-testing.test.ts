// Regression tests for `claude plugin test` / `validate` (M2). Fixtures are
// temporary folders — no real plugin checkout, no network, no user state.

import {
  afterAll,
  beforeAll,
  describe as bdescribe,
  expect as bexpect,
  test as btest,
} from 'bun:test'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import { ModEngine } from '../engine.js'
import type { LoadedMod } from '../types.js'
import { modsPluginTestHandler, findTestFiles } from './command.js'
import { runTestFile } from './execute.js'
import { expect, test as kitTest, __collectTests, __resetKit } from './kit.js'
import { createTestRuntime } from './runtime.js'
import { writeModTypes } from './types.js'
import { validateModDir } from './validate.js'

const MODS_MARKETPLACE =
  'E:/__work/BaseTools/codingTools/cc-mods/cc-mods-marketplace'

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'mods-testing-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function fixture(
  name: string,
  moduleBody: string,
  options: { modules?: string[]; pluginJson?: Record<string, unknown> } = {},
): Promise<string> {
  const root = path.join(dir, name)
  await mkdir(path.join(root, 'hooks'), { recursive: true })
  await mkdir(path.join(root, '.claude-plugin'), { recursive: true })
  await writeFile(
    path.join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify(
      options.pluginJson ?? { name, version: '0.0.1', description: 'fixture' },
    ),
  )
  await writeFile(
    path.join(root, 'hooks', 'hooks.json'),
    JSON.stringify({ modules: options.modules ?? ['./register.ts'], hooks: {} }),
  )
  await writeFile(path.join(root, 'hooks', 'register.ts'), moduleBody)
  return root
}

bdescribe('claude-code/testing kit', () => {
  btest('expect answers the matcher surface the contract names', () => {
    expect(1).toBe(1)
    expect({ a: [1, 2] }).toEqual({ a: [1, 2] })
    expect(['x', 'y']).toContain('y')
    expect('blocked by guard').toContain('guard')
    expect(undefined).toBeUndefined()
    expect(null).toBeNull()
    expect('abc').toMatch(/^a/)
    expect([1, 2, 3]).toHaveLength(3)
    expect(() => {
      throw new Error('boom')
    }).toThrow('boom')
    expect({ nested: { ok: true } }).toHaveProperty('nested.ok')
    bexpect(() => expect(1).toBe(2)).toThrow(/expected 1 to be 2/)
    bexpect(() => expect({ a: 1 }).toEqual({ a: 2 })).toThrow(/to equal/)
  })

  btest('expect supports asymmetric matchers', () => {
    expect({ id: 'x', at: new Date(0) }).toEqual({
      id: expect.any(String),
      at: expect.anything(),
    })
  })
})

bdescribe('engine op events', () => {
  btest('a $ noun call crosses as its argument object and { value } answers it', async () => {
    const engine = new ModEngine()
    engine.registerNounCore(() => ({ from: 'core' }))
    engine.registerMod({
      identity: { name: 'probe', root: '/probe' },
      register: () => {},
      options: {},
    })
    const seen: any[] = []
    engine.on('probe', 'process.run', ((_$: any, e: any) => {
      seen.push(e)
      return { value: { exitCode: 0, stdout: 'stub' } }
    }) as any)
    engine.on('probe', 'fs.read', ((_$: any, e: any) => {
      seen.push(e)
      return { value: 'file text' }
    }) as any)

    const api = (engine as any).apis.get('probe')
    const run = await api.process.run(['ccc', 'x'], { timeoutMs: 40 })
    bexpect(seen[0].argv).toEqual(['ccc', 'x'])
    bexpect(seen[0].init).toEqual({ timeoutMs: 40 })
    bexpect(run.stdout).toBe('stub')

    await api.fs.read('/a/b.txt')
    bexpect(seen[1].path).toBe('/a/b.txt')
    bexpect(seen[1].as).toBe('text')
  })
})

bdescribe('test runtime', () => {
  const mod = (register: LoadedMod['register']): LoadedMod => ({
    identity: { name: 'probe', root: '/probe' },
    register,
    options: { greeting: 'default' },
  })

  btest('test stubs sit beneath the plugin and answer { result } / { deny }', async () => {
    const runtime = await createTestRuntime({
      pluginRoot: '/probe',
      testOptions: {},
      mods: [
        mod(on => {
          on('tool.call', { tool: 'Agent' }, () => ({ deny: 'no agents' }))
        }),
      ],
    })
    runtime.on('tool.call', () => ({ result: { ok: true } }))
    const allowed: any = await runtime.$.tool.call({ tool: 'Read' })
    bexpect(allowed.result).toEqual({ ok: true })
    const denied: any = await runtime.$.tool.call({ tool: 'Agent', prompt: 'x' })
    bexpect(denied.deny).toBe('no agents')
  })

  btest('userConfig values reach register, test options on top', async () => {
    const seen: any[] = []
    await createTestRuntime({
      pluginRoot: '/probe',
      testOptions: { options: { greeting: 'yo' } },
      mods: [
        mod((_on, options) => {
          seen.push(options)
        }),
      ],
    })
    bexpect(seen[0]).toEqual({ greeting: 'yo' })
  })

  btest('the sandbox refuses fs and processes instead of touching them', async () => {
    const runtime = await createTestRuntime({
      pluginRoot: '/probe',
      testOptions: {},
      mods: [mod(() => {})],
    })
    let fsError = ''
    try {
      await runtime.$.fs.read('/etc/passwd')
    } catch (thrown) {
      fsError = thrown instanceof Error ? thrown.message : String(thrown)
    }
    bexpect(fsError).toContain('not available')

    let processError = ''
    try {
      await runtime.$.process.run(['ls'])
    } catch (thrown) {
      processError = thrown instanceof Error ? thrown.message : String(thrown)
    }
    bexpect(processError).toContain('not available')
  })
})

bdescribe('test discovery and execution', () => {
  btest('findTestFiles walks the plugin and skips node_modules', async () => {
    const root = await fixture('discover', 'export const register = () => {}')
    await mkdir(path.join(root, 'tests'), { recursive: true })
    await mkdir(path.join(root, 'node_modules', 'x'), { recursive: true })
    await writeFile(path.join(root, 'hooks', 'one.test.ts'), '// test')
    await writeFile(path.join(root, 'tests', 'two.test.tsx'), '// test')
    await writeFile(path.join(root, 'tests', 'helper.ts'), '// not a test')
    await writeFile(path.join(root, 'node_modules', 'x', 'bad.test.ts'), '// no')
    const files = (await findTestFiles(root)).map(f =>
      path.relative(root, f).split(path.sep).join('/'),
    )
    bexpect(files).toEqual(['hooks/one.test.ts', 'tests/two.test.tsx'])
  })

  btest('runTestFile loads the plugin and reports pass counts', async () => {
    const root = await fixture(
      'runs',
      `export const register = (on, options) => {
        on('tool.call', { tool: 'Agent' }, () => ({ deny: 'agents disabled: ' + options.greeting }))
      }`,
    )
    // The file itself is imported by runner.ts (a child process, where
    // 'claude-code/testing' resolves); here the tests are declared directly so
    // the kit registry and the runtime are exercised in-process.
    __resetKit()
    kitTest('the plugin denies Agent calls', { options: { greeting: 'yo' } }, async $ => {
      const answer: any = await $.tool.call({ tool: 'Agent', prompt: 'x' })
      expect(answer.deny).toContain('agents disabled: yo')
    })
    kitTest('a plain tool falls through to the stub', async ($, on) => {
      on('tool.call', () => ({ result: 'ok' }))
      const answer: any = await $.tool.call({ tool: 'Read', file_path: 'x' })
      expect(answer.result).toBe('ok')
    })
    const { mods } = await loadMods(root)
    const result = await runTestFile({
      pluginRoot: root,
      testFile: path.join(root, 'hooks', 'runs.test.ts'),
      mods,
    })
    bexpect(result.pass).toBe(2)
    bexpect(result.fail).toBe(0)
  })

  btest('a failing test fails its file', async () => {
    const root = await fixture('fails', 'export const register = () => {}')
    __resetKit()
    kitTest('is wrong', () => {
      expect(1).toBe(2)
    })
    const { mods } = await loadMods(root)
    const result = await runTestFile({
      pluginRoot: root,
      testFile: path.join(root, 'hooks', 'fails.test.ts'),
      mods,
    })
    bexpect(result.fail).toBe(1)
    bexpect(result.cases[0].error).toContain('expected 1 to be 2')
  })
})

bdescribe('plugin test command', () => {
  btest('spawns one process per file and sums the verdicts', async () => {
    const root = await fixture(
      'spawn',
      `export const register = on => {
        on('tool.call', { tool: 'Agent' }, () => ({ deny: 'no agents' }))
      }`,
    )
    await mkdir(path.join(root, 'tests'), { recursive: true })
    await writeFile(
      path.join(root, 'hooks', 'a.test.ts'),
      `import { expect, test } from 'claude-code/testing'
test('denies Agent', async $ => {
  const answer = await $.tool.call({ tool: 'Agent', prompt: 'x' })
  expect(answer.deny).toBe('no agents')
})`,
    )
    await writeFile(
      path.join(root, 'tests', 'b.test.ts'),
      `import { expect, test } from 'claude-code/testing'
test('process.run reaches the stub', async ($, on) => {
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'ok' } }))
  const run = await $.process.run(['x'])
  expect(run.stdout).toBe('ok')
})`,
    )
    const summary = await modsPluginTestHandler(root, { quiet: true })
    bexpect(summary.files).toBe(2)
    bexpect(summary.pass).toBe(2)
    bexpect(summary.fail).toBe(0)
    bexpect(summary.failed).toBe(false)
  })
})

bdescribe('plugin validate', () => {
  btest('accepts a legal mod', async () => {
    const root = await fixture(
      'legal',
      `export const register = on => {
        on('tool.call', { tool: 'Write' }, ($, e) => ({ deny: 'no' }))
      }`,
    )
    const result = await validateModDir(root)
    bexpect(result?.success).toBe(true)
    bexpect(result?.errors).toEqual([])
    bexpect(result?.notes[0]).toContain('tool.call')
  })

  btest('refuses unknown events, unknown nouns, dynamic import and missing module', async () => {
    const root = await fixture(
      'illegal',
      `export const register = on => {
        on('tool.cal', () => ({}))
        on('session.start', $ => $.fs.readz('/x'))
      }`,
      { modules: ['./register.ts', './lazy.ts', './missing.ts'] },
    )
    await writeFile(
      path.join(root, 'hooks', 'lazy.ts'),
      `export const register = () => import('./x.js')`,
    )
    const result = await validateModDir(root)
    const messages = result?.errors.map(e => e.message).join('\n') ?? ''
    bexpect(result?.success).toBe(false)
    bexpect(messages).toContain('unknown hook event "tool.cal"')
    bexpect(messages).toContain('unknown $ noun call "fs.readz"')
    bexpect(messages).toContain('dynamic import()')
    bexpect(messages).toContain('does not exist')
  })

  btest('refuses a module with no register export', async () => {
    const root = await fixture('no-register', 'export const other = () => {}')
    const result = await validateModDir(root)
    bexpect(result?.success).toBe(false)
    bexpect(result?.errors[0].message).toContain('does not export a register function')
  })

  btest('a plugin with no modules is not a mod', async () => {
    const root = await fixture('plain', 'export const register = () => {}', {
      modules: [],
    })
    bexpect(await validateModDir(root)).toBeNull()
  })
})

bdescribe('types writer', () => {
  btest('writes the contract and tsconfig, then keeps what exists', async () => {
    const root = await fixture('types', 'export const register = () => {}')
    const first = await writeModTypes(root)
    bexpect(first.written).toHaveLength(2)
    const dts = await readFile(
      path.join(root, '.claude-plugin', 'types', 'claude-code', 'index.d.ts'),
      'utf-8',
    )
    bexpect(dts.startsWith('// Written by Claude Code 2.1.328.')).toBe(true)
    bexpect(dts).toContain("declare module 'claude-code/testing'")

    const tsconfig = JSON.parse(
      await readFile(
        path.join(root, '.claude-plugin', 'types', 'tsconfig.json'),
        'utf-8',
      ),
    )
    bexpect(tsconfig.compilerOptions.target).toBe('es2023')
    bexpect(tsconfig.compilerOptions.moduleResolution).toBe('bundler')
    bexpect(tsconfig.compilerOptions.jsxFactory).toBe('h')
    bexpect(tsconfig.compilerOptions.jsxFragmentFactory).toBe('Fragment')
    bexpect(tsconfig.compilerOptions.types).toContain('claude-code')

    const second = await writeModTypes(root)
    bexpect(second.written).toHaveLength(0)
    bexpect(second.skipped).toHaveLength(2)
  })
})

// The three real cc-mods suites. Skipped when the checkout is absent so the
// regression suite stays runnable anywhere.
const REAL_MODS = [
  { dir: `${MODS_MARKETPLACE}/plugins/readonly-guard`, pass: 10 },
  { dir: `${MODS_MARKETPLACE}/plugins/subagentmods`, pass: 8 },
  { dir: `${MODS_MARKETPLACE}/tests/hook-bench`, pass: 5 },
]

bdescribe('real cc-mods plugins', () => {
  for (const entry of REAL_MODS) {
    const label = path.basename(entry.dir)
    btest(`${label}: ${entry.pass} pass / 0 fail`, async () => {
      if (!existsSync(entry.dir)) {
        console.log(`skip ${label}: ${entry.dir} not present`)
        return
      }
      const summary = await modsPluginTestHandler(entry.dir, { quiet: true })
      bexpect(summary.fail).toBe(0)
      bexpect(summary.pass).toBe(entry.pass)
      bexpect(summary.failed).toBe(false)
    }, 120_000)
  }
})

// Keep the kit registry from leaking into the runner-oriented helpers above.
bdescribe('kit registry', () => {
  btest('collects tests with their describes and options', () => {
    __resetKit()
    kitTest('one', () => {})
    bexpect(__collectTests()).toHaveLength(1)
    bexpect(__collectTests()[0].title).toBe('one')
    __resetKit()
  })
})

async function loadMods(root: string) {
  const { loadModsFromDir } = await import('../loader.js')
  return loadModsFromDir(root)
}
