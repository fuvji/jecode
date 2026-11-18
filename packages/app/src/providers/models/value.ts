export type ValueModel = {
  id: string
  name?: string
  provider: { id?: string; name?: string }
  cost?: { input?: number; output?: number }
  limit?: { context?: number }
  capabilities?: {
    toolcall?: boolean
    reasoning?: boolean
    input?: { image?: boolean; text?: boolean }
    output?: { text?: boolean }
  }
  release_date?: string
}

export type ModelValue = {
  /** Overall value for agent work, 0–100. */
  score: number
  /** A compact letter grade for the picker. */
  grade: "S" | "A" | "B" | "C"
  quality: number
  context: number
  speed: number
  affordability: number
}

const clamp = (value: number) => Math.max(0, Math.min(100, value))

const codingHint = (model: ValueModel) =>
  /coder|code|devstral|qwen|deepseek|claude|gpt-5|gpt-oss|gemini/i.test(`${model.name ?? ""} ${model.id}`)

const localProvider = (model: ValueModel) => /^(ollama|lmstudio)$/i.test(model.provider.id ?? "")

/**
 * A single explainable number for the picker. It intentionally favors models
 * that can actually run an agent loop (tools + text), then context and price.
 * The four bars are independent so a user can see why a model scored well.
 */
export function modelValue(model: ValueModel): ModelValue {
  const contextTokens = Math.max(1, model.limit?.context ?? 0)
  // Log scale keeps a 1M-token model from making every 128K model look broken.
  const context = clamp((Math.log10(contextTokens) / Math.log10(2_000_000)) * 100)

  const input = Math.max(0, model.cost?.input ?? 0)
  const output = Math.max(0, model.cost?.output ?? 0)
  const paid = input + output
  const affordability = clamp(100 - Math.log10(1 + paid) * 38)

  const speed = clamp(
    (localProvider(model) ? 92 : 35) +
      (paid === 0 ? 8 : Math.max(-30, 12 - Math.log10(1 + paid) * 12)) +
      (/flash|small|mini|lite|lightning/i.test(`${model.name ?? ""} ${model.id}`) ? 6 : 0),
  )

  const quality = clamp(
    20 +
      (model.capabilities?.toolcall ? 32 : 0) +
      (model.capabilities?.reasoning ? 9 : 0) +
      (model.capabilities?.input?.image ? 5 : 0) +
      (codingHint(model) ? 8 : 0) +
      context * 0.16 +
      ((): number => {
        const released = Date.parse(model.release_date ?? "")
        if (!Number.isFinite(released)) return 0
        const months = Math.max(0, (Date.now() - released) / (30.44 * 24 * 60 * 60 * 1000))
        return Math.max(0, 12 - months * 1.5)
      })(),
  )

  const score = Math.round(
    clamp(quality * 0.42 + context * 0.23 + affordability * 0.23 + speed * 0.12),
  )

  return {
    score,
    grade: score >= 85 ? "S" : score >= 70 ? "A" : score >= 55 ? "B" : "C",
    quality: Math.round(quality),
    context: Math.round(context),
    speed: Math.round(speed),
    affordability: Math.round(affordability),
  }
}

export function bestValue<T extends ValueModel>(models: readonly T[]) {
  let best: { model: T; value: ModelValue } | undefined
  for (const model of models) {
    const value = modelValue(model)
    if (!best || value.score > best.value.score) best = { model, value }
  }
  return best
}
