// Imported first so its evaluation stamps the moment Electron handed control to this module.
import { marks } from "./lifecycle/marks"
import { app } from "electron"
import { acquireApplicationLock, configureApplication } from "./lifecycle/configure"
import { assertNoDebugEndpoint, installShield } from "./service/shield"
import { ensureLicensedOrPrompt } from "./service/license-gate"
import { keepAwake } from "./lifecycle/power"
import { startSidecarProbe } from "./service/sidecar-probe"
import { registerLicenseManagement } from "./service/license-gate"
import { registerUpdater } from "./service/updater"
import { assertBrandPinned, registerBrand } from "./service/brand"
import { registerStorageSnapshotHandler } from "./storage/snapshot"
import { createEarlyWindow, earlyWindowClosed } from "./windows/early"
import { registerOfflineModelPrompt } from "./service/offline-model"
import { rendererAssetsServed } from "./windows/protocol"
import { registerRendererScheme } from "./windows/scheme"

// This module stays small on purpose. Electron holds the ready event until the entry module has
// finished, and the first window should be on screen before the rest of the main process — a few
// hundred milliseconds of module evaluation and layers — loads. Configuration and the scheme must
// precede ready; the window is created the moment ready fires; everything else is imported after.
configureApplication()

// The license gate owns the only window until activation succeeds. Destroying
// that dialog must not trigger Electron's default quit-on-last-window behavior
// before the main window is created; the lifecycle layer installs the real
// handler after the gate. Without this listener a fresh activation writes the
// license cache and then exits instead of opening the app.
app.on("window-all-closed", () => {})

// Removes Chromium debugging endpoints on packaged builds before the first
// window can be attached to. Development builds are untouched.
installShield()

if (acquireApplicationLock()) {
  registerRendererScheme()
  // The website pill opens this handler. The URL never crosses into the
  // renderer, so a patched renderer cannot redirect it.
  registerBrand()
  // Window first, then the bundle: starting the import before ready delays ready itself, because the
  // module graph evaluates on the same thread Chromium needs to finish initialising.
  void app.whenReady().then(async () => {
    marks.ready = Date.now()
    assertNoDebugEndpoint()
    // Refuse to show a window if the signed renderer no longer carries the
    // website pill. This runs before the license gate, so it applies to paid
    // and free trees alike.
    assertBrandPinned()
    // Hard gate. Nothing below this line runs - no storage snapshot, no window,
    // no sidecar, no plugins - until a key is present and the engine reports it
    // active. A cancelled dialog quits the app; it must never fall through to a
    // usable window.
    try {
      await ensureLicensedOrPrompt()
    } catch {
      app.quit()
      return
    }
    registerStorageSnapshotHandler()
    createEarlyWindow()
    registerOfflineModelPrompt()
    marks.window = Date.now()
    registerLicenseManagement()
    registerUpdater()
    // Long agent turns must not be suspended when the window is unfocused.
    keepAwake()
    startSidecarProbe()

    // The window's renderer is already loading. Its HTML and preloaded chunks are served from this
    // thread, so the bundle waits for that burst to be answered (or a cap) before it evaluates.
    if (!process.env.ELECTRON_RENDERER_URL) await rendererAssetsServed({ quietMs: 40, capMs: 400 })
    marks.served = Date.now()

    // Closing the first window before now quit the app; loading the layers would only start work it interrupts.
    if (earlyWindowClosed()) return

    return import("./desktop")
  })
}
