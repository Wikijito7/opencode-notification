import { beforeEach, describe, expect, it } from "bun:test"
import {
  pendingCommandCount,
  releaseCommands,
  resetRuntime,
  runtime,
  waitFor,
} from "./runtime-mocks"

const { DEFAULTS } = await import("../notifications/shared/config")
const { createFocusTracker } = await import("../notifications/shared/focus")
const { createNotificationCore } = await import(
  "../notifications/shared/core"
)

const config = {
  ...DEFAULTS,
  terminalProcessName: "TestTerminal",
  soundEnabled: false,
}

const makeRenderer = (options: { onThrows?: boolean; offThrows?: boolean } = {}) => {
  const listeners = new Map<string, () => void>()
  const offCalls: string[] = []
  return {
    listeners,
    offCalls,
    on: (event: string, listener: () => void): void => {
      if (options.onThrows) throw new Error("subscribe failed")
      listeners.set(event, listener)
    },
    off: (event: string, listener: () => void): void => {
      offCalls.push(event)
      if (options.offThrows) throw new Error("unsubscribe failed")
      if (listeners.get(event) === listener) listeners.delete(event)
    },
    emit: (event: "focus" | "blur"): void => {
      listeners.get(event)?.()
    },
  }
}

beforeEach(() => {
  resetRuntime()
  console.warn = () => {}
})

describe("shared focus tracker", () => {
  it("falls back to the platform detector while renderer focus is unknown", async () => {
    runtime.commandStdout = "true"
    const focused = await createFocusTracker({
      renderer: makeRenderer(),
      config,
    })
    expect(await focused.isTerminalFocused()).toBe(true)

    runtime.commandStdout = "false"
    const unfocused = await createFocusTracker({
      renderer: makeRenderer(),
      config,
    })
    expect(await unfocused.isTerminalFocused()).toBe(false)
  })

  it("lets renderer focus/blur win over the platform detector", async () => {
    runtime.commandStdout = "false"
    const renderer = makeRenderer()
    const tracker = await createFocusTracker({ renderer, config })

    renderer.emit("focus")
    expect(await tracker.isTerminalFocused()).toBe(true)

    runtime.commandStdout = "true"
    renderer.emit("blur")
    expect(await tracker.isTerminalFocused()).toBe(false)
  })

  it("suppresses when focus arrives while the detector would say not-focused", async () => {
    runtime.commandStdout = "false"
    runtime.deferCommands = true
    const renderer = makeRenderer()
    const tracker = await createFocusTracker({ renderer, config })

    const focused = tracker.isTerminalFocused()
    await waitFor(() => pendingCommandCount() === 1)
    renderer.emit("focus")
    releaseCommands()

    expect(await focused).toBe(true)
  })

  it("allows notification when blur arrives while the detector would say focused", async () => {
    runtime.commandStdout = "true"
    runtime.deferCommands = true
    const renderer = makeRenderer()
    const tracker = await createFocusTracker({ renderer, config })

    const focused = tracker.isTerminalFocused()
    await waitFor(() => pendingCommandCount() === 1)
    renderer.emit("blur")
    releaseCommands()

    expect(await focused).toBe(false)
  })

  it("removes renderer listeners and fails closed after dispose", async () => {
    const renderer = makeRenderer()
    const tracker = await createFocusTracker({ renderer, config })

    expect([...renderer.listeners.keys()].sort()).toEqual(["blur", "focus"])

    tracker.dispose()

    expect(renderer.offCalls.sort()).toEqual(["blur", "focus"])
    expect(renderer.listeners.size).toBe(0)
    expect(await tracker.isTerminalFocused()).toBe(true)
    expect(() => tracker.dispose()).not.toThrow()
  })

  it("removes the focus listener when blur subscription throws and falls back", async () => {
    runtime.commandStdout = "false"
    const listeners = new Map<string, () => void>()
    const offCalls: string[] = []
    const renderer = {
      on: (event: string, listener: () => void): void => {
        if (event === "blur") throw new Error("blur subscribe failed")
        listeners.set(event, listener)
        // The host may report current focus immediately on subscribe.
        listener()
      },
      off: (event: string, listener: () => void): void => {
        offCalls.push(event)
        if (listeners.get(event) === listener) listeners.delete(event)
      },
      emit: (event: "focus" | "blur"): void => {
        listeners.get(event)?.()
      },
    }

    const tracker = await createFocusTracker({ renderer, config })

    // The half-installed pair is discarded, not left stuck as "focused".
    expect(offCalls).toEqual(["focus"])
    expect(listeners.size).toBe(0)
    expect(await tracker.isTerminalFocused()).toBe(false)

    runtime.commandStdout = "true"
    expect(await tracker.isTerminalFocused()).toBe(true)

    expect(() => tracker.dispose()).not.toThrow()
    expect(offCalls).toEqual(["focus"])
  })

  it("keeps notification delivery on the fail-open fallback path", async () => {
    runtime.commandStdout = "false"
    const renderer = {
      on: (event: string, listener: () => void): void => {
        if (event === "blur") throw new Error("blur subscribe failed")
        // Do not report focus: leave renderer state unknown.
        void listener
      },
      off: (): void => {},
    }
    const notificationConfig = {
      ...config,
      dedupeWindowMs: 0,
    }
    const tracker = await createFocusTracker({
      renderer,
      config: notificationConfig,
    })
    const notifications: string[] = []
    const core = createNotificationCore({
      config: notificationConfig,
      renderer: {
        triggerNotification: (message): void => {
          notifications.push(message)
        },
      },
      focus: tracker,
    })

    await core.questionAsked("q-fallback", "main")
    expect(notifications).toHaveLength(1)

    runtime.commandStdout = "true"
    await core.questionAsked("q-suppressed", "main")
    expect(notifications).toHaveLength(1)
  })

  it("swallows a throwing cleanup for the half-installed listener", async () => {
    runtime.commandStdout = "false"
    const offCalls: string[] = []
    const renderer = {
      on: (event: string, listener: () => void): void => {
        if (event === "blur") throw new Error("blur subscribe failed")
        void listener
      },
      off: (event: string): void => {
        offCalls.push(event)
        throw new Error("off failed")
      },
    }

    const tracker = await createFocusTracker({ renderer, config })

    expect(offCalls).toEqual(["focus"])
    expect(await tracker.isTerminalFocused()).toBe(false)
    expect(() => tracker.dispose()).not.toThrow()
    expect(offCalls).toEqual(["focus"])
  })

  it("attempts both focus and blur cleanup even when focus off throws", async () => {
    const listeners = new Map<string, () => void>()
    const offCalls: string[] = []
    const renderer = {
      on: (event: string, listener: () => void): void => {
        listeners.set(event, listener)
      },
      off: (event: string, listener: () => void): void => {
        offCalls.push(event)
        if (event === "focus") throw new Error("focus off failed")
        if (listeners.get(event) === listener) listeners.delete(event)
      },
    }
    const tracker = await createFocusTracker({ renderer, config })

    expect(() => tracker.dispose()).not.toThrow()

    expect(offCalls).toEqual(["focus", "blur"])
    expect(listeners.has("blur")).toBe(false)
  })

  it("survives a throwing renderer subscription and teardown", async () => {
    const renderer = makeRenderer({ onThrows: true, offThrows: true })
    const tracker = await createFocusTracker({ renderer, config })

    expect(renderer.listeners.size).toBe(0)
    expect(await tracker.isTerminalFocused()).toBe(false)
    expect(() => tracker.dispose()).not.toThrow()
  })
})
