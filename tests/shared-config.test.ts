import { beforeEach, describe, expect, it } from "bun:test"
import { resetRuntime, runtime } from "./runtime-mocks"

const {
  DEFAULTS,
  parseJsonc,
  validateConfig,
  deepMerge,
  loadConfig,
} = await import("../notifications/shared/config")

const CONFIG_PATH = "/virtual/notifications.config.jsonc"

beforeEach(() => {
  resetRuntime()
  console.warn = () => {}
})

describe("shared config", () => {
  it("returns built-in defaults when the config file is missing", () => {
    runtime.configExists = false

    expect(loadConfig(CONFIG_PATH)).toEqual(DEFAULTS)
  })

  it("parses JSONC comments, trailing commas and string lookalikes", () => {
    runtime.configText = `{
      // line comment
      "terminalProcessName": "Ghostty", /* block comment */
      "soundEnabled": false,
      "messages": {
        "idle": "keep ,] and // not a comment and \\"quoted\\" text",
      },
      "events": { "idle": false, },
      "dedupeWindowMs": 25,
      "maxRecentNotifications": 2,
    }`

    const config = loadConfig(CONFIG_PATH)

    expect(config.terminalProcessName).toBe("Ghostty")
    expect(config.soundEnabled).toBe(false)
    expect(config.messages.idle).toBe(
      'keep ,] and // not a comment and "quoted" text',
    )
    expect(config.events.idle).toBe(false)
    expect(config.events.error).toBe(true)
    expect(config.dedupeWindowMs).toBe(25)
    expect(config.maxRecentNotifications).toBe(2)
  })

  it("falls back to defaults for malformed JSONC", () => {
    runtime.configText = '{"events": {"idle": true'
    const warnings: string[] = []
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.join(" "))
    }

    expect(parseJsonc(runtime.configText)).toBeNull()
    expect(loadConfig(CONFIG_PATH)).toEqual(DEFAULTS)
    expect(warnings.some((line) => line.includes("Failed to parse config"))).toBe(
      true,
    )
  })

  it("ignores valid-but-wrong shapes and keeps defaults", () => {
    runtime.configText = JSON.stringify({
      terminalProcessName: 42,
      soundEnabled: "yes",
      events: null,
      sounds: [],
      messages: { idle: 7, error: false },
      dedupeWindowMs: -1,
      maxRecentNotifications: 0,
    })

    expect(loadConfig(CONFIG_PATH)).toEqual(DEFAULTS)
  })

  it("validates fields independently and rejects non-positive limits", () => {
    const validated = validateConfig({
      terminalProcessName: null,
      soundEnabled: true,
      events: { idle: false, error: "no", permission: null, question: true },
      sounds: { idle: "Ping", error: 9 },
      messages: { idle: "Done", permission: false },
      dedupeWindowMs: 0,
      maxRecentNotifications: 1.5,
    })

    expect(validated).toEqual({
      terminalProcessName: null,
      soundEnabled: true,
      events: { idle: false, question: true },
      sounds: { idle: "Ping" },
      messages: { idle: "Done" },
      dedupeWindowMs: 0,
    })
  })

  it("deep-merges nested objects and ignores prototype-poisoning keys", () => {
    const source = JSON.parse(
      '{"events":{"idle":false},"messages":{"question":"Custom question"},"__proto__":{"polluted":true}}',
    )
    const merged = deepMerge(DEFAULTS, source)

    expect(merged.events.idle).toBe(false)
    expect(merged.events.error).toBe(true)
    expect(merged.messages.question).toBe("Custom question")
    expect(merged.messages.idle).toBe("Task completed!")
    expect((merged as Record<string, unknown>).polluted).toBeUndefined()
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})
