import path from "node:path"
import os from "node:os"
import fs from "node:fs"
import crypto from "node:crypto"
import https from "node:https"
import tls from "node:tls"
import { Context, Effect, Layer } from "effect"
import { Global } from "@opencode/util/global"
import { checkAntiDebug } from "./anti-debug"

// jetcode licensing. Online activation binds a key to a stable per-machine
// pair of anchors; the server returns an Ed25519-signed token this process
// verifies on every launch with a baked public key. The private key never
// leaves the Worker, so lifting the embedded constant from a dumped binary
// does not enable minting tokens.
//
// Every license-API call is TLS-pinned (checkServerIdentity walks the chain
// looking for a SPKI match). A MITM with their own CA installed on the local
// machine can still complete the TLS handshake but will not match any pin,
// so forged "ok: true" responses never reach this process. Pin set covers
// the current leaf + GTS intermediate + GTS root + GlobalSign cross-sign +
// well-known Let's Encrypt / DigiCert / Baltimore roots as fallbacks.

const DEFAULT_API = "https://license.example.com"
const CACHE_FILENAME = "license.json"

// Ed25519 public key injected at build time (see scripts/package.ps1) as a
// base64-encoded SPKI PEM. The placeholder is a safe default for dev builds
// that never touch the production Worker — they fail verify locally.
declare const JETCODE_LICENSE_PUBKEY: string | undefined
const EMBEDDED_PUBKEY =
  (typeof JETCODE_LICENSE_PUBKEY === "string" && JETCODE_LICENSE_PUBKEY) ||
  "dev-pubkey-replace"

// Accepted SPKI SHA-256 pins (base64). We pin to the LEAF plus the specific
// Cloudflare-used intermediates — not to the root. Pinning the root admits
// any cert the root CA ever signs (millions of unrelated sites), which
// defeats the point. Pinning the leaf + intermediate narrows the trust set
// to this exact Cloudflare property plus its matching CA. Hostname check
// still runs separately (see checkServerIdentity below), so an attacker
// with a legit WE1-signed cert for a different domain still fails SNI.
const ACCEPTED_PINS: ReadonlySet<string> = new Set([
  // Current live chain for license.example.com.
  "/E2cKMmfCluBe5uiOkieUIqGnCbFVWbKV4MYbq+dLhA=", // leaf (example.com)
  "kIdp6NNEd8wsugYyyIYFsi1ylMCED3hZbSR8ZFsa/A4=", // GTS WE1 intermediate
  "RJZX84jaUQLNmvGj9jukzD9IdlnnJAxf5XC6erSMYyc=", // jetcode free-tier preview license leaf
])

export class LicenseError extends Error {
  readonly _tag = "LicenseError"
  constructor(message: string) {
    super(message)
  }
}

export interface Cached {
  readonly key: string
  readonly token: string
  readonly hwid: string
  readonly tier: string
  readonly expires_at: number
  // jetcode email-at-activate (optional). Kept in the cache so a license
  // reinstall on the same box re-presents the same email to the Worker and
  // doesn't trip the mismatch check. Backward-compatible with pre-email
  // keys where this field is undefined.
  readonly email?: string
  // Monotonic high-water mark. Updated on every successful verifyToken,
  // persisted inside the encrypted cache. If the system clock ever reads
  // less than this minus the skew tolerance, the cache is treated as
  // tampered and the session is refused. Defeats "wind clock back to
  // dodge expiry" without any network round-trip.
  readonly last_seen?: number
}

// AES-256-GCM cache encryption. Key is derived from the HWID through HKDF
// with a per-build salt baked at package time. A cache file copied to a
// different box fails HKDF-derive (different HWID -> different key -> GCM
// auth-tag mismatch), so one-license-one-box is enforced at the file level
// as well as the token level. The salt is also obfuscated at build; lifting
// it from a dumped binary without also lifting the HWID formula does not
// enable decrypting another user's cache.
declare const JETCODE_CACHE_SALT: string | undefined
const CACHE_SALT =
  (typeof JETCODE_CACHE_SALT === "string" && JETCODE_CACHE_SALT) || "dev-cache-salt-replace"
const CACHE_MAGIC = Buffer.from("OLEC1") // 5 bytes, file format marker
// Skew tolerance for the clock-rollback guard. NTP drift, DST transitions,
// and VM suspend/resume can all legitimately push the wall clock backward
// by a few minutes; anything larger than this window is a user action.
const CLOCK_ROLLBACK_TOLERANCE_SEC = 10 * 60

export class Service extends Context.Service<Service, Interface>()("@jetcode/Licensing") {}

export interface Interface {
  readonly cachePath: string
  readonly apiBase: string
  readonly hwid: () => string
  readonly load: () => Cached | undefined
  readonly save: (c: Cached) => void
  readonly clear: () => void
}

function hashId(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 32)
}

function readWindowsMachineGuid(): string | undefined {
  if (process.platform !== "win32") return undefined
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process")
  // windowsHide:true is critical here — Electron spawns the CLI as a backend
  // service and this reg query fires on every launch; without the flag Windows
  // 11 pops a visible WindowsTerminal shell per call, which the user sees as
  // "terminal opening and closing rapidly" when the sidecar probe recruits
  // contenders during startup.
  const r = spawnSync(
    "reg",
    ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
    { encoding: "utf8", windowsHide: true },
  )
  if (r.status !== 0 || !r.stdout) return undefined
  const match = r.stdout.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/)
  return match?.[1]
}

// Primary anchor: platform-provided stable per-machine id (MachineGuid /
// machine-id / IOPlatformUUID).
function platformHwidPrimary(): string {
  if (process.platform === "win32") {
    const guid = readWindowsMachineGuid()
    if (guid) return hashId(`win:${guid}`)
  }
  if (process.platform === "linux") {
    for (const p of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
      if (fs.existsSync(p)) {
        const id = fs.readFileSync(p, "utf8").trim()
        if (id) return hashId(`linux:${id}`)
      }
    }
  }
  if (process.platform === "darwin") {
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process")
    const r = spawnSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", windowsHide: true })
    const match = r.stdout?.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)
    if (match) return hashId(`mac:${match[1]}`)
  }
  return hashId(`fallback:${os.hostname()}:${os.userInfo().username}`)
}

// Second anchor: hardware shape (CPU model + RAM bucket + OS release). Cheap
// to compute, doesn't require admin, extremely stable per-machine, and NOT
// derived from the registry — so copying the registry MachineGuid value to
// another box no longer impersonates the original license binding.
function platformHwidSecondary(): string {
  const cpuModel = os.cpus()[0]?.model?.trim() ?? "unknown-cpu"
  const ramGb = Math.round(os.totalmem() / 1024 / 1024 / 1024)
  const release = os.release()
  return hashId(`anchor2:${process.platform}:${process.arch}:${cpuModel}:${ramGb}G:${release}`)
}

function platformHwid(): string {
  return `${platformHwidPrimary()}.${platformHwidSecondary()}`
}

// HKDF-derive a 32-byte key from the HWID under the baked salt. The salt
// is per-build so two installs on the same HWID with different builds
// produce different cache keys, which prevents cross-build cache-swap
// attacks (lift a cache from an older unpatched build, feed to a patched
// newer one).
function deriveCacheKey(hwid: string, info = "jetcode-cache-v1"): Buffer {
  const ikm = Buffer.from(hwid, "utf8")
  const salt = Buffer.from(CACHE_SALT, "utf8")
  return Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from(info), 32))
}

// Pack:   MAGIC(5) | VERSION(1) | IV(12) | TAG(16) | CT(...)
// Unpack: reverse. Returns undefined on any structural problem so the
// caller treats a corrupted cache as a missing cache (re-activation path).
function encryptCache(c: Cached, hwid: string): Buffer {
  const key = deriveCacheKey(hwid)
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv)
  const pt = Buffer.from(JSON.stringify(c), "utf8")
  const ct = Buffer.concat([cipher.update(pt), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([CACHE_MAGIC, Buffer.from([1]), iv, tag, ct])
}

function decryptCache(buf: Buffer, hwid: string, info = "jetcode-cache-v1"): Cached | undefined {
  try {
    if (buf.length < 5 + 1 + 12 + 16) return undefined
    if (buf.compare(CACHE_MAGIC, 0, 5, 0, 5) !== 0) return undefined
    const version = buf[5]
    if (version !== 1) return undefined
    const iv = buf.subarray(6, 18)
    const tag = buf.subarray(18, 34)
    const ct = buf.subarray(34)
    const key = deriveCacheKey(hwid, info)
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv)
    decipher.setAuthTag(tag)
    const pt = Buffer.concat([decipher.update(ct), decipher.final()])
    return JSON.parse(pt.toString("utf8")) as Cached
  } catch {
    return undefined
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    const cachePath = path.join(global.data, CACHE_FILENAME)
    const apiBase = process.env.JETCODE_LICENSE_API ?? DEFAULT_API
    return Service.of({
      cachePath,
      apiBase,
      hwid: platformHwid,
      load: () => {
        if (!fs.existsSync(cachePath)) return undefined
        const raw = fs.readFileSync(cachePath)
        // Encrypted path (release). Plaintext JSON fallback keeps dev
        // builds + rollback-from-v3 installs working: if the file is a
        // JSON object, parse directly; otherwise treat as AES-GCM.
        if (raw.length > 0 && raw[0] === 0x7b /* '{' */) {
          try {
            return JSON.parse(raw.toString("utf8")) as Cached
          } catch {
            return undefined
          }
        }
        const hwid = platformHwid()
        const current = decryptCache(raw, hwid)
        if (current) return current
        // A pre-rename cache used the old HKDF info string. Decrypt it with
        // the legacy binding, then rewrite it under the new binding so the
        // next launch takes the fast path.
        const legacy = decryptCache(raw, hwid, "olliecode-cache-v1")
        if (legacy) {
          try {
            fs.writeFileSync(cachePath, encryptCache(legacy, hwid), { mode: 0o600 })
          } catch {}
        }
        return legacy
      },
      save: (c) => {
        fs.mkdirSync(path.dirname(cachePath), { recursive: true })
        const payload = encryptCache(c, platformHwid())
        fs.writeFileSync(cachePath, payload, { mode: 0o600 })
      },
      clear: () => {
        if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath)
      },
    })
  }),
)

function b64urlDecode(input: string): Buffer {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4))
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64")
}

let cachedPubKey: crypto.KeyObject | undefined
function loadPubKey(): crypto.KeyObject {
  if (cachedPubKey) return cachedPubKey
  const pem = Buffer.from(EMBEDDED_PUBKEY, "base64").toString("utf8")
  cachedPubKey = crypto.createPublicKey(pem)
  return cachedPubKey
}

// Walk the TLS chain, compute SPKI SHA-256 of every cert, pass if any match
// the accepted-pins set. Returns an Error (not thrown) per node:tls contract
// so the connection fails cleanly before any bytes are read.
function verifyPinnedChain(cert: any): Error | undefined {
  if (!cert || typeof cert !== "object") return new Error("tls: no peer cert")
  const seen = new Set<string>()
  let node: any = cert
  while (node && !seen.has(node.fingerprint)) {
    seen.add(node.fingerprint)
    try {
      const x509 = new crypto.X509Certificate(node.raw)
      const spkiDer = x509.publicKey.export({ type: "spki", format: "der" })
      const pin = crypto.createHash("sha256").update(spkiDer as Buffer).digest("base64")
      if (ACCEPTED_PINS.has(pin)) return undefined
    } catch {
      // skip malformed node, continue up the chain
    }
    const next = node.issuerCertificate
    if (!next || next === node) break
    node = next
  }
  return new Error("tls: pin mismatch")
}

// HTTPS POST with TLS pinning. Replaces the previous unpinned fetch() path.
// Returns the parsed JSON body on 2xx; throws LicenseError on 4xx/5xx or on
// any TLS / network error (pin failure counts as a network error, so callers
// that treat network as non-fatal still refuse to trust an unpinned response).
function pinnedPostJson<T>(url: string, body: unknown, timeoutMs = 15000): Promise<T> {
  return new Promise((resolve, reject) => {
    let parsedUrl: URL
    try {
      parsedUrl = new URL(url)
    } catch {
      reject(new LicenseError("bad license-api URL"))
      return
    }
    const data = Buffer.from(JSON.stringify(body ?? {}), "utf8")
    const req = https.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port ? Number(parsedUrl.port) : 443,
        path: parsedUrl.pathname + parsedUrl.search,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(data.length),
          "user-agent": "jetcode-cli",
        },
        timeout: timeoutMs,
        // Node's documented hook for custom cert validation. Returning an
        // Error (not throwing) is the contract. Run the default hostname /
        // SAN check first, then the pin walk — overriding this callback
        // without calling the default disables hostname verification.
        checkServerIdentity: (host, cert) => {
          const identityErr = tls.checkServerIdentity(host, cert)
          if (identityErr) return identityErr
          return verifyPinnedChain(cert)
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c) => chunks.push(c as Buffer))
        res.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf8")
            const parsed = (text ? JSON.parse(text) : {}) as T
            if (res.statusCode && res.statusCode >= 400) {
              const message = (parsed as { error?: string }).error
              reject(new LicenseError(message ?? `HTTP ${res.statusCode}`))
              return
            }
            resolve(parsed)
          } catch (err) {
            reject(new LicenseError((err as Error).message))
          }
        })
      },
    )
    req.on("timeout", () => {
      req.destroy(new Error("timeout"))
    })
    req.on("error", (err) => {
      reject(new LicenseError(err.message))
    })
    req.write(data)
    req.end()
  })
}

// Second-layer binary integrity: BLAKE2b over the first integrity-window
// bytes, compared against a separate sidecar (.sum). This fires inline
// inside verifyToken (not from a dedicated verifyBinaryIntegrity function),
// so a reverser who patches out the first check still hits this one on the
// token-verify hot path — and the hot path is where Ed25519 verify lives,
// so patching THIS routine out also breaks the signature check.
const SECONDARY_WINDOW_BYTES = 4 * 1024 * 1024 // 4 MB

function readSecondarySidecar(exe: string): Buffer | undefined {
  const sidecar = `${exe}.sum`
  if (!fs.existsSync(sidecar)) return undefined
  const raw = fs.readFileSync(sidecar, "utf8").trim().toLowerCase()
  if (!/^[0-9a-f]{128}$/.test(raw)) return undefined // BLAKE2b-512 hex
  return Buffer.from(raw, "hex")
}

function computeSecondaryDigest(exe: string): Buffer | undefined {
  try {
    const fd = fs.openSync(exe, "r")
    const buf = Buffer.allocUnsafe(1 << 16)
    const stat = fs.fstatSync(fd)
    const windowEnd = Math.min(stat.size, SECONDARY_WINDOW_BYTES)
    const h = crypto.createHash("blake2b512")
    let offset = 0
    try {
      while (offset < windowEnd) {
        const want = Math.min(buf.length, windowEnd - offset)
        const n = fs.readSync(fd, buf, 0, want, offset)
        if (n <= 0) break
        h.update(buf.subarray(0, n))
        offset += n
      }
    } finally {
      fs.closeSync(fd)
    }
    return h.digest()
  } catch {
    return undefined
  }
}

function verifyToken(token: string, hwid: string): { tier: string; expires_at: number; key: string } {
  // Anti-debug sweep. Silent exit on any positive -- matches the shape of
  // a "no cached licence" miss, so a reverser cannot tell from behaviour
  // which probe caught them. NOPping this call site also NOPs the Ed25519
  // verify below (same function body), which is the point.
  checkAntiDebug()

  // Secondary integrity: silent exit on mismatch, no-op if the sidecar is
  // absent (dev build). Inline here so a reverser who NOPs the primary
  // check still trips this one on every token verify.
  {
    const exe = process.execPath
    const expected = readSecondarySidecar(exe)
    if (expected) {
      const actual = computeSecondaryDigest(exe)
      if (!actual || !crypto.timingSafeEqual(actual, expected)) process.exit(0)
    }
  }

  const dot = token.indexOf(".")
  if (dot < 0) throw new LicenseError("invalid token")
  const payload = token.slice(0, dot)
  const sigB64 = token.slice(dot + 1)
  const sig = b64urlDecode(sigB64)
  const ok = crypto.verify(null, Buffer.from(payload, "utf8"), loadPubKey(), sig)
  if (!ok) throw new LicenseError("token signature invalid")
  const decoded = JSON.parse(b64urlDecode(payload).toString("utf8")) as {
    k: string
    h: string
    e: number
    t: string
  }
  if (decoded.h !== hwid) throw new LicenseError("license bound to a different machine")
  if (decoded.e && decoded.e * 1000 < Date.now()) throw new LicenseError("license expired")
  return { tier: decoded.t, expires_at: decoded.e, key: decoded.k }
}

export const activate = (key: string, email?: string) =>
  Effect.gen(function* () {
    const svc = yield* Service
    const hwid = svc.hwid()
    const normalizedEmail = email?.trim().toLowerCase() || undefined
    const resp = yield* Effect.tryPromise({
      try: () =>
        pinnedPostJson<{
          ok: boolean
          token?: string
          tier?: string
          expires_at?: number
          error?: string
        }>(`${svc.apiBase}/api/activate`, { key, hwid, email: normalizedEmail }),
      catch: (cause) => (cause instanceof Error ? new LicenseError(cause.message) : new LicenseError(String(cause))),
    })
    if (!resp.ok || !resp.token) throw new LicenseError(resp.error ?? "activation refused")
    verifyToken(resp.token, hwid)
    svc.save({
      key,
      token: resp.token,
      hwid,
      tier: resp.tier ?? "standard",
      expires_at: resp.expires_at ?? 0,
      email: normalizedEmail,
      last_seen: Math.floor(Date.now() / 1000),
    })
    return { tier: resp.tier ?? "standard", expires_at: resp.expires_at ?? 0 }
  })

export const deactivate = Effect.gen(function* () {
  const svc = yield* Service
  svc.clear()
})

export const status = Effect.gen(function* () {
  const svc = yield* Service
  const cached = svc.load()
  if (!cached) return { active: false as const }
  const hwid = svc.hwid()
  if (cached.hwid !== hwid) return { active: false as const, reason: "hwid mismatch" }
  const info = verifyToken(cached.token, hwid)
  return {
    active: true as const,
    key: cached.key,
    tier: info.tier,
    expires_at: info.expires_at,
  }
})

// Primary binary integrity: streaming SHA-256 of the whole exe against the
// .hash sidecar written by scripts/hash-binaries.ts. First of two integrity
// probes; the second lives inline inside verifyToken so a reverser who NOPs
// this one still hits the inline probe on every launch.
function verifyBinaryIntegrity(): void {
  // No env-var escape in shipping builds. The .hash sidecar's absence is
  // the only dev-build signal: a fresh build without hash-binaries.ts
  // output has no sidecar → the function returns early below.
  const exe = process.execPath
  const sidecar = `${exe}.hash`
  if (!fs.existsSync(sidecar)) return // no sidecar → dev build, allow
  let expected: string
  try {
    expected = fs.readFileSync(sidecar, "utf8").trim().toLowerCase()
  } catch {
    process.exit(0)
    return
  }
  if (!/^[0-9a-f]{64}$/.test(expected)) process.exit(0)
  const h = crypto.createHash("sha256")
  const fd = fs.openSync(exe, "r")
  const buf = Buffer.allocUnsafe(1 << 16)
  try {
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null)
      if (n <= 0) break
      h.update(buf.subarray(0, n))
    }
  } finally {
    fs.closeSync(fd)
  }
  const actual = h.digest("hex")
  if (actual !== expected) process.exit(0)
}

// Call at the top of any interactive entry point.
export const ensureLicensed = Effect.gen(function* () {
  verifyBinaryIntegrity()
  const svc = yield* Service
  const cached = svc.load()
  if (!cached) {
    throw new LicenseError(
      "jetcode is not activated on this machine. Run: jetcode license activate <KEY>  (buy at https://example.com/buy)",
    )
  }
  const hwid = svc.hwid()
  verifyToken(cached.token, hwid)

  // Clock-rollback guard. If the wall clock reads less than the cached
  // last-seen minus the skew tolerance, the user wound their system clock
  // back -- usually to extend an expired key. Burn the cache, refuse the
  // session; next launch forces re-activation (and the server-side expiry
  // check catches a key past its true expiry). Legitimate NTP / VM-suspend
  // drift stays inside CLOCK_ROLLBACK_TOLERANCE_SEC.
  const nowSec = Math.floor(Date.now() / 1000)
  if (cached.last_seen && nowSec + CLOCK_ROLLBACK_TOLERANCE_SEC < cached.last_seen) {
    svc.clear()
    throw new LicenseError("licence state tampered; re-activate")
  }
  // Monotonic bump of last_seen. Only writes forward -- never regresses --
  // so a replay of an older encrypted cache also fails the next rollback
  // check. Save is cheap (one AES-GCM + one write) and gated on a 60s
  // threshold so we don't disk-thrash on quick successive launches.
  if (!cached.last_seen || nowSec - cached.last_seen > 60) {
    svc.save({ ...cached, last_seen: nowSec })
  }
  // Opportunistic revocation + last-seen ping. Fire-and-forget via plain
  // Promise so startup never blocks on the network: ensureLicensed returns
  // immediately after the local verifyToken passes, and the validate call
  // runs in the background. Electron spawns `serve --service` on every
  // launch; if validate blocked for 15s on a slow or proxied route the
  // sidecar probe would recruit new contenders on top of the still-waiting
  // one, which looked to the user like a crash loop.
  //
  // Using plain Promise (not Effect pipe) because the per-module obfuscator
  // pass mangles Effect's method lookups (`Effect.catchAll` encoded as a
  // string-array lookup can resolve to undefined), and this hot path has
  // to be robust against that.
  //
  // Security: a revocation the Worker recorded takes at most one more CLI
  // launch to drop the local cache. The signed Ed25519 token with HWID +
  // expiration gates every launch regardless, and the server-side abuse
  // sweep catches sharing with no client cooperation needed.
  // Canary: per-launch random 128-bit. Server logs presence, dashboard
  // flags installs that issue resets but never validate (patched launcher
  // signature). Build-id is baked at package time via the obfuscator;
  // present on releases, "dev" otherwise. Both are observational, server
  // never refuses validate on canary absence.
  const canary = crypto.randomBytes(16).toString("hex")
  const buildId = (typeof JETCODE_LICENSE_PUBKEY === "string" && JETCODE_LICENSE_PUBKEY)
    ? crypto.createHash("sha256").update(JETCODE_LICENSE_PUBKEY).digest("hex").slice(0, 8)
    : "dev"
  pinnedPostJson<{ ok: boolean; error?: string }>(
    `${svc.apiBase}/api/validate`,
    { key: cached.key, hwid, build_id: buildId, canary },
    3000, // short timeout — a slow network is treated the same as no network
  )
    .then((r) => {
      if (!r.ok && (r.error === "revoked" || r.error === "hwid mismatch" || r.error === "expired")) {
        svc.clear()
      }
    })
    .catch(() => undefined)
})

export * as Licensing from "./licensing"
