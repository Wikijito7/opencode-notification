import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import "./runtime-mocks"

const { DEFAULTS } = await import("../notifications/shared/config")
const { createNotificationCore } = await import("../notifications/shared/core")
type DeepPartial<T> = import("../notifications/shared/types").DeepPartial<T>
type NotificationsConfig =
  import("../notifications/shared/types").NotificationsConfig
type ToastInput = import("../notifications/shared/types").ToastInput

const REAL_NOW = Date.now
let now = 1_700_000_000_000

beforeAll(() => {
  Date.now = (): number => now
})

afterAll(() => {
  Date.now = REAL_NOW
})

beforeEach(() => {
  now = 1_700_000_000_000
  console.warn = () => {}
})

const makeConfig = (
  overrides: DeepPartial<NotificationsConfig> = {},
): NotificationsConfig => ({
  ...DEFAULTS,
  ...overrides,
  events: { ...DEFAULTS.events, ...overrides.events },
  sounds: { ...DEFAULTS.sounds, ...overrides.sounds },
  messages: { ...DEFAULTS.messages, ...overrides.messages },
  // Keep every core test sound-free; sound behavior has its own suite.
  soundEnabled: overrides.soundEnabled ?? false,
})

const createFocus = (initial = false) => {
  let focused = initial
  let deferred = false
  let pending: ((value: boolean) => void) | null = null

  return {
    setFocused(value: boolean): void {
      focused = value
    },
    deferNext(): void {
      deferred = true
    },
    get hasPending(): boolean {
      return pending !== null
    },
    resolve(value: boolean): void {
      const resolver = pending
      pending = null
      resolver?.(value)
    },
    async isTerminalFocused(): Promise<boolean> {
      if (deferred) {
        deferred = false
        return new Promise<boolean>((resolve) => {
          pending = resolve
        })
      }
      return focused
    },
    dispose(): void {},
  }
}

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error("Timed out waiting for condition")
}

const createCore = (
  overrides: DeepPartial<NotificationsConfig> = {},
  options: {
    focus?: ReturnType<typeof createFocus>
    rendererThrows?: boolean
    toastThrows?: boolean
    parents?: Map<string, string>
  } = {},
) => {
  const notifications: Array<{ message: string; title?: string }> = []
  const toasts: ToastInput[] = []
  const focus = options.focus ?? createFocus()
  const parents = options.parents ?? new Map<string, string>()

  const core = createNotificationCore({
    config: makeConfig(overrides),
    renderer: {
      triggerNotification: (message: string, title?: string): void => {
        if (options.rendererThrows) throw new Error("renderer destroyed")
        notifications.push({ message, title })
      },
    },
    focus,
    toast: (input): void => {
      if (options.toastThrows) throw new Error("toast failed")
      toasts.push(input)
    },
    getSessionParent: (sessionID) => parents.get(sessionID),
  })

  return { core, focus, notifications, toasts, parents }
}

describe("shared notification core", () => {
  it("notifies normally once and suppresses duplicate completion", async () => {
    const { core, notifications } = createCore()

    await core.ended("main")
    await core.ended("main")

    expect(notifications).toEqual([
      { message: "Task completed!", title: "OpenCode" },
    ])
  })

  it("resets the completion guard on started()", async () => {
    const { core, notifications } = createCore()

    await core.ended("main")
    core.started("main")
    await core.ended("main")

    expect(notifications.map((item) => item.message)).toEqual([
      "Task completed!",
      "Task completed!",
    ])
  })

  it("uses configured error copy, toasts raw detail and suppresses following idle", async () => {
    const { core, notifications, toasts } = createCore({
      messages: { error: "Custom failure copy" },
    })

    await core.failed("main", "raw provider detail")
    await core.ended("main")

    expect(notifications.map((item) => item.message)).toEqual([
      "Custom failure copy",
    ])
    expect(toasts).toEqual([
      {
        sessionID: "main",
        title: "Session failed",
        message: "raw provider detail",
        variant: "error",
      },
    ])
  })

  it("does not repeat the error notification for the same failure", async () => {
    const { core, notifications } = createCore()

    await core.failed("main", "first")
    await core.failed("main", "second")

    expect(notifications).toHaveLength(1)
  })

  it("suppresses only subagent completion while keeping error/question/permission eligible", async () => {
    const { core, notifications, toasts } = createCore()

    core.sessionCreated("child-done", "parent")
    core.sessionCreated("child-error", "parent")
    core.sessionCreated("child-question", "parent")
    core.sessionCreated("child-permission", "parent")

    await core.ended("child-done")
    expect(notifications).toEqual([])

    await core.failed("child-error", "subagent exploded")
    await core.questionAsked("q-child", "child-question")
    await core.permissionAsked("p-child", "child-permission", {
      action: "shell",
      resources: ["ls"],
    })

    expect(notifications.map((item) => item.message)).toEqual([
      DEFAULTS.messages.error,
      DEFAULTS.messages.question,
      "I need permission to do: run: ls",
    ])
    expect(toasts[0]?.message).toBe("subagent exploded")
  })

  it("uses the session parent lookup for subagent suppression", async () => {
    const parents = new Map([["child", "parent"]])
    const { core, notifications } = createCore({}, { parents })

    await core.ended("child")

    expect(notifications).toEqual([])
  })

  it("clears owned form and permission IDs on session deletion", async () => {
    const { core, notifications } = createCore({ dedupeWindowMs: 0 })

    await core.questionAsked("q1", "main")
    await core.permissionAsked("p1", "main", {
      action: "shell",
      resources: ["ls"],
    })
    core.sessionDeleted("main")
    await core.questionAsked("q1", "main")
    await core.permissionAsked("p1", "main", {
      action: "shell",
      resources: ["ls"],
    })

    expect(notifications.map((item) => item.message)).toEqual([
      DEFAULTS.messages.question,
      "I need permission to do: run: ls",
      DEFAULTS.messages.question,
      "I need permission to do: run: ls",
    ])
  })

  it("does not consume the question rate key while focused", async () => {
    const focus = createFocus(true)
    const { core, notifications } = createCore(
      { dedupeWindowMs: 60_000 },
      { focus },
    )

    await core.questionAsked("q-focused", "main")
    expect(notifications).toEqual([])

    focus.setFocused(false)
    await core.questionAsked("q-blurred", "main")

    expect(notifications.map((item) => item.message)).toEqual([
      DEFAULTS.messages.question,
    ])
  })

  it("dedupes a same-key repeat at maxRecentNotifications=1", async () => {
    const { core, notifications } = createCore({
      dedupeWindowMs: 60_000,
      maxRecentNotifications: 1,
    })

    await core.permissionAsked("p1", "main", {
      action: "shell",
      resources: ["ls"],
    })
    await core.permissionAsked("p2", "main", {
      action: "shell",
      resources: ["ls -la"],
    })

    expect(notifications.map((item) => item.message)).toEqual([
      "I need permission to do: run: ls",
    ])
  })

  it("bounds terminal, subagent and form guards", async () => {
    const terminalCore = createCore({ maxRecentNotifications: 1 })
    await terminalCore.core.ended("s1")
    await terminalCore.core.ended("s2")
    await terminalCore.core.ended("s1")
    expect(terminalCore.notifications).toHaveLength(3)

    const subagentCore = createCore({ maxRecentNotifications: 1 })
    subagentCore.core.sessionCreated("child-1", "parent")
    subagentCore.core.sessionCreated("child-2", "parent")
    await subagentCore.core.ended("child-1")
    await subagentCore.core.ended("child-2")
    expect(subagentCore.notifications).toHaveLength(1)

    const formCore = createCore({
      dedupeWindowMs: 1_000,
      maxRecentNotifications: 1,
    })
    await formCore.core.questionAsked("q1", "main")
    await formCore.core.questionAsked("q2", "main")
    now += 1_000
    await formCore.core.questionAsked("q1", "main")
    expect(formCore.notifications).toHaveLength(2)
  })

  it("does not notify after dispose while an async focus probe is pending", async () => {
    const focus = createFocus()
    const { core, notifications } = createCore({}, { focus })

    focus.deferNext()
    const pending = core.questionAsked("q-pending", "main")
    await waitFor(() => focus.hasPending)

    core.dispose()
    focus.resolve(false)
    await pending

    expect(notifications).toEqual([])
  })

  it("swallows renderer and toast failures", async () => {
    const rendererFailed = createCore({}, { rendererThrows: true })
    await expect(rendererFailed.core.ended("main")).resolves.toBeUndefined()

    const toastFailed = createCore({}, { toastThrows: true })
    await expect(
      toastFailed.core.failed("main", "detail"),
    ).resolves.toBeUndefined()
    expect(toastFailed.notifications).toHaveLength(1)
  })
})
