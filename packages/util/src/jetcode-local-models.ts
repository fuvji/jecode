export * as JetcodeLocalModels from "./jetcode-local-models.js"

// Offline continuity for jetcode.
//
// The agent should not die because the Wi-Fi did, so this module discovers
// every local OpenAI-compatible model server we know how to talk to, ranks the
// best one for agent work, remembers it, and can keep an Ollama install stocked
// with a strong free coding model. It is intentionally a best-effort layer:
// discovery failures never block startup and never make a network request leave
// the machine.
import { spawn } from "node:child_process"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync } from "node:fs"
import { statfs, writeFile } from "node:fs/promises"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"
import { homedir, totalmem } from "node:os"
import { dirname, join } from "node:path"
import { Readable } from "node:stream"

const DATA = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
const STATE_DIR = join(DATA, "opencode")
const SELECTED_FILE = join(STATE_DIR, "jetcode-local-model.json")
const LEGACY_SELECTED_FILE = join(STATE_DIR, "olliecode-local-model.json")
const STATUS_FILE = join(STATE_DIR, "jetcode-offline-model.json")
const LOG_DIR = join(STATE_DIR, "log")
const PULL_LOG = join(LOG_DIR, "ollama-pull.log")
const PULL_MARKER = join(STATE_DIR, "jetcode-ollama-pull.json")
const PULL_CONSENT = join(STATE_DIR, "jetcode-ollama-consent.json")

export type LocalTarget = {
  readonly endpoint: string
  readonly model: string
  readonly label: string
  readonly source: "ollama" | "lmstudio" | "openai-compatible"
  readonly tools: boolean
  readonly vision: boolean
  readonly context: number
  readonly parameterB: number
  readonly score: number
  readonly apiKey?: string
}

type OllamaTag = {
  name?: string
  model?: string
  size?: number
  modified_at?: string
  details?: { parameter_size?: string; family?: string }
}

type OllamaShow = {
  capabilities?: string[]
  model_info?: Record<string, unknown>
  details?: { parameter_size?: string }
}

type LmStudioModel = {
  type?: string
  key?: string
  display_name?: string
  max_context_length?: number
  loaded_instances?: unknown[]
  capabilities?: { vision?: boolean; trained_for_tool_use?: boolean }
}

type OpenAiModel = { id?: string }

type Cache = { at: number; targets: LocalTarget[] }

const CACHE_MS = 45_000
let cache: Cache | undefined
let discovery: Promise<LocalTarget[]> | undefined
let bootstrapRun: Promise<void> | undefined

function env(name: string) {
  const value = process.env[name]
  return value && value.trim() ? value.trim() : undefined
}

function rootUrl(raw: string, suffixes: RegExp[]) {
  let value = raw.includes("://") ? raw : `http://${raw}`
  value = value.replace(/\/+$/, "")
  for (const suffix of suffixes) value = value.replace(suffix, "")
  return value.replace(/\/+$/, "")
}

function ollamaRoot() {
  const raw = env("JETCODE_OLLAMA_URL") || env("OLLAMA_HOST") || "http://127.0.0.1:11434"
  // OLLAMA_HOST may be "host:port" without a scheme.
  return rootUrl(raw, [/\/api$/i, /\/v1$/i])
}

function lmStudioRoot() {
  return rootUrl(env("JETCODE_LMSTUDIO_URL") || "http://127.0.0.1:1234", [/\/api\/v1$/i, /\/v1$/i])
}

function genericEndpoint() {
  const raw = env("JETCODE_LOCAL_OPENAI_URL")
  if (!raw) return undefined
  const root = rootUrl(raw, [])
  return /\/chat\/completions$/i.test(root) ? root : `${root}/v1/chat/completions`
}

function timeout(ms: number) {
  return AbortSignal.timeout(ms)
}

/**
 * Direct loopback HTTP. Deliberately does not use globalThis.fetch: the app's
 * fetch wrapper routes opencode.ai through proxies and curl impersonation, and
 * a localhost request must never inherit that egress path.
 */
export async function localFetch(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<Response> {
  const parsed = new URL(url)
  const transport = parsed.protocol === "https:" ? httpsRequest : httpRequest
  const body = init.body === undefined ? undefined : typeof init.body === "string" ? Buffer.from(init.body) : Buffer.from(init.body)
  return await new Promise<Response>((resolve, reject) => {
    const req = transport(
      parsed,
      {
        method: init.method ?? "GET",
        headers: {
          accept: "application/json",
          ...(body ? { "content-type": "application/json", "content-length": String(body.byteLength) } : {}),
          ...init.headers,
        },
        signal: init.signal,
      },
      (res) => {
        const headers = new Headers()
        for (const [key, value] of Object.entries(res.headers)) {
          if (value === undefined) continue
          if (Array.isArray(value)) value.forEach((item) => headers.append(key, item))
          else headers.set(key, value)
        }
        resolve(
          new Response(Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>, {
            status: res.statusCode ?? 502,
            statusText: res.statusMessage ?? "",
            headers,
          }),
        )
      },
    )
    req.on("error", reject)
    req.setTimeout(init.timeoutMs ?? 4_000, () => req.destroy(new Error("local model request timed out")))
    if (body) req.write(body)
    req.end()
  })
}

async function getJson<T>(url: string, ms = 1_200): Promise<T | undefined> {
  try {
    const response = await localFetch(url, { signal: timeout(ms) })
    if (!response.ok) return undefined
    return (await response.json()) as T
  } catch {
    return undefined
  }
}

async function postJson<T>(url: string, body: unknown, ms = 1_500): Promise<T | undefined> {
  try {
    const response = await localFetch(url, {
      method: "POST",
      body: JSON.stringify(body),
      signal: timeout(ms),
    })
    if (!response.ok) return undefined
    return (await response.json()) as T
  } catch {
    return undefined
  }
}

function parameterB(text: string | undefined) {
  if (!text) return 0
  const match = /([\d.]+)\s*B/i.exec(text)
  return match ? Number(match[1]) : 0
}

function contextOf(info: Record<string, unknown> | undefined) {
  if (!info) return 0
  for (const [key, value] of Object.entries(info)) {
    if (key.endsWith(".context_length") && typeof value === "number" && value > 0) return value
  }
  return 0
}

function isCoding(name: string) {
  return /coder|code|devstral|qwen3|gpt-oss|deepseek|starcoder|codestral|granite/i.test(name)
}

function rank(target: Omit<LocalTarget, "score" | "parameterB"> & { parameterB?: number }) {
  let score = 0
  if (target.tools) score += 10_000
  if (isCoding(target.model) || isCoding(target.label)) score += 2_000
  if (target.vision) score += 150
  if (target.source === "ollama") score += 100
  if (target.source === "lmstudio") score += 80
  score += Math.min(target.context / 1024, 512)
  score += Math.min(target.parameterB ?? 0, 100) * 8
  return score
}

function makeTarget(candidate: Omit<LocalTarget, "score">): LocalTarget {
  return { ...candidate, score: rank(candidate) }
}

async function discoverOllama(): Promise<LocalTarget[]> {
  const root = ollamaRoot()
  const tags = await getJson<{ models?: OllamaTag[] }>(`${root}/api/tags`)
  const models = (tags?.models ?? []).filter((model) => (model.model || model.name || "").length > 0)
  if (models.length === 0) return []

  // Show calls provide tool/vision capabilities and the exact context length.
  // They are cheap local calls, but cap the fan-out for large collections.
  const ordered = [...models].sort((left, right) => (right.size ?? 0) - (left.size ?? 0)).slice(0, 16)
  const shows = await Promise.all(
    ordered.map(async (model) => {
      const id = model.model || model.name || ""
      const show = await postJson<OllamaShow>(`${root}/api/show`, { model: id })
      return [id, show, model] as const
    }),
  )
  return shows.map(([id, show, model]) => {
    const parameter = parameterB(show?.details?.parameter_size || model.details?.parameter_size)
    const tools = show?.capabilities?.includes("tools") ?? false
    const vision = show?.capabilities?.includes("vision") ?? false
    return makeTarget({
      endpoint: `${root}/v1/chat/completions`,
      model: id,
      label: `Ollama · ${id}`,
      source: "ollama",
      tools,
      vision,
      context: contextOf(show?.model_info),
      parameterB: parameter,
    })
  })
}

async function discoverLmStudio(): Promise<LocalTarget[]> {
  const root = lmStudioRoot()
  const response = await getJson<{ models?: LmStudioModel[] }>(`${root}/api/v1/models`)
  if (response?.models) {
    return response.models
      .filter((model) => model.type === "llm" && (model.key || "").length > 0)
      .map((model) => {
        const id = model.key ?? ""
        return makeTarget({
          endpoint: `${root}/v1/chat/completions`,
          model: id,
          label: `LM Studio · ${model.display_name || id}`,
          source: "lmstudio",
          tools: model.capabilities?.trained_for_tool_use === true,
          vision: model.capabilities?.vision === true,
          context: model.max_context_length ?? 0,
          parameterB: parameterB(id),
        })
      })
  }

  // Older LM Studio builds only expose /v1/models, without capabilities.
  const legacy = await getJson<{ data?: OpenAiModel[] }>(`${root}/v1/models`)
  return (legacy?.data ?? [])
    .filter((model) => (model.id ?? "").length > 0)
    .map((model) => {
      const id = model.id ?? ""
      return makeTarget({
        endpoint: `${root}/v1/chat/completions`,
        model: id,
        label: `LM Studio · ${id}`,
        source: "lmstudio",
        tools: false,
        vision: false,
        context: 0,
        parameterB: parameterB(id),
      })
    })
}

async function discoverGeneric(): Promise<LocalTarget[]> {
  const endpoint = genericEndpoint()
  if (!endpoint) return []
  const configured = env("JETCODE_LOCAL_MODEL")
  const apiKey = env("JETCODE_LOCAL_API_KEY")
  if (configured) {
    return [
      makeTarget({
        endpoint,
        model: configured,
        label: `Local · ${configured}`,
        source: "openai-compatible",
        tools: true,
        vision: env("JETCODE_LOCAL_VISION") === "1",
        context: Number(env("JETCODE_LOCAL_CONTEXT") ?? 0),
        parameterB: parameterB(configured),
        apiKey,
      }),
    ]
  }
  const root = endpoint.replace(/\/v1\/chat\/completions$/i, "")
  const models = await getJson<{ data?: OpenAiModel[] }>(`${root}/v1/models`)
  return (models?.data ?? [])
    .filter((model) => (model.id ?? "").length > 0)
    .map((model) => {
      const id = model.id ?? ""
      return makeTarget({
        endpoint,
        model: id,
        label: `Local · ${id}`,
        source: "openai-compatible",
        tools: true,
        vision: env("JETCODE_LOCAL_VISION") === "1",
        context: Number(env("JETCODE_LOCAL_CONTEXT") ?? 0),
        parameterB: parameterB(id),
        apiKey,
      })
    })
}

async function discover(): Promise<LocalTarget[]> {
  const groups = await Promise.all([discoverOllama(), discoverLmStudio(), discoverGeneric()])
  return groups
    .flat()
    .toSorted((left, right) => right.score - left.score || right.parameterB - left.parameterB)
}

function readSelected(): LocalTarget | undefined {
  for (const file of [SELECTED_FILE, LEGACY_SELECTED_FILE]) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<LocalTarget>
      if (typeof parsed.endpoint !== "string" || typeof parsed.model !== "string") continue
      return makeTarget({
        endpoint: parsed.endpoint,
        model: parsed.model,
        label: typeof parsed.label === "string" ? parsed.label : `Local · ${parsed.model}`,
        source: parsed.source ?? "openai-compatible",
        tools: parsed.tools ?? true,
        vision: parsed.vision ?? false,
        context: parsed.context ?? 0,
        parameterB: parsed.parameterB ?? parameterB(parsed.model),
        apiKey: parsed.apiKey,
      })
    } catch {
      // Try the pre-rename path, then give up.
    }
  }
  return undefined
}

function remember(target: LocalTarget) {
  try {
    mkdirSync(dirname(SELECTED_FILE), { recursive: true })
    const { apiKey: _apiKey, ...safe } = target
    void writeFile(SELECTED_FILE, JSON.stringify(safe, null, 2)).catch(() => undefined)
  } catch {
    // Read-only profiles keep the in-memory selection.
  }
}

/** Best discovered local model, ranked for tool-using coding agents. */
export async function bestLocalModel(): Promise<LocalTarget | undefined> {
  if (env("JETCODE_OFFLINE") === "0" || env("JETCODE_OFFLINE") === "false") return undefined
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.targets[0]
  if (!discovery) {
    discovery = discover()
      .then((targets) => {
        cache = { at: Date.now(), targets }
        if (targets[0]) remember(targets[0])
        return targets
      })
      .catch(() => {
        cache = { at: Date.now(), targets: [] }
        return []
      })
      .finally(() => {
        discovery = undefined
      })
  }
  const targets = await discovery
  return targets[0] ?? readSelected()
}

/** All local models, for diagnostics and explicit selection. */
export async function listLocalModels(): Promise<LocalTarget[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.targets
  const targets = await discover()
  cache = { at: Date.now(), targets }
  if (targets[0]) remember(targets[0])
  return targets
}

// A conservative hardware ladder. The first model that fits free disk and RAM
// wins. These are Apache-2.0/MIT coding models with tool-calling support.
const PULL_CANDIDATES = [
  { tag: "qwen3-coder:30b", params: 30, ram: 32 * 1024 ** 3, bytes: 19 * 1024 ** 3 },
  { tag: "devstral-small-2:24b", params: 24, ram: 24 * 1024 ** 3, bytes: 15 * 1024 ** 3 },
  { tag: "gpt-oss:20b", params: 20, ram: 16 * 1024 ** 3, bytes: 14 * 1024 ** 3 },
  { tag: "qwen3.5:9b", params: 9, ram: 12 * 1024 ** 3, bytes: 6.6 * 1024 ** 3 },
  { tag: "qwen2.5-coder:7b", params: 7, ram: 8 * 1024 ** 3, bytes: 4.7 * 1024 ** 3 },
]

function ollamaBinary() {
  const explicit = env("JETCODE_OLLAMA_BIN")
  if (explicit) return existsSync(explicit) ? explicit : undefined
  const candidates = process.platform === "win32"
    ? [
        join(process.env.LOCALAPPDATA ?? "", "Programs", "Ollama", "ollama.exe"),
        join(process.env.ProgramFiles ?? "", "Ollama", "ollama.exe"),
      ]
    : ["/usr/local/bin/ollama", "/usr/bin/ollama", "/opt/homebrew/bin/ollama"]
  return candidates.find((file) => file && existsSync(file))
}

async function freeDisk() {
  try {
    const info = await statfs(homedir())
    return Number(info.bavail) * Number(info.bsize)
  } catch {
    return 0
  }
}

function pullMarker() {
  for (const file of [PULL_MARKER, join(STATE_DIR, "olliecode-ollama-pull.json")]) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { at?: number; tag?: string; pid?: number; attempt?: number }
      return {
        at: typeof parsed.at === "number" ? parsed.at : 0,
        tag: parsed.tag,
        pid: typeof parsed.pid === "number" ? parsed.pid : undefined,
        attempt: typeof parsed.attempt === "number" ? parsed.attempt : undefined,
      }
    } catch {
      // Try the pre-rename marker, then report no marker.
    }
  }
  return { at: 0, tag: undefined, pid: undefined, attempt: undefined }
}

function approvedTag() {
  const envTag = env("JETCODE_OFFLINE_DOWNLOAD_CONSENT")
  if (envTag) return envTag
  try {
    const parsed = JSON.parse(readFileSync(PULL_CONSENT, "utf8")) as { tag?: string }
    return typeof parsed.tag === "string" ? parsed.tag : undefined
  } catch {
    return undefined
  }
}

/** Records explicit user approval for one model download. */
export async function approveOllamaDownload(tag: string) {
  mkdirSync(STATE_DIR, { recursive: true })
  await writeFile(PULL_CONSENT, JSON.stringify({ tag, approvedAt: Date.now() }, null, 2))
  await writeStatus({ ollama: { autoPull: "approved", tag } })
}

function scanModelFiles() {
  const roots = [
    join(homedir(), ".ollama", "models"),
    join(homedir(), ".cache", "lm-studio", "models"),
    join(homedir(), ".cache", "huggingface", "hub"),
    join(homedir(), ".local", "share", "lm-studio", "models"),
    join(process.env.LOCALAPPDATA ?? "", "LM-Studio"),
  ].filter((root) => root.length > 0 && existsSync(root))
  const found: Array<{ path: string; bytes: number }> = []
  let visited = 0
  const walk = (directory: string, depth: number) => {
    if (depth > 5 || visited > 4_000 || found.length >= 200) return
    let entries: string[]
    try {
      entries = readdirSync(directory)
    } catch {
      return
    }
    for (const name of entries) {
      if (visited++ > 4_000) return
      const file = join(directory, name)
      let stat
      try {
        stat = statSync(file)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        if (/^(node_modules|\.git|blobs|\.cache)$/i.test(name)) continue
        walk(file, depth + 1)
      } else if (/\.(?:gguf|safetensors)$/i.test(name)) {
        found.push({ path: file, bytes: stat.size })
      }
    }
  }
  for (const root of roots) walk(root, 0)
  return found.toSorted((left, right) => right.bytes - left.bytes).slice(0, 50)
}

async function writeStatus(patch: Record<string, unknown>) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    let current: Record<string, unknown> = {}
    try {
      current = JSON.parse(readFileSync(STATUS_FILE, "utf8")) as Record<string, unknown>
    } catch {
      current = {}
    }
    await writeFile(
      STATUS_FILE,
      JSON.stringify(
        {
          ...current,
          ...patch,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    )
  } catch {
    // Status is advisory only.
  }
}

function startOllamaServer(binary: string) {
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    const log = openSync(PULL_LOG, "a")
    const child = spawn(binary, ["serve"], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", log, log],
    })
    child.unref()
    closeSync(log)
    return true
  } catch {
    return false
  }
}

async function ensureOllamaServer(binary: string, root: string) {
  // The server can still be initializing when the first probe lands. Probe
  // before starting a second process, then retry once if the first launch
  // failed; this also recovers after a tray-app close or a crashed serve.
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (!startOllamaServer(binary)) continue
    for (const delay of [1_500, 2_500, 4_000]) {
      await new Promise((resolve) => setTimeout(resolve, delay))
      const tags = await getJson<{ models?: OllamaTag[] }>(`${root}/api/tags`, 3_000)
      if (tags) return tags
    }
  }
  return undefined
}

function processAlive(pid: number | undefined) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Windows reports EPERM for a live process owned by another process.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function waitForExit(child: ReturnType<typeof spawn>) {
  return new Promise<number | null>((resolve) => {
    let settled = false
    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      resolve(code)
    }
    child.once("error", () => finish(null))
    child.once("exit", (code) => finish(code))
  })
}

function pullProgress() {
  try {
    const tail = readFileSync(PULL_LOG, "utf8").slice(-4_096).replace(/\r/g, "\n")
    const matches = [...tail.matchAll(/(\d{1,3})%.*?(\d+(?:\.\d+)?)\s*([MG]B)/g)]
    const last = matches.at(-1)
    if (!last) return undefined
    return { percent: Number(last[1]), amount: `${last[2]} ${last[3]}` }
  } catch {
    return undefined
  }
}

async function waitForInstalled(root: string, tag: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const tags = await getJson<{ models?: OllamaTag[] }>(`${root}/api/tags`, 2_000)
    if ((tags?.models ?? []).some((model) => (model.model || model.name) === tag)) return true
    await new Promise((resolve) => setTimeout(resolve, 3_000))
  }
  return false
}

async function ensureOllamaModel() {
  if (env("JETCODE_OFFLINE_AUTO_PULL") === "0" || env("JETCODE_OFFLINE_AUTO_PULL") === "false") return
  const root = ollamaRoot()
  let tags = await getJson<{ models?: OllamaTag[] }>(`${root}/api/tags`, 2_000)
  if (!tags) {
    const binary = ollamaBinary()
    if (!binary || !/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/)/i.test(root)) {
      await writeStatus({ ollama: { reachable: false, autoPull: binary ? "remote-host" : "binary-not-found" } })
      return
    }
    // Ollama is installed but its background service is not up. Start it so
    // the local model is usable offline instead of waiting for a manual launch.
    tags = await ensureOllamaServer(binary, root)
    if (!tags) {
      await writeStatus({ ollama: { reachable: false, autoPull: "server-not-responding", retryable: true } })
      return
    }
  }

  const installed = (tags.models ?? []).map((model) => model.model || model.name || "")
  const bestInstalled = installed
    .filter((name) => isCoding(name) && !/embed|vision|vl|llava/i.test(name))
    .reduce((best, name) => Math.max(best, parameterB(name)), 0)

  const disk = await freeDisk()
  const ram = totalmem()
  const candidate = PULL_CANDIDATES.find((item) => ram >= item.ram && disk >= item.bytes * 1.6)
  if (!candidate) {
    await writeStatus({
      ollama: {
        reachable: true,
        installed: installed.length,
        autoPull: "insufficient-resources",
        ramBytes: ram,
        freeDiskBytes: disk,
      },
    })
    return
  }
  // A weaker installed coder is upgraded to the strongest model that this
  // machine can actually run. The 24h marker prevents pull loops.
  if (bestInstalled >= candidate.params * 0.8) {
    await writeStatus({
      ollama: { reachable: true, installed: installed.length, autoPull: "already-present", bestInstalled },
    })
    return
  }

  const binary = ollamaBinary()
  if (!binary) {
    await writeStatus({
      ollama: { reachable: true, installed: installed.length, autoPull: "binary-not-found", bestInstalled },
    })
    return
  }
  if (approvedTag() !== candidate.tag) {
    // No multi-gigabyte download without a human decision. The desktop shows
    // this pending state in a native dialog and writes the consent file; a CLI
    // user can do the same with `approveOllamaDownload` or the consent env.
    await writeStatus({
      ollama: {
        reachable: true,
        installed: installed.length,
        autoPull: "awaiting-confirmation",
        tag: candidate.tag,
        sizeBytes: candidate.bytes,
        sizeGb: Number((candidate.bytes / 1024 ** 3).toFixed(1)),
        bestInstalled,
        consentFile: PULL_CONSENT,
      },
    })
    const deadline = Date.now() + 10 * 60_000
    while (Date.now() < deadline && approvedTag() !== candidate.tag) {
      await new Promise((resolve) => setTimeout(resolve, 5_000))
    }
    if (approvedTag() !== candidate.tag) return
  }
  const marker = pullMarker()
  if (marker.tag === candidate.tag && processAlive(marker.pid)) {
    await writeStatus({
      ollama: {
        reachable: true,
        installed: installed.length,
        autoPull: "in-progress",
        tag: candidate.tag,
        progress: pullProgress(),
        log: PULL_LOG,
      },
    })
    return
  }

  // Ollama resumes partial blobs when `pull` is invoked again. Keep trying
  // until the model is present: a dropped connection, a killed process or a
  // transient server failure must not strand a consented download for 24h.
  const maxAttempts = 6
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let code: number | null = null
    try {
      mkdirSync(LOG_DIR, { recursive: true })
      mkdirSync(STATE_DIR, { recursive: true })
      const log = openSync(PULL_LOG, "a")
      const child = spawn(binary, ["pull", candidate.tag], {
        detached: true,
        windowsHide: true,
        stdio: ["ignore", log, log],
      })
      child.unref()
      closeSync(log)
      await writeFile(
        PULL_MARKER,
        JSON.stringify({ at: Date.now(), tag: candidate.tag, pid: child.pid ?? undefined, attempt }),
      )
      await writeStatus({
        ollama: {
          reachable: true,
          installed: installed.length,
          autoPull: attempt === 1 ? "started" : "resuming",
          tag: candidate.tag,
          attempt,
          maxAttempts,
          progress: pullProgress(),
          log: PULL_LOG,
        },
      })
      code = await waitForExit(child)
    } catch (error) {
      code = null
      await writeStatus({
        ollama: {
          reachable: true,
          installed: installed.length,
          autoPull: "retrying",
          tag: candidate.tag,
          attempt,
          maxAttempts,
          error: (error as Error).message,
        },
      })
    }

    const tagsNow = await getJson<{ models?: OllamaTag[] }>(`${root}/api/tags`, 2_500)
    const installedNow = (tagsNow?.models ?? []).map((model) => model.model || model.name || "")
    if (installedNow.includes(candidate.tag) || (await waitForInstalled(root, candidate.tag, 1_000))) {
      await writeStatus({
        ollama: {
          reachable: true,
          installed: installedNow.length,
          autoPull: "complete",
          tag: candidate.tag,
          attempt,
          log: PULL_LOG,
        },
      })
      return
    }

    if (attempt < maxAttempts) {
      const delay = Math.min(60_000, 5_000 * 2 ** (attempt - 1))
      await writeStatus({
        ollama: {
          reachable: true,
          installed: installedNow.length,
          autoPull: "retrying",
          tag: candidate.tag,
          attempt,
          maxAttempts,
          exitCode: code,
          nextRetryMs: delay,
          progress: pullProgress(),
          log: PULL_LOG,
        },
      })
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  await writeStatus({
    ollama: {
      reachable: true,
      installed: installed.length,
      autoPull: "failed",
      tag: candidate.tag,
      attempts: maxAttempts,
      retryable: true,
      log: PULL_LOG,
    },
  })
}

/**
 * Startup pass: scan local model inventories and model files, persist the best
 * choice, and — when Ollama is already running and no coding model exists —
 * pull the strongest model that fits this machine. Never installs Ollama
 * itself; that is a user-level system change.
 */
export function bootstrapOfflineModels(): Promise<void> {
  if (bootstrapRun) return bootstrapRun
  bootstrapRun = (async () => {
    try {
      const targets = await listLocalModels()
      const files = scanModelFiles()
      await writeStatus({
        selected: targets[0]
          ? {
              model: targets[0].model,
              label: targets[0].label,
              source: targets[0].source,
              tools: targets[0].tools,
              vision: targets[0].vision,
              context: targets[0].context,
              score: targets[0].score,
            }
          : null,
        discovered: targets.length,
        models: targets.slice(0, 20).map((target) => ({
          model: target.model,
          label: target.label,
          source: target.source,
          tools: target.tools,
          vision: target.vision,
          context: target.context,
          parameterB: target.parameterB,
          score: target.score,
        })),
        files: files.map((file) => ({ path: file.path, bytes: file.bytes })),
        autoPull: "checking",
      })
      await ensureOllamaModel()
    } catch (error) {
      await writeStatus({ error: (error as Error).message })
    }
  })()
  return bootstrapRun
}
