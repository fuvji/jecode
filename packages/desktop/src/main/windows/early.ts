import { randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { app, BrowserWindow, screen, shell } from "electron"
import { resolveExternalURL } from "../files/external-url"
import { devToolsEnabled } from "../service/shield"
import { windowArguments } from "./bootstrap"
import { WINDOW_IDS_KEY } from "../storage/keys"
import { getStore } from "../storage/store"
import { platformFrame, storedZoomLevel, tone } from "./defaults"
import {
  initialEarlyWindowState,
  isEarlyWindowClosed,
  transitionEarlyWindow,
  type EarlyWindowCommand,
  type EarlyWindowEvent,
} from "./early-machine"
import { registerRendererProtocol } from "./protocol"
import { persistedWindowIDs } from "./registry"
import { loadWindow } from "./scheme"
import { allowRendererPermissions, wireNavigationPolicy, wireRendererHeaders } from "./security"
import {
  manageWindowState,
  readWindowState,
  resolveWindowState,
  windowStateFile,
  type WindowState,
} from "./window-state"

export type EarlyWindow = {
  readonly id: string
  readonly win: BrowserWindow
  readonly state: WindowState
  readonly shownAt: number
}

const current = { state: initialEarlyWindowState<EarlyWindow>() }

const dispatch = (event: EarlyWindowEvent<EarlyWindow>) => {
  const next = transitionEarlyWindow(current.state, event)
  current.state = next.state
  next.commands.forEach(perform)

  return next.commands
}

const perform = (command: EarlyWindowCommand<EarlyWindow>) => {
  if (command.type === "open-external-early") {
    const target = resolveExternalURL(command.url)

    if (target) void shell.openExternal(target)

    return
  }

  if (command.type === "open-external-adopted") return command.openExternal(command.url)

  if (command.type === "destroy-early") {
    if (!command.entry.win.isDestroyed()) command.entry.win.destroy()

    return
  }

  if (command.type === "quit") app.quit()
}

const displays = {
  all: () => screen.getAllDisplays().map((display) => display.bounds),
  primary: () => screen.getPrimaryDisplay().bounds,
  matching: (bounds: Electron.Rectangle) => screen.getDisplayMatching(bounds).bounds,
}

// jetcode splash sentinel. The WPF splash (scripts/splash.ps1) previously
// polled `Get-Process -Name electron` for a window-title heuristic that drifted
// every time the first-paint title changed, leaving the splash stuck on screen
// until its 90s deadline. Writing a flag file the moment the first window shows
// gives the splash a deterministic close signal with no title coupling.
//
// Fires on both `ready-to-show` (renderer-painted) and `show` (BrowserWindow
// visible). Belt-and-suspenders: Linux/Wayland occasionally swallows
// ready-to-show, and the `show` path catches the deferReveal branch on
// maximized Windows launches. Multiple writes are idempotent -- same path,
// same shape, splash only inspects mtime.
//
// os.tmpdir() returns the user-level temp directory; the splash reads from
// $env:TEMP which resolves to the same path on Windows. One file name is
// shared across every launch; the splash clears a stale one older than ~60s
// at startup so a previous Electron's write can't false-close the current
// splash.
const SPLASH_READY_FLAG = path.join(os.tmpdir(), "jetcode-splash-done.flag")
function writeSplashReadyFlag() {
  try {
    fs.writeFileSync(SPLASH_READY_FLAG, `${process.pid}\n${Date.now()}\n${app.getVersion()}\n`)
  } catch {
    /* best-effort; splash has a window-title + 90s deadline fallback */
  }
}

// Creates and shows the first restored window the moment Electron is ready, before the rest of the
// main process has loaded. The frame options mirror windowAppearance(); the persisted background
// colour stands in for the theme until the renderer applies it, so the window is on screen while the
// bundle, the layers and the renderer boot. restoreWindows() adopts it through restoreEarlyWindow().
export function createEarlyWindow() {
  const id = persistedWindowIDs(getStore().get(WINDOW_IDS_KEY))[0] ?? randomUUID()
  const root = path.dirname(fileURLToPath(import.meta.url))
  const file = path.join(app.getPath("userData"), windowStateFile(id))
  const state = resolveWindowState(readWindowState(file), { width: 1280, height: 800 }, displays)
  const zoom = storedZoomLevel()
  const icons = app.isPackaged ? path.join(process.resourcesPath, "icons") : path.join(root, "../../resources/icons")

  // On Windows, maximize() on a hidden window shows it with SW_SHOWMAXIMIZED, so it never paints at
  // its normal bounds first. macOS does not reliably enter fullscreen while hidden, so it shows first.
  const deferReveal = process.platform === "win32" && state.isMaximized

  const win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    show: !deferReveal,
    autoHideMenuBar: true,
    title: "jetcode",
    icon: path.join(icons, `icon.${process.platform === "win32" ? "ico" : "png"}`),
    // The first window is adopted by the full window manager. Transparency
    // must be enabled here at construction; it cannot be added on adoption.
    transparent: true,
    backgroundColor: "#00000000",
    ...platformFrame(tone(), zoom),
    webPreferences: {
      preload: path.join(root, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Same rule as the full window: no inspector on a packaged renderer.
      devTools: devToolsEnabled(),
      // jetcode: keep timers, rAF and compositing running at full rate while
      // the window is in the background, matching foreground performance.
      backgroundThrottling: false,
      // The renderer boots in this window, so it starts at the saved zoom instead of jumping to it later.
      zoomFactor: zoom,
      additionalArguments: windowArguments(id),
    },
  })

  manageWindowState(win, file, state, displays)

  if (deferReveal) win.show()

  const entry: EarlyWindow = { id, win, state, shownAt: Date.now() }

  dispatch({ type: "early.created", id, entry })
  win.once("ready-to-show", writeSplashReadyFlag)
  win.once("show", writeSplashReadyFlag)
  win.once("closed", () => dispatch({ type: "early.closed", entry }))
  // The renderer boots while the main bundle and layers load, instead of after them. Everything the
  // page needs before its first request is wired here; the IPC port arrives once the layers are up.
  registerRendererProtocol(path.join(root, "../renderer"))
  allowRendererPermissions(win)
  wireNavigationPolicy(win, (url) => dispatch({ type: "external.opened", entry, url }))
  wireRendererHeaders(win)
  loadWindow(win, "index.html")
}

/** The user closed the first window before the layers adopted it, so the app is quitting. */
export function earlyWindowClosed() {
  return isEarlyWindowClosed(current.state)
}

/**
 * Plans the windows to restore: the early window is adopted when its id is still persisted, and nothing is restored
 * once it closed. Its external links switch to `openExternal`.
 */
export function restoreEarlyWindow(input: {
  ids: readonly string[]
  fallbackId: string
  openExternal: (url: string) => void
}) {
  const pending = current.state.status === "pending" ? current.state.entry : undefined

  return dispatch({
    type: "restore.requested",
    ids: input.ids,
    fallbackId: input.fallbackId,
    destroyed: !!pending?.win.isDestroyed(),
    openExternal: input.openExternal,
  }).flatMap((command) => (command.type === "restore-windows" ? command.plan : []))
}
