import { app, BrowserWindow, dialog } from "electron"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

type OfflineStatus = {
  ollama?: {
    autoPull?: string
    tag?: string
    sizeGb?: number
    sizeBytes?: number
  }
}

function dataDir() {
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode")
}

function consentPath() {
  return join(dataDir(), "jetcode-ollama-consent.json")
}

async function ask(status: OfflineStatus) {
  const pending = status.ollama
  if (pending?.autoPull !== "awaiting-confirmation" || !pending.tag) return

  const size =
    typeof pending.sizeGb === "number"
      ? `${pending.sizeGb} GB`
      : typeof pending.sizeBytes === "number"
        ? `${Math.ceil(pending.sizeBytes / 1024 ** 3)} GB`
        : "several GB"
  const options: Electron.MessageBoxOptions = {
    type: "question",
    buttons: ["Download model", "Not now"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: "Set up jetcode offline mode",
    message: `Download ${pending.tag} for offline work?`,
    detail:
      `This is a ${size} download. jetcode will use it only on this machine, and it keeps working when the network is unavailable.\n\n` +
      "You can change or remove this model later. Nothing is downloaded until you choose Download model.",
  }
  const win = BrowserWindow.getAllWindows()[0]
  const result = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
  if (result.response !== 0) return

  mkdirSync(dataDir(), { recursive: true })
  writeFileSync(consentPath(), JSON.stringify({ tag: pending.tag, approvedAt: Date.now() }, null, 2))
}

/**
 * Polls the sidecar's offline inventory for a pending model download and asks
 * once per app run. The model is multi-gigabyte, so this is a real native
 * confirmation, not a toast that can disappear before it is read.
 */
export function registerOfflineModelPrompt() {
  let asked = false
  let stopped = false
  let timer: ReturnType<typeof setInterval> | undefined

  const poll = async () => {
    if (asked || stopped) return
    try {
      const status = JSON.parse(
        readFileSync(join(dataDir(), "jetcode-offline-model.json"), "utf8"),
      ) as OfflineStatus
      if (status.ollama?.autoPull !== "awaiting-confirmation") return
      asked = true
      await ask(status)
    } catch {
      // The inventory is advisory. A missing or partial file simply means wait.
    }
  }

  timer = setInterval(() => void poll(), 5_000)
  timer.unref?.()
  setTimeout(() => {
    stopped = true
    if (timer) clearInterval(timer)
  }, 10 * 60_000).unref?.()
  app.on("before-quit", () => {
    stopped = true
    if (timer) clearInterval(timer)
  })
  void poll()
}
