/**
 * Isolated Bun harness for the v2 notifications TUI adapter.
 *
 * All process-wide mocks live in `runtime-mocks.ts` (Bun module mocks are
 * global to the test process). This harness adds the v2 host surface: captured
 * renderer/toast calls, data-event handlers, renderer focus listeners and
 * configurable failure modes.
 */
import {
  execCalls,
  FAKE_HOME,
  pendingCommandCount,
  releaseCommands,
  resetRuntime,
  type ExecCall,
} from "./runtime-mocks"

export { FAKE_HOME }
export type CommandCall = ExecCall

export interface CapturedNotification {
  message: string
  title: string
}

export interface CapturedToast {
  sessionID?: string
  title?: string
  message?: string
  variant?: string
}

export interface HarnessOptions {
  /** Raw JSONC text, an object (serialized to JSON), or `null` for no config file. */
  config?: string | Record<string, unknown> | null
  /** Simulates the terminal being frontmost (osascript returns "true"). */
  focused?: boolean
  /** Extra filesystem paths that should report as existing. */
  existingPaths?: string[]
  /** Hold child-process callbacks until `releaseCommands()` is called. */
  deferCommands?: boolean
  /** Make renderer methods throw, modelling a destroyed renderer. */
  rendererThrows?: {
    trigger?: boolean
    on?: boolean
    off?: boolean
  }
  /** Handler names whose returned unsubscribe function throws. */
  throwingUnsubscribers?: string[]
  /** Event name whose registration throws, modelling a partially wired host. */
  failingDataRegistration?: string
}

const pluginModule = (await import("../notifications/tui.tsx")) as {
  default: any
}

export const pluginDefinition = pluginModule.default

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

export const BASE_CONFIG = {
  terminalProcessName: "TestTerminal",
  soundEnabled: false,
}

export interface Harness {
  notifications: CapturedNotification[]
  toasts: CapturedToast[]
  handlers: Map<string, (event: unknown) => unknown>
  unsubscribed: string[]
  sessions: Map<string, { parentID?: string }>
  execCalls: ExecCall[]
  rendererListeners: Map<string, () => void>
  rendererOffCalls: string[]
  emit: (name: string, data: unknown) => Promise<void>
  dispatch: (name: string, data: unknown) => Promise<void>
  emitRenderer: (event: "focus" | "blur") => void
  pendingCommandCount: () => number
  releaseCommands: () => void
  dispose: () => void
  setupError: unknown
}

export const createHarness = async (
  options: HarnessOptions = {},
): Promise<Harness> => {
  const config = options.config === undefined ? BASE_CONFIG : options.config
  resetRuntime({
    config,
    focused: options.focused,
    existingPaths: options.existingPaths,
    deferCommands: options.deferCommands,
  })

  const throwingUnsubscribers = new Set(options.throwingUnsubscribers ?? [])
  const notifications: CapturedNotification[] = []
  const toasts: CapturedToast[] = []
  const handlers = new Map<string, (event: unknown) => unknown>()
  const unsubscribed: string[] = []
  const sessions = new Map<string, { parentID?: string }>()
  const rendererListeners = new Map<string, () => void>()
  const rendererOffCalls: string[] = []

  const context = {
    renderer: {
      triggerNotification: (message: string, title: string): void => {
        if (options.rendererThrows?.trigger) {
          throw new Error("renderer destroyed")
        }
        notifications.push({ message, title })
      },
      on: (event: string, listener: () => void): void => {
        if (options.rendererThrows?.on) {
          throw new Error("renderer subscribe failed")
        }
        rendererListeners.set(event, listener)
      },
      off: (event: string, listener: () => void): void => {
        rendererOffCalls.push(event)
        if (options.rendererThrows?.off) {
          throw new Error("renderer unsubscribe failed")
        }
        if (rendererListeners.get(event) === listener) {
          rendererListeners.delete(event)
        }
      },
    },
    ui: {
      toast: {
        show: (toast: CapturedToast): void => {
          toasts.push(toast)
        },
      },
    },
    data: {
      session: {
        get: (sessionID: string) => sessions.get(sessionID),
      },
      on: (name: string, handler: (event: unknown) => unknown): (() => void) => {
        if (name === options.failingDataRegistration) {
          throw new Error(`registration failed for ${name}`)
        }
        handlers.set(name, handler)
        return (): void => {
          handlers.delete(name)
          unsubscribed.push(name)
          if (throwingUnsubscribers.has(name)) {
            throw new Error(`unsubscribe failed for ${name}`)
          }
        }
      },
    },
  }

  let dispose = (): void => {}
  let setupError: unknown
  try {
    dispose = (await pluginDefinition.setup(context)) as () => void
  } catch (error) {
    setupError = error
  }

  return {
    notifications,
    toasts,
    handlers,
    unsubscribed,
    sessions,
    execCalls,
    rendererListeners,
    rendererOffCalls,
    dispose,
    emit: async (name: string, data: unknown): Promise<void> => {
      const handler = handlers.get(name)
      if (!handler) throw new Error(`No handler registered for "${name}"`)
      await handler({ data })
      await flush()
    },
    dispatch: (name: string, data: unknown): Promise<void> => {
      const handler = handlers.get(name)
      if (!handler) throw new Error(`No handler registered for "${name}"`)
      return Promise.resolve(handler({ data })).then(() => undefined)
    },
    emitRenderer: (event: "focus" | "blur"): void => {
      rendererListeners.get(event)?.()
    },
    pendingCommandCount,
    releaseCommands,
    setupError,
  }
}

export const messagesOf = (harness: Harness): string[] =>
  harness.notifications.map((notification) => notification.message)
