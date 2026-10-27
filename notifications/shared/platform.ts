/**
 * Platform primitives shared by the sound player and focus detector.
 *
 * No OpenCode host API is imported here. The module only depends on Node
 * built-ins, which keeps the shared package testable with `bun:test`.
 */
import { execFile } from "node:child_process"
import { promisify } from "node:util"

export const PLATFORM = process.platform
export const isMacOS = PLATFORM === "darwin"
export const isLinux = PLATFORM === "linux"
export const isSupported = isMacOS || isLinux

export const execFileAsync = promisify(execFile)

/** Escape a value for interpolation inside an AppleScript string literal. */
export const safe = (value: string): string =>
  String(value)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")

/** Return the final path segment, or an empty string for an empty path. */
export const extractFilename = (path: string): string =>
  path ? (path.split("/").filter(Boolean).pop() ?? "") : ""

/** Run a command and return trimmed stdout, or `null` when it fails. */
export const runCommand = async (args: string[]): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync(args[0], args.slice(1))
    return stdout.trim()
  } catch {
    return null
  }
}
