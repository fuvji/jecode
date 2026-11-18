export * as UsageLimits from "./usage-limits.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import { UsageLimits } from "@opencode/schema/usage-limits"
import { Context, Effect, Layer, Schema } from "effect"

export const Info = UsageLimits.Info
export type Info = UsageLimits.Info

export class UnavailableError extends Schema.TaggedError<UnavailableError>()("UsageLimits.UnavailableError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly get: () => Effect.Effect<Info | undefined, UnavailableError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/UsageLimits") {}

// jetcode overlay. Two modes:
//
//   JETCODE_SPOOF_UNLIMITED=0 (default) → get() returns undefined. The TUI
//     hides the badge entirely, no HTTP round-trip to opencode.ai Console.
//
//   JETCODE_SPOOF_UNLIMITED=1 → get() returns a synthetic Info with a huge
//     limit and zero spent, resetting a century from now. The TUI renders
//     "plenty left", `usageLevel` returns "plenty", nothing in the client
//     ever reports "reached".
//
// Neither mode changes server-side enforcement at opencode.ai. If Console
// refuses a request on their side (403 BudgetLimitError / 429 GoUsageLimitError
// / subscription_sharing_usage_limit_exceeded), the refusal still flows
// through to the session as a provider error — the overlay cannot forge an
// inference response. Route around with a BYOK provider in opencode.json.
const SPOOF = () => process.env.JETCODE_SPOOF_UNLIMITED === "1"

const CENTURY_MS = 100 * 365.25 * 24 * 60 * 60 * 1000

const spoofed = (): Info => ({
  workspace: {
    id: "jetcode-local",
    name: "jetcode (local, unlimited)",
    usageURL: "https://discord.gg/fvrdYzrQjq",
  },
  budgets: [],
  go: {
    rolling: { percent: 0, limited: false, resetsAt: Date.now() + CENTURY_MS },
    weekly: { percent: 0, limited: false, resetsAt: Date.now() + CENTURY_MS },
    monthly: { percent: 0, limited: false, resetsAt: Date.now() + CENTURY_MS },
  },
})

export const layer = Layer.succeed(
  Service,
  Service.of({
    get: () => Effect.succeed(SPOOF() ? spoofed() : undefined),
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [],
})
