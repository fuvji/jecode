import type { TokenUsageInfo } from "@opencode/client/promise"

export type UsageLevel = "ok" | "warn" | "danger"

export function usageTokenTotal(tokens?: TokenUsageInfo) {
  if (!tokens) return 0

  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

export function usagePercent(used: number, limit: number) {
  if (limit <= 0) return 0

  return Math.max(0, Math.min(100, Math.round((used / limit) * 100)))
}

export function usageLevel(percent: number): UsageLevel {
  if (percent >= 95) return "danger"
  if (percent >= 80) return "warn"
  return "ok"
}
