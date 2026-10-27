/**
 * Shared terminal-focus detection.
 *
 * Focus suppression prefers the terminal's own focus/blur reporting (reliable
 * on Wayland/KDE) and falls back to the platform detectors, failing open when
 * focus cannot be determined. The renderer is passed in structurally so this
 * module stays independent of both host API generations.
 */
import { readFileSync } from "node:fs"
import { isLinux, isMacOS, runCommand, safe } from "./platform"
import type { FocusRenderer, FocusTracker, NotificationsConfig } from "./types"

type TerminalProcessMap = Record<string, string | null>

const MACOS_TERMINAL_PROCESS_NAMES: TerminalProcessMap = {
  ghostty: "Ghostty",
  kitty: "kitty",
  iterm: "iTerm2",
  iterm2: "iTerm2",
  wezterm: "WezTerm",
  alacritty: "Alacritty",
  terminal: "Terminal",
  apple_terminal: "Terminal",
  hyper: "Hyper",
  warp: "Warp",
  vscode: "Code",
  "vscode-insiders": "Code - Insiders",
}

const LINUX_TERMINAL_PROCESS_NAMES: TerminalProcessMap = {
  ghostty: "ghostty",
  kitty: "kitty",
  iterm: null,
  iterm2: null,
  wezterm: "wezterm-gui",
  alacritty: "alacritty",
  terminal: null,
  apple_terminal: null,
  hyper: "hyper",
  warp: null,
  vscode: "code",
  "vscode-insiders": "code-insiders",
}

const detectTerminalViaPsMacOS = async (): Promise<string | null> => {
  const knownNames = new Set(
    Object.values(MACOS_TERMINAL_PROCESS_NAMES).filter((value): value is string => value !== null),
  )
  let pid = process.ppid
  while (pid && pid > 1) {
    const output = await runCommand(["ps", "-o", "comm=,ppid=", "-p", String(pid)])
    if (!output) break
    const parts = output.split(/\s+/)
    const comm = parts[0]
    const ppid = parseInt(parts[1])
    if (knownNames.has(comm)) return comm
    if (!ppid || ppid === pid) break
    pid = ppid
  }
  return null
}

const detectTerminalViaProcLinux = async (): Promise<string | null> => {
  const knownNames = new Set(
    Object.values(LINUX_TERMINAL_PROCESS_NAMES).filter((value): value is string => value !== null),
  )
  let pid = process.ppid
  while (pid && pid > 1) {
    try {
      const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim()
      if (knownNames.has(comm)) return comm
      const ppidStr = readFileSync(`/proc/${pid}/stat`, "utf8").split(/\s+/)[3]
      const ppid = parseInt(ppidStr)
      if (!ppid || ppid === pid) break
      pid = ppid
    } catch {
      break
    }
  }
  return null
}

const detectTerminalProcessName = async (
  config: NotificationsConfig,
): Promise<string | null> => {
  if (config.terminalProcessName) return config.terminalProcessName

  const termProgram = (process.env.TERM_PROGRAM ?? "").toLowerCase()
  const nameMap = isMacOS ? MACOS_TERMINAL_PROCESS_NAMES : LINUX_TERMINAL_PROCESS_NAMES
  if (termProgram && nameMap[termProgram]) return nameMap[termProgram]

  if (isMacOS) return detectTerminalViaPsMacOS()
  if (isLinux) return detectTerminalViaProcLinux()
  return null
}

const detectDisplayServer = (): string => {
  if (process.env.XDG_SESSION_TYPE === "x11") return "x11"
  if (process.env.XDG_SESSION_TYPE === "wayland") return "wayland"
  if (process.env.DISPLAY) return "x11"
  if (process.env.WAYLAND_DISPLAY) return "wayland"
  return "unknown"
}

// Wayland compositors expose no read-only, non-interactive API that reports
// the focused window in a form comparable to a terminal process name. GNOME's
// `x11-display` metadata describes an X11 window, not a process, so comparing
// it to a process name would be guessing from unlike data. Platform focus on
// Wayland is therefore unsupported and stays unknown, leaving the renderer
// focus/blur signal authoritative and the caller's fail-open fallback intact.
const isTerminalFocusedX11 = async (terminalProcessName: string): Promise<boolean> => {
  const winId = await runCommand(["xdotool", "getactivewindow"])
  if (!winId) return false

  const xpropOutput = await runCommand(["xprop", "-id", winId, "_NET_WM_PID"])
  if (!xpropOutput) return false
  const match = xpropOutput.match(/=\s*(\d+)/)
  if (!match) return false
  const winPid = parseInt(match[1])

  try {
    const procName = readFileSync(`/proc/${winPid}/comm`, "utf8").trim()
    return procName === terminalProcessName
  } catch {
    return false
  }
}

const isTerminalFocusedLinux = async (terminalProcessName: string): Promise<boolean> => {
  const displayServer = detectDisplayServer()

  if (displayServer === "x11") return isTerminalFocusedX11(terminalProcessName)
  // Wayland platform focus is unsupported/unknown. Returning false lets the
  // caller fail open (deliver) while the renderer state remains unknown.
  return false
}

const isTerminalFocusedMacOS = async (terminalProcessName: string): Promise<boolean> => {
  const script = `tell application "System Events" to return frontmost of process "${safe(terminalProcessName)}"`
  const result = await runCommand(["osascript", "-e", script])
  return result === "true"
}

export interface CreateFocusTrackerOptions {
  renderer?: FocusRenderer
  config: NotificationsConfig
}

type RendererFocus = "unknown" | "focused" | "blurred"

interface RendererFocusState {
  status: RendererFocus
}

/**
 * Create the shared focus tracker. The terminal hosting the TUI reports
 * focus/blur directly; that signal is authoritative and is the only reliable
 * signal on Wayland compositors such as KWin. Platform detection is only
 * consulted while the renderer state is still unknown.
 */
export const createFocusTracker = async (
  options: CreateFocusTrackerOptions,
): Promise<FocusTracker> => {
  const { renderer, config } = options

  // Read through a mutable state object rather than a local `let`: each access
  // yields a fresh union value, so TypeScript does not narrow a post-await
  // check to `never` after the early returns below.
  const focusState: RendererFocusState = { status: "unknown" }
  const readFocus = (): RendererFocus => focusState.status

  let disposed = false
  let focusSubscribed = false
  let blurSubscribed = false

  const onRendererFocus = (): void => {
    focusState.status = "focused"
  }
  const onRendererBlur = (): void => {
    focusState.status = "blurred"
  }

  const subscribe = (event: "focus" | "blur", listener: () => void): boolean => {
    const target = renderer
    if (!target || typeof target.on !== "function") return false
    try {
      target.on(event, listener)
      return true
    } catch {
      // A renderer without terminal focus reporting leaves focus unknown.
      return false
    }
  }

  focusSubscribed = subscribe("focus", onRendererFocus)
  if (focusSubscribed) {
    blurSubscribed = subscribe("blur", onRendererBlur)
    if (!blurSubscribed) {
      // A half-installed pair cannot be trusted: drop the focus listener and
      // forget any state it captured so the platform fallback (fail open) is
      // used instead of a partially wired tracker.
      focusSubscribed = false
      focusState.status = "unknown"
      try {
        renderer?.off?.("focus", onRendererFocus)
      } catch {
        // Best-effort cleanup; disposal stays safe even if this throws.
      }
    }
  }

  const terminalProcessName: string | null = await detectTerminalProcessName(config)

  const isTerminalFocused = async (): Promise<boolean> => {
    if (disposed) return true

    // A positively focused renderer is authoritative and avoids the
    // false-positive/false-negative guessing of the platform detectors.
    const rendererFocus = readFocus()
    if (rendererFocus === "focused") return true
    // A known blur is equally authoritative; never override it with a stale
    // platform guess.
    if (rendererFocus === "blurred") return false
    if (!terminalProcessName) return false

    let platformFocused = false
    if (isMacOS) platformFocused = await isTerminalFocusedMacOS(terminalProcessName)
    else if (isLinux) platformFocused = await isTerminalFocusedLinux(terminalProcessName)
    else return false

    // Renderer focus/blur is authoritative, so a focus or blur event that
    // arrived while the platform detector was running must win over the
    // detector's older snapshot. Only fall back to the platform result when
    // renderer state is still unknown (fail open on unknown focus).
    const latestRendererFocus = readFocus()
    if (latestRendererFocus === "focused") return true
    if (latestRendererFocus === "blurred") return false
    return platformFocused
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    // Only touch listeners that were actually installed. Cleanup is
    // best-effort and each listener is independent: a throwing `off("focus")`
    // must not prevent `off("blur")` from being attempted.
    if (focusSubscribed) {
      focusSubscribed = false
      try {
        renderer?.off?.("focus", onRendererFocus)
      } catch {
        // Best-effort cleanup.
      }
    }
    if (blurSubscribed) {
      blurSubscribed = false
      try {
        renderer?.off?.("blur", onRendererBlur)
      } catch {
        // Best-effort cleanup.
      }
    }
  }

  return { isTerminalFocused, dispose }
}
