import { app } from "electron"

type Channel = "local" | "dev" | "beta" | "prod"

const raw = import.meta.env.OPENCODE_CHANNEL

// jetcode: default to "local" so the User-Agent sent to opencode.ai matches
// the standalone CLI build (opencode/local/<ver>/opencode-cli). Opencode.ai
// appears to apply looser free-tier limits to "local" (dev-tree) builds than
// to the "dev" nightly channel, which is why the TUI from the same source
// tree worked while the desktop was being rate-limited.
export const CHANNEL: Channel = raw === "local" || raw === "dev" || raw === "beta" || raw === "prod" ? raw : "local"

export const VERSION = app.isPackaged ? app.getVersion() : (process.env.OPENCODE_VERSION ?? app.getVersion())

// Drives app.setName(), which feeds the Windows taskbar/Alt-Tab tooltip,
// the macOS Dock/menu bar label, and the userData folder name. Must match
// electron-builder productName so an upgraded install finds its own state.
const appNames: Record<string, string> = {
  local: "jetcode",
  dev: "jetcode Dev",
  beta: "jetcode Beta",
  prod: "jetcode",
}

const appIDs: Record<string, string> = {
  local: "ai.opencode.desktop.dev",
  dev: "ai.opencode.desktop.dev",
  beta: "ai.opencode.desktop.beta",
  prod: "ai.opencode.desktop",
}

// Local renderer/server mode keeps the dev application identity. Fallback
// covers any unexpected CHANNEL value so app.setName never receives undefined.
export const APP_NAME = app.isPackaged ? (appNames[CHANNEL] ?? "jetcode") : "jetcode"

export const APP_ID = app.isPackaged ? appIDs[CHANNEL] : "ai.opencode.desktop.dev"
