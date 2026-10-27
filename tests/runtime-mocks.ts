/**
 * Central process-wide mocks shared by every test file.
 *
 * Bun registers `mock.module` mocks globally for the whole test process, so
 * keeping one controllable mock layer here avoids later files overwriting an
 * earlier file's fake child-process/filesystem implementations. Every test file
 * imports this module before dynamically importing any production module.
 */
import { mock } from "bun:test"
import * as realChildProcess from "node:child_process"
import * as realFs from "node:fs"
import * as realOs from "node:os"

export const FAKE_HOME = "/Users/assert-ape"
export const CONFIG_SUFFIX = "notifications.config.jsonc"

export interface ExecCall {
  file: string
  args: string[]
}

export interface RuntimeState {
  configExists: boolean
  configText: string
  commandStdout: string
  deferCommands: boolean
  existingPaths: Set<string>
}

export const runtime: RuntimeState = {
  configExists: true,
  configText: "{}",
  commandStdout: "false",
  deferCommands: false,
  existingPaths: new Set(),
}

export const execCalls: ExecCall[] = []
let deferred: Array<() => void> = []

const fakeExecFile = (
  file: string,
  args: string[],
  optionsOrCallback?: unknown,
  maybeCallback?: unknown,
): unknown => {
  const callback =
    typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback
  execCalls.push({ file, args })
  if (typeof callback !== "function") return undefined

  const complete = (): void => {
    ;(callback as (error: unknown, result: unknown) => void)(null, {
      stdout: runtime.commandStdout,
      stderr: "",
    })
  }

  if (runtime.deferCommands) deferred.push(complete)
  else complete()
  return undefined
}

mock.module("node:child_process", () => ({
  ...realChildProcess,
  execFile: fakeExecFile,
}))

mock.module("node:os", () => ({
  ...realOs,
  homedir: () => FAKE_HOME,
}))

mock.module("node:fs", () => ({
  ...realFs,
  existsSync: (path: unknown): boolean => {
    if (typeof path !== "string") return false
    if (path.endsWith(CONFIG_SUFFIX)) return runtime.configExists
    return runtime.existingPaths.has(path)
  },
  readFileSync: (path: unknown, encoding?: unknown): unknown => {
    if (typeof path === "string" && path.endsWith(CONFIG_SUFFIX)) {
      return runtime.configText
    }
    return (realFs.readFileSync as (...args: unknown[]) => unknown)(path, encoding)
  },
}))

mock.module("@opencode/plugin/tui", () => ({
  Plugin: { define: (definition: unknown) => definition },
}))

export interface ResetRuntimeOptions {
  config?: Record<string, unknown> | string | null
  focused?: boolean
  existingPaths?: string[]
  deferCommands?: boolean
}

export const resetRuntime = (options: ResetRuntimeOptions = {}): void => {
  const config = options.config === undefined ? {} : options.config
  runtime.configExists = config !== null
  runtime.configText =
    config === null
      ? ""
      : typeof config === "string"
        ? config
        : JSON.stringify(config)
  runtime.commandStdout = options.focused ? "true" : "false"
  runtime.existingPaths = new Set(options.existingPaths ?? [])
  runtime.deferCommands = options.deferCommands ?? false
  deferred = []
  execCalls.length = 0
}

export const pendingCommandCount = (): number => deferred.length

export const releaseCommands = (): void => {
  const pending = deferred
  deferred = []
  // Future commands (e.g. sound after a buggy post-dispose notify) resolve
  // immediately so a failing assertion cannot hang the test.
  runtime.deferCommands = false
  for (const complete of pending) complete()
}

export const audioCalls = (): ExecCall[] =>
  execCalls.filter(
    (call) => call.file === "afplay" || call.file === "paplay",
  )

export const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error("Timed out waiting for condition")
}
