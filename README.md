# OpenCode Notifications

Terminal notifications for [OpenCode](https://opencode.ai): get a desktop alert and a sound when a task finishes, a session fails, a permission needs approval, or a question needs an answer.

One shared policy/config/delivery core drives two generation-specific TUI adapters (v1 and v2). The plugin adds no extra npm dependencies; it relies on the host-provided TUI APIs. All user policy lives in a single JSONC file, and the plugin works on macOS and Linux. Windows is not supported.

## Features

- **Completion** — notifies when a session's execution succeeds or is interrupted.
- **Errors** — notifies when a session execution fails, plus an optional error toast with the raw detail.
- **Permissions** — notifies when a permission request is asked, with a short human-readable summary.
- **Questions** — notifies when a question form/request is created.
- **Focus suppression** — stays quiet while the terminal hosting OpenCode is focused.
- **Deduplication** — suppresses duplicate events by key within a configurable time window, and caps the in-memory bookkeeping sets.
- **Per-event sounds** — plays the configured sound through the platform player (`afplay` on macOS, `paplay` on Linux).
- **JSONC config** — comments and trailing commas are allowed; messages can contain text such as `,]` without being mangled.
- **One shared config** — the v1 and v2 adapters read the same `notifications/notifications.config.jsonc`.

## Repository layout

```
opencode-notification/
├── notifications.tsx                    # v1 TUI adapter (registered via tui.json)
├── notifications/                       # v2 TUI adapter directory (deploy this for v2)
│   ├── tui.tsx                          # Plugin.define({ id, setup }) v2 entry
│   ├── notifications.config.jsonc       # single shared user configuration
│   └── shared/                          # host-agnostic policy/config/delivery core
│       ├── config.ts                    # JSONC parser, validation, defaults, loader
│       ├── core.ts                      # policy, dedupe, lifecycle, delivery
│       ├── focus.ts                     # renderer focus + platform fallback
│       ├── permission.ts                # permission summary formatter
│       ├── platform.ts                  # platform constants and process helpers
│       ├── sound.ts                     # path-like sound resolution/player
│       └── types.ts                     # shared config/event types
├── legacy/
│   └── v1/
│       ├── notifications.ts             # archived v1 SERVER plugin (reference only)
│       └── notifications.config.jsonc   # archived v1 server config
├── tests/                               # Bun test suite and harness
│   ├── fixtures/
│   │   └── focus-linux.ts               # Linux focus-detection fixtures
│   ├── harness.ts                       # mocked fs/os/child_process/renderer harness
│   ├── runtime-mocks.ts                 # shared process-wide test mocks
│   ├── v1-adapter.test.ts               # v1 TUI adapter tests
│   ├── v2-adapter.test.ts               # v2 TUI adapter tests
│   ├── shared-config.test.ts            # config/JSONC parser and validation tests
│   ├── shared-core.test.ts              # policy, dedupe and lifecycle tests
│   ├── shared-focus.test.ts             # focus tracker tests
│   ├── shared-focus-linux.test.ts       # Linux focus-detection tests
│   ├── shared-permission.test.ts        # permission summary formatter tests
│   └── shared-sound.test.ts             # sound resolution and player tests
├── .gitignore
├── README.md
└── LICENSE
```

- `notifications.tsx` is the **v1 TUI** entry. It is a loose root `.tsx` file, which v2's directory-only TUI discovery never loads.
- `notifications/` is the **v2 TUI** package. Its entry is `notifications/tui.tsx`; it has **no root `server.ts` or `index.ts`**.
- `notifications/shared/` contains only pure/shared helpers. It imports Node built-ins but **no v1/v2 host API**, so both adapters and unit tests can use it.
- `legacy/v1/notifications.ts` is the preserved original v1 **server** plugin. It is a reference artifact and **not an active entrypoint**.

## Requirements

- OpenCode v1 (TUI) or OpenCode v2 (TUI).
- macOS or Linux:
  - macOS uses `afplay` and `/System/Library/Sounds/*.aiff`.
  - Linux uses `paplay` and `/usr/share/sounds/freedesktop/stereo/*.oga`.
- The sound player for your platform must be on `PATH` if `soundEnabled` is `true`.

## Install

The same deployed layout serves both generations:

```bash
mkdir -p ~/.config/opencode/plugins/notifications
cp notifications.tsx ~/.config/opencode/plugins/notifications.tsx
cp -R notifications/. ~/.config/opencode/plugins/notifications/
```

The result is:

```
~/.config/opencode/plugins/notifications.tsx        # v1 TUI entry
~/.config/opencode/plugins/notifications/
  ├── tui.tsx                                       # v2 TUI entry
  ├── notifications.config.jsonc
  └── shared/...
```

### v1 registration (`tui.json`)

Register the flat v1 TUI file and disable the v1 built-in notification plugin so nothing fires twice:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "./plugins/notifications.tsx"
  ],
  "plugin_enabled": {
    "internal:notifications": false
  }
}
```

- `plugin` is the v1 TUI entry list. It must point at the loose `notifications.tsx` file.
- `plugin_enabled` disables the v1 built-in `internal:notifications` plugin. Without it you may receive duplicate notifications and sounds.
- If your v1 build names the built-in differently, disable the notification entry shown in the plugin list instead.

### v2 registration (`cli.json`)

Register the v2 TUI **directory** and disable the v2 built-in plugin:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    "./plugins/notifications",
    "-opencode.notifications"
  ]
}
```

- `./plugins/notifications` is the directory containing `tui.tsx`.
- `-opencode.notifications` is the built-in plugin's disable entry.

Do **not** add a global `attention` block for either generation. Notification and sound policy lives entirely in `notifications/notifications.config.jsonc`; the plugin uses `renderer.triggerNotification` for the bubble and its own platform sound player.

### Configuration reload

The config file is read **once during plugin setup**. Editing `notifications.config.jsonc` while OpenCode is running has no effect until you restart or reload the TUI.

## Development and testing

The package has no npm dependencies of its own; it consumes the host-provided TUI APIs. The test suite uses Bun's built-in runner:

```bash
bun test
```

`tests/harness.ts` loads the real v2 adapter (`notifications/tui.tsx`) with `node:fs`, `node:os`, `node:child_process`, and `@opencode/plugin/tui` mocked, so tests never emit OS notifications, play audio, or touch your real config. The shared core is plain TypeScript and can be tested without a host.

## Configuration

All configuration lives in the shared file `notifications/notifications.config.jsonc`. Both adapters read it. Every field is optional; missing or invalid values fall back to the defaults below.

```jsonc
{
  // Optional terminal override. Auto-detected by default.
  // "terminalProcessName": "Ghostty",

  "soundEnabled": true,

  "events": {
    "idle": true,
    "error": true,
    "permission": true,
    "question": true
  },

  "sounds": {
    "idle": "Glass",
    "error": "Basso",
    "permission": "Submarine",
    "question": "Submarine"
  },

  "messages": {
    "idle": "Task completed!",
    "error": "Something went wrong, I need your attention!",
    "permission": "I need permission to do: {summary}",
    "question": "I have a question for you!"
  },

  "dedupeWindowMs": 1500,
  "maxRecentNotifications": 100
}
```

### Reference

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `terminalProcessName` | `string \| null` | `null` | Terminal process name used by focus detection. Auto-detected from `TERM_PROGRAM` or the parent process tree; set it manually only when detection fails. |
| `soundEnabled` | `boolean` | `true` | Master sound toggle. When `false`, notifications are still delivered. |
| `events.idle` | `boolean` | `true` | Completion notifications for non-subagent sessions. |
| `events.error` | `boolean` | `true` | Failure notifications (and the error toast). |
| `events.permission` | `boolean` | `true` | Permission-request notifications. |
| `events.question` | `boolean` | `true` | Question-form/request notifications. |
| `sounds.idle` | `string` | `"Glass"` | Sound for completion. |
| `sounds.error` | `string` | `"Basso"` | Sound for errors. |
| `sounds.permission` | `string` | `"Submarine"` | Sound for permissions. |
| `sounds.question` | `string` | `"Submarine"` | Sound for questions. |
| `messages.idle` | `string` | `"Task completed!"` | Completion text. |
| `messages.error` | `string` | `"Something went wrong, I need your attention!"` | Error text. |
| `messages.permission` | `string` | `"I need permission to do: {summary}"` | Permission text. `{summary}` is replaced with a short description of the requested action. |
| `messages.question` | `string` | `"I have a question for you!"` | Question text. |
| `dedupeWindowMs` | `number` | `1500` | Time window in milliseconds used to dedupe repeated notification keys. |
| `maxRecentNotifications` | `positive integer` | `100` | Maximum size of each in-memory dedupe set/map. |

### Sound resolution

Each sound value is resolved in this order:

1. **Absolute or home-relative file path** — `/path/to/sound.aiff` or `~/sounds/sound.aiff`. The path is expanded and checked for existence.
2. **System sound stem** — the configured name is resolved against the platform sound directory (`/System/Library/Sounds/<name>.aiff` on macOS, `/usr/share/sounds/freedesktop/stereo/<name>.oga` on Linux).
3. **Platform fallback** — `Glass` on macOS, `complete` on Linux.
4. **Disabled** — if nothing resolves, the sound is skipped and a warning is logged.

If a path-like value does not exist, its basename without extension is retried as a system sound stem before the platform fallback is used.

## Event mapping

Both adapters normalize their generation-specific events into the same shared core inputs, so policy, messages, sounds, focus, dedupe and lifecycle cleanup behave identically.

### v1 (`notifications.tsx`)

| Notification | v1 event(s) |
| --- | --- |
| Execution started | `session.status` with `busy`/`retry` (clears the per-session completion/error guards) |
| Completion (`idle`) | `session.status` with `idle` (`session.idle` alone is not used) |
| Error (`error`) | `session.error` (raw error text is toast detail, not notification copy) |
| Permission (`permission`) | `permission.asked` (deduped by request ID, then by action); `permission.replied` clears the ID |
| Question (`question`) | `question.asked` (deduped by request ID); `question.replied` / `question.rejected` clear the ID |
| Session lifecycle | `session.created` (tracks subagent `info.parentID`), `session.deleted` (drops every guard owned by the session) |
| Focus/disposal | `renderer` focus/blur listeners; `lifecycle.onDispose` unsubscribes everything |

### v2 (`notifications/tui.tsx`)

| Notification | v2 event(s) |
| --- | --- |
| Completion (`idle`) | `session.execution.succeeded`, `session.execution.interrupted` |
| Error (`error`) | `session.execution.failed` |
| Permission (`permission`) | `permission.asked` (deduped by permission ID, then by action); `permission.replied` clears the ID |
| Question (`question`) | `form.created` where `form.metadata.kind === "question"` (deduped by form ID); `form.replied` / `form.cancelled` clear the ID |
| Session lifecycle | `session.created` (tracks subagent `parentID`), `session.deleted` (drops every guard owned by the session) |
| Execution reset | `session.execution.started` clears the completion/error guards for that session |
| Focus/disposal | `renderer` focus/blur listeners; the returned cleanup unsubscribes everything |

Subagents suppress completion/idle notifications only. Their errors, permissions, and questions still notify. Cleanup happens on `session.deleted`, which also drops any form and permission dedupe entries owned by that session.

## Focus behavior

Focus suppression works in this order:

1. **Renderer focus/blur** — the terminal hosting the TUI reports focus changes directly. This is authoritative, including on Wayland compositors such as KWin; on Wayland it is the only reliable focus signal.
2. **Platform detector** — when the renderer has not reported focus yet, macOS checks the frontmost process with `osascript`; Linux checks the active window on X11 (`xdotool` + `xprop`). Wayland has no supported read-only window-focus API that can be compared to a terminal process name, so GNOME Wayland (like KWin) is treated as unsupported/unknown.
3. **Fail open** — if focus cannot be determined, the notification is delivered rather than suppressed. No notification is lost because of a guessed focus state.

## Desktop notifications and OSC

Desktop bubbles use the public renderer notification primitive:

- v1: `api.renderer.triggerNotification(message, "OpenCode")`.
- v2: `context.renderer.triggerNotification(message, "OpenCode")`.

OpenTUI emits an **OSC** escape sequence (OSC 9, OSC 777, or OSC 99, selected from terminal capability detection) and never calls `notify-send`, AppleScript, or another host notification command for the bubble itself. The old `osascript`/`notify-send` bubble transport exists only in the archived v1 server reference and is not used by either TUI adapter.

Implications:

- The terminal decides whether and how to display the notification. Some terminals show a banner only while unfocused; desktop settings may silence it.
- Detection is asynchronous. A notification can be dropped before the terminal has replied to capability queries.
- In tmux, passthrough must be enabled (`set -g allow-passthrough on`; use `all` when the pane is not visible). Zellij uses OSC 99. Screen needs passthrough plus a detected/forced protocol.
- Override detection with `OPENTUI_NOTIFICATION_PROTOCOL=osc9|osc777|osc99` if needed, or disable it with `OPENTUI_NOTIFICATIONS=0`.
- `triggerNotification` returning `true` only means the sequence was queued — not that the desktop displayed it.

Sounds are separate from OSC: they are played locally by `afplay`/`paplay`.

## Limitations

- **TUI-only.** Notifications only originate while the TUI is running; there is no server-side notification launcher in this package.
- **Built-in plugins must be disabled.** v1: disable `internal:notifications` in `tui.json`. v2: add `-opencode.notifications` to `cli.json`.
- **No Windows support.**
- **Wayland platform focus detection is unsupported.** On Wayland, only renderer focus/blur events can suppress notifications. If the terminal never reports focus, notifications are delivered (fail open).
- **Notifications depend on the terminal.** If the terminal does not accept the selected OSC protocol (or passthrough is disabled), the bubble silently does not appear.
- **Config requires a restart/reload.** It is read during setup.
- **Sound players are external.** `afplay`/`paplay` must exist and be on `PATH`.
- Custom sound names are system stems by default; use absolute or `~/` paths for arbitrary files.

## Legacy v1 plugin (reference only)

`legacy/v1/` preserves the original flat OpenCode v1 **server** plugin and its config for compatibility reference.

- Files: `legacy/v1/notifications.ts` and `legacy/v1/notifications.config.jsonc`.
- It is **not** an active entrypoint. v1 `tui.json` must register `./plugins/notifications.tsx` (the TUI adapter), not `legacy/v1/notifications.ts`.
- It uses the old v1 server event/hook surface (`session.idle`, `session.error`, `permission.asked`/`permission.updated`, `tool.execute.before`) and `osascript`/`notify-send` for bubbles.
- The archived source and config are kept unchanged. Do not load the legacy server plugin alongside either TUI adapter, or you will get duplicate notifications.

## Attribution

The v1 plugin and the original notification policy come from the `notifications` plugin in [Wikijito7](https://github.com/Wikijito7)'s OpenCode configuration. The v1/v2 TUI adapters and shared core are a port of that work, using each generation's renderer notification primitive and TUI event APIs.

## License

MIT. See [LICENSE](LICENSE).

Copyright (c) 2026 Cristian Andrades
