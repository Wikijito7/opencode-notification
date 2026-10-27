/**
 * Permission summary formatting shared by both generations.
 *
 * v1 and v2 expose different permission payload shapes; each adapter normalizes
 * its event into {@link PermissionSummaryInput} before calling this module.
 */
import { extractFilename } from "./platform"
import type { PermissionSummaryInput } from "./types"

const asString = (value: unknown): string => (typeof value === "string" ? value : "")

const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []

const stripTrailingGlob = (resource: string): string => {
  const stripped = resource.replace(/\/\*+$/, "").replace(/\/+$/, "")
  return stripped || resource
}

const toShortPath = (path: string): string => {
  const cleaned = stripTrailingGlob(path)
  return extractFilename(cleaned) || cleaned
}

const summarizeExternalDirectory = (
  meta: Record<string, unknown>,
  resources: string[],
): string => {
  const explicitPath =
    asString(meta.filepath) || asString(meta.parentDir) || asString(meta.directory)
  const candidates = (explicitPath ? [explicitPath] : resources).filter(
    (candidate) => candidate.length > 0,
  )
  if (candidates.length === 0) return "access external file"

  const names = [...new Set(candidates.map(toShortPath))]
  const first = names[0] || toShortPath(candidates[0])
  if (names.length > 1) return `access: ${first} (+${names.length - 1} more)`
  return `access: ${first}`
}

/** Build a short human-readable description of a permission request. */
export const toPermissionSummary = (data: PermissionSummaryInput): string => {
  const action = asString(data.action).trim()
  const meta = data.metadata && typeof data.metadata === "object" ? data.metadata : {}
  const resources = asStringArray(data.resources)
  const resource = resources[0] ?? ""
  const explicit = asString(data.message).trim()

  switch (action) {
    case "external_directory":
      return summarizeExternalDirectory(meta, resources)
    case "webfetch":
    case "network": {
      const url = asString(meta.url) || asString(meta.host) || resource
      return url ? `network request: ${url}` : "make a network request"
    }
    case "websearch": {
      const query = resource || asString(meta.query)
      return query ? `web search: ${query}` : "make a web search"
    }
    case "shell": {
      const cmd = asString(meta.command) || asString(meta.cmd) || resources.join(" ")
      const tokens = cmd.trim().split(/\s+/).filter(Boolean).slice(0, 5)
      return tokens.length > 0 ? `run: ${tokens.join(" ")}` : "run a shell command"
    }
    case "read":
    case "edit":
    case "write":
    case "patch": {
      const path = asString(meta.filepath) || asString(meta.path) || resource
      const label =
        action === "read" ? "read" : action === "patch" ? "apply patch to" : "edit"
      return path ? `${label}: ${toShortPath(path)}` : `${label} a file`
    }
    case "glob":
    case "grep": {
      const pattern = resource || asString(meta.pattern)
      const label = action === "glob" ? "search files" : "search contents"
      return pattern ? `${label}: ${pattern}` : label
    }
    default: {
      if (explicit) return explicit
      const label = action ? action.replace(/_/g, " ") : "external operation"
      const path =
        asString(meta.filepath) ||
        asString(meta.parentDir) ||
        asString(meta.path) ||
        resource
      return path ? `${label}: ${toShortPath(path)}` : label
    }
  }
}
