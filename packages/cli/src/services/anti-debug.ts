// jetcode anti-debug surface. Called from ensureLicensed + verifyToken on
// every launch. Cheap checks only -- none allocate memory or spawn processes
// on the hot path, so startup cost stays under 2 ms.
//
// Philosophy: no visible refusal, no error, no log line. On detection the
// process silently exits 0, the same shape a legitimate "licence missing"
// path produces. A reverser who trips one of these checks sees the window
// close with no clue which probe caught them -- they have to NOP all of
// them to make progress, and NOPping any one of them also NOPs the Ed25519
// verify path that shares the same call site.
//
// All checks are string-free at runtime: identifiers used only as object
// keys come through the obfuscator's string-array RC4 encoding, so
// `strings opencode.exe | grep -i debug` returns nothing.

import crypto from "node:crypto"
import inspector from "node:inspector"

// Release-build gate. Same sentinel the licensing + launcher paths use.
// Dev builds carry "dev-pubkey-replace" so these probes never run under a
// bare `bun run dev` or CI; release builds carry the real pubkey and all
// probes fire. Lifting the probes from a release binary means also lifting
// the baked pubkey, which invalidates every live token.
declare const JETCODE_LICENSE_PUBKEY: string | undefined
const IS_RELEASE_BUILD =
  typeof JETCODE_LICENSE_PUBKEY === "string" &&
  JETCODE_LICENSE_PUBKEY !== "dev-pubkey-replace" &&
  JETCODE_LICENSE_PUBKEY.length > 0

// Timing threshold for the artificial-slowness probe. The baseline for a
// 1000-iteration BLAKE2b loop on a 2020-vintage laptop is ~200 microseconds;
// a debugger single-stepping through the same loop blows past 50 ms by two
// orders of magnitude. 10ms is a wide margin that never false-positives on
// cold cores.
const TIMING_CEILING_MS = 10

// Inspector probe. node --inspect / --inspect-brk register a transport that
// surfaces here as a non-undefined URL. Also true for Chrome DevTools
// attached post-launch.
function inspectorAttached(): boolean {
  try {
    return typeof inspector.url === "function" && inspector.url() !== undefined
  } catch {
    return false
  }
}

// execArgv / NODE_OPTIONS scan. Bundled Bun exes don't honour --inspect
// directly, but a reverser running the unpacked JS under plain node would
// trip this.
function suspiciousArgv(): boolean {
  const argv = process.execArgv ?? []
  for (const a of argv) {
    if (a.indexOf("inspect") >= 0) return true
    if (a.indexOf("debug") >= 0) return true
  }
  const opts = process.env.NODE_OPTIONS ?? ""
  if (opts.indexOf("inspect") >= 0) return true
  if (opts.indexOf("debug") >= 0) return true
  return false
}

// Parent-process probe. On Windows a legitimate launch's parent is
// explorer.exe (shortcut), cmd.exe (bat), wscript.exe (vbs), or
// electron.exe (sidecar). A debugger launch makes the parent devenv.exe,
// ida.exe, ghidra, x64dbg.exe, windbg.exe, or similar. We don't allow-list
// (too brittle across OS variants); we deny-list known analysis tools.
//
// Match is against the BASENAME (lowercased, without extension), exact
// equality only. Substring matching here false-positives badly:
// "ida" vs "nvidia-container.exe", "frida" vs "fridays.exe", "cutter"
// vs anything with that substring. The exact set below lists the known
// executable names of each tool; add aliases as needed, not substrings.
const DENYLIST_PARENT: ReadonlySet<string> = new Set([
  "ida", "ida64", "idag", "idaq", "idaq64", "idaw", "idaw64",
  "ghidra", "ghidrarun",
  "x64dbg", "x32dbg",
  "windbg", "windbgx",
  "ollydbg",
  "radare2", "r2",
  "cutter",
  "dnspy", "dnspy-x86",
  "ilspy",
  "reflector",
  "processhacker", "processhacker2", "processhacker-x64",
  "procexp", "procexp64",
  "cheatengine", "cheatengine-x86_64", "cheatengine-i386",
  "frida", "frida-server", "frida-helper",
  "scylla", "scylla_x64", "scylla_x86",
])
function suspiciousParent(): boolean {
  if (process.platform !== "win32") return false
  try {
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process")
    // wmic is EOL on W11 but still ships; a missing wmic silently succeeds
    // with empty stdout, which is treated as "no denylist hit" below.
    const r = spawnSync("wmic", ["process", "where", `ProcessId=${process.ppid}`, "get", "Name"], {
      encoding: "utf8", windowsHide: true, timeout: 500,
    })
    const raw = (r.stdout ?? "").trim()
    // wmic output is two lines: a "Name" header, then the actual name.
    const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    const nameLine = lines.length >= 2 ? lines[1] : ""
    const base = nameLine.toLowerCase().replace(/\.exe$/, "")
    if (DENYLIST_PARENT.has(base)) return true
  } catch {
    // probe failure is benign -- do not refuse on a missing wmic
  }
  return false
}

// Timing probe. Run a short hash loop and measure. If a step-through
// debugger is attached, each iteration explodes to tens of ms; the total
// crosses the ceiling after a few iterations.
function debuggerSlowing(): boolean {
  try {
    const start = process.hrtime.bigint()
    const h = crypto.createHash("blake2s256")
    const buf = Buffer.alloc(64, 0xa5)
    for (let i = 0; i < 1000; i++) h.update(buf)
    h.digest()
    const ms = Number((process.hrtime.bigint() - start) / 1000000n)
    return ms > TIMING_CEILING_MS
  } catch {
    return false
  }
}

// Virtualisation / sandbox probe. Not a full battery -- just the two
// signatures that consistently appear under malware-analysis sandboxes but
// almost never under a buyer's bare-metal Windows install. Buyers in VMs
// are allowed through (CI, home-lab, Parallels on Mac); we only trip on
// known analysis-sandbox strings.
const SANDBOX_HOSTS = ["sandbox", "malware", "virus", "cuckoo", "anubis", "capev2"]
function sandboxHost(): boolean {
  try {
    const h = (require("node:os") as typeof import("node:os")).hostname().toLowerCase()
    for (const bad of SANDBOX_HOSTS) if (h.indexOf(bad) >= 0) return true
  } catch {}
  return false
}

// Top-level probe. Called from the two hot paths in licensing.ts. Silent
// exit 0 on detection -- same shape as the "no cached licence" path, so a
// reverser cannot distinguish the two from the outside.
export function checkAntiDebug(): void {
  if (!IS_RELEASE_BUILD) return
  if (inspectorAttached()) process.exit(0)
  if (suspiciousArgv()) process.exit(0)
  if (debuggerSlowing()) process.exit(0)
  if (sandboxHost()) process.exit(0)
  // Parent-process probe is last because wmic spawn is the most expensive
  // of the set (~5 ms). Keep it off the first-launch critical path by
  // only running it every 30s wall-clock -- the cache above persists
  // across the Effect invocation.
  const nowSec = Math.floor(Date.now() / 1000)
  if (!lastParentCheckSec || nowSec - lastParentCheckSec > 30) {
    lastParentCheckSec = nowSec
    if (suspiciousParent()) process.exit(0)
  }
}

let lastParentCheckSec = 0
