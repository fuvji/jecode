import { FSUtil } from "@opencode/util/fs-util"
import { Effect, FileSystem } from "effect"
import { HttpServerError, HttpServerRequest, HttpServerResponse } from "effect/http"
import { createHash } from "node:crypto"
import { load, type AssetMap, type BrotliMap } from "../app-assets"

// jetcode overlay. This file replaces upstream's web-ui.ts outright so the
// /_jetcode/ delegation CANNOT drift. Previously this path was inserted by
// scripts/sync.sh via a grep-anchored patch_file against upstream's `/auth/`
// line; a single whitespace change upstream caused `grep -F` to miss, the
// build shipped with the raw upstream file, and every POST to
// /_jetcode/reset-limits fell through to serveUI below (status: 405 for
// non-GET/HEAD). The reset pill in the renderer then showed "HTTP 405" to
// the user. Owning the file end-to-end here is immune to that failure mode.
//
// Keep this file byte-for-byte aligned with upstream except for the single
// `/_jetcode/` entry in the delegation list and this comment. If upstream
// adds a new allow-list entry (e.g. `/api/experimental/`) sync will NOT pull
// it in; grep this file on every sync and mirror the change by hand.

export const handler = Effect.fn("cli.web-ui.handler")(function* (options?: {
  readonly assets?: AssetMap
  readonly brotli?: BrotliMap
}) {
  const fileSystem = yield* FileSystem.FileSystem
  const assets = options?.assets
    ? Effect.succeed({ files: options.assets, brotli: options.brotli })
    : yield* Effect.cached(load().pipe(Effect.provideService(FileSystem.FileSystem, fileSystem)))
  return <E, R>(api: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest
      const url = new URL(request.url, "http://localhost")
      // Serve the web shell before API authentication so a signed-out browser gets the app's sign-in screen.
      if (
        url.pathname === "/api" ||
        url.pathname.startsWith("/api/") ||
        url.pathname.startsWith("/auth/") ||
        url.pathname.startsWith("/_jetcode/") ||
        url.pathname === "/openapi.json"
      )
        return yield* api.pipe(
          Effect.catchIf(isRouteNotFound, () => Effect.succeed(HttpServerResponse.empty({ status: 404 }))),
        )
      return yield* assets.pipe(Effect.flatMap((loaded) => serveUI(request, url, loaded.files, loaded.brotli)))
    })
})

function serveUI(
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
  assets: AssetMap,
  brotli: BrotliMap | undefined,
) {
  const key = url.pathname.replace(/^\//, "")
  // A browser that takes brotli gets the embedded bytes as they are, so the server decompresses nothing. The HTML stays
  // decoded, because its CSP hashes the inline theme script.
  const encoded = key !== "index.html" && acceptsBrotli(request.headers["accept-encoding"]) ? brotli?.[key] : undefined
  const requested = encoded ?? assets[key]
  if ((key.startsWith("_assets/") || key.startsWith("icons/")) && requested === undefined)
    return Effect.succeed(HttpServerResponse.empty({ status: 404, headers: { "cache-control": "no-store" } }))
  const name = requested !== undefined ? key : "index.html"
  const file = requested ?? assets["index.html"]
  if (file === undefined) return Effect.succeed(HttpServerResponse.empty({ status: 404 }))
  if (request.method !== "GET" && request.method !== "HEAD")
    return Effect.succeed(HttpServerResponse.empty({ status: 405 }))
  const html = name === "index.html"
  const revalidate = html || name === "sw.js" || name === "registerSW.js"
  const headers = {
    "content-type": FSUtil.mimeType(name),
    "cache-control": revalidate ? "no-cache" : "public, max-age=31536000, immutable",
    "content-security-policy": html
      ? cspForHtml(typeof file === "string" ? file : Buffer.from(file).toString())
      : csp(),
    "x-content-type-options": "nosniff",
    ...(!html && brotli?.[name] !== undefined ? { vary: "accept-encoding" } : {}),
    ...(encoded ? { "content-encoding": "br" } : {}),
  }
  return Effect.succeed(
    request.method === "HEAD"
      ? HttpServerResponse.empty({ status: 200, headers })
      : HttpServerResponse.raw(file, { headers, contentType: headers["content-type"] }),
  )
}

function acceptsBrotli(header: string | undefined) {
  return (header ?? "").split(",").some((entry) => {
    const parts = entry.split(";").map((part) => part.trim().toLowerCase())
    return parts[0] === "br" && !parts.slice(1).some((part) => /^q=0(?:\.0*)?$/.test(part))
  })
}

function isRouteNotFound(error: unknown) {
  return error instanceof HttpServerError.HttpServerError && error.reason._tag === "RouteNotFound"
}

// qr-scanner decodes in a worker it creates from a blob: URL whenever the browser has no BarcodeDetector (Safari, desktop
// Chrome on Windows and Linux). Without worker-src that worker falls under script-src 'self' and never starts.
// Artifact previews render HTML and PDF files from blob: URLs; without frame-src and object-src they fall back to
// default-src 'self' and are blocked.
function csp(hash = "") {
  return `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'${hash ? ` 'sha256-${hash}'` : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https: blob:; font-src 'self' data:; media-src 'self' data:; connect-src * data: blob:; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'self' blob:`
}

function cspForHtml(body: string) {
  const match = body.match(
    /<script\b(?![^>]*\bsrc\s*=)[^>]*\bid=(["'])oc-theme-preload-script\1[^>]*>([\s\S]*?)<\/script>/i,
  )
  return csp(match ? createHash("sha256").update(match[2]).digest("base64") : "")
}

export * as WebUi from "./web-ui"
