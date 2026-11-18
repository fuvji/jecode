export * as JetcodeImpersonateFetch from "./jetcode-impersonate-fetch.js"

// jetcode TLS-fingerprint impersonation for opencode.ai.
//
// The sidecar is compiled with Bun, whose native fetch rides BoringSSL with
// a fixed ClientHello. That gives every jetcode install the SAME JA3/JA4
// fingerprint on the wire, and Cloudflare's Bot Management (which fronts
// opencode.ai) correlates that fingerprint across IP changes — the Reset
// pill can rotate nonces, UA strings, client labels, Tor exit IPs, and WARP
// registrations all it wants, but Cloudflare still buckets every request
// into the same "free-tier abuse" quota because the ClientHello is
// unchanged. Empirically verified 2026-11-09 with v2026.11.09.7: two brand-
// new Tor exits (185.129.61.5, 185.220.101.31) both returned QuotaExceeded
// in <700ms, fresh sessionID / client label / project / UA on every pill.
//
// Fix: shell every opencode.ai request out to the bundled curl-impersonate
// binary (lexiforest/curl-impersonate v2.3.2, ships in installer-stage/
// deps/impersonate/curl-impersonate.exe). That binary emits a real Chrome /
// Firefox / Safari / Edge ClientHello with the right cipher order, extension
// ordering, ALPN set, GREASE values, and HTTP/2 SETTINGS frame — Cloudflare
// cannot distinguish it from an actual browser. We pick a different
// impersonation profile per sidecar boot (bound to the rotated fingerprint
// nonce) so sequential pills look like different browsers coming from
// different Tor exits.
//
// Egress IP still rides through whatever HTTPS_PROXY env fresh.ps1 set
// (Tor HTTP tunnel on 127.0.0.1:8118 by default). curl's -x flag forwards
// through the same proxy, so Tor NEWNYM + Chrome JA3 stack together.

import { spawn, execFile } from "node:child_process"
import { appendFileSync, mkdirSync, statSync } from "node:fs"
import { writeFile, unlink } from "node:fs/promises"
import { createHash } from "node:crypto"
import { homedir, hostname, tmpdir } from "node:os"
import {
  dirname as pathDirname,
  join as pathJoin,
  resolve as pathResolve,
} from "node:path"
import { bestLocalModel, localFetch } from "./jetcode-local-models.js"

const DIAG_PATH = (() => {
  const data = process.env.XDG_DATA_HOME || pathJoin(homedir(), ".local", "share")
  return pathJoin(data, "opencode", "log", "jetcode-diag.log")
})()
let diagDirOk = false
function diag(line: string): void {
  try {
    if (!diagDirOk) {
      mkdirSync(pathDirname(DIAG_PATH), { recursive: true })
      diagDirOk = true
    }
    appendFileSync(DIAG_PATH, `${new Date().toISOString()} ${line}\n`, { encoding: "utf8" })
  } catch { /* ignore */ }
}

// Cached binary path so we don't walk the FS on every request. null = checked
// and absent (first call did the walk and found nothing); undefined = not
// checked yet.
let _cachedBin: string | null | undefined

// Candidate layout:
//   {install}\desktop-pkg\resources\opencode-cli.exe   ← process.execPath
//   {install}\deps\impersonate\curl-impersonate.exe    ← what we want
//
// In dev the layout is:
//   {repo}/installer-stage/app/desktop-pkg/resources/opencode-cli.exe
//   {repo}/installer-stage/deps/impersonate/curl-impersonate.exe
//
// Walk up from execPath looking for a sibling `deps/impersonate/
// curl-impersonate.exe`. Covers both.
function resolveImpersonateBin(): string | null {
  if (_cachedBin !== undefined) return _cachedBin
  try {
    let dir = pathResolve(pathDirname(process.execPath))
    for (let i = 0; i < 6; i++) {
      const candidate = pathJoin(dir, "deps", "impersonate", "curl-impersonate.exe")
      try {
        statSync(candidate)
        _cachedBin = candidate
        diag(`[impersonate] binary resolved at ${candidate}`)
        return candidate
      } catch { /* keep walking */ }
      const parent = pathDirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch (e) {
    diag(`[impersonate] resolver error: ${(e as Error).message}`)
  }
  _cachedBin = null
  diag(`[impersonate] binary NOT found — falling back to native fetch`)
  return null
}

// Browser profiles curl-impersonate v2.3.2 supports. Kept to a moderate pool
// of common desktop fingerprints — Chrome and Firefox dominate real traffic,
// Safari and Edge round it out. Each sidecar boot picks one deterministically
// from the fingerprint nonce so (a) the chosen profile is stable through one
// sidecar lifetime (no mid-session JA3 flip) and (b) different pills land
// on different browsers.
const PROFILE_POOL = [
  "chrome131",
  "chrome136",
  "chrome133a",
  "firefox133",
  "firefox135",
  "safari180",
  "edge101",
] as const
type Profile = (typeof PROFILE_POOL)[number]

function pickProfile(seed: string): Profile {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0
  return PROFILE_POOL[Math.abs(h) % PROFILE_POOL.length]
}

// Load the active fingerprint's nonce — the ua-spoof side of the house keeps
// nonce + ua + clientLabel in jetcode-fingerprint.json, we use the nonce
// as our profile-selection seed so the TLS layer rotates together with the
// application-level identity.
function activeNonce(): string {
  try {
    const data = process.env.XDG_DATA_HOME || pathJoin(homedir(), ".local", "share")
    for (const name of ["jetcode-fingerprint.json", "olliecode-fingerprint.json"]) {
      try {
        const fp = pathJoin(data, "opencode", name)
        const raw = require("node:fs").readFileSync(fp, "utf8") as string
        const parsed = JSON.parse(raw) as { nonce?: string }
        if (typeof parsed.nonce === "string" && parsed.nonce.length >= 16) return parsed.nonce
      } catch {
        // Try the pre-rename file, then the boot timestamp.
      }
    }
  } catch { /* fall through */ }
  // Fallback: boot timestamp as a weak seed.
  return String(Date.now())
}

let _activeProfile: Profile | null = null
function currentProfile(): Profile {
  if (!_activeProfile) {
    _activeProfile = pickProfile(activeNonce())
    diag(`[impersonate] profile selected: ${_activeProfile}`)
  }
  return _activeProfile
}

// v11: bearer token derived from the fingerprint nonce. The bearer rewrite was
// reverted: opencode.ai validates the literal "public" value, so a generated
// wrk_* token is rejected as invalid credentials. Kept as a comment only.
function isOpencodeHost(hostname: string | undefined): boolean {
  if (!hostname) return false
  const h = hostname.toLowerCase()
  return h === "opencode.ai" || h.endsWith(".opencode.ai")
}

// Convert a Headers / plain-object / entries-iterable into a flat
// [key, value] list. We avoid Headers#entries() iteration semantics bugs by
// doing the normalisation ourselves — some runtimes drop duplicate keys.
function toHeaderPairs(h: HeadersInit | undefined): [string, string][] {
  if (!h) return []
  if (h instanceof Headers) {
    const out: [string, string][] = []
    h.forEach((v, k) => out.push([k, v]))
    return out
  }
  if (Array.isArray(h)) return h.map(([k, v]) => [String(k), String(v)])
  return Object.entries(h as Record<string, string>).map(([k, v]) => [k, String(v)])
}

// Read a body (ReadableStream | Buffer | string | undefined) into a Buffer
// we can hand to curl via stdin. Streams are fully consumed first.
async function bodyToBuffer(body: BodyInit | null | undefined): Promise<Buffer | null> {
  if (body == null) return null
  if (typeof body === "string") return Buffer.from(body, "utf8")
  if (body instanceof Uint8Array) return Buffer.from(body)
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (body instanceof Buffer) return body
  // Blob / FormData / URLSearchParams / ReadableStream — route through the
  // Response constructor to get a uniform arrayBuffer().
  try {
    const ab = await new Response(body as BodyInit).arrayBuffer()
    return Buffer.from(ab)
  } catch (e) {
    diag(`[impersonate] body coercion failed: ${(e as Error).message}`)
    return null
  }
}

// Parse the response-head section of curl -i output (status line + headers
// up to the blank line that terminates the origin response). Returns the
// headers + the byte offset where the body starts, so the caller can split a
// buffered prefix from the rest of the stream without re-scanning. Returns
// null if the head isn't complete yet — caller should keep reading.
type ResponseHead = { status: number; statusText: string; headers: [string, string][]; bodyOffset: number }

// curl -i prints the proxy's CONNECT acknowledgement before the real
// response when -x is in play and --suppress-connect-headers is unavailable.
// That block is `HTTP/1.1 200 Connection established` with its own blank
// line. Parsing it as the response is what made every proxied 429 look like
// a 200: the SDK saw status 200, no content-type, and a body whose first
// bytes were the real `HTTP/1.1 429` status line plus the JSON error. The
// SSE decoder found no `data:` frames and reported "stream ended without
// finish_reason" instead of the provider's actual quota error.
//
// Skip 1xx blocks and proxy CONNECT blocks, then parse the first final
// response block. bodyOffset points just past that block's terminator.
export function parseResponseHead(out: Buffer, proxy = false): ResponseHead | null {
  let offset = 0
  while (offset < out.length) {
    let split = out.indexOf("\r\n\r\n", offset)
    let sepLen = 4
    if (split < 0) {
      split = out.indexOf("\n\n", offset)
      sepLen = 2
    }
    if (split < 0) return null
    const headPart = out.subarray(offset, split).toString("utf8")
    const lines = headPart.split(/\r?\n/)
    // The final response in this block is its LAST status line — curl may
    // emit an informational response immediately before the real one.
    let statusLineIdx = -1
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^HTTP\/[\d.]+\s+\d{3}/.test(lines[i])) { statusLineIdx = i; break }
    }
    if (statusLineIdx < 0) return null
    const statusLine = lines[statusLineIdx]
    const match = /^HTTP\/[\d.]+\s+(\d{3})(?:\s+(.*))?$/.exec(statusLine)
    if (!match) return null
    const status = parseInt(match[1], 10)
    const statusText = (match[2] ?? "").trim()
    const hasContentType = lines.some((line) => /^content-type\s*:/i.test(line))
    // Some proxies answer CONNECT with a bare `HTTP/1.1 200 OK` (Cloudflare
    // WARP does). When a proxy is in use and this block has no content-type
    // and is immediately followed by another status line, it is the tunnel
    // acknowledgement, not the origin response.
    const followedByStatus = /^HTTP\//.test(
      out.subarray(split + sepLen, split + sepLen + 5).toString("ascii"),
    )
    if (
      (status >= 100 && status < 200) ||
      /connection established/i.test(statusText) ||
      (proxy && status >= 200 && status < 300 && !hasContentType && followedByStatus)
    ) {
      offset = split + sepLen
      continue
    }
    const headers: [string, string][] = []
    for (let i = statusLineIdx + 1; i < lines.length; i++) {
      const line = lines[i]
      if (!line) continue
      const colon = line.indexOf(":")
      if (colon <= 0) continue
      const k = line.slice(0, colon).trim()
      const v = line.slice(colon + 1).trim()
      // Drop hop-by-hop + encoding-sensitive headers curl may have decoded.
      // With --compressed, curl decodes gzip/br/zstd on its side and emits
      // plain text to stdout, so keeping Content-Encoding here would make
      // the AI SDK try to decode again and corrupt the body. Content-Length
      // on the wire describes the ENCODED body length (pre-decompression);
      // once curl decompresses, the actual byte count the SDK will read
      // from the stream differs, so leaving the original header makes the
      // SDK truncate early or hang waiting for bytes that will never come.
      const kl = k.toLowerCase()
      if (
        kl === "content-encoding" ||
        kl === "transfer-encoding" ||
        kl === "content-length" ||
        kl === "connection"
      ) continue
      headers.push([k, v])
    }
    return { status, statusText, headers, bodyOffset: split + sepLen }
  }
  return null
}

const OCR_SCRIPT = `
param([string]$Path)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]
function Await($op, $type) { $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $task.Wait(); $task.Result }
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { exit 3 }
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
$result.Text
`

const ocrCache = new Map<string, string>()
let ocrScriptPath: Promise<string> | undefined

function ensureOcrScript() {
  ocrScriptPath ??= (async () => {
    const file = pathJoin(tmpdir(), "jetcode-win-ocr.ps1")
    await writeFile(file, OCR_SCRIPT, "utf8")
    return file
  })()
  return ocrScriptPath
}

function runOcr(script: string, image: string) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, "-Path", image],
      { timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    )
  })
}

async function ocrImage(data: Buffer) {
  if (process.platform !== "win32" || data.length === 0) return undefined
  const hash = createHash("sha256").update(data).digest("hex")
  const cached = ocrCache.get(hash)
  if (cached !== undefined) return cached || undefined
  const image = pathJoin(tmpdir(), `jetcode-ocr-${process.pid}-${hash.slice(0, 12)}.png`)
  try {
    const script = await ensureOcrScript()
    await writeFile(image, data)
    const text = (await runOcr(script, image)).trim()
    ocrCache.set(hash, text)
    return text || undefined
  } catch (error) {
    diag(`[fallback] OCR failed: ${(error as Error).message}`)
    ocrCache.set(hash, "")
    return undefined
  } finally {
    await unlink(image).catch(() => undefined)
  }
}

function imageBytes(part: Record<string, unknown>) {
  const url = (part.image_url as { url?: unknown } | undefined)?.url
  if (typeof url === "string" && url.startsWith("data:")) {
    const comma = url.indexOf(",")
    if (comma >= 0 && /;base64/i.test(url.slice(5, comma))) return Buffer.from(url.slice(comma + 1), "base64")
  }
  const file = part.file as { file_data?: unknown; mime_type?: unknown } | undefined
  if (typeof file?.file_data === "string") return Buffer.from(file.file_data, "base64")
  return undefined
}

async function fallbackMessages(messages: unknown[], allowImages: boolean) {
  return Promise.all(
    messages.map(async (message) => {
      if (!message || typeof message !== "object" || !("content" in message)) return message
      const content = (message as { content?: unknown }).content
      if (!Array.isArray(content)) return message
      const parts = await Promise.all(
        content.map(async (part) => {
          if (!part || typeof part !== "object") return [part]
          const value = part as Record<string, unknown>
          const type = value.type
          const file = value.file as { mime_type?: unknown } | undefined
          const mime =
            typeof file?.mime_type === "string"
              ? file.mime_type
              : typeof value.mime === "string"
                ? value.mime
                : undefined
          const image =
            type === "image_url" ||
            type === "image" ||
            type === "input_image" ||
            (typeof mime === "string" && mime.startsWith("image/"))
          const media =
            image ||
            type === "file" ||
            type === "media" ||
            type === "input_file" ||
            (typeof mime === "string" && mime !== "text/plain")
          if (!media) return [part]
          // DeepSeek V4.1 Flash accepts image_url despite older docs saying
          // text-only, so keep the image when the fallback supports vision.
          if (image && allowImages) return [part]
          if (!image) {
            return [
              {
                type: "text",
                text: `[attachment omitted: ${mime ?? String(type)}; the fallback model is text-only]`,
              },
            ]
          }
          // A text-only fallback cannot see the bytes. OCR turns the common
          // case (a Snipping Tool capture, a screenshot of an error) into text
          // instead of silently dropping the image.
          const bytes = imageBytes(value)
          const text = bytes === undefined ? undefined : await ocrImage(bytes)
          diag(
            `[fallback] media part type=${String(type)} mime=${mime ?? "n/a"} bytes=${bytes?.length ?? 0} ocr=${text?.length ?? 0}`,
          )
          return [
            {
              type: "text",
              text: text
                ? `[image text]\n${text}`
                : "[image omitted: the fallback model does not accept images and OCR found no text]",
            },
          ]
        }),
      )
      return { ...message, content: parts.flat() }
    }),
  )
}

// The anonymous opencode.ai free pool is a single global bucket: the same
// 429 + Retry-After comes back from every IP, every session/project/client
// header, every TLS profile, the OpenAI/Anthropic/Responses/SystemOne paths,
// and the dev host. Rotating any of those cannot reset it. The only way to
const FALLBACK_TOOLS = new Set(["read", "write", "edit", "glob", "grep", "shell", "list", "patch", "todowrite", "todoread"])

const truncateText = (text: string, max = 4000) => (text.length > max ? `${text.slice(0, max)}\n[truncated]` : text)

const textOf = (content: unknown) => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) =>
      part && typeof part === "object" && (part as { type?: unknown }).type === "text"
        ? String((part as { text?: unknown }).text ?? "")
        : "",
    )
    .join("\n")
}

const compactMessage = (message: unknown, max = 4000) => {
  if (!message || typeof message !== "object") return message
  const value = message as Record<string, unknown>
  if (typeof value.content === "string") return { ...value, content: truncateText(value.content, max) }
  if (!Array.isArray(value.content)) return value
  return {
    ...value,
    content: value.content.map((part) =>
      part && typeof part === "object" && (part as { type?: unknown }).type === "text"
        ? { ...part, text: truncateText(String((part as { text?: unknown }).text ?? ""), max) }
        : part,
    ),
  }
}

// Pollinations accepts a much smaller body than the agent normally sends.
// The full system prompt, tool schemas and history can reach 80k tokens, and
// the anonymous endpoint then sits on the request instead of answering. Keep
// a short directive, a clipped system prompt and the last few turns.
function compactFallbackMessages(messages: unknown[]) {
  const directive = {
    role: "system",
    content: "Fallback mode: keep answers concise. Use the available tools when needed. The context below is trimmed.",
  }
  const system = messages.filter((message) => (message as { role?: unknown } | null)?.role === "system")
  const rest = messages.filter((message) => (message as { role?: unknown } | null)?.role !== "system")
  const tail = rest.slice(-6).map((message) => compactMessage(message))
  if (!system.length) return [directive, ...tail]
  return [directive, { role: "system", content: truncateText(textOf((system[0] as { content?: unknown }).content)) }, ...tail]
}

function compactFallbackTools(tools: unknown) {
  if (!Array.isArray(tools)) return undefined
  const kept = tools.filter((tool) => {
    const name = (tool as { function?: { name?: unknown } } | null)?.function?.name
    return typeof name === "string" && FALLBACK_TOOLS.has(name)
  })
  return kept.length ? kept : undefined
}

// keep the agent running is to switch the *provider* for the request.
//
// This rewrites an OpenAI Chat body into the tiny compatible subset that
// Pollinations' free OpenAI endpoint accepts. Tool calls and SSE survive.
export async function fallbackBody(
  body: Buffer | null,
  model = process.env.JETCODE_FREE_FALLBACK_MODEL || "openai",
  allowImages = false,
  compact = false,
): Promise<string | null> {
  if (!body) return null
  try {
    const parsed = JSON.parse(body.toString("utf8")) as Record<string, unknown>
    if (!Array.isArray(parsed.messages)) return null
    // Title and summary helpers share the same provider but are not the
    // user's reply. Pollinations serves one generation at a time, so letting
    // them take the slot delays the actual answer; leave them on opencode.ai
    // and let the normal title fallback name the session.
    const conversation = JSON.stringify(parsed.messages)
    if (
      conversation.includes("You name conversations") ||
      conversation.includes("Summarize what was done in this conversation")
    )
      return null
    const messages = await fallbackMessages(parsed.messages, allowImages)
    const out: Record<string, unknown> = {
      model,
      messages: compact ? compactFallbackMessages(messages) : messages,
      stream: parsed.stream ?? true,
    }
    for (const key of ["tools", "tool_choice", "temperature", "top_p", "stop", "response_format"]) {
      if (parsed[key] !== undefined) out[key] = parsed[key]
    }
    const max = parsed.max_tokens ?? parsed.max_completion_tokens
    if (max !== undefined) out.max_tokens = max
    if (typeof out.max_tokens === "number" && out.max_tokens > 8192) out.max_tokens = 8192
    if (compact) {
      const tools = compactFallbackTools(parsed.tools)
      if (tools) out.tools = tools
      else {
        delete out.tools
        delete out.tool_choice
      }
      const limit = typeof out.max_tokens === "number" ? out.max_tokens : 2048
      out.max_tokens = Math.min(limit, 2048)
    }
    return JSON.stringify(out)
  } catch {
    return null
  }
}

async function retryLocalRequest(run: () => Promise<Response>) {
  let response = await run()
  // A local server restart (Ollama reloading a model, a tray restart, an
  // antivirus pause) commonly returns one 5xx. Retry here so the agent loop
  // does not abandon the whole turn for a transient local failure.
  if (response.status === 408 || response.status === 429 || response.status >= 500) {
    await response.body?.cancel().catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 750))
    response = await run()
  }
  return response
}

// Last line of defense: run the same OpenAI-compatible request against a
// model on this machine. This is what keeps a turn alive when the network is
// gone, the free pool is exhausted, and every hosted relay is unreachable.
// The body is compacted so a small-context local model still sees the task and
// the core file/shell tools instead of overflowing before its first token.
export async function localFallbackResponse(body: Buffer | null, reason: string): Promise<Response | undefined> {
  if (!body || process.env.JETCODE_OFFLINE === "0" || process.env.JETCODE_OFFLINE === "false") return
  try {
    const target = await bestLocalModel()
    if (!target) return
    const images = requestHasImage(body)

    // First send the original request: full AGENTS.md/project context, full
    // history, and every tool schema. This is the whole point of a local
    // fallback. Only a length rejection earns a compact retry.
    const full = await fallbackBody(body, target.model, target.vision && images, false)
    if (!full) return
    diag(`[offline] ${reason}; using ${target.label} with full context`)
    let response = await retryLocalRequest(() =>
      localFetch(target.endpoint, {
        method: "POST",
        headers: target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : undefined,
        body: full,
        // A cold Ollama model can spend tens of seconds loading before its first
        // token. The discovery timeout is deliberately short; inference is not.
        timeoutMs: 180_000,
      }),
    )

    if (!response.ok && [400, 413, 422, 500].includes(response.status)) {
      let errorText = ""
      try {
        errorText = await response.clone().text()
      } catch {
        errorText = ""
      }
      if (isContextLengthRejection(errorText)) {
        diag(`[offline] ${target.label} rejected full context for length; retrying compacted`)
        await response.body?.cancel().catch(() => undefined)
        const compact = await fallbackBody(body, target.model, target.vision && images, true)
        if (compact) {
          response = await retryLocalRequest(() =>
            localFetch(target.endpoint, {
              method: "POST",
              headers: target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : undefined,
              body: compact,
              timeoutMs: 180_000,
            }),
          )
        }
      }
    }

    if (response.ok) {
      diag(`[offline] ${target.label} responded ${response.status} type=${response.headers.get("content-type") || "n/a"}`)
      return response
    }
    diag(`[offline] ${target.label} rejected the request with ${response.status}`)
    await response.body?.cancel().catch(() => undefined)
  } catch (error) {
    diag(`[offline] local fallback failed: ${(error as Error).message}`)
  }
  return undefined
}

// Pollinations' anonymous classic endpoint serves one generation at a time
// per IP. The desktop issues the reply and the title request together, so
// without a local queue the second gets "Your previous request is still
// running" and the UI shows a retry error. Serialize fallback requests and
// hold the slot until the stream is consumed.
let fallbackTail: Promise<void> = Promise.resolve()

// The opencode.ai free bucket is global and stays exhausted for hours once it
// trips. Retrying it before every model step adds a full round trip to each
// step (and another for the title request), which is most of the "slow to
// respond" feeling. After the first 429, route chat completions straight to
// the fallback until the advertised Retry-After, clamped to a sane window.
const FREE_LIMIT_DEFAULT_MS = 10 * 60_000
const FREE_LIMIT_MAX_MS = 30 * 60_000

// Ordered best-to-last free models in the opencode catalog. A 429 on one model
// moves the same request to the next model without dropping the turn, so the
// agent keeps working even when the preferred free bucket is exhausted.
// `vision` models can accept image parts; text-only models are skipped for
// image-bearing requests.
const FREE_MODEL_PRIORITY = [
  { id: "big-pickle", vision: false },
  { id: "deepseek-v4.1-flash-free", vision: true },
  { id: "hy4-flash-free", vision: true },
  { id: "nemotron-3.5-super-vl-free", vision: true },
  { id: "inkling-2-small-free", vision: true },
  { id: "longcat-2.5-free", vision: true },
  { id: "mimo-v2.6-flash-free", vision: true },
  { id: "beam-free", vision: false },
  { id: "flint-40b-free", vision: false },
  { id: "nemotron-3.5-lightning-free", vision: false },
  { id: "iceman-free", vision: false },
] as const

const FREE_MODELS: ReadonlyMap<string, { readonly vision: boolean }> = new Map(
  FREE_MODEL_PRIORITY.map((model) => [model.id, model]),
)
const modelCooldownUntil = new Map<string, number>()

/** Test-only hook: transient free-model cooldowns otherwise leak between tests. */
export function resetFallbackStateForTests() {
  modelCooldownUntil.clear()
}

function parseBody(body: Buffer | null): Record<string, unknown> | undefined {
  if (!body) return undefined
  try {
    const parsed = JSON.parse(body.toString("utf8")) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** The model named by an OpenAI chat body, if the body is decodable. */
export function requestModel(body: Buffer | null): string | undefined {
  const model = parseBody(body)?.model
  return typeof model === "string" && model.length > 0 ? model : undefined
}

/** Replaces only the model field, keeping context, tools, and stream settings intact. */
export function rewriteModel(body: Buffer | null, model: string): Buffer | null {
  const parsed = parseBody(body)
  if (!parsed) return null
  return Buffer.from(JSON.stringify({ ...parsed, model }), "utf8")
}

/** Requested free model first, then the quality-ordered catalog. */
export function freeModelOrder(requested?: string): string[] {
  if (!requested || !FREE_MODELS.has(requested)) return FREE_MODEL_PRIORITY.map((model) => model.id)
  return [requested, ...FREE_MODEL_PRIORITY.map((model) => model.id).filter((id) => id !== requested)]
}

/** First free model that is not cooling down and can read the request's content. */
export function bestFreeModel(body: Buffer | null): string | undefined {
  const requested = requestModel(body)
  if (requested && !FREE_MODELS.has(requested)) return undefined
  const vision = requestHasImage(body)
  return freeModelOrder(requested).find((id) => {
    const model = FREE_MODELS.get(id)
    if (!model) return false
    if (vision && !model.vision) return false
    return Date.now() >= (modelCooldownUntil.get(id) ?? 0)
  })
}

function noteFreeLimit(headers: Headers, model?: string) {
  const raw = headers.get("retry-after")
  const seconds = raw === null ? Number.NaN : Number(raw)
  const date = raw === null || Number.isFinite(seconds) ? Number.NaN : Date.parse(raw)
  const wait = Number.isFinite(seconds)
    ? seconds * 1000
    : Number.isFinite(date)
      ? date - Date.now()
      : FREE_LIMIT_DEFAULT_MS
  const clamped = Math.min(FREE_LIMIT_MAX_MS, Math.max(60_000, Number.isFinite(wait) ? wait : FREE_LIMIT_DEFAULT_MS))
  const until = Date.now() + clamped
  if (model) modelCooldownUntil.set(model, until)
  diag(`[fallback] free-limit cooldown ${Math.round(clamped / 1000)}s${model ? ` model=${model}` : ""}`)
}

function freeLimitCooling(model?: string) {
  if (model) return Date.now() < (modelCooldownUntil.get(model) ?? 0)
  return FREE_MODEL_PRIORITY.every((item) => Date.now() < (modelCooldownUntil.get(item.id) ?? 0))
}

function fallbackEnabled() {
  return process.env.JETCODE_FREE_FALLBACK !== "0" && process.env.JETCODE_FREE_FALLBACK !== "false"
}

// The free-model path is rate limited by the fallback provider itself. Prefer
// the DeepSeek key the user already configured: it answers in ~1 s and does
// not have Pollinations' one-reply-per-45-seconds window. Pollinations stays
// the fallback when no key exists or when explicitly selected.
let deepseekKeyCache: string | undefined

async function deepseekKey() {
  if (deepseekKeyCache) return deepseekKeyCache
  const env = process.env.JETCODE_DEEPSEEK_KEY || process.env.DEEPSEEK_API_KEY
  if (env) return (deepseekKeyCache = env)
  const data = process.env.XDG_DATA_HOME || pathJoin(homedir(), ".local", "share")
  // local-channel builds keep credentials in opencode-local.db; older
  // installs and the upstream desktop use opencode.db. Try both so a fresh
  // install does not silently fall back to the 45-second Pollinations slot.
  for (const name of ["opencode-local.db", "opencode.db"]) {
    try {
      const { Database } = await import("bun:sqlite")
      const db = new Database(pathJoin(data, "opencode", name), { readonly: true })
      try {
        const row = db
          .query("select value from credential where integration_id = 'deepseek' and active = 1 limit 1")
          .get() as { value?: string } | undefined
        if (row?.value === undefined) continue
        const parsed = JSON.parse(row.value) as { type?: string; key?: string }
        if (parsed.type === "key" && parsed.key) return (deepseekKeyCache = parsed.key)
      } finally {
        db.close()
      }
    } catch {
      // Missing DB, old schema, or locked file: try the next path.
    }
  }
  // Do not cache absence: the user can connect a key after this process booted.
  return undefined
}

async function withFallbackSlot(run: (release: () => void) => Promise<Response>): Promise<Response> {
  const previous = fallbackTail
  let resolveSlot!: () => void
  fallbackTail = new Promise<void>((resolve) => (resolveSlot = resolve))
  let released = false
  const release = () => {
    if (released) return
    released = true
    resolveSlot()
  }
  await previous
  try {
    return await run(release)
  } catch (cause) {
    release()
    throw cause
  }
}

function holdFallbackSlot(response: Response, release: () => void): Response {
  if (!response.body) {
    release()
    return response
  }
  const reader = response.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) {
          release()
          controller.close()
          return
        }
        controller.enqueue(next.value)
      } catch (cause) {
        release()
        controller.error(cause)
      }
    },
    cancel(reason) {
      release()
      return reader.cancel(reason)
    },
  })
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}

function busyFallbackBody(text: string) {
  return /previous request is still running|Classic API answers 1 request/i.test(text)
}

export function requestHasImage(body: Buffer | null) {
  if (!body || body.length === 0) return false
  try {
    const parsed = JSON.parse(body.toString("utf8")) as { messages?: unknown }
    if (!Array.isArray(parsed.messages)) return false
    const scan = (value: unknown): boolean => {
      if (!value || typeof value !== "object") return false
      if (Array.isArray(value)) return value.some(scan)
      const part = value as Record<string, unknown>
      if (part.type === "image_url" || part.type === "image" || part.type === "input_image") return true
      const file = part.file as { mime_type?: unknown } | undefined
      const mime =
        typeof part.mime_type === "string"
          ? part.mime_type
          : typeof part.mime === "string"
            ? part.mime
            : typeof file?.mime_type === "string"
              ? file.mime_type
              : undefined
      if (typeof mime === "string" && mime.startsWith("image/")) return true
      return "content" in part ? scan(part.content) : false
    }
    return parsed.messages.some(scan)
  } catch {
    return false
  }
}

// A model can be blocked for the caller's country even while the account and
// the request are valid. Providers return this as a normal error response, and
// the AI SDK used to hand that sentence to the user as the agent's reply. Treat
// it as a routing signal instead: cool the model down and continue on another
// free model or the local model.
const REGION_BLOCK =
  /(?:not|isn't|is\s+not)\s+(?:currently\s+)?available\s+in\s+your\s+(?:country|region|location)|(?:country|region|location)[^\n]{0,80}(?:not|isn't)\s+(?:supported|available)|unsupported\s+(?:country|region|location)|(?:country|region)\s+restriction/i

export function isRegionBlockText(text: string) {
  return REGION_BLOCK.test(text)
}

function noteRegionBlock(model?: string) {
  const until = Date.now() + FREE_LIMIT_MAX_MS
  if (model) modelCooldownUntil.set(model, until)
  diag(`[fallback] region-block cooldown 30m${model ? ` model=${model}` : ""}`)
}

/** Inspects an error response without consuming a response that is not a region block. */
async function inspectRegionBlock(
  response: Response,
): Promise<{ blocked: true } | { blocked: false; response: Response }> {
  if (response.status !== 400 && response.status !== 403 && response.status !== 451) {
    return { blocked: false, response }
  }
  try {
    const text = await response.clone().text()
    if (!isRegionBlockText(text)) return { blocked: false, response }
    await response.body?.cancel().catch(() => undefined)
    return { blocked: true }
  } catch {
    return { blocked: false, response }
  }
}

const CONTEXT_LENGTH_REJECTION =
  /(?:context\s+(?:length|window|size)|maximum\s+context|too\s+many\s+tokens|prompt\s+is\s+too\s+long|input[^\n]{0,40}too\s+long|exceeds?[^\n]{0,40}(?:context|tokens)|n_ctx|num_ctx)/i

export function isContextLengthRejection(text: string) {
  return CONTEXT_LENGTH_REJECTION.test(text)
}

// Run the provider fallback for a chat-completions body. Returns undefined
// when the request is not eligible (titles/summaries, fallback disabled, or no
// usable body); callers then keep the original response.
const installId = () => createHash("sha256").update(`${homedir()}|${hostname()}`).digest("hex").slice(0, 32)

async function fallbackResponse(
  bin: string,
  url: string,
  body: Buffer | null,
  profile: Profile,
  headers: [string, string][] = [],
): Promise<Response | undefined> {
  if (!fallbackEnabled() || !/\/chat\/completions(?:\?|$)/.test(url)) return
  // First keep the turn on opencode.ai by trying the next free model. This is
  // the preferred path: full tools, full context, and no external relay.
  const requested = requestModel(body)
  if (requested && FREE_MODELS.has(requested) && headers.length > 0) {
    for (const candidate of freeModelOrder(requested).slice(1)) {
      const model = FREE_MODELS.get(candidate)
      if (!model || (requestHasImage(body) && !model.vision) || freeLimitCooling(candidate)) continue
      const rewrite = rewriteModel(body, candidate)
      if (!rewrite) continue
      try {
        diag(`[fallback] ${requested} exhausted; trying free model ${candidate}`)
        const response = await impersonateFetchViaSubprocess(
          bin,
          url,
          "POST",
          headers,
          rewrite,
          false,
          90_000,
        )
        if (response.status === 429) {
          noteFreeLimit(response.headers, candidate)
          await response.body?.cancel().catch(() => undefined)
          continue
        }
        const region = await inspectRegionBlock(response)
        if (region.blocked) {
          noteRegionBlock(candidate)
          diag(`[fallback] ${candidate} is blocked for this country; trying the next model`)
          continue
        }
        return region.response
      } catch (e) {
        diag(`[fallback] free model ${candidate} failed: ${(e as Error).message}`)
      }
    }
  }
  const provider = (process.env.JETCODE_FREE_FALLBACK_PROVIDER || "auto").toLowerCase()
  const key = provider === "pollinations" ? undefined : await deepseekKey()
  if (key !== undefined && provider !== "pollinations") {
    const rewrite = await fallbackBody(
      body,
      process.env.JETCODE_FREE_FALLBACK_DEEPSEEK_MODEL || "deepseek-chat",
      true,
    )
    if (rewrite) {
      try {
        diag(`[fallback] free limit on ${url.slice(0, 120)} -> deepseek`)
        const response = await impersonateFetchViaSubprocess(
          bin,
          "https://api.deepseek.com/chat/completions",
          "POST",
          [
            ["content-type", "application/json"],
            ["authorization", `Bearer ${key}`],
          ],
          Buffer.from(rewrite, "utf8"),
          false,
          90_000,
        )
        diag(`[fallback] deepseek status=${response.status} type=${response.headers.get("content-type") || "n/a"}`)
        if (response.ok) return response
        await response.body?.cancel()
      } catch (e) {
        diag(`[fallback] deepseek failed: ${(e as Error).message}`)
      }
    }
  }
  // Prefer a local model over an external relay: it is free, private, and works
  // with no network at all.
  const local = await localFallbackResponse(body, "hosted fallbacks unavailable")
  if (local) return local

  const relayUrl = process.env.JETCODE_FREE_RELAY || "https://license.example.com/api/free/chat"
  const relayBody = await fallbackBody(body, "deepseek-chat", true)
  if (relayBody) {
    try {
      diag(`[fallback] relay -> ${relayUrl}`)
      const response = await impersonateFetchViaSubprocess(
        bin,
        relayUrl,
        "POST",
        [
          ["content-type", "application/json"],
          ["x-user-install", installId()],
        ],
        Buffer.from(relayBody, "utf8"),
        false,
        90_000,
      )
      diag(`[fallback] relay status=${response.status} type=${response.headers.get("content-type") || "n/a"}`)
      if (response.ok) return response
      await response.body?.cancel()
    } catch (e) {
      diag(`[fallback] relay failed: ${(e as Error).message}`)
    }
  }
  const rewrite = await fallbackBody(body, process.env.JETCODE_FREE_FALLBACK_MODEL || "openai", false, true)
  if (!rewrite) return
  const fallbackUrl = process.env.JETCODE_FREE_FALLBACK_URL || "https://text.pollinations.ai/openai"
  const fbHeaders: [string, string][] = [["content-type", "application/json"]]
  const fbKey = process.env.JETCODE_FREE_FALLBACK_KEY
  if (fbKey) fbHeaders.push(["authorization", `Bearer ${fbKey}`])
  try {
    diag(`[fallback] free limit on ${url.slice(0, 120)} -> ${fallbackUrl}`)
    return await withFallbackSlot(async (release) => {
      let lastStatus = 0
      let lastHeaders = new Headers()
      let lastText = ""
      for (let attempt = 0; attempt < 4; attempt++) {
        const response = await impersonateFetchViaSubprocess(
          bin,
          fallbackUrl,
          "POST",
          fbHeaders,
          Buffer.from(rewrite, "utf8"),
          false,
          90_000,
        )
        diag(
          `[fallback] response status=${response.status} type=${response.headers.get("content-type") || "n/a"} attempt=${attempt + 1}`,
        )
        if (response.status !== 429) return holdFallbackSlot(response, release)
        lastStatus = response.status
        lastHeaders = response.headers
        lastText = await response.text()
        if (!busyFallbackBody(lastText)) {
          release()
          return new Response(lastText, { status: lastStatus, headers: lastHeaders })
        }
        diag(`[fallback] classic slot busy; waiting (attempt=${attempt + 1})`)
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)))
      }
      release()
      return new Response(lastText, { status: lastStatus, headers: lastHeaders })
    })
  } catch (e) {
    diag(`[fallback] failed: ${(e as Error).message}`)
    return
  }
}

// Core: run curl-impersonate for the given request, return a Response.
async function impersonateFetchViaSubprocess(
  bin: string,
  url: string,
  method: string,
  headerPairs: [string, string][],
  body: Buffer | null,
  allowFallback = true,
  timeoutMs = 0,
): Promise<Response> {
  const profile = currentProfile()
  const chatUrl = /\/chat\/completions(?:\?|$)/.test(url)
  const vision = chatUrl && requestHasImage(body)
  // If the selected model is cooling down, move to the best free model that
  // still works instead of abandoning opencode.ai or waiting. Image requests
  // also pick a vision-capable free model when the selected one is text-only.
  if (allowFallback && chatUrl && fallbackEnabled()) {
    const requested = requestModel(body)
    const candidate = bestFreeModel(body)
    if (candidate && requested && candidate !== requested) {
      const rewrite = rewriteModel(body, candidate)
      if (rewrite) {
        body = rewrite
        diag(`[fallback] ${requested} cooling${vision ? " or text-only for image" : ""}; switched to ${candidate}`)
      }
    }
    if (!candidate) {
      const response = await fallbackResponse(bin, url, body, profile, headerPairs)
      if (response !== undefined) {
        diag(`[fallback] all free models are cooling; routed ${url.slice(0, 120)} without probing opencode.ai`)
        return response
      }
    }
  }
  // --compressed: curl-impersonate advertises Chrome's Accept-Encoding
  // (gzip, deflate, br, zstd) in the ClientHello because real Chrome does.
  // Without --compressed, opencode.ai's br/gzip response body reaches us
  // raw and we pass raw compressed bytes back to the AI SDK's SSE parser,
  // which sees "stream ended without finish reason" because the parser
  // can't make sense of compressed bytes. With --compressed, curl decodes
  // on the client side and stdout is plain-text SSE events the SDK can
  // parse end-to-end. We also strip Content-Encoding on the way back out
  // (parseHttpResponse drops it) so the SDK doesn't try to decode again.
  // --no-buffer: curl flushes each stream chunk as it arrives instead of
  // waiting for its 16 KB buffer to fill. Without this, opencode.ai's
  // streaming inference chunks arrive at the SDK in one big blob after
  // the stream completes — functional but defeats token-at-a-time UI.
  const args: string[] = [
    "--impersonate", profile,
    "-s",
    "-i",
    // With -x, curl prints the proxy's `HTTP/1.1 200 Connection established`
    // block before the TLS response. Without this flag the parser used to
    // take that block as the response, so a real 429 reached the AI SDK as
    // status 200 + a JSON body it could not decode as SSE.
    "--suppress-connect-headers",
    "--compressed",
    "--no-buffer",
    "-X", method,
  ]
  // The fallback endpoint can accept a connection and then sit on it. A
  // bounded total time turns that into a retry/error instead of a spinner
  // that never resolves. Primary opencode.ai requests keep no cap.
  if (timeoutMs > 0) args.push("--max-time", String(Math.ceil(timeoutMs / 1000)))

  // Honour HTTPS_PROXY / HTTP_PROXY env — curl reads these natively, but we
  // pass -x explicitly so the proxy choice is visible in diag and survives
  // env-stripping child-spawns. Tor HTTP tunnel on 127.0.0.1:8118 by default
  // (fresh.ps1 Invoke-TorRotate return value).
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
  const local = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/)/i.test(url)
  if (proxy && !local) args.push("-x", proxy)

  // Drop Accept-Encoding so curl can pick its own browser-matching value.
  // Content-Length is recomputed by curl from the stdin body length; passing
  // the caller's value here mismatches when the body is a stream-read Buffer.
  const dropped = new Set(["accept-encoding", "content-length", "host"])
  // v12: bearer rewrite was reverted — opencode.ai validates the literal
  // string "public" and rejects randomized wrk_* tokens as "invalid
  // credentials". The FreeUsageLimit bucket must be keyed by something OTHER
  // than the bearer value. Keep the request-header logging so the real
  // identifier can be spotted on the wire.
  const isInferenceReq = /\/inference\//.test(url)
  const sentHeaders: string[] = []
  for (const [k, v] of headerPairs) {
    if (dropped.has(k.toLowerCase())) continue
    args.push("-H", `${k}: ${v}`)
    // Collect for diag — strip the bearer VALUE so the log doesn't leak the
    // token, keep header shape visible. Also log cookie sizes without values.
    if (k.toLowerCase() === "authorization") {
      sentHeaders.push(`${k}: ${v.replace(/Bearer\s+\S+/i, "Bearer <" + (v.slice(7, 12) || "?") + "...>")}`)
    } else if (k.toLowerCase() === "cookie" || k.toLowerCase() === "set-cookie") {
      sentHeaders.push(`${k}: <${v.length}B: ${v.slice(0, 80)}...>`)
    } else {
      sentHeaders.push(`${k}: ${v.slice(0, 200)}`)
    }
  }
  if (isInferenceReq) {
    diag(`[impersonate] req-headers profile=${profile} ${method} ${url.slice(0, 120)}: ${sentHeaders.join(" | ").slice(0, 2000)}`)
  }

  if (body && body.length > 0) {
    args.push("--data-binary", "@-")
  }
  args.push(url)

  return new Promise<Response>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
    const stderrChunks: Buffer[] = []
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk as Buffer))
    child.on("error", (e) => {
      diag(`[impersonate] spawn error: ${e.message}`)
      reject(e)
    })

    // Buffer stdout until we've seen the end of headers, then stream the
    // rest into the Response body. Streaming matters for /inference/*
    // SSE endpoints — the AI SDK renders tokens as they arrive. Without
    // streaming the user stares at a blank screen until the whole
    // completion lands.
    const headBuf: Buffer[] = []
    let headSeen = false
    let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null
    let settled = false
    let totalBodyBytes = 0
    // Body sampler: capture up to 4KB of head + 4KB of tail for small
    // responses (<=16KB) so we can diag account-layer error envelopes that
    // return 200 + tiny SSE body. Added v10 to decode the 552B error pattern
    // seen on v8/v9 post-JA3 bypass.
    const SAMPLE_CAP = 4096
    const sampleHead: Buffer[] = []
    const sampleTail: Buffer[] = []
    let sampleHeadLen = 0
    let responseStatus = 0
    let responseContentType = ""
    // A 429 carries a small JSON body. Buffer it instead of resolving the
    // Response so we can inspect FreeUsageLimitError and switch providers
    // before the AI SDK ever sees the error.
    let errorBuffering = false
    let errorStatus = 0
    let errorHeaders: Headers | null = null
    let errorBytes = 0
    const errorChunks: Buffer[] = []
    const settleBufferedError = async (): Promise<Response> => {
      const text = Buffer.concat(errorChunks).toString("utf8")
      const headers = errorHeaders ?? new Headers({ "content-type": "application/json" })
      const isFreeLimit = /FreeUsageLimit|free usage limit/i.test(text)
      const regionBlocked = isRegionBlockText(text)
      if (isFreeLimit) {
        noteFreeLimit(headers, requestModel(body))
        diag(`[impersonate] 429 body profile=${profile} bytes=${errorBytes} text=${text.replace(/\r?\n/g, "\\n").slice(0, 300)}`)
      }
      if (regionBlocked) {
        noteRegionBlock(requestModel(body))
        diag(`[impersonate] region block profile=${profile} bytes=${errorBytes} text=${text.replace(/\r?\n/g, "\\n").slice(0, 300)}`)
      }
      if (
        allowFallback &&
        fallbackEnabled() &&
        (isFreeLimit || regionBlocked) &&
        /\/chat\/completions(?:\?|$)/.test(url)
      ) {
        const response = await fallbackResponse(bin, url, body, profile, headerPairs)
        if (response !== undefined) return response
      }
      return new Response(text, { status: errorStatus, headers })
    }

    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      if (err) {
        diag(`[impersonate] stream error profile=${profile} url=${url.slice(0, 120)}: ${err.message}`)
        if (bodyController) {
          try { bodyController.error(err) } catch { /* ignore */ }
        } else {
          reject(err)
        }
        return
      }
      if (bodyController) {
        try { bodyController.close() } catch { /* ignore */ }
      }
    }

    const bodyStream = new ReadableStream<Uint8Array>({
      start(ctrl) {
        bodyController = ctrl
      },
      cancel(reason) {
        diag(`[impersonate] body stream cancelled: ${String(reason)}`)
        try { child.kill() } catch { /* ignore */ }
      },
    })

    const emitBody = (chunk: Buffer) => {
      if (chunk.length === 0) return
      totalBodyBytes += chunk.length
      if (errorBuffering) {
        if (errorBytes < 64 * 1024) {
          errorChunks.push(chunk)
          errorBytes += chunk.length
        }
        return
      }
      // Sampler: fill head up to cap, then rotate tail ring.
      if (sampleHeadLen < SAMPLE_CAP) {
        const room = SAMPLE_CAP - sampleHeadLen
        const take = chunk.length <= room ? chunk : chunk.subarray(0, room)
        sampleHead.push(take)
        sampleHeadLen += take.length
        if (chunk.length > room) {
          sampleTail.push(chunk.subarray(room))
        }
      } else {
        sampleTail.push(chunk)
      }
      // Trim tail ring to SAMPLE_CAP bytes (keep only the last 4KB).
      let tailBytes = 0
      for (const b of sampleTail) tailBytes += b.length
      while (tailBytes > SAMPLE_CAP && sampleTail.length > 1) {
        tailBytes -= sampleTail[0].length
        sampleTail.shift()
      }
      if (bodyController) {
        try { bodyController.enqueue(new Uint8Array(chunk)) } catch { /* consumer gone */ }
      }
    }

    child.stdout.on("data", (chunk: Buffer) => {
      if (headSeen) {
        emitBody(chunk)
        return
      }
      headBuf.push(chunk)
      const combined = Buffer.concat(headBuf)
      const parsed = parseResponseHead(combined, Boolean(proxy))
      if (!parsed) {
        // Head not complete yet — keep buffering. Guard against pathological
        // responses that never close the head section.
        if (combined.length > 1024 * 1024) {
          finish(new Error("curl-impersonate: response head exceeded 1 MiB without terminator"))
          try { child.kill() } catch { /* ignore */ }
        }
        return
      }
      headSeen = true
      responseStatus = parsed.status
      const headers = new Headers()
      for (const [k, v] of parsed.headers) {
        try { headers.append(k, v) } catch { /* ignore invalid header char */ }
        if (k.toLowerCase() === "content-type") responseContentType = v
      }
      diag(
        `[impersonate] profile=${profile} ${method} ${url.slice(0, 120)} -> ${parsed.status} ` +
          `(streaming, proxy=${proxy || "none"}, ct=${responseContentType || "n/a"})`,
      )
      if (parsed.status === 400 || parsed.status === 403 || parsed.status === 429 || parsed.status === 451) {
        // Hold the response until close so the error body can be inspected and,
        // when it is a free-limit or country block, transparently rerouted.
        errorBuffering = true
        errorStatus = parsed.status
        errorHeaders = headers
      } else {
        resolve(
          new Response(bodyStream, {
            status: parsed.status,
            statusText: parsed.statusText,
            headers,
          }),
        )
      }
      // Any body bytes already buffered past the head terminator get
      // flushed into the stream before we return control to the event loop.
      const tail = combined.subarray(parsed.bodyOffset)
      if (tail.length > 0) emitBody(tail)
    })

    child.on("close", (code) => {
      const errText = Buffer.concat(stderrChunks).toString("utf8").slice(0, 2048)
      if (!headSeen) {
        // Process exited without ever emitting a complete head — hand the
        // promise a failure so the AI SDK sees a proper error instead of
        // "stream ended without finish reason".
        const combined = Buffer.concat(headBuf)
        const msg = code === 0
          ? `curl-impersonate produced no parseable HTTP head (stdoutLen=${combined.length}, stderr=${errText.slice(0, 200)})`
          : `curl-impersonate exit ${code}: ${errText}`
        diag(`[impersonate] early-exit profile=${profile} url=${url.slice(0, 120)} code=${code} ${msg.slice(0, 300)}`)
        reject(new Error(msg))
        return
      }
      if (errorBuffering) {
        if (code !== 0) {
          diag(`[impersonate] 429 stream exit ${code} profile=${profile} url=${url.slice(0, 120)} bytes=${errorBytes}`)
        }
        void settleBufferedError()
          .then(resolve)
          .catch((e) => {
            diag(`[fallback] settle failed: ${(e as Error).message}`)
            resolve(new Response("free-limit fallback failed", { status: 502 }))
          })
        return
      }
      if (code !== 0) {
        diag(`[impersonate] stream aborted profile=${profile} url=${url.slice(0, 120)} code=${code} bytes=${totalBodyBytes} stderr=${errText.slice(0, 200)}`)
        finish(new Error(`curl-impersonate exit ${code}: ${errText}`))
        return
      }
      diag(`[impersonate] stream done profile=${profile} url=${url.slice(0, 120)} status=${responseStatus} bytes=${totalBodyBytes}`)
      // Body sampler: for short responses (<= 16KB) or any response on the
      // inference endpoint, log the head and tail of the body so account-
      // layer errors masquerading as 200 are visible in diag. Replace raw
      // newlines with \n so the log stays one line per entry.
      const isInference = /\/inference\/|\/chat\/completions/.test(url)
      const shouldSample = totalBodyBytes <= 16 * 1024 || isInference
      if (shouldSample) {
        const headText = Buffer.concat(sampleHead, Math.min(sampleHeadLen, SAMPLE_CAP))
          .toString("utf8")
          .replace(/\r?\n/g, "\\n")
          .slice(0, 2000)
        const tailBuf = Buffer.concat(sampleTail)
        const tailText = tailBuf.length > 0
          ? tailBuf.toString("utf8").replace(/\r?\n/g, "\\n").slice(-1000)
          : ""
        diag(`[impersonate] body-sample profile=${profile} status=${responseStatus} bytes=${totalBodyBytes} HEAD="${headText}"${tailText && tailText !== headText ? ` TAIL="${tailText}"` : ""}`)
      }
      finish()
    })

    if (body && body.length > 0) {
      child.stdin.write(body)
    }
    child.stdin.end()
  })
}

// Native-fetch fallback used when the optional curl-impersonate binary is not
// installed. The opencode free bucket answers 429 FreeUsageLimit before any
// token is generated, so retrying the same request can never help. Rewrite the
// request for the public Pollinations OpenAI-compatible endpoint instead and
// keep the response protocol (streaming and tool-call deltas) intact.
export async function nativeFallbackResponse(
  original: typeof globalThis.fetch,
  url: string,
  body: Buffer | null,
  requestHeaders: Headers,
): Promise<Response | undefined> {
  if (!fallbackEnabled() || !/\/chat\/completions(?:\?|$)/.test(url)) return
  const requested = requestModel(body)
  if (requested && FREE_MODELS.has(requested)) {
    for (const candidate of freeModelOrder(requested).slice(1)) {
      const model = FREE_MODELS.get(candidate)
      if (!model || (requestHasImage(body) && !model.vision) || freeLimitCooling(candidate)) continue
      const rewrite = rewriteModel(body, candidate)
      if (!rewrite) continue
      try {
        diag(`[fallback-native] ${requested} exhausted; trying free model ${candidate}`)
        const response = await original(url, { method: "POST", headers: requestHeaders, body: new Uint8Array(rewrite) })
        if (response.status === 429) {
          noteFreeLimit(response.headers, candidate)
          await response.body?.cancel().catch(() => undefined)
          continue
        }
        const region = await inspectRegionBlock(response)
        if (region.blocked) {
          noteRegionBlock(candidate)
          diag(`[fallback-native] ${candidate} is blocked for this country; trying the next model`)
          continue
        }
        return region.response
      } catch (e) {
        diag(`[fallback-native] free model ${candidate} failed: ${(e as Error).message}`)
      }
    }
  }
  const local = await localFallbackResponse(body, "hosted fallbacks unavailable")
  if (local) return local

  const rewrite = await fallbackBody(body, process.env.JETCODE_FREE_FALLBACK_MODEL || "openai", false, true)
  if (!rewrite) return
  const fallbackUrl = process.env.JETCODE_FREE_FALLBACK_URL || "https://text.pollinations.ai/openai"
  const fallbackHeaders: Record<string, string> = { "content-type": "application/json" }
  const key = process.env.JETCODE_FREE_FALLBACK_KEY
  if (key) fallbackHeaders.authorization = `Bearer ${key}`
  try {
    diag(`[fallback-native] free limit on ${url.slice(0, 120)} -> ${fallbackUrl}`)
    return await withFallbackSlot(async (release) => {
      let lastStatus = 0
      let lastHeaders = new Headers()
      let lastText = ""
      for (let attempt = 0; attempt < 4; attempt++) {
        const response = await original(fallbackUrl, { method: "POST", headers: fallbackHeaders, body: rewrite })
        diag(
          `[fallback-native] response status=${response.status} type=${response.headers.get("content-type") || "n/a"} attempt=${attempt + 1}`,
        )
        if (response.status !== 429) return holdFallbackSlot(response, release)
        lastStatus = response.status
        lastHeaders = response.headers
        lastText = await response.text()
        if (!busyFallbackBody(lastText)) {
          release()
          return new Response(lastText, { status: lastStatus, headers: lastHeaders })
        }
        diag(`[fallback-native] classic slot busy; waiting (attempt=${attempt + 1})`)
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)))
      }
      release()
      const clean = new Headers(lastHeaders)
      for (const header of ["content-encoding", "content-length", "transfer-encoding"]) clean.delete(header)
      return new Response(lastText, { status: lastStatus, headers: clean })
    })
  } catch (e) {
    diag(`[fallback-native] failed: ${(e as Error).message}`)
    return
  }
}

// Public: fallback-only override for builds without curl-impersonate. The
// curated desktop package intentionally ships no curl dependency, so without
// this a single global 429 leaves every prompt unanswered.
export function installNativeFallbackFetchOverride(): { installed: boolean; reason?: string } {
  const marker = globalThis as {
    __jetcodeNativeFallbackInstalled?: boolean
    __jetcodeImpersonateInstalled?: boolean
  }
  if (marker.__jetcodeNativeFallbackInstalled) return { installed: true, reason: "already installed" }
  if (marker.__jetcodeImpersonateInstalled) return { installed: false, reason: "curl impersonation already handles fallback" }
  if (typeof globalThis.fetch !== "function") return { installed: false, reason: "no native fetch to override" }
  const original = globalThis.fetch.bind(globalThis)
  ;(globalThis as { fetch: typeof globalThis.fetch }).fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    let url = ""
    let body: Buffer | null = null
    try {
      url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url
      const parsed = new URL(url)
      if (!isOpencodeHost(parsed.hostname) || !/\/chat\/completions(?:\?|$)/.test(url)) {
        return original(input as RequestInfo | URL, init)
      }
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
      if (method !== "POST") return original(input as RequestInfo | URL, init)
      const bodySource =
        init?.body ??
        (input instanceof Request ? await input.clone().arrayBuffer() : null)
      body = await bodyToBuffer(bodySource as BodyInit | null)

      const headers = new Headers(input instanceof Request ? input.headers : undefined)
      for (const [key, value] of toHeaderPairs(init?.headers)) headers.set(key, value)
      const requested = requestModel(body)
      const candidate = bestFreeModel(body)
      let switched = false
      if (candidate && requested && candidate !== requested) {
        const rewritten = rewriteModel(body, candidate)
        if (rewritten) {
          body = rewritten
          switched = true
          diag(`[fallback-native] ${requested} cooling or text-only; switched to ${candidate}`)
        }
      }

      if (!candidate && requested && FREE_MODELS.has(requested)) {
        const cached = await nativeFallbackResponse(original, url, body, headers)
        if (cached) return cached
      }

      const request =
        switched && body
          ? input instanceof Request
            ? new Request(input, { method, headers, body: new Uint8Array(body) })
            : new Request(url, { ...init, method, headers, body: new Uint8Array(body) })
          : input instanceof Request
            ? input.clone()
            : input
      const response = await original(request as RequestInfo | URL, switched ? undefined : init)
      if (response.status === 400 || response.status === 403 || response.status === 451) {
        const region = await inspectRegionBlock(response)
        if (region.blocked) {
          const model = requestModel(body)
          noteRegionBlock(model)
          diag(`[fallback-native] ${model ?? "model"} is blocked for this country; trying fallbacks`)
          const fallback = await nativeFallbackResponse(original, url, body, headers)
          if (fallback) return fallback
          return new Response(
            JSON.stringify({
              error: {
                message:
                  "This model is not available in your country, and no fallback model could answer. jetcode tried the other free models and the local model.",
              },
            }),
            { status: 451, headers: { "content-type": "application/json" } },
          )
        }
        return region.response
      }
      if (response.status !== 429) return response
      const text = await response.clone().text()
      if (!/FreeUsageLimit|free usage limit/i.test(text)) return response
      noteFreeLimit(response.headers, requestModel(body))
      const fallback = await nativeFallbackResponse(original, url, body, headers)
      if (!fallback) return response
      await response.body?.cancel().catch(() => undefined)
      return fallback
    } catch (e) {
      diag(`[fallback-native] fetch override ERROR, trying local model: ${(e as Error).message}`)
      const local = await localFallbackResponse(body, "opencode.ai unreachable")
      if (local) return local
      return original(input as RequestInfo | URL, init)
    }
  }) as typeof globalThis.fetch
  marker.__jetcodeNativeFallbackInstalled = true
  diag(`[fallback-native] global fetch override INSTALLED (opencode.ai 429 -> Pollinations)`)
  return { installed: true }
}

// Public: install a global fetch override that routes opencode.ai through
// curl-impersonate, leaving every other host on the native fetch. Idempotent:
// a second install call is a no-op. Returns the previous fetch so callers
// who want to unhook (tests) can restore it.
export function installImpersonateFetchOverride(): { installed: boolean; reason?: string } {
  const bin = resolveImpersonateBin()
  if (!bin) {
    return { installed: false, reason: "curl-impersonate.exe not found under deps/impersonate" }
  }
  if ((globalThis as { __jetcodeImpersonateInstalled?: boolean }).__jetcodeImpersonateInstalled) {
    return { installed: true, reason: "already installed" }
  }
  if (typeof globalThis.fetch !== "function") {
    return { installed: false, reason: "no native fetch to override" }
  }
  const original = globalThis.fetch.bind(globalThis)
  ;(globalThis as { fetch: typeof globalThis.fetch }).fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    let bodyForLocal: Buffer | null = null
    try {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url
      const host = new URL(url).hostname.toLowerCase()
      if (!isOpencodeHost(host)) {
        return original(input as RequestInfo | URL, init)
      }
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
      const headerPairs = toHeaderPairs(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      const bodySource =
        init?.body ??
        (input instanceof Request && method !== "GET" && method !== "HEAD" ? await input.clone().arrayBuffer() : null)
      const bodyBuf = await bodyToBuffer(bodySource as BodyInit | null)
      bodyForLocal = bodyBuf
      return await impersonateFetchViaSubprocess(bin, url, method, headerPairs, bodyBuf)
    } catch (e) {
      diag(`[impersonate] fetch override ERROR, trying local model: ${(e as Error).message}`)
      const local = await localFallbackResponse(bodyForLocal, "opencode.ai unreachable")
      if (local) return local
      return original(input as RequestInfo | URL, init)
    }
  }) as typeof globalThis.fetch
  ;(globalThis as { __jetcodeImpersonateInstalled?: boolean }).__jetcodeImpersonateInstalled = true
  diag(`[impersonate] global fetch override INSTALLED (opencode.ai hosts routed via curl-impersonate)`)
  return { installed: true }
}
