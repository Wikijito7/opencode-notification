import { describe, expect, it } from "bun:test"
import "./runtime-mocks"

const { toPermissionSummary } = await import(
  "../notifications/shared/permission"
)

describe("shared permission summaries", () => {
  it("formats v1 permission/patterns payloads", () => {
    const v1Cases: Array<{
      data: Parameters<typeof toPermissionSummary>[0]
      expected: string
    }> = [
      {
        data: {
          action: "network",
          resources: ["https://example.com/api"],
          metadata: { url: "https://example.com/api" },
        },
        expected: "network request: https://example.com/api",
      },
      {
        data: {
          action: "external_directory",
          resources: ["/Users/me/alpha/*", "/Users/me/beta/*"],
        },
        expected: "access: alpha (+1 more)",
      },
      {
        data: {
          action: "shell",
          resources: ["git commit -m message", "and more"],
        },
        expected: "run: git commit -m message and",
      },
      {
        data: {
          action: "custom_tool",
          resources: [],
          metadata: { filepath: "/a/b/c.txt" },
        },
        expected: "custom tool: c.txt",
      },
    ]

    for (const testCase of v1Cases) {
      expect(toPermissionSummary(testCase.data)).toBe(testCase.expected)
    }
  })

  it("formats v2 action/resources/metadata payloads", () => {
    const v2Cases: Array<{
      data: Parameters<typeof toPermissionSummary>[0]
      expected: string
    }> = [
      {
        data: {
          action: "webfetch",
          resources: ["https://example.com/page"],
          metadata: { url: "https://example.com/page" },
        },
        expected: "network request: https://example.com/page",
      },
      {
        data: {
          action: "websearch",
          resources: ["opencode notifications"],
          metadata: { query: "opencode notifications" },
        },
        expected: "web search: opencode notifications",
      },
      {
        data: {
          action: "read",
          resources: ["src/utils/file.ts"],
          metadata: { truncated: false },
        },
        expected: "read: file.ts",
      },
      {
        data: {
          action: "edit",
          resources: ["src/app.ts"],
          metadata: { files: [] },
        },
        expected: "edit: app.ts",
      },
      {
        data: {
          action: "glob",
          resources: ["**/*.ts"],
          metadata: { root: "." },
        },
        expected: "search files: **/*.ts",
      },
      {
        data: {
          action: "grep",
          resources: ["TODO"],
          metadata: { include: "*.ts" },
        },
        expected: "search contents: TODO",
      },
      {
        data: {
          action: "patch",
          resources: ["src/patched.ts"],
        },
        expected: "apply patch to: patched.ts",
      },
    ]

    for (const testCase of v2Cases) {
      expect(toPermissionSummary(testCase.data)).toBe(testCase.expected)
    }
  })

  it("prefers an explicit v2 message for unknown actions", () => {
    expect(
      toPermissionSummary({
        action: "custom_action",
        resources: [],
        message: "Do the custom thing",
      }),
    ).toBe("Do the custom thing")
  })

  it("handles empty and malformed permission payloads", () => {
    expect(toPermissionSummary({})).toBe("external operation")
    expect(
      toPermissionSummary({
        action: "external_directory",
        resources: [],
      }),
    ).toBe("access external file")
    expect(
      toPermissionSummary({
        action: "webfetch",
        resources: [],
      }),
    ).toBe("make a network request")
    expect(
      toPermissionSummary({
        action: "websearch",
        resources: [],
      }),
    ).toBe("make a web search")
    expect(
      toPermissionSummary({
        action: "shell",
        resources: [],
      }),
    ).toBe("run a shell command")
    expect(
      toPermissionSummary({
        action: "read",
        resources: [],
      }),
    ).toBe("read a file")
  })
})
