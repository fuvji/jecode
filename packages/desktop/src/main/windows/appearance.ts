import { app, BrowserWindow, nativeImage, nativeTheme } from "electron"
import type { DesktopZoomLevel } from "@opencode/app/desktop-menu"
import type { Path } from "effect"
import { type TitlebarTheme } from "../../shared/ipc-contract"
import {
  WindowFocusChanged,
  WindowFullscreenChanged,
  WindowPinchZoomChanged,
  WindowZoomChanged,
} from "../../shared/ipc-rpc/events"
import { emitIpcEvent } from "../ipc-events"
import type { DesktopPaths } from "../paths"
import { BACKGROUND_COLOR_KEY, PINCH_ZOOM_ENABLED_KEY, ZOOM_LEVEL_KEY } from "../storage/keys"
import { getStore } from "../storage/store"
import { platformFrame, savedBackgroundColor, storedZoomLevel, titlebarOverlay, tone } from "./defaults"
import { devToolsEnabled } from "../service/shield"

const titlebarThemes = new WeakMap<BrowserWindow, Partial<TitlebarTheme>>()

const pinchZoomEnabled = new WeakMap<BrowserWindow, boolean>()

const maxZoomLevel = 10

const minZoomLevel = 0.2

let backgroundColor: string | undefined

// The one background value that means "let the desktop through". Every other
// value is an opaque colour painted over the webview.
const TRANSPARENT_BACKGROUND = "#00000000"

export function windowAppearance(path: Path.Path, paths: DesktopPaths.Resolved) {
  return {
    title: "jetcode",
    icon: iconPath(path, paths),
    // The Clear theme reveals the desktop through #root, which requires a
    // per-pixel transparent window. Opaque kits paint their base colour over
    // the whole webview, so the transparency is invisible for them.
    transparent: true,
    backgroundColor: "#00000000",
    ...platformFrame(tone(), storedZoomLevel()),
    webPreferences: {
      preload: paths.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Packaged builds have no DevTools: the renderer holds the preload
      // bridge, so an inspector there is a live handle on every IPC call.
      devTools: devToolsEnabled(),
      // jetcode: no background timer/rAF throttling, so sessions keep the
      // same throughput when the window is not focused.
      backgroundThrottling: false,
    },
  }
}

export function setDockIcon(path: Path.Path, paths: DesktopPaths.Resolved) {
  if (process.platform !== "darwin") return
  const icon = nativeImage.createFromPath(path.join(iconsDir(path, paths), "dock.png"))

  if (!icon.isEmpty()) app.dock?.setIcon(icon)
}

export function setBackgroundColor(color: string) {
  // The renderer reports its theme background on every boot; electron-store rewrites and fsyncs the
  // settings file on each set, so only persist a change.
  if (getBackgroundColor() !== color) getStore().set(BACKGROUND_COLOR_KEY, color)
  backgroundColor = color
  BrowserWindow.getAllWindows().forEach((win) => {
    win.setBackgroundColor(color)

    if (process.platform === "darwin") win.invalidateShadow()
  })
}

export function getBackgroundColor() {
  return backgroundColor ?? savedBackgroundColor()
}

export function setTitlebar(win: BrowserWindow, theme: Partial<TitlebarTheme> = {}) {
  titlebarThemes.set(win, theme)

  // Native window controls follow nativeTheme, not the renderer theme.
  if (process.platform === "darwin" || process.platform === "win32") {
    nativeTheme.themeSource = theme.scheme ?? theme.mode ?? "system"
  }

  updateTitlebar(win)
}

export function setTrafficLightsPosition(win: BrowserWindow, position: { x: number; y: number }) {
  if (process.platform !== "darwin") return
  win.setWindowButtonPosition({ x: Math.round(position.x), y: Math.round(position.y) })
}

export function updateTitlebar(win: BrowserWindow) {
  if (process.platform !== "win32") return
  win.setTitleBarOverlay(overlay(titlebarThemes.get(win), win.webContents.getZoomFactor()))
}

export function setPinchZoomEnabled(enabled: boolean) {
  getStore().set(PINCH_ZOOM_ENABLED_KEY, enabled)
  BrowserWindow.getAllWindows().forEach((win) => {
    pinchZoomEnabled.set(win, enabled)
    emitIpcEvent(win.webContents, new WindowPinchZoomChanged({ enabled }))

    if (!enabled) win.webContents.setZoomFactor(storedZoomLevel())
    updateZoom(win)
  })
}

export function getPinchZoomEnabled() {
  return getStore().get(PINCH_ZOOM_ENABLED_KEY) === true
}

// Saves the level and applies it to every window. A pinch zooms one window without saving.
export function setZoomLevel(level: DesktopZoomLevel) {
  if (storedZoomLevel() !== level) getStore().set(ZOOM_LEVEL_KEY, level)
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.setZoomFactor(level)
    updateZoom(win)
  })
}

export function wireZoom(win: BrowserWindow) {
  pinchZoomEnabled.set(win, getPinchZoomEnabled())
  win.webContents.setZoomFactor(storedZoomLevel())
  updateTitlebar(win)
  win.webContents.on("zoom-changed", (event, direction) => {
    event.preventDefault()

    if (pinchZoomEnabled.get(win)) {
      const delta = direction === "in" ? 0.2 : -0.2
      win.webContents.setZoomFactor(clampZoom(win.webContents.getZoomFactor() + delta))
      updateZoom(win)

      return
    }

    win.webContents.setZoomFactor(storedZoomLevel())
    updateZoom(win)
  })
}

export function wireFullscreen(win: BrowserWindow) {
  const send = (fullscreen: boolean) => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    emitIpcEvent(win.webContents, new WindowFullscreenChanged({ fullscreen }))
  }

  win.on("enter-full-screen", () => {
    send(true)
    reassertTransparency(win)
  })
  win.on("leave-full-screen", () => {
    send(false)
    reassertTransparency(win)
  })
  // Releasing the top spot on blur keeps alt-tab behaving normally; the window
  // takes it back when it is focused again while still fullscreen.
  win.on("blur", () => {
    if (process.platform === "win32" && win.isFullScreen()) win.setAlwaysOnTop(false)
  })
  win.on("focus", () => {
    if (process.platform === "win32" && win.isFullScreen()) win.setAlwaysOnTop(true, "screen-saver")
  })
}

// Windows can hand a transparent window back to the compositor as an opaque
// surface across a fullscreen transition, and the frame after it flickers
// while the surface is reallocated. Re-declaring the transparent backing
// colour and forcing a frame at the transition and just after it puts the
// alpha surface back without touching the window state.
//
// A transparent window also never gets the shell's exclusive-fullscreen
// treatment, so the taskbar keeps drawing over it. Raising the window into the
// topmost band while it is fullscreen covers the taskbar and restores the
// fullscreen look.
function reassertTransparency(win: BrowserWindow) {
  if (process.platform !== "win32") return
  const fullscreen = win.isFullScreen()
  win.setAlwaysOnTop(fullscreen, "screen-saver")
  if (getBackgroundColor() !== TRANSPARENT_BACKGROUND) return
  const apply = () => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    win.setBackgroundColor(TRANSPARENT_BACKGROUND)
    win.webContents.invalidate()
  }
  apply()
  setTimeout(apply, 80)
  setTimeout(apply, 300)
}

export function wireFocus(win: BrowserWindow) {
  const send = (focused: boolean) => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    emitIpcEvent(win.webContents, new WindowFocusChanged({ focused }))
  }

  win.on("focus", () => send(true))
  win.on("blur", () => send(false))
}

function iconsDir(path: Path.Path, paths: DesktopPaths.Resolved) {
  return app.isPackaged ? path.join(process.resourcesPath, "icons") : path.join(paths.developmentResourcesRoot, "icons")
}

function iconPath(path: Path.Path, paths: DesktopPaths.Resolved) {
  return path.join(iconsDir(path, paths), `icon.${process.platform === "win32" ? "ico" : "png"}`)
}

function overlay(theme: Partial<TitlebarTheme> = {}, zoom = 1) {
  return titlebarOverlay(theme.mode ?? tone(), zoom)
}

function clampZoom(value: number) {
  return Math.min(Math.max(value, minZoomLevel), maxZoomLevel)
}

function updateZoom(win: BrowserWindow) {
  updateTitlebar(win)
  emitIpcEvent(
    win.webContents,
    new WindowZoomChanged({ factor: win.webContents.getZoomFactor(), level: storedZoomLevel() }),
  )
}
