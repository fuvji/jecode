import { app, powerSaveBlocker } from "electron"

// Long agent turns spend most of their time waiting on a model stream or a
// build. Without a guard the OS can suspend the app when the window is
// unfocused or the display turns off, which pauses timers, stalls the stream
// and makes a running session look frozen. `prevent-app-suspension` keeps the
// process scheduled while still allowing the display to sleep, so it does not
// drain a laptop panel. One blocker covers the whole app lifetime; there is
// nothing to toggle per session and no way for a renderer to forget it.

let blocker: number | undefined

export function keepAwake(): void {
  if (blocker !== undefined && powerSaveBlocker.isStarted(blocker)) return
  blocker = powerSaveBlocker.start("prevent-app-suspension")
  app.once("will-quit", release)
}

function release() {
  if (blocker === undefined) return
  try {
    if (powerSaveBlocker.isStarted(blocker)) powerSaveBlocker.stop(blocker)
  } catch {
    // The process is exiting; a failed stop must not block shutdown.
  }
  blocker = undefined
}
