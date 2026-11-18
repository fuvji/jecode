import { expect, test } from "bun:test"
import { convertMcpServer } from "./discovery"

test("converts a Claude-style local MCP server with args and environment", () => {
  expect(
    convertMcpServer({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "C:\\work"],
      env: { TOKEN: "abc" },
    }),
  ).toEqual({
    type: "local",
    command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "C:\\work"],
    cwd: undefined,
    environment: { TOKEN: "abc" },
  })
})

test("converts a remote MCP server and keeps headers", () => {
  expect(
    convertMcpServer({
      type: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer token" },
    }),
  ).toEqual({
    type: "remote",
    url: "https://example.com/mcp",
    headers: { Authorization: "Bearer token" },
  })
})

test("preserves an explicit disabled flag", () => {
  expect(convertMcpServer({ command: "node", args: ["server.js"], disabled: true })).toEqual({
    type: "local",
    command: ["node", "server.js"],
    cwd: undefined,
    environment: undefined,
    disabled: true,
  })
})

test("rejects entries with neither a command nor a url", () => {
  expect(convertMcpServer({ type: "stdio" })).toBeUndefined()
})
