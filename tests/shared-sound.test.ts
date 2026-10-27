import { beforeEach, describe, expect, it } from "bun:test"
import {
  execCalls,
  FAKE_HOME,
  resetRuntime,
  runtime,
} from "./runtime-mocks"

const { DEFAULTS } = await import("../notifications/shared/config")
const { resolveSoundPath, playSound, playConfiguredSound } = await import(
  "../notifications/shared/sound"
)

beforeEach(() => {
  resetRuntime()
  console.warn = () => {}
})

describe("shared sound resolution", () => {
  it("uses an existing absolute path as-is", () => {
    const path = "/Users/assert-ape/custom/alert.aiff"
    runtime.existingPaths.add(path)

    expect(resolveSoundPath(path)).toBe(path)
  })

  it("expands ~/ to the home directory", () => {
    const expanded = `${FAKE_HOME}/Sounds/chime.aiff`
    runtime.existingPaths.add(expanded)

    expect(resolveSoundPath("~/Sounds/chime.aiff")).toBe(expanded)
  })

  it("resolves system sound stems on macOS", () => {
    const path = "/System/Library/Sounds/Glass.aiff"
    runtime.existingPaths.add(path)

    expect(resolveSoundPath("Glass")).toBe(path)
  })

  it("retries a missing absolute path as a basename stem", () => {
    const path = "/System/Library/Sounds/Funk.aiff"
    runtime.existingPaths.add(path)

    expect(resolveSoundPath("/missing/custom/Funk.aiff")).toBe(path)
  })

  it("uses the platform fallback when the configured stem is missing", () => {
    const fallback = "/System/Library/Sounds/Glass.aiff"
    runtime.existingPaths.add(fallback)

    expect(resolveSoundPath("Nope")).toBe(fallback)
  })

  it("returns null when neither the sound nor a fallback exists", () => {
    expect(resolveSoundPath("Nope")).toBeNull()
  })

  it("plays through the mocked platform player only", async () => {
    const path = "/System/Library/Sounds/Glass.aiff"

    await playSound(path)

    expect(execCalls).toEqual([{ file: "afplay", args: [path] }])
  })

  it("honours soundEnabled in playConfiguredSound", async () => {
    const path = "/System/Library/Sounds/Glass.aiff"
    runtime.existingPaths.add(path)
    const config = {
      ...DEFAULTS,
      soundEnabled: true,
      sounds: { ...DEFAULTS.sounds, idle: "Glass" },
    }

    await playConfiguredSound(config, "idle")
    expect(execCalls).toEqual([{ file: "afplay", args: [path] }])

    execCalls.length = 0
    await playConfiguredSound({ ...config, soundEnabled: false }, "idle")
    expect(execCalls).toEqual([])
  })
})
