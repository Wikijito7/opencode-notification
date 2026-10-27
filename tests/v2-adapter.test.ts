import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import {
  BASE_CONFIG,
  createHarness,
  FAKE_HOME,
  messagesOf,
  type Harness,
} from "./harness"

const REAL_NOW = Date.now
const ORIGINAL_TERM_PROGRAM = process.env.TERM_PROGRAM
const ORIGINAL_WARN = console.warn

const DEFAULT_ERROR_MESSAGE =
  "Something went wrong, I need your attention!"

let now = 1_700_000_000_000

beforeAll(() => {
  Date.now = (): number => now
  // Deterministic terminal detection: avoids the ps/proc parent walk.
  process.env.TERM_PROGRAM = "ghostty"
})

afterAll(() => {
  Date.now = REAL_NOW
  if (ORIGINAL_TERM_PROGRAM === undefined) delete process.env.TERM_PROGRAM
  else process.env.TERM_PROGRAM = ORIGINAL_TERM_PROGRAM
  console.warn = ORIGINAL_WARN
})

beforeEach(() => {
  now = 1_700_000_000_000
  // The mocks intentionally hide sound files, so the plugin's expected
  // "sound not found" warnings would otherwise spam the test output.
  console.warn = () => {}
})

const completion = (harness: Harness, sessionID: string): Promise<void> =>
  harness.emit("session.execution.succeeded", { sessionID })

const failure = (
  harness: Harness,
  sessionID: string,
  message: string,
): Promise<void> =>
  harness.emit("session.execution.failed", {
    sessionID,
    error: { type: "api", message },
  })

/** A v2 `permission.asked` payload: action + resources, metadata optional. */
const permissionAsked = (
  id: string,
  action: string,
  resources: string[],
  metadata?: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  sessionID: "main",
  action,
  resources,
  save: resources.map(() => "*"),
  ...(metadata === undefined ? {} : { metadata }),
  ...extra,
})

/** A v2 `form.created` question payload. */
const questionForm = (id: string, sessionID = "main"): Record<string, unknown> => ({
  form: {
    id,
    sessionID,
    title: "Question",
    metadata: { kind: "question", tool: { messageID: "msg", id: "call" } },
    fields: [],
  },
})

const audioCalls = (harness: Harness): string[] =>
  harness.execCalls
    .map((call) => call.file)
    .filter((file) => file === "afplay" || file === "paplay")

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error("Timed out waiting for condition")
}

describe("config loading", () => {
  it("uses built-in defaults when no config file exists", async () => {
    const harness = await createHarness({ config: null })

    await completion(harness, "s1")

    expect(messagesOf(harness)).toEqual(["Task completed!"])
    expect(harness.notifications[0]?.title).toBe("OpenCode")
  })

  it("keeps all notification events enabled by default", async () => {
    const harness = await createHarness({ config: null })

    await completion(harness, "s1")
    await failure(harness, "s2", "boom")
    await harness.emit("form.created", questionForm("q1"))
    await harness.emit(
      "permission.asked",
      permissionAsked("p1", "webfetch", ["https://example.com"]),
    )

    expect(messagesOf(harness)).toEqual([
      "Task completed!",
      DEFAULT_ERROR_MESSAGE,
      "I have a question for you!",
      "I need permission to do: network request: https://example.com",
    ])
    // The raw error is toast detail, not notification copy.
    expect(harness.toasts).toEqual([
      {
        sessionID: "s2",
        title: "Session failed",
        message: "boom",
        variant: "error",
      },
    ])
  })

  it("parses JSONC comments and trailing commas and applies message overrides", async () => {
    const config = `{
      // terminal override
      "terminalProcessName": "TestTerminal",
      "soundEnabled": false, /* silence */
      "messages": {
        "idle": "Done (custom)!",
      },
    }`
    const harness = await createHarness({ config })

    await completion(harness, "s1")

    expect(messagesOf(harness)).toEqual(["Done (custom)!"])
  })

  it("preserves string content that looks like JSONC syntax", async () => {
    const config = `{
      "terminalProcessName": "TestTerminal",
      "soundEnabled": false,
      "messages": {
        "idle": "keep ,] and // not a comment and \\"quoted\\" text",
      },
    }`
    const harness = await createHarness({ config })

    await completion(harness, "s1")

    expect(messagesOf(harness)).toEqual([
      'keep ,] and // not a comment and "quoted" text',
    ])
  })

  it("honours event toggles parsed from JSONC", async () => {
    const config = `{
      "terminalProcessName": "TestTerminal",
      "soundEnabled": false,
      "events": { "idle": false },
    }`
    const harness = await createHarness({ config })

    await completion(harness, "s1")

    expect(messagesOf(harness)).toEqual([])
  })

  it("falls back to defaults when JSONC is malformed", async () => {
    const warnings: string[] = []
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.join(" "))
    }

    const harness = await createHarness({
      config: '{"events": {"idle": true',
    })

    await completion(harness, "s1")

    expect(messagesOf(harness)).toEqual(["Task completed!"])
    expect(warnings.some((line) => line.includes("Failed to parse config"))).toBe(
      true,
    )
  })

  it("ignores valid-but-wrong shapes such as events:null and negative limits", async () => {
    const config = `{
      "terminalProcessName": "TestTerminal",
      "soundEnabled": "yes",
      "events": null,
      "sounds": [],
      "messages": { "idle": 42, "error": false },
      "dedupeWindowMs": -5,
      "maxRecentNotifications": 0
    }`
    const harness = await createHarness({ config })

    await completion(harness, "s1")
    await failure(harness, "s2", "boom")
    // Invalid dedupeWindowMs -5 must not disable the rate limit: two distinct
    // forms in the same instant still collapse to one notification.
    await harness.emit("form.created", questionForm("q1"))
    await harness.emit("form.created", questionForm("q2"))
    await harness.emit(
      "permission.asked",
      permissionAsked("p1", "webfetch", ["https://example.com"]),
    )

    expect(messagesOf(harness)).toEqual([
      "Task completed!",
      DEFAULT_ERROR_MESSAGE,
      "I have a question for you!",
      "I need permission to do: network request: https://example.com",
    ])
    expect(harness.toasts.map((toast) => toast.message)).toEqual(["boom"])
    expect(audioCalls(harness)).toEqual([])
  })

  it("ignores wrong nested field types and keeps defaults", async () => {
    const config = {
      terminalProcessName: 42,
      soundEnabled: "yes",
      events: { idle: "no", error: 0, permission: null, question: [] },
      sounds: { idle: 7 },
      messages: { idle: 5, error: false },
      dedupeWindowMs: "fast",
      maxRecentNotifications: 1.5,
    }
    const harness = await createHarness({ config })

    await completion(harness, "s1")
    await failure(harness, "s2", "detail only")

    expect(messagesOf(harness)).toEqual([
      "Task completed!",
      DEFAULT_ERROR_MESSAGE,
    ])
    expect(harness.toasts.map((toast) => toast.message)).toEqual([
      "detail only",
    ])
  })
})

describe("completion policy", () => {
  it("notifies once on normal completion", async () => {
    const harness = await createHarness()

    await completion(harness, "main")

    expect(messagesOf(harness)).toEqual(["Task completed!"])
    expect(harness.notifications[0]?.title).toBe("OpenCode")
  })

  it("suppresses duplicate completion for the same session", async () => {
    const harness = await createHarness()

    await completion(harness, "main")
    await completion(harness, "main")

    expect(messagesOf(harness)).toEqual(["Task completed!"])
  })

  it("resets the completion guard on session.execution.started", async () => {
    const harness = await createHarness()

    await completion(harness, "main")
    await harness.emit("session.execution.started", { sessionID: "main" })
    await completion(harness, "main")

    expect(messagesOf(harness)).toEqual([
      "Task completed!",
      "Task completed!",
    ])
  })

  it("suppresses completion from subagent sessions", async () => {
    const harness = await createHarness()

    await harness.emit("session.created", {
      sessionID: "child",
      parentID: "parent",
    })
    await completion(harness, "child")

    expect(messagesOf(harness)).toEqual([])
  })

  it("suppresses completion when the session lookup reports a parent", async () => {
    const harness = await createHarness()
    harness.sessions.set("child", { parentID: "parent" })

    await completion(harness, "child")

    expect(messagesOf(harness)).toEqual([])
  })
})

describe("subagent error, question and permission eligibility", () => {
  it("still notifies for a subagent execution failure", async () => {
    const harness = await createHarness()
    await harness.emit("session.created", {
      sessionID: "child",
      parentID: "parent",
    })

    await failure(harness, "child", "subagent exploded")

    expect(messagesOf(harness)).toEqual([DEFAULT_ERROR_MESSAGE])
    expect(harness.toasts[0]?.message).toBe("subagent exploded")
  })

  it("still notifies for a subagent question form", async () => {
    const harness = await createHarness()
    await harness.emit("session.created", {
      sessionID: "child",
      parentID: "parent",
    })

    await harness.emit("form.created", questionForm("q-child", "child"))

    expect(messagesOf(harness)).toEqual(["I have a question for you!"])
  })

  it("still notifies for a subagent permission request", async () => {
    const harness = await createHarness()
    await harness.emit("session.created", {
      sessionID: "child",
      parentID: "parent",
    })

    await harness.emit(
      "permission.asked",
      permissionAsked("p-child", "webfetch", ["https://example.com"]),
    )

    expect(messagesOf(harness)).toEqual([
      "I need permission to do: network request: https://example.com",
    ])
  })
})

describe("question form policy", () => {
  it("ignores non-question forms", async () => {
    const harness = await createHarness()

    await harness.emit("form.created", {
      form: {
        id: "f1",
        sessionID: "main",
        title: "Other",
        metadata: { kind: "other" },
        fields: [],
      },
    })

    expect(messagesOf(harness)).toEqual([])
  })

  it("alerts for question forms", async () => {
    const harness = await createHarness()

    await harness.emit("form.created", questionForm("q1"))

    expect(messagesOf(harness)).toEqual(["I have a question for you!"])
  })

  it("does not alert twice for the same form id", async () => {
    const harness = await createHarness()
    const event = questionForm("q1")

    await harness.emit("form.created", event)
    await harness.emit("form.created", event)

    expect(messagesOf(harness)).toEqual(["I have a question for you!"])
  })

  it("does not consume the shared question rate-limit key while focused", async () => {
    const harness = await createHarness({
      config: { ...BASE_CONFIG, dedupeWindowMs: 60_000 },
    })

    harness.emitRenderer("focus")
    await harness.emit("form.created", questionForm("q-focused"))
    expect(messagesOf(harness)).toEqual([])

    harness.emitRenderer("blur")
    await harness.emit("form.created", questionForm("q-blurred"))

    expect(messagesOf(harness)).toEqual(["I have a question for you!"])
  })

  it("rate-limits distinct question forms inside the dedupe window", async () => {
    const harness = await createHarness({
      config: { ...BASE_CONFIG, dedupeWindowMs: 1_000 },
    })

    await harness.emit("form.created", questionForm("q1"))
    await harness.emit("form.created", questionForm("q2"))
    now += 1_000
    await harness.emit("form.created", questionForm("q3"))

    expect(messagesOf(harness)).toEqual([
      "I have a question for you!",
      "I have a question for you!",
    ])
  })

  it("clears the form guard when the form is replied", async () => {
    const harness = await createHarness({
      config: { ...BASE_CONFIG, dedupeWindowMs: 1_000 },
    })
    const event = questionForm("q1")

    await harness.emit("form.created", event)
    await harness.emit("form.replied", {
      id: "q1",
      sessionID: "main",
      answer: {},
    })
    now += 1_000
    await harness.emit("form.created", event)

    expect(messagesOf(harness)).toEqual([
      "I have a question for you!",
      "I have a question for you!",
    ])
  })

  it("suppresses question alerts when events.question is false", async () => {
    const harness = await createHarness({
      config: { ...BASE_CONFIG, events: { question: false } },
    })

    await harness.emit("form.created", questionForm("q1"))

    expect(messagesOf(harness)).toEqual([])
  })
})

describe("permission policy", () => {
  it("formats actual v2 action/resource payloads", async () => {
    const cases: Array<{
      data: Record<string, unknown>
      expected: string
    }> = [
      {
        // FileAccess.authorizeExternal emits directory glob resources.
        data: permissionAsked("p1", "external_directory", [
          "/Users/me/external/*",
        ]),
        expected: "I need permission to do: access: external",
      },
      {
        data: permissionAsked("p2", "external_directory", [
          "/Users/me/alpha/*",
          "/Users/me/beta/*",
        ]),
        expected: "I need permission to do: access: alpha (+1 more)",
      },
      {
        data: permissionAsked("p3", "external_directory", []),
        expected: "I need permission to do: access external file",
      },
      {
        // webfetch asserts resources: [url], metadata: input
        data: permissionAsked(
          "p4",
          "webfetch",
          ["https://example.com/api"],
          { url: "https://example.com/api", format: "markdown" },
        ),
        expected:
          "I need permission to do: network request: https://example.com/api",
      },
      {
        // websearch asserts resources: [query], metadata: input
        data: permissionAsked(
          "p5",
          "websearch",
          ["opencode plugin notifications"],
          { query: "opencode plugin notifications" },
        ),
        expected:
          "I need permission to do: web search: opencode plugin notifications",
      },
      {
        // shell asserts one resource per parsed command.
        data: permissionAsked("p6", "shell", [
          "git commit -m message",
          "and more",
        ]),
        expected: "I need permission to do: run: git commit -m message and",
      },
      {
        // read/edit/glob/grep use the tool's resource, not v1 metadata.
        data: permissionAsked(
          "p7",
          "read",
          ["src/utils/file.ts"],
          { truncated: false },
        ),
        expected: "I need permission to do: read: file.ts",
      },
      {
        data: permissionAsked(
          "p8",
          "edit",
          ["src/app.ts"],
          { files: [{ path: "src/app.ts", patch: "@@" }] },
        ),
        expected: "I need permission to do: edit: app.ts",
      },
      {
        data: permissionAsked(
          "p9",
          "glob",
          ["**/*.ts"],
          { root: ".", path: "src", hidden: false, limit: 100 },
        ),
        expected: "I need permission to do: search files: **/*.ts",
      },
      {
        data: permissionAsked(
          "p10",
          "grep",
          ["TODO"],
          { root: ".", path: "src", include: "*.ts" },
        ),
        expected: "I need permission to do: search contents: TODO",
      },
      {
        // v2 carries a free-form message for non-special actions.
        data: permissionAsked(
          "p11",
          "custom_action",
          [],
          undefined,
          { message: "Do the custom thing" },
        ),
        expected: "I need permission to do: Do the custom thing",
      },
    ]

    for (const testCase of cases) {
      const harness = await createHarness()
      await harness.emit("permission.asked", testCase.data)
      expect(messagesOf(harness)).toEqual([testCase.expected])
    }
  })

  it("does not notify twice for the same permission request id", async () => {
    const harness = await createHarness()
    const event = permissionAsked("p1", "shell", ["ls"])

    await harness.emit("permission.asked", event)
    await harness.emit("permission.asked", event)

    expect(messagesOf(harness)).toEqual([
      "I need permission to do: run: ls",
    ])
  })

  it("rate-limits distinct permission requests for the same action", async () => {
    const harness = await createHarness({
      config: { ...BASE_CONFIG, dedupeWindowMs: 1_000 },
    })

    await harness.emit(
      "permission.asked",
      permissionAsked("p1", "shell", ["ls"]),
    )
    await harness.emit(
      "permission.asked",
      permissionAsked("p2", "shell", ["ls -la"]),
    )
    now += 1_000
    await harness.emit(
      "permission.asked",
      permissionAsked("p3", "shell", ["pwd"]),
    )

    expect(messagesOf(harness)).toEqual([
      "I need permission to do: run: ls",
      "I need permission to do: run: pwd",
    ])
  })

  it("evicts oldest dedupe keys when maxRecentNotifications is reached", async () => {
    const harness = await createHarness({
      config: {
        ...BASE_CONFIG,
        dedupeWindowMs: 60_000,
        maxRecentNotifications: 1,
      },
    })

    await harness.emit(
      "permission.asked",
      permissionAsked("p1", "webfetch", ["https://one.example"]),
    )
    await harness.emit(
      "permission.asked",
      permissionAsked("p2", "read", ["src/one.ts"]),
    )
    await harness.emit(
      "permission.asked",
      permissionAsked("p3", "webfetch", ["https://two.example"]),
    )

    expect(messagesOf(harness)).toEqual([
      "I need permission to do: network request: https://one.example",
      "I need permission to do: read: one.ts",
      "I need permission to do: network request: https://two.example",
    ])
  })

  it("clears the permission guard when the request is replied", async () => {
    const harness = await createHarness({
      config: { ...BASE_CONFIG, dedupeWindowMs: 1_000 },
    })
    const event = permissionAsked("p1", "webfetch", [
      "https://example.com",
    ])

    await harness.emit("permission.asked", event)
    await harness.emit("permission.replied", {
      sessionID: "main",
      requestID: "p1",
      reply: "once",
    })
    now += 1_000
    await harness.emit("permission.asked", event)

    expect(messagesOf(harness)).toEqual([
      "I need permission to do: network request: https://example.com",
      "I need permission to do: network request: https://example.com",
    ])
  })

  it("suppresses permission alerts when events.permission is false", async () => {
    const harness = await createHarness({
      config: { ...BASE_CONFIG, events: { permission: false } },
    })

    await harness.emit(
      "permission.asked",
      permissionAsked("p1", "shell", ["ls"]),
    )

    expect(messagesOf(harness)).toEqual([])
  })
})

describe("failed execution policy", () => {
  it("notifies the configured error message and suppresses the following completion", async () => {
    const harness = await createHarness()

    await failure(harness, "main", "kaboom")
    await completion(harness, "main")

    expect(messagesOf(harness)).toEqual([DEFAULT_ERROR_MESSAGE])
    expect(harness.toasts).toEqual([
      {
        sessionID: "main",
        title: "Session failed",
        message: "kaboom",
        variant: "error",
      },
    ])
  })

  it("uses a configured messages.error instead of the raw error text", async () => {
    const harness = await createHarness({
      config: {
        ...BASE_CONFIG,
        messages: { error: "Custom failure copy" },
      },
    })

    await failure(harness, "main", "raw provider detail")

    expect(messagesOf(harness)).toEqual(["Custom failure copy"])
    expect(harness.toasts.map((toast) => toast.message)).toEqual([
      "raw provider detail",
    ])
  })

  it("does not toast an empty error detail", async () => {
    const harness = await createHarness()

    await harness.emit("session.execution.failed", {
      sessionID: "main",
      error: { type: "unknown", message: "" },
    })

    expect(messagesOf(harness)).toEqual([DEFAULT_ERROR_MESSAGE])
    expect(harness.toasts).toEqual([])
  })

  it("does not notify twice for the same failed execution", async () => {
    const harness = await createHarness()

    await failure(harness, "main", "first")
    await failure(harness, "main", "second")

    expect(messagesOf(harness)).toEqual([DEFAULT_ERROR_MESSAGE])
  })

  it("suppresses both notification and toast when events.error is false", async () => {
    const harness = await createHarness({
      config: { ...BASE_CONFIG, events: { error: false } },
    })

    await failure(harness, "main", "kaboom")

    expect(messagesOf(harness)).toEqual([])
    expect(harness.toasts).toEqual([])
  })
})

describe("bounded lifecycle sets", () => {
  it("bounds the terminal guard so an evicted session can complete again", async () => {
    const harness = await createHarness({
      config: { ...BASE_CONFIG, maxRecentNotifications: 1 },
    })

    await completion(harness, "s1")
    await completion(harness, "s2")
    await completion(harness, "s1")

    expect(messagesOf(harness)).toEqual([
      "Task completed!",
      "Task completed!",
      "Task completed!",
    ])
  })

  it("bounds the subagent set so an evicted child is no longer suppressed", async () => {
    const harness = await createHarness({
      config: { ...BASE_CONFIG, maxRecentNotifications: 1 },
    })

    await harness.emit("session.created", {
      sessionID: "child-1",
      parentID: "parent",
    })
    await harness.emit("session.created", {
      sessionID: "child-2",
      parentID: "parent",
    })

    await completion(harness, "child-1")
    await completion(harness, "child-2")

    expect(messagesOf(harness)).toEqual(["Task completed!"])
  })

  it("bounds the form guard so an evicted form id can alert again", async () => {
    const harness = await createHarness({
      config: {
        ...BASE_CONFIG,
        dedupeWindowMs: 1_000,
        maxRecentNotifications: 1,
      },
    })

    await harness.emit("form.created", questionForm("q1"))
    await harness.emit("form.created", questionForm("q2"))
    now += 1_000
    await harness.emit("form.created", questionForm("q1"))

    // q2 is still deduped by the same-key check even though q1 was evicted from
    // the form map. After the window, the replayed q1 is no longer tracked.
    expect(messagesOf(harness)).toEqual([
      "I have a question for you!",
      "I have a question for you!",
    ])
  })

  it("dedupes a same-key repeat at maxRecentNotifications=1", async () => {
    const permissionHarness = await createHarness({
      config: {
        ...BASE_CONFIG,
        dedupeWindowMs: 60_000,
        maxRecentNotifications: 1,
      },
    })

    await permissionHarness.emit(
      "permission.asked",
      permissionAsked("p1", "shell", ["ls"]),
    )
    await permissionHarness.emit(
      "permission.asked",
      permissionAsked("p2", "shell", ["ls -la"]),
    )

    expect(messagesOf(permissionHarness)).toEqual([
      "I need permission to do: run: ls",
    ])

    const questionHarness = await createHarness({
      config: {
        ...BASE_CONFIG,
        dedupeWindowMs: 60_000,
        maxRecentNotifications: 1,
      },
    })

    await questionHarness.emit("form.created", questionForm("q1"))
    await questionHarness.emit("form.created", questionForm("q2"))

    expect(messagesOf(questionHarness)).toEqual([
      "I have a question for you!",
    ])
  })
})

describe("session.deleted id reuse", () => {
  it("clears form IDs owned by the deleted session", async () => {
    const harness = await createHarness({
      config: { ...BASE_CONFIG, dedupeWindowMs: 0 },
    })
    const event = questionForm("q1", "main")

    await harness.emit("form.created", event)
    await harness.emit("session.deleted", { sessionID: "main" })
    await harness.emit("form.created", event)

    expect(messagesOf(harness)).toEqual([
      "I have a question for you!",
      "I have a question for you!",
    ])
  })

  it("clears permission IDs owned by the deleted session", async () => {
    const harness = await createHarness({
      config: { ...BASE_CONFIG, dedupeWindowMs: 0 },
    })
    const event = permissionAsked("p1", "shell", ["ls"])
    event.sessionID = "main"

    await harness.emit("permission.asked", event)
    await harness.emit("session.deleted", { sessionID: "main" })
    await harness.emit("permission.asked", event)

    expect(messagesOf(harness)).toEqual([
      "I need permission to do: run: ls",
      "I need permission to do: run: ls",
    ])
  })

  it("only clears entries owned by the deleted session", async () => {
    const harness = await createHarness({
      config: { ...BASE_CONFIG, dedupeWindowMs: 0 },
    })

    await harness.emit("form.created", questionForm("q-main", "main"))
    await harness.emit("form.created", questionForm("q-other", "other"))
    await harness.emit("session.deleted", { sessionID: "main" })

    await harness.emit("form.created", questionForm("q-main", "main"))
    await harness.emit("form.created", questionForm("q-other", "other"))

    // q-other is still tracked, so only its first alert is emitted.
    expect(messagesOf(harness)).toEqual([
      "I have a question for you!",
      "I have a question for you!",
      "I have a question for you!",
    ])
  })
})

describe("renderer focus changes during a pending detector", () => {
  it("suppresses when focus arrives while the detector would say not-focused", async () => {
    const harness = await createHarness({
      focused: false,
      deferCommands: true,
    })

    const pending = harness.dispatch(
      "form.created",
      questionForm("q-pending-focus"),
    )

    await waitFor(() => harness.pendingCommandCount() === 1)
    harness.emitRenderer("focus")
    harness.releaseCommands()
    await pending

    expect(messagesOf(harness)).toEqual([])
  })

  it("allows notification when blur arrives while the detector would say focused", async () => {
    const harness = await createHarness({
      focused: true,
      deferCommands: true,
    })

    const pending = harness.dispatch(
      "form.created",
      questionForm("q-pending-blur"),
    )

    await waitFor(() => harness.pendingCommandCount() === 1)
    harness.emitRenderer("blur")
    harness.releaseCommands()
    await pending

    expect(messagesOf(harness)).toEqual(["I have a question for you!"])
  })
})

describe("renderer focus policy", () => {
  it("renderer focus suppresses even when the OS detector says unfocused", async () => {
    const harness = await createHarness({ focused: false })
    harness.emitRenderer("focus")

    await completion(harness, "main")

    expect(messagesOf(harness)).toEqual([])
  })

  it("renderer blur overrides a stale focused OS detector", async () => {
    const harness = await createHarness({ focused: true })
    harness.emitRenderer("blur")

    await completion(harness, "main")

    expect(messagesOf(harness)).toEqual(["Task completed!"])
  })

  it("uses the OS fallback while renderer focus is unknown", async () => {
    const focusedHarness = await createHarness({ focused: true })
    await completion(focusedHarness, "main")
    expect(messagesOf(focusedHarness)).toEqual([])

    const unfocusedHarness = await createHarness({ focused: false })
    await completion(unfocusedHarness, "main")
    expect(messagesOf(unfocusedHarness)).toEqual(["Task completed!"])
  })

  it("removes renderer focus listeners on dispose", async () => {
    const harness = await createHarness()

    expect([...harness.rendererListeners.keys()].sort()).toEqual([
      "blur",
      "focus",
    ])

    harness.dispose()

    expect(harness.rendererOffCalls.sort()).toEqual(["blur", "focus"])
    expect(harness.rendererListeners.size).toBe(0)
  })

  it("unsubscribes every data handler on dispose", async () => {
    const harness = await createHarness()
    const registered = harness.handlers.size

    expect(registered).toBe(11)

    harness.dispose()

    expect(harness.unsubscribed).toHaveLength(registered)
    expect(harness.handlers.size).toBe(0)
    expect(new Set(harness.unsubscribed).size).toBe(registered)
  })

  it("stops notifying after dispose", async () => {
    const harness = await createHarness()
    await completion(harness, "one")
    harness.dispose()

    await expect(completion(harness, "two")).rejects.toThrow(
      "No handler registered",
    )
    expect(messagesOf(harness)).toEqual(["Task completed!"])
  })
})

describe("sound path resolution", () => {
  const soundPlayed = (harness: Harness): string | undefined =>
    harness.execCalls.find(
      (call) => call.file === "afplay" || call.file === "paplay",
    )?.args[0]

  it("plays an existing absolute path as-is", async () => {
    const absolute = "/Users/assert-ape/custom/alert.aiff"
    const harness = await createHarness({
      config: {
        ...BASE_CONFIG,
        soundEnabled: true,
        sounds: { idle: absolute },
      },
      existingPaths: [absolute],
    })

    await completion(harness, "main")

    expect(messagesOf(harness)).toEqual(["Task completed!"])
    expect(soundPlayed(harness)).toBe(absolute)
  })

  it("expands ~/ to the home directory before playing", async () => {
    const expanded = `${FAKE_HOME}/Sounds/chime.aiff`
    const harness = await createHarness({
      config: {
        ...BASE_CONFIG,
        soundEnabled: true,
        sounds: { idle: "~/Sounds/chime.aiff" },
      },
      existingPaths: [expanded],
    })

    await completion(harness, "main")

    expect(soundPlayed(harness)).toBe(expanded)
  })

  it("falls back to the basename stem when a configured path is missing", async () => {
    const harness = await createHarness({
      config: {
        ...BASE_CONFIG,
        soundEnabled: true,
        sounds: { idle: "/missing/custom/Funk.aiff" },
      },
      existingPaths: ["/System/Library/Sounds/Funk.aiff"],
    })

    await completion(harness, "main")

    expect(soundPlayed(harness)).toBe("/System/Library/Sounds/Funk.aiff")
  })
})

describe("async teardown", () => {
  it("does not notify or play sound when disposed while awaiting focus detection", async () => {
    const soundPath = `${FAKE_HOME}/custom/question.aiff`
    const harness = await createHarness({
      config: {
        ...BASE_CONFIG,
        soundEnabled: true,
        sounds: { question: soundPath },
      },
      existingPaths: [soundPath],
      deferCommands: true,
    })

    const question = harness.dispatch(
      "form.created",
      questionForm("q-pending"),
    )
    const permission = harness.dispatch(
      "permission.asked",
      permissionAsked("p-pending", "shell", ["ls"]),
    )

    await waitFor(() => harness.pendingCommandCount() === 2)

    harness.dispose()
    harness.releaseCommands()
    await Promise.all([question, permission])

    expect(messagesOf(harness)).toEqual([])
    expect(audioCalls(harness)).toEqual([])
  })
})

describe("best-effort renderer and teardown", () => {
  it("swallows a throwing renderer trigger", async () => {
    const harness = await createHarness({
      rendererThrows: { trigger: true },
    })

    await expect(completion(harness, "main")).resolves.toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(messagesOf(harness)).toEqual([])
  })

  it("continues setup when renderer focus subscription throws", async () => {
    const harness = await createHarness({
      rendererThrows: { on: true },
    })

    expect(harness.rendererListeners.size).toBe(0)

    await completion(harness, "main")

    expect(messagesOf(harness)).toEqual(["Task completed!"])
  })

  it("continues teardown when renderer off and unsubscribers throw", async () => {
    const harness = await createHarness({
      rendererThrows: { off: true },
      throwingUnsubscribers: ["form.created", "permission.asked"],
    })
    const registered = harness.handlers.size

    expect(() => harness.dispose()).not.toThrow()

    expect(harness.unsubscribed).toHaveLength(registered)
    expect(harness.handlers.size).toBe(0)
  })
})

describe("v2 adapter remaining event mappings", () => {
  it("maps execution.interrupted to completion", async () => {
    const harness = await createHarness()

    await harness.emit("session.execution.interrupted", { sessionID: "main" })

    expect(messagesOf(harness)).toEqual(["Task completed!"])
  })

  it("maps form.cancelled so the form id can alert again", async () => {
    const harness = await createHarness({
      config: { ...BASE_CONFIG, dedupeWindowMs: 0 },
    })

    await harness.emit("form.created", questionForm("q1"))
    await harness.emit("form.cancelled", { id: "q1", sessionID: "main" })
    await harness.emit("form.created", questionForm("q1"))

    expect(messagesOf(harness)).toEqual([
      "I have a question for you!",
      "I have a question for you!",
    ])
  })
})

describe("v2 adapter partial setup failure", () => {
  it("cleans up earlier subscriptions and focus listeners when registration throws", async () => {
    const harness = await createHarness({
      failingDataRegistration: "form.created",
    })

    expect(harness.setupError).toBeDefined()
    expect(harness.handlers.size).toBe(0)
    expect([...harness.unsubscribed].sort()).toEqual([
      "session.created",
      "session.deleted",
    ])
    expect(harness.rendererListeners.size).toBe(0)
    expect([...harness.rendererOffCalls].sort()).toEqual(["blur", "focus"])
    expect(harness.notifications).toEqual([])
    expect(harness.toasts).toEqual([])
    expect(
      harness.execCalls.filter(
        (call) => call.file === "afplay" || call.file === "paplay",
      ),
    ).toEqual([])
  })
})

describe("v2 adapter error disposal race", () => {
  it("suppresses notification, sound and toast when disposed before deferred focus resolves", async () => {
    const soundPath = `${FAKE_HOME}/custom/error.aiff`
    const harness = await createHarness({
      config: {
        ...BASE_CONFIG,
        soundEnabled: true,
        sounds: { error: soundPath },
      },
      existingPaths: [soundPath],
      deferCommands: true,
    })

    const pendingError = harness.dispatch("session.execution.failed", {
      sessionID: "main",
      error: { type: "api", message: "boom" },
    })

    await waitFor(() => harness.pendingCommandCount() === 1)

    harness.dispose()
    harness.releaseCommands()
    await pendingError

    expect(messagesOf(harness)).toEqual([])
    expect(harness.toasts).toEqual([])
    expect(
      harness.execCalls.filter(
        (call) => call.file === "afplay" || call.file === "paplay",
      ),
    ).toEqual([])
  })
})
