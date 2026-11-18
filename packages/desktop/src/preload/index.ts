import { contextBridge, ipcRenderer, webUtils } from "electron"
import {
  DragCancelEvent,
  IpcTransportPort,
  WindowSnapshotChannel,
  storageSnapshotNames,
  type WindowSnapshot,
} from "../shared/ipc-transport"
import { windowBootstrapFromArguments } from "../shared/window-bootstrap"

ipcRenderer.on(IpcTransportPort, (event) => {
  const port = event.ports[0]

  if (port) window.postMessage(IpcTransportPort, "*", [port])
})

ipcRenderer.on(DragCancelEvent, () => window.dispatchEvent(new Event(DragCancelEvent)))

const bootstrap = windowBootstrapFromArguments(process.argv)

// Asked before the page runs, so the stores the shell reads are hydrated on the first render.
const snapshot: Promise<WindowSnapshot> = ipcRenderer
  .invoke(WindowSnapshotChannel, storageSnapshotNames(bootstrap.id))
  .catch(() => ({ storage: {} }))

// jetcode narrow IPC surface for the license pill + the updater toast.
// Each method is an explicit named function; no generic `invoke(channel,
// ...)` pass-through. The renderer must not be able to call arbitrary
// ipcMain channels from a hostile page.
//
// updateStatus / installUpdate talk to registerUpdater in
// service/updater.ts. onUpdateReady lets the renderer FAB subscribe to
// the push event the main process fires when a download finishes +
// verifies, so the toast can appear without polling.
//
// Notes-field scrub: release notes used to flow through the IPC surface so
// the renderer could show them in the pill tooltip + confirm dialog. They
// were leaking the whole anti-piracy changelog ("DB wipe inside sidecar",
// "nonce ledger", "reverse-engineering") to any user who hovered the pill
// or clicked Install. The notes payload is now dropped at the preload
// boundary — only the version string crosses. Main still receives the raw
// notes from the Worker (fine; it's a server side-effect anyway) and keeps
// them in its own log for operator diagnostics, but nothing user-visible
// gets them.
type UpdateInfoPublic = { version: string }
const updateReadyListeners = new Set<(info: UpdateInfoPublic) => void>()
ipcRenderer.on("jetcode:update-ready", (_e, info: { version: string; notes?: string }) => {
  const scrubbed: UpdateInfoPublic = { version: info.version }
  updateReadyListeners.forEach((fn) => {
    try { fn(scrubbed) } catch { /* listener should not break the renderer */ }
  })
})

// License-status snapshot the pill polls. Prefix only, never the full key —
// the engine masks it in main (key.slice(0,5) + "…" + key.slice(-4)) and
// the renderer sees the masked form. days_left is derived from expires_at
// so the pill's countdown is accurate to the second the main process ran
// the check; the renderer re-polls on a 60s interval to keep it live.
type LicenseStatus =
  | { active: false; reason?: string }
  | {
      active: true
      key_prefix: string
      tier: string
      days_left: number
      expires_at: number
      email_masked?: string
    }

contextBridge.exposeInMainWorld("electron", {
  windowID: bootstrap.id,
  bootstrap,
  storageSnapshot: snapshot.then((snapshot) => snapshot.storage),
  plugins: snapshot.then((snapshot) => snapshot.plugins),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  jetcode: {
    openLicenseManage: () => ipcRenderer.invoke("jetcode:license-manage-open"),
    licenseStatus: () => ipcRenderer.invoke("jetcode:license-status") as Promise<LicenseStatus>,
    // Pull the full key on demand so the License pill's eye toggle can reveal
    // it. The status stream above never carries it; only this explicit per-
    // click fetch does. Shape matches `active | inactive` so the renderer
    // short-circuits when the engine has no key cached.
    licenseFullKey: () =>
      ipcRenderer.invoke("jetcode:license-full-key") as Promise<
        { active: true; key: string } | { active: false; reason?: string }
      >,
    // Theme persistence lives in the main process so it survives every
    // Electron relaunch (localStorage is per-session partition and gets
    // nuked on the Fresh-Desktop ritual, which is why the picked theme
    // kept reverting to aurora on next open). Reads + writes a tiny JSON
    // at <data-dir>/opencode/theme.json via IPC.
    themeGet: () => ipcRenderer.invoke("jetcode:theme-get") as Promise<string | null>,
    themeSet: (id: string) => ipcRenderer.invoke("jetcode:theme-set", id) as Promise<{ ok: boolean }>,
    // Average luminance of the display behind this window, 0..1. Only the
    // Clear kit calls it, on a timer, to decide dark-on-bright glyphs.
    backdropLuminance: () => ipcRenderer.invoke("jetcode:backdrop-luminance") as Promise<number | null>,
    updateStatus: async (): Promise<{ ready: boolean; version?: string }> => {
      const r = await (ipcRenderer.invoke("jetcode:update-status") as Promise<{ ready: boolean; version?: string; notes?: string }>)
      // Strip notes at the boundary; the renderer never sees them.
      return r?.ready ? { ready: true, version: r.version } : { ready: false }
    },
    installUpdate: () => ipcRenderer.invoke("jetcode:update-install") as Promise<{ ok: boolean; message?: string }>,
    // Native confirm dialog — the renderer's window.confirm() is suppressed
    // in sandboxed Chromium contexts under some Electron builds (the dialog
    // never appears and the call returns false), which read to users as
    // "clicking the pill does nothing". Routing through main's dialog
    // module guarantees a visible prompt every time.
    //
    // Deliberately no `notes` in the argument: main's dialog shows only the
    // version + a generic "will close and reopen" line. Zero technical
    // changelog leaks to the user.
    confirmUpdate: (info: { version: string }) =>
      ipcRenderer.invoke("jetcode:update-confirm", { version: info.version }) as Promise<{ ok: boolean }>,
    onUpdateReady: (fn: (info: UpdateInfoPublic) => void) => {
      updateReadyListeners.add(fn)
      return () => updateReadyListeners.delete(fn)
    },
    // Current app version baked into desktop/package.json at build time
    // (JETCODE_RELEASE_VERSION in the pipeline). Used by the subtle
    // top-middle version badge so users can glance at what they're on.
    appVersion: () => ipcRenderer.invoke("jetcode:app-version") as Promise<string>,
    // The renderer never receives the destination URL. It asks main to open
    // the site; main owns the constant and validates nothing from the caller.
    openWebsite: () => ipcRenderer.invoke("jetcode:open-website") as Promise<{ ok: boolean }>,
  },
})
