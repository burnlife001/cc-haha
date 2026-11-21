// Runs one *.test.ts file of the plugin under test: a fresh engine per test,
// the plugin loaded with that test's userConfig values, and the test body's
// `$` / `on` over it.

import path from 'path'
import type { LoadedMod } from '../types.js'
import { __collectTests, __timeoutOf, type CollectedTest } from './kit.js'
import { createTestRuntime } from './runtime.js'

export type TestCaseResult = {
  title: string
  passed: boolean
  error: string | null
  ms: number
}

export type FileResult = {
  file: string
  cases: TestCaseResult[]
  pass: number
  fail: number
  ms: number
}

export type RunTestFileOptions = {
  pluginRoot: string
  testFile: string
  mods: readonly LoadedMod[]
}

export async function runTestFile(
  options: RunTestFileOptions,
): Promise<FileResult> {
  const started = Date.now()
  const cases: TestCaseResult[] = []

  for (const declared of __collectTests()) {
    cases.push(await runOne(declared, options))
  }

  const pass = cases.filter(c => c.passed).length
  return {
    file: path.relative(options.pluginRoot, options.testFile).split(path.sep).join('/'),
    cases,
    pass,
    fail: cases.length - pass,
    ms: Date.now() - started,
  }
}

async function runOne(
  declared: CollectedTest,
  options: RunTestFileOptions,
): Promise<TestCaseResult> {
  const started = Date.now()
  let error: string | null = null
  try {
    const runtime = await createTestRuntime({
      mods: options.mods,
      pluginRoot: options.pluginRoot,
      testOptions: declared.options,
    })
    await withTimeout(
      Promise.resolve(declared.body(runtime.$, runtime.on)),
      __timeoutOf(declared.options),
      declared.title,
    )
  } catch (thrown) {
    error = formatFailure(thrown)
  }
  return {
    title: declared.title,
    passed: error === null,
    error,
    ms: Date.now() - started,
  }
}

function withTimeout(
  body: Promise<unknown>,
  timeoutMs: number,
  title: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`test "${title}" timed out after ${timeoutMs}ms`))
    }, timeoutMs)
  })
  return Promise.race([body.then(() => undefined), timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function formatFailure(thrown: unknown): string {
  if (thrown instanceof Error) {
    if (thrown.name === 'ExpectationError') return thrown.message
    const stack = thrown.stack?.split('\n').slice(1, 4).join('\n') ?? ''
    return stack ? `${thrown.message}\n${stack}` : thrown.message
  }
  return String(thrown)
}
