/**
 * Shared JSONC configuration parser and validator.
 *
 * The same config file (`notifications/notifications.config.jsonc`) drives both
 * the v1 and v2 TUI adapters, so parsing lives here rather than in either
 * adapter. This module uses only Node built-ins and the shared types; it never
 * imports a v1/v2 OpenCode host API.
 */
import { existsSync, readFileSync } from "node:fs"
import type {
  DeepPartial,
  EventKey,
  MessageConfig,
  NotificationEventConfig,
  NotificationsConfig,
  SoundConfig,
} from "./types"

const EVENT_KEYS: EventKey[] = ["idle", "error", "permission", "question"]

export const DEFAULTS: NotificationsConfig = {
  terminalProcessName: null,
  soundEnabled: true,
  events: {
    idle: true,
    error: true,
    permission: true,
    question: true,
  },
  sounds: {
    idle: "Glass",
    error: "Basso",
    permission: "Submarine",
    question: "Submarine",
  },
  messages: {
    idle: "Task completed!",
    error: "Something went wrong, I need your attention!",
    permission: "I need permission to do: {summary}",
    question: "I have a question for you!",
  },
  dedupeWindowMs: 1500,
  maxRecentNotifications: 100,
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isNonNegativeNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0

/**
 * Removes trailing commas outside of quoted strings. A JSONC comment stripper
 * has already run, so the input contains only structural characters, whitespace
 * and string literals. This keeps sequences such as `,]` inside message text
 * intact instead of rewriting them as part of the comma cleanup.
 */
const stripTrailingCommas = (text: string): string => {
  let result = ""
  let inString = false
  let escaped = false

  for (let index = 0; index < text.length; index++) {
    const char = text[index]

    if (inString) {
      result += char
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      result += char
      continue
    }

    if (char === ",") {
      let next = index + 1
      while (next < text.length && /\s/.test(text[next])) next++
      if (text[next] === "}" || text[next] === "]") continue
    }

    result += char
  }

  return result
}

export const parseJsonc = (text: string): unknown => {
  try {
    const withoutComments = text.replace(
      /("(?:[^"\\]|\\.)*")|\/\/[^\n\r]*|\/\*[\s\S]*?\*\//g,
      (match: string, str: string) => str ?? "",
    )
    return JSON.parse(stripTrailingCommas(withoutComments))
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[NotificationsPlugin] Failed to parse config, using defaults: ${message}`)
    return null
  }
}

/**
 * Validates the raw JSONC payload one field at a time. Valid-but-wrong shapes
 * (for example `"events": null`, `"messages": []`, or a numeric `soundEnabled`)
 * are ignored so the corresponding default survives the deep merge instead of
 * surfacing later as a runtime error inside an event handler.
 */
export const validateConfig = (value: unknown): DeepPartial<NotificationsConfig> => {
  const result: DeepPartial<NotificationsConfig> = {}
  if (!isRecord(value)) return result

  if (value.terminalProcessName === null || typeof value.terminalProcessName === "string") {
    result.terminalProcessName = value.terminalProcessName
  }
  if (typeof value.soundEnabled === "boolean") result.soundEnabled = value.soundEnabled

  if (isRecord(value.events)) {
    const events: Partial<NotificationEventConfig> = {}
    for (const key of EVENT_KEYS) {
      const item = value.events[key]
      if (typeof item === "boolean") events[key] = item
    }
    if (Object.keys(events).length > 0) result.events = events
  }

  if (isRecord(value.sounds)) {
    const sounds: Partial<SoundConfig> = {}
    for (const key of EVENT_KEYS) {
      const item = value.sounds[key]
      if (typeof item === "string") sounds[key] = item
    }
    if (Object.keys(sounds).length > 0) result.sounds = sounds
  }

  if (isRecord(value.messages)) {
    const messages: Partial<MessageConfig> = {}
    for (const key of EVENT_KEYS) {
      const item = value.messages[key]
      if (typeof item === "string") messages[key] = item
    }
    if (Object.keys(messages).length > 0) result.messages = messages
  }

  if (isNonNegativeNumber(value.dedupeWindowMs)) result.dedupeWindowMs = value.dedupeWindowMs
  if (isPositiveInteger(value.maxRecentNotifications)) {
    result.maxRecentNotifications = value.maxRecentNotifications
  }

  return result
}

export const deepMerge = <T,>(target: T, source: DeepPartial<T>): T => {
  const result = { ...target } as Record<string, unknown>
  if (!isRecord(source)) return result as T
  const targetRecord = target as Record<string, unknown>

  for (const key of Object.keys(source)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue
    const sourceValue = (source as Record<string, unknown>)[key]
    if (sourceValue === undefined) continue
    const targetValue = targetRecord[key]
    if (isRecord(sourceValue)) {
      result[key] = deepMerge(isRecord(targetValue) ? targetValue : {}, sourceValue)
    } else {
      result[key] = sourceValue
    }
  }

  return result as T
}

/**
 * Read and normalize the shared JSONC config. A missing file yields the
 * built-in defaults; malformed JSONC logs once and also falls back to defaults,
 * with every field validated independently.
 */
export const loadConfig = (configPath: string): NotificationsConfig => {
  const rawConfig = existsSync(configPath) ? parseJsonc(readFileSync(configPath, "utf8")) : {}
  return deepMerge(DEFAULTS, validateConfig(rawConfig))
}
