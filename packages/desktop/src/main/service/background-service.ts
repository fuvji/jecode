import { app } from "electron"
import { createServer } from "node:net"
import type { Endpoint } from "@opencode/client/service"
import { Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { SidecarChanged } from "../../shared/ipc-rpc/events"
import { CHANNEL } from "../constants"
import { emitIpcEvent } from "../ipc-events"
import { getMainWindows } from "../windows"
import { BackgroundServiceMachine } from "./background-service-machine"
import { cleanStages } from "./cli-stages"
import { keptStages, serviceVersion, shouldRetryEnsure } from "./cli-version"
import { DesktopCli } from "./desktop-cli"
import { resolveLicenseApi } from "./licensing-engine"
import { SidecarCredentials } from "./sidecar-credentials"
import { takeSidecarProbe } from "./sidecar-probe"

export * as BackgroundService from "./background-service"

const RegisteredService = Schema.Struct({ version: Schema.optional(Schema.String) })
const PREFERRED_SERVICE_PORT = 0x0c0d

function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once("error", () => resolve(false))
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)))
  })
}

async function chooseServicePort(): Promise<number> {
  if (await canBind(PREFERRED_SERVICE_PORT)) return PREFERRED_SERVICE_PORT
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = address && typeof address === "object" ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error("no free service port"))))
    })
  })
}

export interface Interface {
  readonly connection: Effect.Effect<SidecarCredentials.Data>
  readonly reconnect: Effect.Effect<SidecarCredentials.Data>
}

export class Service extends Context.Service<Service, Interface>()("opencode/desktop/BackgroundService") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const context = yield* Effect.context<FileSystem.FileSystem | Path.Path | DesktopCli.Service>()

    return Service.of(
      yield* BackgroundServiceMachine.make({
        probe: probe().pipe(Effect.provide(context)),
        ensure: (mode) => ensure(mode).pipe(Effect.provide(context)),
        publish: (data) => {
          SidecarCredentials.set(data)
          // Every window moves its requests and event stream to the new origin, not only the one that reconnected.
          const event = new SidecarChanged({ url: data.url })
          getMainWindows().forEach((win) => emitIpcEvent(win.webContents, event))
        },
      }),
    )
  }),
)

// A compatible service the entry module already found is adopted at once; the machine still verifies it with
// `ensure("initial")` (which also completes a terminal handoff), off the renderer's path.
const probe = Effect.fn("BackgroundService.probe")(function* () {
  const service = yield* Effect.promise(takeSidecarProbe)

  if (!service) return undefined
  const setup = yield* prepare("initial")

  return (yield* adopt(setup, service, true)).credentials
})

const ensure = Effect.fn("BackgroundService.ensure")(function* (mode: BackgroundServiceMachine.ConnectMode) {
  const runFork = Effect.runForkWith(yield* Effect.context<FileSystem.FileSystem | Path.Path>())
  const setup = yield* prepare(mode)

  const run = (version = setup.version) =>
    setup.client.Service.ensure({
      file: setup.file,
      version,
      // The CLI chooses its registration path from XDG_STATE_HOME; ensure() only reads `file`.
      // Pass the same state root so the child writes where this process probes.
      env: {
        ...(setup.stateHome === undefined ? {} : { XDG_STATE_HOME: setup.stateHome }),
        // The reset handler runs inside the staged sidecar, which cannot see
        // resources/gateway.json. Pass the same Worker origin licensing uses.
        JETCODE_LICENSE_API: resolveLicenseApi(),
      },
      // A fixed port makes a second contender fail to bind and back off; port 0 never collides, so two
      // services could boot against the same database. local/dev (jetcode) gets its own port and
      // state root so the upstream OpenCode desktop can run at the same time.
      command: [
        ...setup.cli.command,
        "serve",
        "--service",
        ...(setup.isolated
          ? ["--hostname", "0.0.0.0", "--port", String(0x0c0c)]
          : setup.port
            ? ["--hostname", "127.0.0.1", "--port", String(setup.port)]
            : []),
      ],
      onStart: (reason, previousVersion) =>
        runFork(Effect.logInfo("v2 CLI background service starting", { reason, previousVersion })),
    })

  const service = yield* Effect.tryPromise(() =>
    run().catch((error) => {
      if (!shouldRetryEnsure(setup.version, error instanceof Error ? error.message : String(error))) throw error

      return run(setup.cli.version)
    }),
  )

  const ready = yield* adopt(setup, service, false)

  // Only packaged and isolated builds run a staged copy; any other binary sits in the source tree.
  // Keep both the bundled stage and the running server's stage so its executable stays on disk. This runs only
  // once `Service.ensure` settled which server runs, never for a probed one it may still replace.
  if (mode === "initial" && (app.isPackaged || setup.isolated) && setup.cli.binary && ready.runningVersion)
    runFork(
      cleanStages(setup.cli.binary, { keep: keptStages(setup.cli.version, ready.runningVersion) }).pipe(
        Effect.catch((error) => Effect.logError("failed to clean staged v2 CLIs", { error })),
      ),
    )

  return ready.credentials
})

const prepare = Effect.fn("BackgroundService.prepare")(function* (mode: BackgroundServiceMachine.ConnectMode) {
  yield* Effect.logInfo("starting v2 background service")
  const path = yield* Path.Path
  const desktopCli = yield* DesktopCli.Service
  const isolated = !app.isPackaged && process.env.OPENCODE_DESKTOP_ISOLATED_SERVER === "1"
  // local/dev is the jetcode channel. The upstream OpenCode desktop uses latest/prod and the
  // shared XDG state registration; without a dedicated state root and port the two apps replace
  // each other's background service every few seconds and both renderers time out.
  //
  // The CLI writes <XDG_STATE_HOME>/opencode/service.json, not the path passed to ensure(), so the
  // dedicated registration only works if the child's state root moves with it. Keep both sides on
  // the same value: file = <userData>/opencode/service.json, child XDG_STATE_HOME = <userData>.
  const dedicated = CHANNEL === "local" || CHANNEL === "dev"
  const cli = yield* desktopCli.resolve
  const version = serviceVersion({ channel: CHANNEL, isolated, mode, version: cli.version })

  const stateHome = dedicated || isolated ? app.getPath("userData") : undefined
  if (stateHome !== undefined) process.env.XDG_STATE_HOME = stateHome
  const client = yield* Effect.promise(() => import("@opencode/client/service"))

  // The CLI names its registration file by channel. local and the desktop's
  // dev channel use the dedicated service-local.json registration so they can
  // run beside upstream OpenCode; beta/prod use service.json. Reading the wrong
  // name leaves ensure() waiting on a stale registration until it times out.
  const file =
    stateHome !== undefined
      ? path.join(stateHome, "opencode", dedicated ? "service-local.json" : "service.json")
      : undefined

  const port = dedicated ? yield* Effect.promise(chooseServicePort) : undefined
  if (dedicated && port !== PREFERRED_SERVICE_PORT)
    yield* Effect.logWarning("preferred service port unavailable; using a free port", {
      preferred: PREFERRED_SERVICE_PORT,
      port,
    })

  return { cli, client, file, isolated, version, stateHome, port }
})

const adopt = Effect.fn("BackgroundService.adopt")(function* (
  setup: Effect.Success<ReturnType<typeof prepare>>,
  service: Endpoint,
  probed: boolean,
) {
  const fs = yield* FileSystem.FileSystem

  if (service.auth?.type !== "basic") throw new Error("V2 CLI background service did not provide authentication")
  const url = new URL(service.url)

  if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1"

  const runningVersion = yield* fs.readFileString(setup.file ?? setup.client.fallback()).pipe(
    Effect.map(
      (text) =>
        Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(RegisteredService))(text))?.version,
    ),
    Effect.orElseSucceed(() => undefined),
  )

  yield* Effect.logInfo("v2 CLI background service ready", {
    version: setup.version,
    runningVersion,
    probed,
    ...endpoint(url.origin),
  })

  return {
    credentials: { url: url.origin, password: service.auth.password } satisfies SidecarCredentials.Data,
    runningVersion,
  }
})

function endpoint(url: string | undefined) {
  if (!url || !URL.canParse(url)) return {}
  const parsed = new URL(url)

  return { url, hostname: parsed.hostname, port: parsed.port }
}
