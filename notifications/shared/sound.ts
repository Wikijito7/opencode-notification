/**
 * Shared sound resolution and playback.
 *
 * Sounds are played locally with the platform player (`afplay` on macOS,
 * `paplay` on Linux) and are unrelated to the notification bubble, which uses
 * the renderer's OSC notification primitive.
 */
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { extractFilename, isLinux, isMacOS, PLATFORM, runCommand } from "./platform"
import type { EventKey, NotificationsConfig } from "./types"

const FALLBACK_SOUNDS: Record<string, string> = {
  darwin: "Glass",
  linux: "complete",
}

const soundPaths: Record<string, (name: string) => string> = {
  darwin: (name) => `/System/Library/Sounds/${name}.aiff`,
  linux: (name) => `/usr/share/sounds/freedesktop/stereo/${name}.oga`,
}

const soundPlayers: Record<string, string> = {
  darwin: "afplay",
  linux: "paplay",
}

const isPathLike = (value: string): boolean =>
  value.startsWith("/") || value.startsWith("~/")

const expandHome = (value: string): string =>
  value.startsWith("~/") ? `${homedir()}${value.slice(1)}` : value

const systemSoundPath = (name: string): string | null => {
  const resolver = soundPaths[PLATFORM]
  return resolver ? resolver(name) : null
}

/**
 * Resolves a sound config value to an absolute file path:
 *
 *   1. Absolute (/…) or home-relative (~/…) path → expand ~, check the file.
 *      If it exists, use it as-is; otherwise fall back to its basename stem.
 *   2. System sound stem → check /System/Library/Sounds or the freedesktop dir.
 *   3. Platform fallback (Glass on macOS, complete on Linux) when available.
 *   4. Nothing works → warn and disable sound.
 */
export const resolveSoundPath = (nameOrPath: string): string | null => {
  let candidateName = nameOrPath

  if (isPathLike(nameOrPath)) {
    const expanded = expandHome(nameOrPath)
    if (existsSync(expanded)) return expanded

    // A path was configured but the file is missing: retry it as a stem.
    const basename = extractFilename(expanded).replace(/\.[^.]+$/, "")
    if (basename) candidateName = basename
  }

  const systemPath = systemSoundPath(candidateName)
  if (systemPath && existsSync(systemPath)) return systemPath

  const fallback = FALLBACK_SOUNDS[PLATFORM]
  if (fallback) {
    const fallbackPath = systemSoundPath(fallback)
    if (fallbackPath && existsSync(fallbackPath)) {
      console.warn(`[NotificationsPlugin] Sound "${nameOrPath}" not found, using fallback: ${fallback}`)
      return fallbackPath
    }
  }

  console.warn(`[NotificationsPlugin] Sound "${nameOrPath}" not found and no fallback available, disabling sound`)
  return null
}

export const playSound = async (path: string): Promise<void> => {
  const player = soundPlayers[PLATFORM]
  if (!player) return
  await runCommand([player, path])
}

/** Resolve and play the sound configured for an event, when enabled. */
export const playConfiguredSound = async (
  config: NotificationsConfig,
  key: EventKey,
): Promise<void> => {
  if (!config.soundEnabled) return
  if (!isMacOS && !isLinux) return
  const path = resolveSoundPath(config.sounds[key])
  if (!path) return
  await playSound(path)
}
