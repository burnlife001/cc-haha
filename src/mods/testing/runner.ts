// Per-file entry for `claude plugin test <dir>`: one process per *.test.ts, so
// module state, timers and a crashing test cannot leak between files.

import path from 'path'
import { pathToFileURL } from 'url'
import { loadModsFromDir } from '../loader.js'
import { runTestFile } from './execute.js'

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

const pluginRoot = path.resolve(flag('--plugin') ?? process.cwd())
const file = flag('--file')
if (!file) {
  console.error('usage: runner --plugin <dir> --file <test file>')
  process.exit(2)
}
const testFile = path.resolve(pluginRoot, file)

const { mods, failures } = await loadModsFromDir(pluginRoot)
if (failures.length > 0) {
  for (const failure of failures) {
    console.error(
      `[mods] ${failure.plugin}/${failure.module}: ${failure.reason}`,
    )
  }
  process.exit(2)
}

try {
  await import(pathToFileURL(testFile).href)
} catch (error) {
  console.error(
    `cannot load ${testFile}: ${
      error instanceof Error ? error.stack ?? error.message : String(error)
    }`,
  )
  process.exit(2)
}

const result = await runTestFile({ pluginRoot, testFile, mods })
console.log(result.file)
for (const testCase of result.cases) {
  if (testCase.passed) {
    console.log(`  ✓ ${testCase.title}`)
    continue
  }
  console.log(`  ✗ ${testCase.title}`)
  for (const line of (testCase.error ?? '').split('\n')) {
    console.log(`      ${line}`)
  }
}
console.log(`${result.pass} pass / ${result.fail} fail (${(result.ms / 1000).toFixed(2)}s)`)
process.exit(result.fail > 0 ? 1 : 0)
