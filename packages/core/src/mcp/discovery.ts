import type { ServerConfig } from "@opencode/schema/mcp"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

type RawServer = {
  command?: string | string[]
  args?: string[]
  env?: Record<string, string>
  environment?: Record<string, string>
  cwd?: string
  url?: string
  serverUrl?: string
  type?: string
  headers?: Record<string, string>
  disabled?: boolean
  enabled?: boolean
}

type Source = { name: string; file: string }

export type DiscoveredServer = {
  name: string
  config: ServerConfig
  source: string
}

function sources(): Source[] {
  const home = homedir()
  const appData = process.env.APPDATA
  const files: Source[] = [
    { name: "claude", file: join(home, ".claude.json") },
    { name: "cursor", file: join(home, ".cursor", "mcp.json") },
    { name: "windsurf", file: join(home, ".codeium", "windsurf", "mcp_config.json") },
    { name: "continue", file: join(home, ".continue", "config.json") },
    { name: "generic", file: join(home, ".mcp.json") },
    { name: "vscode", file: join(home, ".config", "Code", "User", "mcp.json") },
  ]
  if (appData) {
    files.unshift(
      { name: "claude", file: join(appData, "Claude", "claude_desktop_config.json") },
      { name: "vscode", file: join(appData, "Code", "User", "mcp.json") },
      {
        name: "cline",
        file: join(
          appData,
          "Code",
          "User",
          "globalStorage",
          "saoudrizwan.claude-dev",
          "settings",
          "cline_mcp_settings.json",
        ),
      },
    )
  }
  return files
}

function expand(value: string) {
  return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? "")
}

function strings(value: unknown) {
  if (!Array.isArray(value)) return undefined
  const result = value.filter((item): item is string => typeof item === "string").map(expand)
  return result.length ? result : undefined
}

function record(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  )
  return entries.length ? Object.fromEntries(entries.map(([key, item]) => [key, expand(item)])) : undefined
}

export function convertMcpServer(raw: Record<string, unknown>): ServerConfig | undefined {
  return convert(raw as RawServer)
}

function convert(raw: RawServer): ServerConfig | undefined {
  const command = Array.isArray(raw.command) ? raw.command : raw.command ? [raw.command] : undefined
  const args = strings(raw.args)
  const localCommand = command ? [...command.map(expand), ...(args ?? [])] : undefined
  const url = typeof raw.url === "string" ? expand(raw.url) : typeof raw.serverUrl === "string" ? expand(raw.serverUrl) : undefined
  const disabled = raw.disabled === true || raw.enabled === false

  if (url) {
    return {
      type: "remote",
      url,
      headers: record(raw.headers),
      ...(disabled ? { disabled: true } : {}),
    }
  }
  if (localCommand?.length) {
    return {
      type: "local",
      command: localCommand,
      cwd: typeof raw.cwd === "string" ? expand(raw.cwd) : undefined,
      environment: record(raw.environment) ?? record(raw.env),
      ...(disabled ? { disabled: true } : {}),
    }
  }
  return undefined
}

function serversFrom(file: string) {
  try {
    if (!existsSync(file)) return undefined
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      mcpServers?: Record<string, RawServer>
      servers?: Record<string, RawServer>
    }
    return parsed.mcpServers ?? parsed.servers
  } catch {
    return undefined
  }
}

/**
 * Finds MCP servers already configured for common desktop agents. jetcode
 * connects them automatically at startup; an entry with the same name in
 * jetcode's own config still wins, and an explicit disabled flag is preserved.
 */
export function discoverSystemMcpServers(): DiscoveredServer[] {
  const found: DiscoveredServer[] = []
  const used = new Set<string>()
  for (const source of sources()) {
    const servers = serversFrom(source.file)
    if (!servers) continue
    for (const [rawName, raw] of Object.entries(servers)) {
      if (!raw || typeof raw !== "object") continue
      const config = convert(raw)
      if (!config) continue
      let name = rawName.trim()
      if (!name) continue
      if (used.has(name)) name = `${source.name}-${name}`
      let suffix = 2
      while (used.has(name)) name = `${source.name}-${rawName}-${suffix++}`
      used.add(name)
      found.push({ name, config, source: source.name })
    }
  }
  return found
}
