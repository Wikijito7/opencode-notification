/**
 * Isolated Linux/GNOME Wayland probe for the shared focus tracker.
 *
 * Runs in a child Bun process so `process.platform` can be overridden without
 * leaking a global platform mock into the rest of the test process.
 */
Object.defineProperty(process, "platform", { value: "linux" })
process.env.XDG_SESSION_TYPE = "wayland"
process.env.XDG_CURRENT_DESKTOP = "GNOME"

const { DEFAULTS } = await import("../../notifications/shared/config")
const { createFocusTracker } = await import("../../notifications/shared/focus")
const { createNotificationCore } = await import(
  "../../notifications/shared/core"
)

const config = {
  ...DEFAULTS,
  terminalProcessName: "ghostty",
  soundEnabled: false,
  dedupeWindowMs: 0,
}

const tracker = await createFocusTracker({ config })
const focused = await tracker.isTerminalFocused()
const notifications: string[] = []
const core = createNotificationCore({
  config,
  renderer: {
    triggerNotification: (message): void => {
      notifications.push(message)
    },
  },
  focus: tracker,
})

await core.questionAsked("q-wayland", "main")

console.log(JSON.stringify({ focused, notifications }))
