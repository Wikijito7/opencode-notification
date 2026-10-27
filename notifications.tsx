/**
 * notifications — OpenCode v1 TUI adapter (`@opencode-ai/plugin/tui`).
 *
 * Registered through v1 `tui.json` as `./plugins/notifications.tsx`. The v2 TUI
 * adapter is the `notifications/` directory (`notifications/tui.tsx`); this
 * flat root file is a loose `.tsx` entry, which v2's directory-only TUI
 * discovery never loads. The archived v1 **server** plugin under `legacy/v1/`
 * is reference-only and must not be loaded.
 *
 * All policy, config parsing, permission summaries, focus detection, sound
 * playback and dedupe live in `notifications/shared/`. This file only
 * normalizes the v1 event surface:
 *   - `session.status` (`busy`/`retry`) → execution started (clears guards)
 *   - `session.status` (`idle`) → completion
 *   - `session.error` → error copy + optional detail toast
 *   - `question.asked` / `replied` / `rejected`
 *   - `permission.asked` / `permission.replied`
 *   - `session.created` / `session.updated` / `session.deleted`
 *   - renderer focus/blur + lifecycle disposal
 *
 * v1.19 publishes `session.created` and `session.updated` with
 * `properties.info.parentID`, and exposes the live session state through
 * `api.state.session.get(sessionID)?.parentID`. Both are used to classify
 * subagent sessions: the event is tracked eagerly, and the state lookup is the
 * fallback for sessions created before the plugin was registered.
 *
 * Desktop bubbles use `api.renderer.triggerNotification`, the same terminal
 * notification primitive as v2. The v1 built-in notification plugin
 * (`internal:notifications`) should be disabled in `tui.json` so nothing
 * double-fires.
 */
import { fileURLToPath } from "node:url"
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { loadConfig } from "./notifications/shared/config"
import { createNotificationCore } from "./notifications/shared/core"
import { createFocusTracker } from "./notifications/shared/focus"
import { isSupported, PLATFORM } from "./notifications/shared/platform"
import type {
  FocusRenderer,
  NotificationRenderer,
  PermissionSummaryInput,
  ToastInput,
} from "./notifications/shared/types"

interface V1Event<Properties> {
  properties: Properties
}

interface V1PermissionRequest {
  id: string
  sessionID: string
  permission: string
  patterns?: string[]
  metadata?: Record<string, unknown>
  message?: string
}

interface V1QuestionRequest {
  id: string
  sessionID: string
}

/**
 * v1.19.0 publishes each execution's state as `session.status`: `busy` and
 * `retry` when work begins, `idle` when it settles. Older `session.idle`
 * events are also published, so it is deliberately *not* handled separately —
 * mapping both would double-fire completion. The shared core permits a first
 * `idle` even without a preceding busy/retry (a session that was already idle
 * still notifies); only duplicate `idle`s after a completion are suppressed
 * by the terminal guard, which a new busy/retry clears.
 */
interface V1SessionStatus {
  type: string
  [key: string]: unknown
}

interface V1EventMap {
  "session.status": V1Event<{
    sessionID: string
    status?: V1SessionStatus
  }>
  "session.error": V1Event<{
    sessionID?: string
    error?: unknown
  }>
  "question.asked": V1Event<V1QuestionRequest>
  "question.replied": V1Event<{ sessionID: string; requestID: string }>
  "question.rejected": V1Event<{ sessionID: string; requestID: string }>
  "permission.asked": V1Event<V1PermissionRequest>
  "permission.replied": V1Event<{ sessionID: string; requestID: string }>
  "session.created": V1Event<{
    sessionID: string
    info?: { parentID?: string }
  }>
  "session.updated": V1Event<{
    sessionID: string
    info?: { parentID?: string }
  }>
  "session.deleted": V1Event<{ sessionID: string }>
}

interface V1SessionState {
  parentID?: string
}

/**
 * The subset of the v1 TUI API this adapter uses. Typed structurally so the
 * file stays readable even if the host's (version-drifting) types change.
 */
interface V1TuiApi {
  /**
   * Live session state. Optional because older hosts may not expose it; when
   * absent, subagent classification falls back to the session events alone.
   */
  state?: {
    session?: {
      get?: (sessionID: string) => V1SessionState | undefined
    }
  }
  event: {
    on<Type extends keyof V1EventMap>(
      type: Type,
      handler: (event: V1EventMap[Type]) => void,
    ): () => void
  }
  renderer: NotificationRenderer & FocusRenderer
  ui?: {
    toast?: (input: { variant?: "info" | "success" | "warning" | "error"; title?: string; message: string; duration?: number }) => void
  }
  lifecycle?: {
    onDispose(dispose: () => void | Promise<void>): () => void
  }
}

const asString = (value: unknown): string => (typeof value === "string" ? value : "")

/** v1 errors carry `message` directly or nested under `data.message`. */
const errorDetail = (error: unknown): string => {
  if (!error || typeof error !== "object") return ""
  const record = error as Record<string, unknown>
  const direct = asString(record.message)
  if (direct) return direct
  const data = record.data
  if (data && typeof data === "object") {
    return asString((data as Record<string, unknown>).message)
  }
  return ""
}

const normalizePermission = (
  request: V1PermissionRequest,
): PermissionSummaryInput => ({
  action: request.permission,
  resources: Array.isArray(request.patterns) ? request.patterns : [],
  metadata: request.metadata,
  message: request.message,
})

const tui: TuiPlugin = async (rawApi) => {
  const api = rawApi as unknown as V1TuiApi

  if (!isSupported) {
    console.warn(
      `[NotificationsPlugin] Platform "${PLATFORM}" is not supported; notifications disabled.`,
    )
    return
  }

  const configPath = fileURLToPath(
    new URL("./notifications/notifications.config.jsonc", import.meta.url),
  )
  const config = loadConfig(configPath)

  const focus = await createFocusTracker({ renderer: api.renderer, config })
  const core = createNotificationCore({
    config,
    renderer: api.renderer,
    focus,
    // v1 has no sessionID on toasts; drop the field rather than pass unknown
    // keys to the host.
    toast: api.ui?.toast
      ? (input: ToastInput) => {
          api.ui?.toast?.({
            title: input.title,
            message: input.message,
            variant: input.variant,
          })
        }
      : undefined,
    // Fallback for sessions whose `session.created` event fired before this
    // plugin was registered (or was otherwise missed).
    getSessionParent: (sessionID) =>
      api.state?.session?.get?.(sessionID)?.parentID,
  })

  const disposers: Array<() => void> = []

  const on = <Type extends keyof V1EventMap>(
    type: Type,
    handler: (event: V1EventMap[Type]) => void,
  ): void => {
    disposers.push(api.event.on(type, handler))
  }

  const releaseEvents = (): void => {
    // Unsubscribe in reverse order and never let one failing cleanup abort the
    // rest: partial registration must not leak handlers.
    for (const cleanup of [...disposers].reverse()) {
      try {
        cleanup()
      } catch {
        // Best-effort cleanup.
      }
    }
    disposers.length = 0
  }

  const dispose = (): void => {
    // Flip the core guard before unsubscribing so an in-flight async handler
    // that resumes during/after teardown cannot notify or play a sound.
    core.dispose()
    releaseEvents()
    focus.dispose()
  }

  try {
    on("session.created", (event) => {
      core.sessionCreated(event.properties.sessionID, event.properties.info?.parentID)
    })
    on("session.updated", (event) => {
      // An update can promote a session the plugin has not classified yet to a
      // child (e.g. it is attached to a parent later). Classification is
      // additive only: a session is never demoted back to a parent, and an
      // update without a parentID leaves the existing classification alone.
      core.sessionCreated(event.properties.sessionID, event.properties.info?.parentID)
    })
    on("session.deleted", (event) => {
      core.sessionDeleted(event.properties.sessionID)
    })
    on("session.status", (event) => {
      const sessionID = event.properties.sessionID
      if (!sessionID) return
      const type = event.properties.status?.type
      // busy/retry begin an execution: clear the shared per-session
      // completion/error guards so a later idle for this session notifies.
      if (type === "busy" || type === "retry") {
        core.started(sessionID)
        return
      }
      if (type === "idle") {
        void core.ended(sessionID)
      }
    })
    on("session.error", (event) => {
      const sessionID = event.properties.sessionID ?? ""
      void core.failed(sessionID, errorDetail(event.properties.error))
    })
    on("question.asked", (event) => {
      void core.questionAsked(event.properties.id, event.properties.sessionID)
    })
    on("question.replied", (event) => {
      core.questionResolved(event.properties.requestID)
    })
    on("question.rejected", (event) => {
      core.questionResolved(event.properties.requestID)
    })
    on("permission.asked", (event) => {
      void core.permissionAsked(
        event.properties.id,
        event.properties.sessionID,
        normalizePermission(event.properties),
      )
    })
    on("permission.replied", (event) => {
      core.permissionResolved(event.properties.requestID)
    })
  } catch (error) {
    // A later registration failed before lifecycle disposal could be wired:
    // roll back every handler and renderer listener installed so far, then
    // rethrow rather than leave a half-registered plugin behind.
    core.dispose()
    releaseEvents()
    focus.dispose()
    throw error
  }

  try {
    api.lifecycle?.onDispose?.(dispose)
  } catch {
    // If lifecycle registration is unavailable, dispose immediately rather
    // than leave listeners behind.
    dispose()
  }
}

const plugin: TuiPluginModule & { id: string } = {
  id: "notifications",
  tui,
}

export default plugin
