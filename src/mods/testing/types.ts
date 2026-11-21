// Writes the contract the engine is built against beside a plugin, the way the
// engine does when it loads a mod from a folder the person owns:
//
//   .claude-plugin/types/claude-code/index.d.ts   the plugin API contract
//   .claude-plugin/types/tsconfig.json            the compiler options it fits
//
// A plugin's own tsconfig.json usually just extends the second file. Existing
// files are never overwritten, and an unwritable folder is skipped with a
// warning — a read-only plugin checkout still tests fine.

import { mkdir, readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const CONTRACT_PATH = fileURLToPath(
  new URL('../contract/claude-code-2.1.328.d.ts', import.meta.url),
)

// Reads the version the contract names, so the written line stays true when the
// contract is replaced.
function contractVersion(): string {
  const hit = /claude-code-(\d+\.\d+\.\d+)\.d\.ts$/.exec(CONTRACT_PATH)
  return hit?.[1] ?? '2.1.328'
}

export const TYPES_TSCONFIG = {
  compilerOptions: {
    target: 'es2023',
    lib: ['es2023'],
    module: 'esnext',
    moduleResolution: 'bundler',
    strict: true,
    noUncheckedIndexedAccess: true,
    noEmit: true,
    skipLibCheck: true,
    jsx: 'react',
    jsxFactory: 'h',
    jsxFragmentFactory: 'Fragment',
    typeRoots: ['.'],
    types: ['claude-code', 'claude-code-tools', 'claude-code-mcp'],
  },
  include: ['../../hooks', '../../types', '../../tests'],
}

export type WriteModTypesResult = {
  written: string[]
  skipped: string[]
  warnings: string[]
}

export async function writeModTypes(
  pluginDir: string,
  options: { log?: (line: string) => void } = {},
): Promise<WriteModTypesResult> {
  const result: WriteModTypesResult = { written: [], skipped: [], warnings: [] }
  const typesDir = path.join(pluginDir, '.claude-plugin', 'types')
  const dtsPath = path.join(typesDir, 'claude-code', 'index.d.ts')
  const tsconfigPath = path.join(typesDir, 'tsconfig.json')

  let contract: string
  try {
    contract = await readFile(CONTRACT_PATH, 'utf-8')
  } catch (error) {
    result.warnings.push(
      `contract not readable at ${CONTRACT_PATH}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return report(result, options)
  }

  try {
    await mkdir(path.join(typesDir, 'claude-code'), { recursive: true })
  } catch (error) {
    result.warnings.push(
      `cannot create ${typesDir}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return report(result, options)
  }

  await writeOne(
    dtsPath,
    `// Written by Claude Code ${contractVersion()}.\n${contract}`,
    result,
    options,
  )
  await writeOne(
    tsconfigPath,
    JSON.stringify(TYPES_TSCONFIG, null, 2) + '\n',
    result,
    options,
  )
  return report(result, options)
}

async function writeOne(
  file: string,
  content: string,
  result: WriteModTypesResult,
  options: { log?: (line: string) => void },
): Promise<void> {
  if (existsSync(file)) {
    result.skipped.push(file)
    options.log?.(`[types] kept existing ${file}`)
    return
  }
  try {
    await writeFile(file, content)
    result.written.push(file)
    options.log?.(`[types] wrote ${file}`)
  } catch (error) {
    result.warnings.push(
      `cannot write ${file}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
}

function report(
  result: WriteModTypesResult,
  options: { log?: (line: string) => void },
): WriteModTypesResult {
  for (const warning of result.warnings) {
    options.log?.(`[types] warning: ${warning}`)
  }
  return result
}
