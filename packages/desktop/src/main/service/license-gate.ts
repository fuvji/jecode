import { licenseAppearance, licenseBackground, licenseThemeListener } from "./license-appearance"
// jetcode license gate for the desktop app.
//
// Runs once on app.whenReady(), before startSidecarProbe. If the local
// license.json verifies, resolves and the desktop boots. Otherwise opens
// a small modal BrowserWindow with a key-entry form; on successful
// activate it resolves and boot continues. If the user closes the window
// without a valid key, the function calls app.quit() and the desktop
// never spawns a backend.
//
// Historically this file execFile'd `opencode-cli license status|activate`
// to talk to the CLI's licensing engine. That shelled out ~400 ms per
// check, forked a 283 MB SHA-256-of-self integrity probe every time, and
// broke whenever the CLI binary moved or started slowly. The engine is
// now ported into Electron main (see ./licensing-engine.ts); the dialog
// talks to it directly over IPC, no spawn.
//
// The CLI's own `jetcode license activate` subcommand still exists for
// terminal users; it reads/writes the SAME license.json this engine does,
// so a key activated here works for the CLI sidecar and vice-versa.

import { app, BrowserWindow, desktopCapturer, ipcMain, Menu, powerMonitor, screen, shell } from "electron"
import { installedBuild } from "./shield"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import tls from "node:tls"
import https from "node:https"
import { LicensingEngine } from "./licensing-engine"

// Release-build log gate. In a dev / non-release artifact the gate's internals
// stay printable (developer context). In a release build every console.log in
// this module collapses to a no-op so a reverser running strings/ProcMon
// against the installed Electron process cannot grep for "[jetcode-license-
// gate]" or any of the prefixes that name the activation flow, IPC channels,
// or dialog states. Gated on the baked pubkey sentinel (same signal the
// engine uses to tell release apart from dev).
function noopLog(..._args: unknown[]): void {}

// Directive cross-check on boot. The Reset-pill flow spawns us with the
// signed directive token in JETCODE_DIRECTIVE_TOKEN. We re-verify the
// Ed25519 signature here against the baked pubkey, confirm the k_prefix
// binds to the loaded licence, and confirm the nonce appears in the
// launcher's consumed-nonces ledger (proof the launcher actually ran its
// gate rather than a reverser constructing a plausible env).
//
// First-launch cold boot (no env token) has no bind to a Reset flow; skip
// this check and let the normal licence-cache gate carry the floor.
//
// A PID-liveness watchdog was considered and dropped: the launcher spawns
// Electron detached then exits, so the PID is always dead by the time we
// read it. The nonce-in-ledger check gives the same guarantee without the
// timing fragility -- a reverser who fabricates a token also needs to have
// walked the launcher's Test-DirectiveValid + Record-Nonce path, which
// requires the Ed25519 verify to have passed in the first place.
declare const JETCODE_LICENSE_PUBKEY: string | undefined
const GATE_PUBKEY =
  (typeof JETCODE_LICENSE_PUBKEY === "string" && JETCODE_LICENSE_PUBKEY) || "dev-pubkey-replace"
const GATE_IS_RELEASE = GATE_PUBKEY !== "dev-pubkey-replace" && GATE_PUBKEY.length > 0

// Release builds get the no-op logger; dev keeps console.log. Reassigned once
// at module load so the hot path is a single reference deref, not a branch.
const LOG: (...args: unknown[]) => void = GATE_IS_RELEASE ? noopLog : console.log.bind(console)

function b64urlDecodeGate(input: string): Buffer {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4))
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64")
}

function checkDirectiveEnv(): void {
  // Dev builds skip the whole check -- there is no real pubkey to verify
  // against and the env token is likely absent anyway.
  if (!GATE_IS_RELEASE) return
  const token = process.env.JETCODE_DIRECTIVE_TOKEN
  if (!token) return // cold-boot path, not a Reset-driven launch
  try {
    const dot = token.indexOf(".")
    if (dot < 0) throw new Error("directive malformed")
    const payloadB64 = token.slice(0, dot)
    const sigB64 = token.slice(dot + 1)
    const payload = JSON.parse(b64urlDecodeGate(payloadB64).toString("utf8")) as {
      type?: string; n?: string; e?: number; k_prefix?: string
    }
    const pem = Buffer.from(GATE_PUBKEY, "base64").toString("utf8")
    const pk = crypto.createPublicKey(pem)
    const ok = crypto.verify(null, Buffer.from(payloadB64, "utf8"), pk, b64urlDecodeGate(sigB64))
    if (!ok) throw new Error("directive signature invalid")
    if (payload.type !== "reset-directive-v1") throw new Error("directive wrong type")
    if (!payload.n) throw new Error("directive missing nonce")
    // Do NOT fail on expired directive. By the time Electron reads this,
    // the launcher has already consumed the nonce and the Reset flow
    // crossed the critical destructive steps; the 60s TTL is a server-
    // side freshness guarantee at ISSUE time, not an Electron-side gate.
    // A cold Tor bootstrap routinely pushes past 60s, so enforcing exp
    // here would false-positive legitimate slow boots.
    // Confirm the launcher's ledger recorded this exact nonce. Absence
    // means we were launched with an env token that never made it through
    // Test-DirectiveValid + Record-Nonce -- i.e. a forged env, not a real
    // Reset click.
    const state = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state")
    const ledger = path.join(state, "opencode", "consumed-nonces.log")
    if (!fs.existsSync(ledger)) throw new Error("nonce ledger missing")
    // Line format is "<unix_ts> <nonce>". Tokenise instead of substring-
    // matching so an all-digit nonce can't false-positive against a
    // timestamp prefix. Nonce-field equality is the right check.
    const lines = fs.readFileSync(ledger, "utf8").split(/\r?\n/)
    let found = false
    for (const line of lines) {
      const sp = line.indexOf(" ")
      if (sp < 0) continue
      if (line.slice(sp + 1).trim() === payload.n) { found = true; break }
    }
    if (!found) throw new Error("nonce not in ledger")
  } catch (e) {
    LOG("[jetcode-license-gate] directive env check failed:", (e as Error).message)
    app.quit()
    throw e
  }
}
// Silence unused-import warnings for libs we only reference inside
// checkDirectiveEnv's try body via type inference from node:crypto.
void tls; void https

// Kept exported for existing callers that still want the CLI binary path
// (desktop-cli.ts resolves it independently; this re-export just keeps
// the public surface stable).
export { resolveCliBinary } from "./cli-binary"

export interface GateDeps {
  // Not used by the engine, but kept so the caller signature in
  // packages/desktop/src/main/index.ts (patched in by scripts/sync.sh)
  // does not have to change.
  readonly cliBinary?: string
}

let engineInstance: LicensingEngine | undefined
function engine(): LicensingEngine {
  if (!engineInstance) engineInstance = new LicensingEngine()
  return engineInstance
}

function licenseThemeId(): string {
  try {
    const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
    const value = JSON.parse(fs.readFileSync(path.join(base, "opencode", "theme.json"), "utf8"))
    return typeof value.id === "string" ? value.id : "aurora"
  } catch { return "aurora" }
}

function dialogHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';" />
<title>jetcode — License</title>
${licenseAppearance(licenseThemeId())}
</head>
<body>
<div class="card">
  <div class="brand"><span class="brand-mark" aria-hidden="true">jC</span><span>jetcode</span><span class="eyebrow">Workspace access</span></div>
  <h1>Enter license key</h1>
  <p class="sub">One key per machine. Get a free key for this machine, or paste a key you already have.</p>
  <label for="email">Email</label>
  <input id="email" type="email" autocomplete="email" spellcheck="false" placeholder="the email your key was issued to" />
  <div class="labelrow"><label for="key" style="margin-top:12px;">License key</label><button id="paste" class="link" type="button">Paste key</button></div>
  <input id="key" type="text" autocomplete="off" spellcheck="false" placeholder="paste your key" />
  <div class="key-actions">
    <button id="getkey" class="ghost" type="button">Get a free key</button>
    <span id="keyhint" class="hint">Requests a key for this machine and activates it.</span>
  </div>
  <div class="row">
    <label class="remember"><input id="remember" type="checkbox" checked /> Remember me</label>
    <button id="go" class="primary">Activate</button>
  </div>
  <div id="status" class="status" role="status" aria-live="polite"></div>
</div>
<script>
  const { ipcRenderer, clipboard } = require('electron')
  ${licenseThemeListener()}
  const emailInput = document.getElementById('email')
  const input = document.getElementById('key')
  const btn = document.getElementById('go')
  const getkey = document.getElementById('getkey')
  const paste = document.getElementById('paste')
  const status = document.getElementById('status')
  const remember = document.getElementById('remember')

  const normaliseKey = (value) => {
    // Keep variable-length keys intact. Grouping is cosmetic: the server is
    // still the authority on whether the key was issued and is redeemable.
    const raw = String(value || '').toUpperCase().replace(/[^0-9A-Z]/g, '')
    return (raw.match(/.{1,5}/g) || []).join('-')
  }

  const validEmail = (value) => {
    const at = value.lastIndexOf('@')
    return at > 0 && at === value.indexOf('@') && at < value.length - 3 && value.slice(at + 1).includes('.')
  }

  const setStatus = (message, kind) => {
    status.className = 'status' + (kind ? ' ' + kind : '')
    status.textContent = message
  }

  const setBusy = (busy, message) => {
    btn.disabled = busy
    getkey.disabled = busy
    paste.disabled = busy
    btn.setAttribute('aria-busy', busy ? 'true' : 'false')
    if (message) setStatus(message)
  }

  const fieldError = (field, message) => {
    if (field === 'email') {
      emailInput.classList.add('error')
      emailInput.setAttribute('aria-invalid', 'true')
      emailInput.focus()
    } else {
      input.classList.add('error')
      input.setAttribute('aria-invalid', 'true')
      input.focus()
    }
    setStatus(message, 'err')
  }

  const validateKey = (key, email) => {
    const raw = key.replace(/-/g, '')
    if (!raw) return { field: 'key', message: 'Enter your license key to continue.' }
    if (raw.length < 10) return { field: 'key', message: 'That key looks too short. Paste the full key from your email.' }
    if (raw.length > 128) return { field: 'key', message: 'That key looks too long. Paste only the license key.' }
    if (email && !validEmail(email)) return { field: 'email', message: 'Enter a valid email address, or leave it blank.' }
    return null
  }

  const activate = async (key, email) => {
    setBusy(true, 'Activating…')
    const r = await ipcRenderer.invoke('jetcode:license-activate', { key, email, remember: remember.checked }).catch(() => ({ ok: false, message: 'Unable to reach the licensing service. Check your connection and try again.' }))
    if (r && r.ok) {
      setStatus(r.message || 'Activated. Opening jetcode…', 'ok')
      return true
    }
    setBusy(false)
    const msg = (r && r.message) || 'Activation failed. Please try again.'
    if (/email/i.test(msg)) fieldError('email', msg)
    else if (/key|licen[cs]e|machine|activation|unknown|expired|revoked/i.test(msg)) fieldError('key', msg)
    else setStatus(msg, 'err')
    return false
  }

  input.addEventListener('input', () => {
    input.value = normaliseKey(input.value)
    input.classList.remove('error')
    input.removeAttribute('aria-invalid')
    setStatus('')
  })

  emailInput.addEventListener('input', () => {
    emailInput.classList.remove('error')
    emailInput.removeAttribute('aria-invalid')
    setStatus('')
  })

  const trySubmit = (e) => {
    if (e.key !== 'Enter' || btn.disabled) return
    e.preventDefault()
    btn.click()
  }
  input.addEventListener('keydown', trySubmit)
  emailInput.addEventListener('keydown', trySubmit)

  btn.addEventListener('click', async () => {
    const key = normaliseKey(input.value)
    input.value = key
    const email = emailInput.value.trim()
    const problem = validateKey(key, email)
    if (problem) { fieldError(problem.field, problem.message); return }
    await activate(key, email)
  })

  paste.addEventListener('click', async () => {
    let text = ''
    try { text = clipboard.readText() } catch {}
    if (!text) {
      try { text = await navigator.clipboard.readText() } catch {}
    }
    const match = String(text || '').toUpperCase().match(/[0-9A-Z]{5}(?:-[0-9A-Z]{5}){1,}|[0-9A-Z]{10,}/)
    if (!match) {
      setStatus('The clipboard does not contain a license key.', 'err')
      input.focus()
      return
    }
    input.value = normaliseKey(match[0])
    input.classList.remove('error')
    input.removeAttribute('aria-invalid')
    setStatus('Key pasted. Review it, then activate.', 'ok')
    input.focus()
  })

  getkey.addEventListener('click', async () => {
    const email = emailInput.value.trim()
    if (!email) { fieldError('email', 'Enter your email to request a free key.'); return }
    if (!validEmail(email)) { fieldError('email', 'Enter a valid email address.'); return }
    setBusy(true, 'Requesting a free key…')
    const r = await ipcRenderer.invoke('jetcode:license-free-key', { email }).catch(() => ({ ok: false, message: 'Unable to reach the licensing service. Check your connection and try again.' }))
    if (!r || !r.ok || !r.key) {
      setBusy(false)
      const msg = (r && r.message) || 'Free key request failed. Please try again.'
      // Only address/email validation failures belong on the email field.
      // Network, rate-limit, and signing-service failures are status errors.
      if (/email/i.test(msg)) fieldError('email', msg)
      else setStatus(msg, 'err')
      return
    }
    input.value = normaliseKey(r.key)
    setStatus('Free key received — activating…', 'ok')
    await activate(input.value, email)
  })

  emailInput.focus()
</script>
</body>
</html>`
}

function markCacheWipeOnQuit(): void {
  app.once("before-quit", () => {
    try {
      engine().clear()
    } catch {
      /* best effort */
    }
  })
}

let firstRunWindow: BrowserWindow | null = null

function showDialog(): Promise<boolean> {
  // Guard against double-open. Swap-key triggers showDialog mid-session; if a
  // first-run dialog is already visible (startup path ran, user never
  // dismissed it), just focus it and fold both callers into the same resolved
  // value. Prevents the ipcMain.handle("jetcode:license-activate", ...)
  // registration below from throwing on duplicate.
  if (firstRunWindow && !firstRunWindow.isDestroyed()) {
    firstRunWindow.focus()
    firstRunWindow.moveTop()
    return new Promise((resolve) => {
      firstRunWindow!.once("closed", () => resolve(engineInstance ? engineInstance.load() !== undefined : false))
    })
  }
  // Idempotent removal. A prior showDialog may have resolved and cleared its
  // handlers inside settle(), but mid-session swap-key paths can re-enter
  // before the Promise rejection propagates. Clearing first makes handle()
  // below safe regardless of call history.
  try { ipcMain.removeHandler("jetcode:license-activate") } catch { /* no prior */ }
  try { ipcMain.removeHandler("jetcode:license-free-key") } catch { /* no prior */ }
  LOG("[jetcode-license-gate] opening dialog (in-process engine)")
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 540,
      height: 600,
      resizable: true,
      minWidth: 340,
      minHeight: 420,
      maximizable: false,
      minimizable: true,
      fullscreenable: false,
      autoHideMenuBar: true,
      alwaysOnTop: true,
      center: true,
      show: false,
      backgroundColor: licenseBackground(licenseThemeId()),
      title: "jetcode",
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false,
      },
    })
    firstRunWindow = win

    let settled = false
    const settle = (ok: boolean) => {
      if (settled) return
      settled = true
      LOG("[jetcode-license-gate] dialog settling, activated:", ok)
      ipcMain.removeHandler("jetcode:license-activate")
      ipcMain.removeHandler("jetcode:license-free-key")
      if (firstRunWindow === win) firstRunWindow = null
      if (!win.isDestroyed()) win.destroy()
      resolve(ok)
    }

    ipcMain.handle(
      "jetcode:license-activate",
      async (_evt, payload: { key: string; email?: string; remember: boolean }) => {
        LOG(
          "[jetcode-license-gate] activate request, key prefix:",
          payload.key.slice(0, 5),
          "email:",
          payload.email ? payload.email.replace(/(.{2}).+(@.+)/, "$1***$2") : "<empty>",
        )
        try {
          const r = await engine().activate(payload.key, payload.email)
          LOG("[jetcode-license-gate] activated:", r)
          if (!payload.remember) markCacheWipeOnQuit()
          setTimeout(() => settle(true), 400)
          return { ok: true, message: `activated — tier ${r.tier}` }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          LOG("[jetcode-license-gate] activate failed:", message)
          return { ok: false, message }
        }
      },
    )

    ipcMain.handle(
      "jetcode:license-free-key",
      async (_evt, payload: { email?: string }) => {
        const email = payload?.email?.trim().toLowerCase() ?? ""
        if (!email || !email.includes("@") || !email.split("@")[1]?.includes(".")) {
          return { ok: false, message: "Enter a valid email address." }
        }
        LOG(
          "[jetcode-license-gate] free-key request, email:",
          email.replace(/(.{2}).+(@.+)/, "$1***$2"),
        )
        try {
          const r = await engine().requestFreeKey(email)
          LOG("[jetcode-license-gate] free key issued")
          return { ok: true, key: r.key }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          LOG("[jetcode-license-gate] free-key failed:", message)
          return { ok: false, message }
        }
      },
    )

    win.webContents.on("did-fail-load", (_e, code, desc, url) => {
      LOG("[jetcode-license-gate] did-fail-load:", code, desc, url.slice(0, 80))
    })
    win.webContents.on("console-message", (_e, level, message) => {
      LOG("[jetcode-license-gate] renderer console:", level, message)
    })
    win.webContents.on("did-finish-load", () => {
      LOG("[jetcode-license-gate] did-finish-load — dialog HTML ready")
    })

    let revealed = false
    const reveal = () => {
      if (revealed || win.isDestroyed()) return
      revealed = true
      win.show()
      win.focus()
      win.moveTop()
      setTimeout(() => !win.isDestroyed() && win.setAlwaysOnTop(false), 2500)
    }

    win.once("ready-to-show", reveal)
    win.on("closed", () => settle(false))

    void win
      .loadURL("data:text/html;charset=utf-8," + encodeURIComponent(dialogHtml()))
      .then(() => {
        reveal()
      })
      .catch((err) => {
        LOG("[jetcode-license-gate] loadURL failed:", err)
        settle(false)
      })
  })
}

const HEARTBEAT_MS = 30_000
// Local key/HWID/token checks stay at 30s for instant lockout. The server
// revocation poll is 15 minutes: 5 minutes was 288 Worker requests per user
// per day and helped exhaust the free plan. Revocation still lands within
// one local check after the next server poll.
const SERVER_HEARTBEAT_MS = 15 * 60_000
let heartbeatTimer: ReturnType<typeof setInterval> | undefined
let heartbeatBusy = false
let lastServerCheck = 0

function lockOut(reason: string): void {
  LOG("[jetcode-license-gate] heartbeat lockout:", reason)
  try {
    engine().clear()
  } catch {
    /* best effort */
  }
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = undefined
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      if (!win.isDestroyed()) win.destroy()
    } catch {
      /* best effort */
    }
  }
  app.quit()
  // app.quit() drains the sidecar and window teardown; force the exit if a
  // wedged child keeps the quit promise pending.
  setTimeout(() => app.exit(1), 900)
}

/**
 * Starts the running-session key heartbeat. Local status is checked every
 * 30 seconds (file present, token valid, HWID matches, not expired) and the
 * Worker is asked every 5 minutes. A missing/invalid key locks immediately;
 * an unreachable Worker leaves the signed offline grant alone.
 */
export function startLicenseHeartbeat(): void {
  if (!installedBuild() || heartbeatTimer) return
  lastServerCheck = 0
  const beat = async () => {
    if (heartbeatBusy || firstRunWindow) return
    heartbeatBusy = true
    try {
      const status = await engine().status()
      if (!status.active) return lockOut(status.reason ?? "license missing")
      if (Date.now() - lastServerCheck < SERVER_HEARTBEAT_MS) return
      lastServerCheck = Date.now()
      const result = await engine().validate()
      if (!result.ok && result.permanent) lockOut(result.error ?? "validation refused")
    } catch (e) {
      LOG("[jetcode-license-gate] heartbeat error:", (e as Error).message)
    } finally {
      heartbeatBusy = false
    }
  }
  heartbeatTimer = setInterval(() => void beat(), HEARTBEAT_MS)
  setTimeout(() => void beat(), 5_000)
  app.once("will-quit", () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    heartbeatTimer = undefined
  })
}

export async function ensureLicensedOrPrompt(_deps: GateDeps = {}): Promise<void> {
  // Free edition: the 2027 line has no key gate, no heartbeat, and no license
  // surfaces. Paid 2026/2099 builds keep the full gate.
  if (app.getVersion().startsWith("2027.")) return
  // The gate is for released trees. A development run has no signed install
  // and no cache, and demanding a key there would stall every local build.
  if (!installedBuild()) return

  // Re-verify the Reset-flow directive if one was passed. Cold boots skip.
  checkDirectiveEnv()

  const first = await engine().status()
  LOG("[jetcode-license-gate] initial status:", first)
  if (first.active) {
    // Background revocation ping — never blocks boot. If the Worker rejects
    // the key, the next launch will see no cache and re-prompt.
    engine()
      .ensureLicensed()
      .catch(() => undefined)
    startLicenseHeartbeat()
    return
  }
  const ok = await showDialog()
  if (!ok) {
    LOG("[jetcode-license-gate] user cancelled, quitting")
    app.quit()
    await new Promise((r) => setTimeout(r, 50))
    throw new Error("jetcode license gate: user cancelled")
  }
  const after = await engine().status()
  LOG("[jetcode-license-gate] post-activate status:", after)
  if (!after.active) {
    app.quit()
    throw new Error(
      `jetcode license gate: still inactive after activate (${after.active === false ? after.reason ?? "unknown" : "unknown"})`,
    )
  }
  startLicenseHeartbeat()
}

// --- Post-activation management -------------------------------------------------
//
// Everything below runs AFTER ensureLicensedOrPrompt has passed the initial
// gate. It gives the operator a native way to see what key is active, how many
// days are left, and to deactivate / swap keys without touching the CLI or the
// on-disk cache file. Reachable two ways:
//
//   1. Alt → Help → "License…" menu item (always visible on Windows)
//   2. Ctrl+Shift+L global shortcut (registered at app.whenReady)
//
// The management view is a dedicated BrowserWindow loaded from a data: URL —
// same pattern as the first-run dialog. No renderer / preload changes, so the
// surface area is one file.

const MANAGE_CHANNEL_STATUS = "jetcode:license-status"
const MANAGE_CHANNEL_DEACTIVATE = "jetcode:license-deactivate"
const MANAGE_CHANNEL_SWAP = "jetcode:license-swap"
const MANAGE_CHANNEL_OPEN = "jetcode:license-manage-open"
const MANAGE_CHANNEL_FULL_KEY = "jetcode:license-full-key"
const THEME_GET_CHANNEL = "jetcode:theme-get"
const THEME_SET_CHANNEL = "jetcode:theme-set"
const BACKDROP_CHANNEL = "jetcode:backdrop-luminance"

// Dragging a transparent window runs a modal move loop in the shell. A display
// capture during that loop blocks the main process for tens of milliseconds on
// every sample, which is what made the window stutter while it was dragged.
// Motion is tracked per window and sampling is refused until it settles.
const motionAt = new Map<number, number>()
const watchedWindows = new Set<number>()

function watchMotion(win: BrowserWindow) {
  if (watchedWindows.has(win.id)) return
  watchedWindows.add(win.id)
  const mark = () => motionAt.set(win.id, Date.now())
  win.on("move", mark)
  win.on("resize", mark)
  win.on("closed", () => {
    watchedWindows.delete(win.id)
    motionAt.delete(win.id)
  })
}

type ManageStatus =
  | { active: false; reason?: string }
  | { active: true; key_prefix: string; tier: string; days_left: number; expires_at: number; email_masked?: string }

function toManageStatus(raw: Awaited<ReturnType<LicensingEngine["status"]>>): ManageStatus {
  if (!raw.active) return { active: false, reason: raw.reason }
  // Never ship the full key to the renderer. Prefix is enough to let the user
  // confirm which key is active without painting the whole secret into the DOM
  // where devtools / a screenshot / a crash dump could lift it.
  const prefix = raw.key ? `${raw.key.slice(0, 5)}…${raw.key.slice(-4)}` : "—"
  const daysLeft = raw.expires_at ? Math.max(0, Math.ceil((raw.expires_at * 1000 - Date.now()) / 86_400_000)) : 0
  return {
    active: true,
    key_prefix: prefix,
    tier: raw.tier ?? "standard",
    days_left: daysLeft,
    expires_at: raw.expires_at ?? 0,
  }
}

function manageDialogHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';" />
<title>jetcode — License</title>
${licenseAppearance(licenseThemeId())}
</head>
<body>
<div class="card">
  <div class="brand"><span class="brand-mark" aria-hidden="true">jC</span><span>jetcode</span><span class="eyebrow">Workspace access</span></div>
  <h1>License</h1>
  <p class="sub" id="sub">Loading…</p>
  <div id="body"></div>
  <div id="status" class="status" role="status" aria-live="polite"></div>
</div>
<script>
  const { ipcRenderer } = require('electron')
  ${licenseThemeListener()}

  function escapeText(value) {
    const node = document.createElement('span'); node.textContent = String(value ?? ''); return node.innerHTML
  }
  function render(s) {
    document.querySelector('.card').dataset.status = s && s.active ? 'active' : 'inactive'
    const body = document.getElementById('body')
    const sub = document.getElementById('sub')
    if (!s || !s.active) {
      sub.textContent = 'This machine is not activated.'
      body.innerHTML = '<div class="inactive">' + (s && s.reason ? 'Reason: ' + escapeText(s.reason) : 'No active key on this machine.') +
        '</div><div class="row"><button class="ghost" id="close">Close</button><button class="primary" id="swap">Enter a key</button></div>'
      document.getElementById('close').onclick = () => window.close()
      document.getElementById('swap').onclick = async () => {
        await ipcRenderer.invoke('${MANAGE_CHANNEL_SWAP}')
        refresh()
      }
      return
    }
    sub.textContent = 'Active on this machine.'
    // Colour the days-left number without assuming a total key duration.
    // 30-day keys, 7-day trial keys and arbitrary-length keys all use the
    // same thresholds: amber under a week, red under three days.
    //
    // When expires_at is 0 or missing (lifetime / open-ended keys, or a
    // status payload the worker didn't populate yet) the raw days_left
    // calc lands on 0, which the old renderer painted in red as "0 days"
    // — reading to the user as "expired right now". That was a visual
    // false-positive on a perfectly active key. Render "—" for both rows
    // in that case so the dialog says nothing it isn't sure about.
    const hasExpiry = s.expires_at && s.expires_at > 0
    const nClass = hasExpiry ? (s.days_left <= 3 ? 'crit' : s.days_left <= 7 ? 'warn' : '') : ''
    const timeLeftCell = hasExpiry
      ? '<span class="days"><span class="n ' + nClass + '">' + s.days_left + '</span><span class="u">day' + (s.days_left === 1 ? '' : 's') + '</span></span>'
      : '<span class="days"><span class="n">—</span></span>'
    const expiresCell = hasExpiry ? new Date(s.expires_at * 1000).toLocaleString() : '—'
    body.innerHTML =
      '<dl class="grid">' +
        '<dt>Key</dt><dd>' + escapeText(s.key_prefix) + '</dd>' +
        '<dt>Tier</dt><dd>' + escapeText(s.tier) + '</dd>' +
        '<dt>Time left</dt><dd>' + timeLeftCell + '</dd>' +
        '<dt>Expires</dt><dd class="muted">' + escapeText(expiresCell) + '</dd>' +
      '</dl>' +
      '<div class="row">' +
        '<button class="danger" id="deact">Deactivate</button>' +
        '<button class="ghost" id="swap">Swap key</button>' +
        '<button class="primary" id="close">Done</button>' +
      '</div>'
    document.getElementById('close').onclick = () => window.close()
    document.getElementById('deact').onclick = async () => {
      const el = document.getElementById('status')
      el.className = 'status'; el.textContent = 'Deactivating…'
      const r = await ipcRenderer.invoke('${MANAGE_CHANNEL_DEACTIVATE}').catch(() => ({ ok: false, message: 'Unable to deactivate. Please try again.' }))
      if (r && r.ok) { el.className = 'status ok'; el.textContent = 'Deactivated.'; setTimeout(refresh, 400) }
      else { el.className = 'status err'; el.textContent = (r && r.message) || 'Failed to deactivate.' }
    }
    document.getElementById('swap').onclick = async () => {
      await ipcRenderer.invoke('${MANAGE_CHANNEL_SWAP}')
      refresh()
    }
  }

  async function refresh() {
    try {
      const s = await ipcRenderer.invoke('${MANAGE_CHANNEL_STATUS}')
      render(s)
    } catch {
      document.getElementById('sub').textContent = 'License status unavailable.'
      document.getElementById('body').innerHTML = '<div class="inactive">Could not load your license. Please try again.</div><div class="row"><button id="retry" class="primary">Try again</button><button id="close" class="ghost">Close</button></div>'
      document.getElementById('retry').onclick = refresh
      document.getElementById('close').onclick = () => window.close()
    }
  }

  refresh()
</script>
</body>
</html>`
}

let manageWindow: BrowserWindow | null = null

export function openManagementDialog(): void {
  if (manageWindow && !manageWindow.isDestroyed()) {
    manageWindow.focus()
    manageWindow.moveTop()
    return
  }
  LOG("[jetcode-license-gate] opening management dialog")
  const win = new BrowserWindow({
    width: 560,
    height: 570,
    minWidth: 340,
    minHeight: 420,
    resizable: true,
    maximizable: false,
    minimizable: true,
    fullscreenable: false,
    autoHideMenuBar: true,
    alwaysOnTop: false,
    center: true,
    show: false,
    backgroundColor: licenseBackground(licenseThemeId()),
    title: "jetcode",
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
  })
  manageWindow = win
  win.once("ready-to-show", () => {
    win.show()
    win.focus()
  })
  win.on("closed", () => {
    if (manageWindow === win) manageWindow = null
  })
  win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(manageDialogHtml())).catch(() => {
    if (!win.isDestroyed()) win.destroy()
  })
}

// Registered once at app.whenReady, outside any dialog's local scope, so the
// channels stay live for the whole session. Caller is wired in by
// scripts/sync.sh as a sibling of the ensureLicensedOrPrompt invocation.
export function registerLicenseManagement(): void {
  if (app.getVersion().startsWith("2027.")) return
  // Guard against double-registration. ipcMain.handle throws on duplicate.
  try {
    ipcMain.removeHandler(MANAGE_CHANNEL_STATUS)
    ipcMain.removeHandler(MANAGE_CHANNEL_DEACTIVATE)
    ipcMain.removeHandler(MANAGE_CHANNEL_SWAP)
    ipcMain.removeHandler(MANAGE_CHANNEL_OPEN)
    ipcMain.removeHandler(MANAGE_CHANNEL_FULL_KEY)
    ipcMain.removeHandler(THEME_GET_CHANNEL)
    ipcMain.removeHandler(THEME_SET_CHANNEL)
    ipcMain.removeHandler(BACKDROP_CHANNEL)
  } catch {
    /* no prior handler */
  }

  // Theme persistence. Writes a tiny `{ "id": "<kit>" }` JSON to
  // <XDG_DATA_HOME or ~/.local/share>/opencode/theme.json. Kept in the main
  // process (not localStorage) so it survives the Fresh-Desktop ritual
  // wiping the Electron session partition.
  const themeFilePath = (): string => {
    const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
    return path.join(base, "opencode", "theme.json")
  }
  ipcMain.handle(THEME_GET_CHANNEL, async () => {
    try {
      const p = themeFilePath()
      if (!fs.existsSync(p)) return null
      const parsed = JSON.parse(fs.readFileSync(p, "utf8")) as { id?: unknown }
      if (typeof parsed?.id === "string") return parsed.id
      return null
    } catch {
      return null
    }
  })
  ipcMain.handle(THEME_SET_CHANNEL, async (_e, id: unknown) => {
    try {
      if (typeof id !== "string" || !/^[a-z][a-z0-9-]{1,32}$/i.test(id)) {
        return { ok: false }
      }
      const p = themeFilePath()
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, JSON.stringify({ id }, null, 2))
      if (manageWindow && !manageWindow.isDestroyed()) {
        manageWindow.setBackgroundColor(licenseBackground(id))
        manageWindow.webContents.send("jetcode:theme-changed", id)
      }
      return { ok: true }
    } catch {
      return { ok: false }
    }
  })

  // Clear kit: the window itself is transparent, so the colour of the glyphs
  // has to follow whatever application sits behind it. Capture the display at
  // low resolution and average the window rectangle; the renderer polls this
  // only while the Clear kit is active. Returns relative luminance 0..1.
  ipcMain.handle(BACKDROP_CHANNEL, async (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return null
      watchMotion(win)
      if (Date.now() - (motionAt.get(win.id) ?? 0) < 900) return null
      // Idle time is whole seconds. Under two means the pointer or keyboard is
      // in use, and a capture started now runs inside the shell's modal move
      // loop — the stall the user feels while dragging. Wait for a quiet
      // moment; the next poll is a few seconds away.
      if (powerMonitor.getSystemIdleTime() < 2) return null
      const bounds = win.getBounds()
      const display = screen.getDisplayMatching(bounds)
      const width = 240
      const height = Math.max(1, Math.round((width * display.size.height) / Math.max(1, display.size.width)))
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width, height },
        fetchWindowIcons: false,
      })
      const source = sources.find((item) => String(item.display_id) === String(display.id)) ?? sources[0]
      if (!source || source.thumbnail.isEmpty()) return null
      const size = source.thumbnail.getSize()
      const bitmap = source.thumbnail.toBitmap()
      const scaleX = size.width / Math.max(1, display.size.width)
      const scaleY = size.height / Math.max(1, display.size.height)
      const left = Math.max(0, Math.round((bounds.x - display.bounds.x) * scaleX))
      const top = Math.max(0, Math.round((bounds.y - display.bounds.y) * scaleY))
      const right = Math.min(size.width, Math.round((bounds.x - display.bounds.x + bounds.width) * scaleX))
      const bottom = Math.min(size.height, Math.round((bounds.y - display.bounds.y + bounds.height) * scaleY))
      if (right <= left || bottom <= top) return null
      // Skip the outer ring: the window border and shadow are not what the
      // text sits on, and they are always either black or transparent.
      const stepX = Math.max(1, Math.floor((right - left) / 40))
      const stepY = Math.max(1, Math.floor((bottom - top) / 30))
      let sum = 0
      let count = 0
      for (let y = top + stepY; y < bottom - stepY; y += stepY) {
        for (let x = left + stepX; x < right - stepX; x += stepX) {
          const index = (y * size.width + x) * 4
          const b = bitmap[index] ?? 0
          const g = bitmap[index + 1] ?? 0
          const r = bitmap[index + 2] ?? 0
          sum += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
          count += 1
        }
      }
      return count ? sum / count : null
    } catch {
      return null
    }
  })

  // Renderer FAB → open management dialog. Fire-and-forget; the dialog is a
  // dedicated BrowserWindow owned by the main process, so the renderer just
  // asks and we handle the rest.
  ipcMain.handle(MANAGE_CHANNEL_OPEN, async () => {
    openManagementDialog()
    return { ok: true }
  })

  ipcMain.handle(MANAGE_CHANNEL_STATUS, async () => {
    try {
      return toManageStatus(await engine().status())
    } catch (e) {
      return { active: false, reason: (e as Error).message }
    }
  })

  // Full-key reveal for the License pill's eye toggle. The operator owns
  // this box; they need to be able to copy their own key for support /
  // transfer. Kept out of the status payload (which is polled and rendered
  // into the DOM) because the full secret belongs to one explicit user
  // action, not an always-on signal. Returns only { active: false } shape
  // when there is nothing to reveal, matching the status payload's
  // discriminant so the renderer can switch on .active without a second
  // code path.
  ipcMain.handle(MANAGE_CHANNEL_FULL_KEY, async () => {
    try {
      const raw = await engine().status()
      if (!raw.active || !raw.key) return { active: false }
      return { active: true, key: raw.key }
    } catch (e) {
      return { active: false, reason: (e as Error).message }
    }
  })

  ipcMain.handle(MANAGE_CHANNEL_DEACTIVATE, async () => {
    try {
      await engine().deactivate()
      return { ok: true }
    } catch (e) {
      return { ok: false, message: (e as Error).message }
    }
  })

  // Swap key: drop the current cache, close the management window, open the
  // first-run dialog. The user re-enters a new key; the gate then picks up the
  // fresh cache on the next status poll.
  ipcMain.handle(MANAGE_CHANNEL_SWAP, async () => {
    try {
      await engine().deactivate()
    } catch {
      /* best effort; if deactivate fails the activate overwrites anyway */
    }
    if (manageWindow && !manageWindow.isDestroyed()) {
      manageWindow.close()
      manageWindow = null
    }
    // Fire-and-forget. The first-run dialog resolves when the user closes it.
    showDialog().catch(() => undefined)
    return { ok: true }
  })


  // Native menu. The upstream app does not call Menu.setApplicationMenu, so
  // Electron falls back to its auto-generated default which does not include
  // the role items we want. Build a minimal, role-based template so every
  // standard shortcut (copy, paste, reload, devtools when applicable, fullscreen,
  // close) keeps working, with one extra Help entry for License and About.
  // autoHideMenuBar stays true, so the bar is invisible until Alt is tapped.
  // The accelerator below fires whether or not the bar is visible, as long as
  // an jetcode window has focus — i.e. never while the user is in another app.
  const licenseItem: Electron.MenuItemConstructorOptions = {
    label: "License…",
    accelerator: "CmdOrCtrl+Shift+L",
    click: () => openManagementDialog(),
  }
  const template: Electron.MenuItemConstructorOptions[] = [
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        licenseItem,
        { type: "separator" },
        { label: "Visit example.com", click: () => void shell.openExternal("https://example.com") },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))

  // No globalShortcut.register. A system-wide accelerator that fires even
  // when jetcode is unfocused would hijack Ctrl+Shift+L in every other
  // app on the box (VS Code "Select all occurrences", browser context,
  // etc.) which the operator explicitly called out as unwanted. The menu
  // accelerator above only fires when an jetcode window has focus, which
  // is the right scope for a license-management entry buried in Help.

  LOG("[jetcode-license-gate] management registered (menu + ipc)")
}
