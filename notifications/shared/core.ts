/**
 * Shared notification policy and delivery core.
 *
 * Both TUI adapters normalize their generation-specific events into the
 * methods below. Everything that decides *whether* to notify (focus, event
 * toggles, per-session guards, dedupe windows, bounded sets) and *how* to
 * deliver (renderer bubble + platform sound) lives here, so the two adapters
 * stay behaviorally equivalent.
 *
 * No v1/v2 host API is imported in this module; the renderer, focus tracker
 * and toast sink are injected.
 */
import { toPermissionSummary } from "./permission"
import { playSound, resolveSoundPath } from "./sound"
import type {
  EventKey,
  FocusTracker,
  NotificationRenderer,
  NotificationsConfig,
  PermissionSummaryInput,
  ToastInput,
} from "./types"

export interface NotificationCoreOptions {
  config: NotificationsConfig
  renderer: NotificationRenderer
  focus: FocusTracker
  /** Show a best-effort error toast with the raw failure detail. */
  toast?: (input: ToastInput) => void
  /** Parent lookup for sessions not seen via `session.created`. */
  getSessionParent?: (sessionID: string) => string | undefined
}

export interface NotificationCore {
  /** A new execution started; clears the completion/error guards. */
  started(sessionID: string): void
  /** Execution succeeded or was interrupted. */
  ended(sessionID: string): Promise<void>
  /** Execution failed. `detail` is toast-only, never notification copy. */
  failed(sessionID: string, detail: string): Promise<void>
  /** A question form/request appeared. */
  questionAsked(formID: string, sessionID: string): Promise<void>
  /** A question was answered or rejected. */
  questionResolved(formID: string): void
  /** A permission request appeared. */
  permissionAsked(
    permissionID: string,
    sessionID: string,
    data: PermissionSummaryInput,
  ): Promise<void>
  /** A permission request was answered. */
  permissionResolved(requestID: string): void
  /** Track a child session so its completion/idle is suppressed. */
  sessionCreated(sessionID: string, parentID?: string): void
  /** Drop every guard owned by the deleted session. */
  sessionDeleted(sessionID: string): void
  /** Stop all side effects. Unsubscribe from host events separately. */
  dispose(): void
}

const logHandlerError = (scope: string, err: unknown): void => {
  const detail = err instanceof Error ? err.message : String(err)
  console.warn(`[NotificationsPlugin] ${scope} handler failed: ${detail}`)
}

export const createNotificationCore = (
  options: NotificationCoreOptions,
): NotificationCore => {
  const { config, renderer, focus, toast, getSessionParent } = options

  // Set by dispose(). Async handlers may still be awaiting a focus probe when
  // the plugin is torn down; every side effect checks this flag so a pending
  // handler can never notify or play a sound after disposal.
  let disposed = false

  const recentNotifications = new Map<string, number>()

  const shouldNotify = (key: string): boolean => {
    const now = Date.now()
    const windowMs = config.dedupeWindowMs
    const maxEntries = config.maxRecentNotifications

    // Drop expired entries first so capacity only counts live keys.
    const expiredKeys: string[] = []
    for (const [candidate, timestamp] of recentNotifications) {
      if (now - timestamp >= windowMs) expiredKeys.push(candidate)
    }
    for (const candidate of expiredKeys) recentNotifications.delete(candidate)

    // Check the incoming key BEFORE evicting: at capacity, evicting first
    // would delete the very key we are trying to dedupe and let a repeat
    // through (e.g. maxRecentNotifications: 1).
    const last = recentNotifications.get(key)
    if (last !== undefined && now - last < windowMs) return false

    // Make room only after the repeat check. The map order is insertion
    // order, so the oldest live entries are removed first.
    if (recentNotifications.size >= maxEntries) {
      const sorted = [...recentNotifications.entries()].sort((a, b) => a[1] - b[1])
      const toRemove = sorted.slice(0, recentNotifications.size - maxEntries + 1)
      for (const [candidate] of toRemove) recentNotifications.delete(candidate)
    }

    recentNotifications.set(key, now)
    return true
  }

  const deliver = async (message: string, key: EventKey): Promise<void> => {
    if (disposed) return

    try {
      renderer.triggerNotification(message, "OpenCode")
    } catch (err: unknown) {
      // A destroyed renderer must never break the event pipeline. The handler
      // is best-effort: log while the plugin is alive and move on.
      if (!disposed) {
        const detail = err instanceof Error ? err.message : String(err)
        console.warn(`[NotificationsPlugin] Failed to show notification: ${detail}`)
      }
      return
    }

    if (disposed || !config.soundEnabled) return
    const soundPath = resolveSoundPath(config.sounds[key])
    // Disposal may have happened while resolving the sound path.
    if (disposed || !soundPath) return
    await playSound(soundPath)
  }

  const notify = async (message: string, key: EventKey): Promise<void> => {
    if (disposed || !config.events[key]) return
    if (await focus.isTerminalFocused()) return
    // The focus probe is async; the plugin may have been disposed meanwhile.
    if (disposed) return
    await deliver(message, key)
  }

  const errored = new Set<string>()
  const terminal = new Set<string>()
  // Track form/permission dedupe IDs together with the session that owns them
  // so `sessionDeleted` can clear every entry for that session.
  const forms = new Map<string, string>()
  const permissions = new Map<string, string>()
  const subagents = new Set<string>()

  const trimSet = (set: Set<string>): void => {
    while (set.size > config.maxRecentNotifications) {
      const oldest = set.values().next().value
      if (oldest === undefined) break
      set.delete(oldest)
    }
  }

  const trimMap = (map: Map<string, string>): void => {
    while (map.size > config.maxRecentNotifications) {
      const oldest = map.keys().next().value
      if (oldest === undefined) break
      map.delete(oldest)
    }
  }

  const clearSessionEntries = (map: Map<string, string>, sessionID: string): void => {
    for (const [id, ownerSessionID] of map) {
      if (ownerSessionID === sessionID) map.delete(id)
    }
  }

  const isSubagent = (sessionID: string): boolean => {
    if (subagents.has(sessionID)) return true
    return getSessionParent?.(sessionID) !== undefined
  }

  const started = (sessionID: string): void => {
    errored.delete(sessionID)
    terminal.delete(sessionID)
  }

  const ended = async (sessionID: string): Promise<void> => {
    if (disposed) return
    try {
      if (terminal.has(sessionID)) return
      terminal.add(sessionID)
      trimSet(terminal)
      if (errored.has(sessionID)) {
        errored.delete(sessionID)
        return
      }
      // Subagents only suppress completion/idle. Their errors, questions and
      // permissions still notify.
      if (isSubagent(sessionID)) return
      await notify(config.messages.idle, "idle")
    } catch (err: unknown) {
      logHandlerError("completion", err)
    }
  }

  const failed = async (sessionID: string, detail: string): Promise<void> => {
    if (disposed) return
    try {
      if (terminal.has(sessionID)) return
      errored.add(sessionID)
      trimSet(errored)
      // The configured message is notification copy; the raw error text is
      // detail and only appears in the toast.
      await notify(config.messages.error, "error")
      // notify() awaits the focus probe, so teardown may have happened while
      // this handler was suspended. Never toast after disposal.
      if (!disposed && config.events.error && detail) {
        try {
          toast?.({
            sessionID,
            title: "Session failed",
            message: detail,
            variant: "error",
          })
        } catch {
          // Toasting is best-effort; the notification path must still work.
        }
      }
      await ended(sessionID)
    } catch (err: unknown) {
      logHandlerError("error", err)
    }
  }

  const questionAsked = async (formID: string, sessionID: string): Promise<void> => {
    try {
      // Per-form dedupe is independent of delivery: track the form before any
      // focus/rate-limit check so a focused form is still never alerted twice,
      // and cleanup still works on reply/cancel/session delete.
      if (forms.has(formID)) return
      forms.set(formID, sessionID)
      trimMap(forms)
      if (disposed || !config.events.question) return
      // A focused terminal must not consume the shared question rate-limit key,
      // otherwise the next distinct form while unfocused is swallowed.
      if (await focus.isTerminalFocused()) return
      if (disposed || !shouldNotify("question")) return
      await deliver(config.messages.question, "question")
    } catch (err: unknown) {
      logHandlerError("question", err)
    }
  }

  const questionResolved = (formID: string): void => {
    forms.delete(formID)
  }

  const permissionAsked = async (
    permissionID: string,
    sessionID: string,
    data: PermissionSummaryInput,
  ): Promise<void> => {
    try {
      if (disposed || !config.events.permission) return
      if (permissions.has(permissionID)) return
      permissions.set(permissionID, sessionID)
      trimMap(permissions)
      const action = data.action ?? "unknown"
      if (await focus.isTerminalFocused()) return
      if (disposed || !shouldNotify(`permission:${action}`)) return
      const summary = toPermissionSummary(data)
      const message = config.messages.permission.replace("{summary}", summary)
      await deliver(message, "permission")
    } catch (err: unknown) {
      logHandlerError("permission", err)
    }
  }

  const permissionResolved = (requestID: string): void => {
    permissions.delete(requestID)
  }

  const sessionCreated = (sessionID: string, parentID?: string): void => {
    if (parentID === undefined) return
    subagents.add(sessionID)
    trimSet(subagents)
  }

  const sessionDeleted = (sessionID: string): void => {
    subagents.delete(sessionID)
    errored.delete(sessionID)
    terminal.delete(sessionID)
    clearSessionEntries(forms, sessionID)
    clearSessionEntries(permissions, sessionID)
  }

  const dispose = (): void => {
    // Flip the guard first so an in-flight async handler that resumes during or
    // after teardown cannot notify or play a sound.
    disposed = true
  }

  return {
    started,
    ended,
    failed,
    questionAsked,
    questionResolved,
    permissionAsked,
    permissionResolved,
    sessionCreated,
    sessionDeleted,
    dispose,
  }
}
