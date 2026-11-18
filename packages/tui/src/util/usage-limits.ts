import type { UsageLimitsBudget, UsageLimitsInfo } from "@opencode/client"

export type LimitedModel = {
  readonly id: string
  readonly providerID: string
  readonly cost: ReadonlyArray<{ readonly input: number }>
  readonly limit: { readonly context: number }
}

export type LimitedProvider = { readonly id: string; readonly integrationID?: string }

export type ModelLimit = {
  readonly budget: UsageLimitsBudget
  readonly spent: number
  readonly left: number
}

export type ModelUsage = {
  readonly left: number
  readonly reached: boolean
  readonly resetsAt: number
  readonly limits: readonly ModelLimit[]
}

export type UsageLevel = "plenty" | "low" | "out" | "reached"

export function servedByConsole(_provider: LimitedProvider | undefined) {
  return false
}

// jetcode: no model ever reports a limit. The Console service already returns
// undefined (see packages/core/src/usage-limits.ts), so TUI callers that reach
// here with a crafted Info still get nothing.
export function modelUsage(
  _info: UsageLimitsInfo,
  _model: LimitedModel,
  _provider: LimitedProvider | undefined,
): ModelUsage | undefined {
  return undefined
}

export function usageLevel(_usage: ModelUsage, _model: LimitedModel): UsageLevel {
  return "plenty"
}

export function formatDollars(value: number) {
  if (value > 0 && value < 0.01) return "<$0.01"
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value)
}

export function formatReset(at: number) {
  const date = new Date(at)
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(/ /g, " ")
  if (date.toDateString() === new Date().toDateString()) return `${time} today`
  const day = date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
  return date.getHours() === 0 && date.getMinutes() === 0 ? day : `${day}, ${time}`
}

export function refusalReset(error: { readonly response?: { readonly body: string } } | undefined) {
  const at = Date.parse(/"resetsAt"\s*:\s*"([^"]+)"/.exec(error?.response?.body ?? "")?.[1] ?? "")
  return Number.isNaN(at) ? undefined : at
}

export function retryReset(error: { readonly retryAfterMs?: number } | undefined, base: number) {
  const delay = error?.retryAfterMs
  if (delay === undefined || !Number.isFinite(delay) || delay < 0 || delay > 7 * 86_400_000) return undefined
  const at = base + delay
  return Number.isNaN(new Date(at).getTime()) ? undefined : at
}

export function goLimitName(error: { readonly response?: { readonly body: string } } | undefined) {
  return /"limitName"\s*:\s*"([^"]+)"/.exec(error?.response?.body ?? "")?.[1]
}

export function goLimitLink(error: { readonly response?: { readonly body: string } } | undefined) {
  const workspace = /"workspace"\s*:\s*"(wrk_\w+)"/.exec(error?.response?.body ?? "")?.[1]
  return workspace ? `https://opencode.ai/console/${workspace}/go` : "https://opencode.ai/console"
}

export function limitScope(budget: UsageLimitsBudget, workspace: string | undefined) {
  const who =
    budget.scope === "each"
      ? "Only you"
      : budget.shared
        ? `Everyone in ${workspace ?? "the workspace"}`
        : "You and others"
  if (budget.per === "model") return who
  return `${who} · ${limitModels(budget)}`
}

function limitModels(budget: UsageLimitsBudget) {
  if (budget.coverage === "all") return "All models"
  const vendors = budget.vendors.length > 0 ? list(budget.vendors) : undefined
  const price = budget.inputPriceAtLeast === undefined ? undefined : `${formatDollars(budget.inputPriceAtLeast)} per 1M`
  if (vendors && price) return `${vendors} models over ${price}`
  if (vendors) return `All ${vendors} models`
  if (price) return `Models over ${price}`
  const names = budget.models.map((model) => model.name)
  if (names.length > 3) return `${names.slice(0, 3).join(", ")} +${names.length - 3} more`
  return names.join(", ")
}

function list(items: readonly string[]) {
  return new Intl.ListFormat("en-US", { style: "long", type: "conjunction" }).format(items)
}
