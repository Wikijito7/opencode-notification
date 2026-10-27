import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const fixture = fileURLToPath(
  new URL("./fixtures/focus-linux.ts", import.meta.url),
)
const repoRoot = fileURLToPath(new URL("..", import.meta.url))

let fakeBin = ""
let marker = ""

const scriptFor = (name: string): string => `#!/bin/sh
echo "${name} $@" >> "$FOCUS_MARKER"
echo "x11-display"
`

beforeAll(() => {
  fakeBin = mkdtempSync(join(tmpdir(), "notifications-focus-bin-"))
  marker = join(fakeBin, "probes.log")
  // Any X11/GNOME focus probe would run one of these and leave a marker.
  for (const name of ["busctl", "xdotool", "xprop", "qdbus"]) {
    const path = join(fakeBin, name)
    writeFileSync(path, scriptFor(name))
    chmodSync(path, 0o755)
  }
})

afterAll(() => {
  rmSync(fakeBin, { recursive: true, force: true })
})

describe("shared focus tracker on Linux", () => {
  it("treats GNOME Wayland focus as unknown, fails open and does not probe X11 metadata", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "run", fixture],
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        FOCUS_MARKER: marker,
      },
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(result.exitCode).toBe(0)
    const parsed = JSON.parse(result.stdout.toString()) as {
      focused: boolean
      notifications: string[]
    }

    expect(parsed.focused).toBe(false)
    expect(parsed.notifications).toEqual(["I have a question for you!"])
    expect(existsSync(marker)).toBe(false)
  })
})
