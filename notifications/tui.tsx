/**
 * notifications — OpenCode v2 TUI adapter (`@opencode/plugin/tui`).
 *
 * This directory is a **v2 TUI-only** package: its entry is `tui.tsx`, and it
 * deliberately has no package-root `server.ts` / `index.ts`. The v1 TUI adapter
 * is the flat root file `../notifications.tsx`; the archived v1 server plugin
 * lives under `../legacy/v1/` as a reference only.
 *
 * All policy, config parsing, permission summaries, focus detection, sound
 * playback and dedupe live in `./shared/`. This file only normalizes v2 events:
 *   - `session.execution.started` → reset per-session guards
 *   - `session.execution.succeeded` / `interrupted` → completion
 *   - `session.execution.failed` → error copy + optional detail toast
 *   - `form.created` (question metadata only) / `replied` / `cancelled`
 *   - `permission.asked` / `permission.replied`
 *   - `session.created` / `session.deleted`
 *
 * Desktop bubbles use the public `context.renderer.triggerNotification` API.
 * The built-in `opencode.notifications` plugin stays disabled via
 * `plugins: ["-opencode.notifications"]` in cli.json, so nothing double-fires.
 */
import { fileURLToPath } from "node:url"
import { Plugin } from "@opencode/plugin/tui"
import { loadConfig } from "./shared/config"
import { createNotificationCore } from "./shared/core"
import { createFocusTracker } from "./shared/focus"
import { isSupported, PLATFORM } from "./shared/platform"

const asString = (value: unknown): string => (typeof value === "string" ? value : "")

export default Plugin.define({
  id: "notifications",
  async setup(context) {
    const configPath = fileURLToPath(new URL("./notifications.config.jsonc", import.meta.url))
    const config = loadConfig(configPath)

    if (!isSupported) {
      console.warn(
        `[NotificationsPlugin] Platform "${PLATFORM}" is not supported; notifications disabled.`,
      )
      return
    }

    const focus = await createFocusTracker({ renderer: context.renderer, config })
    const core = createNotificationCore({
      config,
      renderer: context.renderer,
      focus,
      toast: (input) => context.ui?.toast?.show?.(input),
      getSessionParent: (sessionID) => context.data.session.get(sessionID)?.parentID,
    })

    const disposers: Array<() => void> = []

    const releaseEvents = (): void => {
      // Unsubscribe in reverse order and never let one failing cleanup abort
      // the rest: partial registration must not leak subscriptions.
      for (const cleanup of [...disposers].reverse()) {
        try {
          cleanup()
        } catch {
          // Best-effort cleanup.
        }
      }
      disposers.length = 0
    }

    try {
      // Register incrementally so a throw from any later `data.on` can be
      // rolled back without leaking the subscriptions installed before it.
      disposers.push(
        context.data.on("session.created", (event) => {
          core.sessionCreated(event.data.sessionID, event.data.parentID)
        }),
      )
      disposers.push(
        context.data.on("session.deleted", (event) => {
          core.sessionDeleted(event.data.sessionID)
        }),
      )
      disposers.push(
        context.data.on("form.created", async (event) => {
          const form = event.data.form
          if (form.metadata?.kind !== "question") return
          await core.questionAsked(form.id, form.sessionID)
        }),
      )
      disposers.push(
        context.data.on("form.replied", (event) => {
          core.questionResolved(event.data.id)
        }),
      )
      disposers.push(
        context.data.on("form.cancelled", (event) => {
          core.questionResolved(event.data.id)
        }),
      )
      disposers.push(
        context.data.on("permission.asked", async (event) => {
          await core.permissionAsked(event.data.id, event.data.sessionID, event.data)
        }),
      )
      disposers.push(
        context.data.on("permission.replied", (event) => {
          core.permissionResolved(event.data.requestID)
        }),
      )
      disposers.push(
        context.data.on("session.execution.started", (event) => {
          core.started(event.data.sessionID)
        }),
      )
      disposers.push(
        context.data.on("session.execution.succeeded", async (event) => {
          await core.ended(event.data.sessionID)
        }),
      )
      disposers.push(
        context.data.on("session.execution.interrupted", async (event) => {
          await core.ended(event.data.sessionID)
        }),
      )
      disposers.push(
        context.data.on("session.execution.failed", async (event) => {
          await core.failed(event.data.sessionID, asString(event.data.error?.message))
        }),
      )
    } catch (error) {
      // Setup failed before returning its disposal callback: unwind the
      // subscriptions and renderer listeners that were installed, then
      // rethrow instead of leaving a half-registered plugin behind.
      core.dispose()
      releaseEvents()
      focus.dispose()
      throw error
    }

    return () => {
      // Flip the core guard before unsubscribing so an in-flight async handler
      // that resumes during/after teardown cannot notify or play a sound.
      core.dispose()
      releaseEvents()
      focus.dispose()
    }
  },
})
