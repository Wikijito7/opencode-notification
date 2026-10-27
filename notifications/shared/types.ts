/**
 * Shared notification types.
 *
 * This module is deliberately host-agnostic: it imports no v1 or v2 OpenCode
 * API. Both TUI adapters (`/notifications.tsx` for v1 and
 * `/notifications/tui.tsx` for v2) normalize their host events into these
 * shapes and hand them to the shared policy core.
 */

export interface NotificationEventConfig {
  idle: boolean
  error: boolean
  permission: boolean
  question: boolean
}

export interface SoundConfig {
  idle: string
  error: string
  permission: string
  question: string
}

export interface MessageConfig {
  idle: string
  error: string
  permission: string
  question: string
}

export interface NotificationsConfig {
  terminalProcessName: string | null
  soundEnabled: boolean
  events: NotificationEventConfig
  sounds: SoundConfig
  messages: MessageConfig
  dedupeWindowMs: number
  maxRecentNotifications: number
}

export type EventKey = keyof NotificationEventConfig

export type DeepPartial<T> = {
  [Key in keyof T]?: T[Key] extends object ? DeepPartial<T[Key]> : T[Key]
}

/** Normalized permission request used by the shared summary formatter. */
export interface PermissionSummaryInput {
  action?: string
  resources?: string[]
  metadata?: Record<string, unknown>
  message?: string
}

/** Normalized error toast. v2 forwards `sessionID`; v1 drops it. */
export interface ToastInput {
  sessionID?: string
  title: string
  message: string
  variant: "error"
}

/**
 * The minimum renderer surface the core needs. Both generations expose
 * `triggerNotification` on their renderer.
 */
export interface NotificationRenderer {
  triggerNotification(message: string, title?: string): boolean | void
}

export interface FocusRenderer {
  on?(event: "focus" | "blur", listener: () => void): unknown
  off?(event: "focus" | "blur", listener: () => void): unknown
}

export interface FocusTracker {
  isTerminalFocused(): Promise<boolean>
  dispose(): void
}
