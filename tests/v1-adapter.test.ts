import { beforeEach, describe, expect, it } from "bun:test"
import { execCalls, resetRuntime } from "./runtime-mocks"

const adapter = (await import("../notifications")) as {
  default: {
    id: string
    tui: (api: unknown) => Promise<void>
  }
}

interface V1Toast {
  title?: string
  message: string
  variant?: string
}

interface V1HarnessOptions {
  config?: Record<string, unknown>
  throwingUnsubscribers?: string[]
  offThrows?: boolean
  onDisposeThrows?: boolean
  failingEventRegistration?: string
  sessions?: Record<string, { parentID?: string }>
  hostState?: "present" | "missing" | "missing-session"
}

const createV1Harness = async (options: V1HarnessOptions = {}) => {
  resetRuntime({
    config: {
      terminalProcessName: "TestTerminal",
      soundEnabled: false,
      ...options.config,
    },
    focused: false,
  })

  const handlers = new Map<string, (event: unknown) => unknown>()
  const unsubscribed: string[] = []
  const notifications: Array<{ message: string; title?: string }> = []
  const toasts: V1Toast[] = []
  const rendererListeners = new Map<string, () => void>()
  const rendererOffCalls: string[] = []
  const sessions = new Map(Object.entries(options.sessions ?? {}))
  let disposeCallback: (() => void | Promise<void>) | null = null

  const api = {
    state: {
      session: {
        get: (sessionID: string) => sessions.get(sessionID),
      },
    } as { session?: { get: (sessionID: string) => unknown } },
    event: {
      on: (type: string, handler: (event: unknown) => unknown): (() => void) => {
        if (type === options.failingEventRegistration) {
          throw new Error(`registration failed for ${type}`)
        }
        handlers.set(type, handler)
        return (): void => {
          handlers.delete(type)
          unsubscribed.push(type)
          if (options.throwingUnsubscribers?.includes(type)) {
            throw new Error(`unsubscribe failed for ${type}`)
          }
        }
      },
    },
    renderer: {
      triggerNotification: (message: string, title?: string): void => {
        notifications.push({ message, title })
      },
      on: (event: string, listener: () => void): void => {
        rendererListeners.set(event, listener)
      },
      off: (event: string, listener: () => void): void => {
        rendererOffCalls.push(event)
        if (options.offThrows) throw new Error("unsubscribe failed")
        if (rendererListeners.get(event) === listener) {
          rendererListeners.delete(event)
        }
      },
    },
    ui: {
      toast: (input: V1Toast): void => {
        toasts.push(input)
      },
    },
    lifecycle: {
      onDispose: (dispose: () => void | Promise<void>): (() => void) => {
        if (options.onDisposeThrows) throw new Error("lifecycle unavailable")
        disposeCallback = dispose
        return () => {}
      },
    },
  }

  if (options.hostState === "missing") {
    delete (api as { state?: unknown }).state
  } else if (options.hostState === "missing-session") {
    ;(api as { state: { session?: unknown } }).state.session = undefined
  }

  let setupError: unknown
  try {
    await adapter.default.tui(api)
  } catch (error) {
    setupError = error
  }

  const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  return {
    handlers,
    unsubscribed,
    notifications,
    toasts,
    rendererListeners,
    rendererOffCalls,
    sessions,
    setupError,
    get dispose() {
      return disposeCallback
    },
    async emit(type: string, properties: unknown): Promise<void> {
      const handler = handlers.get(type)
      if (!handler) throw new Error(`No handler registered for "${type}"`)
      await handler({ properties })
      await flush()
    },
    disposeNow(): void {
      disposeCallback?.()
    },
  }
}

beforeEach(() => {
  console.warn = () => {}
})

describe("v1 TUI adapter", () => {
  it("registers the v1 event surface", async () => {
    const harness = await createV1Harness()

    expect([...harness.handlers.keys()].sort()).toEqual([
      "permission.asked",
      "permission.replied",
      "question.asked",
      "question.rejected",
      "question.replied",
      "session.created",
      "session.deleted",
      "session.error",
      "session.status",
      "session.updated",
    ])
    expect(adapter.default.id).toBe("notifications")
  })

  it("resets the completion guard on busy/retry status", async () => {
    const harness = await createV1Harness()

    await harness.emit("session.status", {
      sessionID: "main",
      status: { type: "busy" },
    })
    await harness.emit("session.status", {
      sessionID: "main",
      status: { type: "idle" },
    })
    await harness.emit("session.status", {
      sessionID: "main",
      status: { type: "idle" },
    })
    expect(harness.notifications).toHaveLength(1)

    await harness.emit("session.status", {
      sessionID: "main",
      status: {
        type: "retry",
        attempt: 1,
        message: "retrying",
        next: Date.now() + 1_000,
      },
    })
    await harness.emit("session.status", {
      sessionID: "main",
      status: { type: "idle" },
    })
    await harness.emit("session.status", {
      sessionID: "main",
      status: { type: "idle" },
    })

    expect(harness.notifications).toHaveLength(2)
  })

  it("busy resets a completed session so the next idle notifies again", async () => {
    const harness = await createV1Harness()

    await harness.emit("session.status", {
      sessionID: "main",
      status: { type: "busy" },
    })
    await harness.emit("session.status", {
      sessionID: "main",
      status: { type: "idle" },
    })
    expect(harness.notifications).toHaveLength(1)

    // A second busy after completion must clear the terminal guard again.
    await harness.emit("session.status", {
      sessionID: "main",
      status: { type: "busy" },
    })
    await harness.emit("session.status", {
      sessionID: "main",
      status: { type: "idle" },
    })
    expect(harness.notifications).toHaveLength(2)

    // No new busy: another idle must stay deduped.
    await harness.emit("session.status", {
      sessionID: "main",
      status: { type: "idle" },
    })
    expect(harness.notifications).toHaveLength(2)
  })

  it("busy clears the error guard so the next execution can complete", async () => {
    const harness = await createV1Harness()

    await harness.emit("session.status", {
      sessionID: "main",
      status: { type: "busy" },
    })
    await harness.emit("session.error", {
      sessionID: "main",
      error: { message: "boom" },
    })
    expect(harness.notifications.map((item) => item.message)).toEqual([
      "Something went wrong, I need your attention!",
    ])

    // idle after the error must not emit a completion notification.
    await harness.emit("session.status", {
      sessionID: "main",
      status: { type: "idle" },
    })
    expect(harness.notifications.map((item) => item.message)).toEqual([
      "Something went wrong, I need your attention!",
    ])

    // A fresh execution starts/resets the error + terminal guards.
    await harness.emit("session.status", {
      sessionID: "main",
      status: { type: "busy" },
    })
    await harness.emit("session.status", {
      sessionID: "main",
      status: { type: "idle" },
    })
    expect(harness.notifications.map((item) => item.message)).toEqual([
      "Something went wrong, I need your attention!",
      "Task completed!",
    ])
  })

  it("retry clears the error guard after a failed execution", async () => {
    const harness = await createV1Harness()

    await harness.emit("session.status", {
      sessionID: "main",
      status: { type: "busy" },
    })
    await harness.emit("session.error", {
      sessionID: "main",
      error: { message: "boom" },
    })
    await harness.emit("session.status", {
      sessionID: "main",
      status: { type: "idle" },
    })
    expect(harness.notifications.map((item) => item.message)).toEqual([
      "Something went wrong, I need your attention!",
    ])

    await harness.emit("session.status", {
      sessionID: "main",
      status: {
        type: "retry",
        attempt: 1,
        message: "retrying",
        next: Date.now() + 1_000,
      },
    })
    await harness.emit("session.status", {
      sessionID: "main",
      status: { type: "idle" },
    })

    expect(harness.notifications.map((item) => item.message)).toEqual([
      "Something went wrong, I need your attention!",
      "Task completed!",
    ])
  })

  it("maps idle session.status to completion", async () => {
    const harness = await createV1Harness()

    await harness.emit("session.status", {
      sessionID: "main",
      status: { type: "idle" },
    })

    expect(harness.notifications).toEqual([
      { message: "Task completed!", title: "OpenCode" },
    ])
  })

  it("maps session.error to configured copy plus a raw-detail toast", async () => {
    const harness = await createV1Harness()

    await harness.emit("session.error", {
      sessionID: "main",
      error: { message: "boom" },
    })

    expect(harness.notifications.map((item) => item.message)).toEqual([
      "Something went wrong, I need your attention!",
    ])
    expect(harness.toasts).toEqual([
      {
        title: "Session failed",
        message: "boom",
        variant: "error",
      },
    ])
  })

  it("extracts nested v1 error detail", async () => {
    const harness = await createV1Harness()

    await harness.emit("session.error", {
      sessionID: "main",
      error: { data: { message: "nested detail" } },
    })

    expect(harness.toasts[0]?.message).toBe("nested detail")
  })

  it("maps question.asked and question.replied", async () => {
    const harness = await createV1Harness({
      config: { dedupeWindowMs: 0 },
    })

    await harness.emit("question.asked", {
      id: "q1",
      sessionID: "main",
    })
    await harness.emit("question.replied", {
      sessionID: "main",
      requestID: "q1",
    })
    await harness.emit("question.asked", {
      id: "q1",
      sessionID: "main",
    })

    expect(harness.notifications).toHaveLength(2)
    expect(harness.notifications[0]?.message).toBe(
      "I have a question for you!",
    )
  })

  it("normalizes v1 permission/patterns payloads", async () => {
    const harness = await createV1Harness()

    await harness.emit("permission.asked", {
      id: "p1",
      sessionID: "main",
      permission: "network",
      patterns: ["https://example.com/api"],
      metadata: { url: "https://example.com/api" },
    })

    expect(harness.notifications.map((item) => item.message)).toEqual([
      "I need permission to do: network request: https://example.com/api",
    ])
  })

  it("maps session lifecycle and suppresses only subagent completion", async () => {
    const harness = await createV1Harness()

    await harness.emit("session.created", {
      sessionID: "child-done",
      info: { parentID: "parent" },
    })
    await harness.emit("session.created", {
      sessionID: "child-error",
      info: { parentID: "parent" },
    })
    await harness.emit("session.status", {
      sessionID: "child-done",
      status: { type: "idle" },
    })
    expect(harness.notifications).toEqual([])

    await harness.emit("session.error", {
      sessionID: "child-error",
      error: { message: "child failed" },
    })
    expect(harness.notifications).toHaveLength(1)
  })

  it("works without api.state on older hosts", async () => {
    const harness = await createV1Harness({ hostState: "missing" })

    expect(harness.setupError).toBeUndefined()
    await harness.emit("session.created", {
      sessionID: "child",
      info: { parentID: "parent" },
    })
    await harness.emit("session.status", {
      sessionID: "child",
      status: { type: "idle" },
    })
    expect(harness.notifications).toEqual([])

    await harness.emit("session.status", {
      sessionID: "root",
      status: { type: "idle" },
    })
    expect(harness.notifications).toEqual([
      { message: "Task completed!", title: "OpenCode" },
    ])
  })

  it("works without api.state.session on older hosts", async () => {
    const harness = await createV1Harness({ hostState: "missing-session" })

    expect(harness.setupError).toBeUndefined()
    await harness.emit("session.created", {
      sessionID: "child",
      info: { parentID: "parent" },
    })
    await harness.emit("session.status", {
      sessionID: "child",
      status: { type: "idle" },
    })
    expect(harness.notifications).toEqual([])

    await harness.emit("session.status", {
      sessionID: "root",
      status: { type: "idle" },
    })
    expect(harness.notifications).toEqual([
      { message: "Task completed!", title: "OpenCode" },
    ])
  })

  it("tracks parentID from session.updated before completion", async () => {
    const harness = await createV1Harness()

    await harness.emit("session.updated", {
      sessionID: "child",
      info: { parentID: "parent" },
    })
    await harness.emit("session.status", {
      sessionID: "child",
      status: { type: "idle" },
    })

    expect(harness.notifications).toEqual([])
  })

  it("suppresses completion when api.state identifies the session as a child", async () => {
    const harness = await createV1Harness({
      sessions: { child: { parentID: "parent" } },
    })

    await harness.emit("session.status", {
      sessionID: "child",
      status: { type: "idle" },
    })
    expect(harness.notifications).toEqual([])

    // Root-session control still notifies.
    await harness.emit("session.status", {
      sessionID: "root",
      status: { type: "idle" },
    })
    expect(harness.notifications).toEqual([
      { message: "Task completed!", title: "OpenCode" },
    ])
  })

  it("clears owned question and permission IDs on session.deleted", async () => {
    const harness = await createV1Harness({
      config: { dedupeWindowMs: 0 },
    })

    await harness.emit("question.asked", { id: "q1", sessionID: "main" })
    await harness.emit("permission.asked", {
      id: "p1",
      sessionID: "main",
      permission: "shell",
      patterns: ["ls"],
    })
    await harness.emit("session.deleted", { sessionID: "main" })
    await harness.emit("question.asked", { id: "q1", sessionID: "main" })
    await harness.emit("permission.asked", {
      id: "p1",
      sessionID: "main",
      permission: "shell",
      patterns: ["ls"],
    })

    expect(harness.notifications).toHaveLength(4)
  })

  it("maps question.rejected to question resolution", async () => {
    const harness = await createV1Harness({
      config: { dedupeWindowMs: 0 },
    })

    await harness.emit("question.asked", { id: "q1", sessionID: "main" })
    await harness.emit("question.rejected", {
      sessionID: "main",
      requestID: "q1",
    })
    await harness.emit("question.asked", { id: "q1", sessionID: "main" })

    expect(harness.notifications).toHaveLength(2)
  })

  it("disposes immediately when lifecycle registration throws", async () => {
    const harness = await createV1Harness({ onDisposeThrows: true })

    expect(harness.unsubscribed).toHaveLength(10)
    expect(harness.handlers.size).toBe(0)
    expect(harness.rendererOffCalls.sort()).toEqual(["blur", "focus"])
    expect(harness.dispose).toBeNull()
  })

  it("cleans up listeners best-effort on lifecycle dispose", async () => {
    const harness = await createV1Harness({
      throwingUnsubscribers: ["session.status", "permission.asked"],
      offThrows: true,
    })

    expect(harness.rendererListeners.size).toBe(2)
    expect(() => harness.disposeNow()).not.toThrow()

    expect(harness.unsubscribed).toHaveLength(10)
    expect(harness.handlers.size).toBe(0)
    expect([...harness.rendererOffCalls].sort()).toEqual(["blur", "focus"])
  })
})

describe("v1 adapter partial setup failure", () => {
  it("cleans up earlier subscriptions and focus listeners when registration throws", async () => {
    const harness = await createV1Harness({
      failingEventRegistration: "session.error",
    })

    expect(harness.setupError).toBeDefined()
    expect(harness.handlers.size).toBe(0)
    expect([...harness.unsubscribed].sort()).toEqual([
      "session.created",
      "session.deleted",
      "session.status",
      "session.updated",
    ])
    expect(harness.rendererListeners.size).toBe(0)
    expect([...harness.rendererOffCalls].sort()).toEqual(["blur", "focus"])
    expect(harness.notifications).toEqual([])
    expect(harness.toasts).toEqual([])
    expect(
      execCalls.filter(
        (call) => call.file === "afplay" || call.file === "paplay",
      ),
    ).toEqual([])
  })
})
