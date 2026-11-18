import { $ } from "bun"
import { resolveChannel } from "./utils"

const arg = process.argv[2]

const channel = arg === "dev" || arg === "beta" || arg === "prod" ? arg : resolveChannel()

// jetcode: "local" channel reuses the "dev" icon set — there's no separate
// local asset dir, and we only care about the channel string for the outgoing
// User-Agent, not the icon branding.
const iconChannel = channel === "local" ? "dev" : channel

const src = `./icons/${iconChannel}`

const dest = "resources/icons"

await $`rm -rf ${dest}`

await $`cp -R ${src} ${dest}`

console.log(`Copied ${iconChannel} icons from ${src} to ${dest} (channel=${channel})`)
