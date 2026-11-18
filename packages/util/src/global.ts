import path from "path"
import fs from "fs"
import os from "os"
import { Context, Effect, Layer } from "effect"
// XDG on runtimes with a home directory; one tmp-rooted directory on workerd.
// The variants resolve through the `workerd` bundle condition, like the
// native-module stubs, so no runtime sniffing happens here.
import { roots } from "#global-roots"
import { Flock } from "./flock.js"
import { makeGlobalNode } from "./effect/app-node.js"

const app = "opencode"
const { data, cache, config, state, tmp } = roots(app)

const paths = {
  get home() {
    return process.env.OPENCODE_TEST_HOME ?? os.homedir()
  },
  data,
  bin: path.join(cache, "bin"),
  log: path.join(data, "log"),
  repos: path.join(data, "repos"),
  cache,
  config,
  state,
  tmp,
}

export const Path = paths

Flock.setGlobal({ state })

export class Service extends Context.Service<Service, Interface>()("@opencode/Global") {}

export interface Interface {
  readonly home: string
  readonly data: string
  readonly cache: string
  readonly config: string
  readonly state: string
  readonly tmp: string
  readonly bin: string
  readonly log: string
  readonly repos: string
}

export function make(input: Partial<Interface> = {}): Interface {
  // The acquired service canonicalizes default tmp; use it instead of Path.tmp for path comparisons.
  return {
    home: Path.home,
    data: Path.data,
    cache: Path.cache,
    config: Path.config,
    state: Path.state,
    tmp: input.tmp ?? Path.tmp,
    bin: Path.bin,
    log: Path.log,
    repos: Path.repos,
    ...input,
  }
}

// jetcode-hardened mkdir. The vanilla `fs.promises.mkdir(dir, { recursive:
// true })` tolerates an existing directory but still throws EEXIST when the
// path exists as a FILE. We saw this in the wild as:
//
//   Error: EEXIST: file already exists, mkdir 'C:\Users\<name>\.config\opencode'
//   Server process exited with code 1
//
// The user had a plain file at `.config/opencode` (likely from an aborted
// install, a touched path by some other tool, or a cloud-sync collision),
// and the sidecar refused to start forever until they manually removed it.
// Nothing about that outcome is OK — the Electron shell showed "Desktop
// IPC handler failed" with an opaque error and the user had no way to
// self-recover.
//
// Now: on EEXIST we stat the path. If it's already a directory we treat
// mkdir as the no-op it meant to be. If it's a file (or anything other
// than a directory — symlink to nothing, FIFO, socket) we rename it
// aside to `<path>.jetcode-bak-<epoch>` and create the directory fresh.
// The bak file is left on disk so the user can recover their own content
// if the collision was genuine; nothing is deleted. All other mkdir
// errors still propagate — permission denied, path too long, bad drive
// — because those need user action we can't do silently.
async function ensureDirResilient(dir: string): Promise<void> {
  try {
    await fs.promises.mkdir(dir, { recursive: true })
    return
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== "EEXIST") throw err
  }
  // EEXIST with recursive:true means a non-directory is at the path.
  let st: fs.Stats
  try {
    st = await fs.promises.lstat(dir)
  } catch {
    // Vanished between our mkdir and the stat. Try one more mkdir.
    await fs.promises.mkdir(dir, { recursive: true })
    return
  }
  if (st.isDirectory()) return
  const backup = `${dir}.jetcode-bak-${Date.now()}`
  await fs.promises.rename(dir, backup)
  await fs.promises.mkdir(dir, { recursive: true })
}

const acquire = (input: Partial<Interface>) =>
  Effect.gen(function* () {
    const service = Service.of(make(input))
    yield* Effect.promise(() =>
      Promise.all(
        [service.data, service.config, service.state, service.log, service.bin, service.repos, service.tmp].map(
          (directory) => ensureDirResilient(directory),
        ),
      ),
    )
    const canonicalTmp = yield* Effect.promise(() => fs.promises.realpath(service.tmp))
    return Service.of({ ...service, tmp: input.tmp ?? canonicalTmp })
  })

const layer = Layer.effect(
  Service,
  Effect.suspend(() => acquire({ config: process.env.OPENCODE_CONFIG_DIR ?? Path.config })),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [] })

export const layerWith = (input: Partial<Interface>) => Layer.effect(Service, acquire(input))

export * as Global from "./global.js"
