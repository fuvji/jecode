import { expect, test } from "bun:test"
import { bestValue, modelValue } from "./value"

const base = {
  provider: { id: "opencode" },
  cost: { input: 0, output: 0 },
  limit: { context: 200_000 },
  capabilities: { toolcall: true, input: { text: true, image: true }, output: { text: true } },
  release_date: "2026-10-01",
}

test("free tool-capable agents rank above expensive text-only models", () => {
  const free = modelValue({ ...base, id: "free-coder", name: "Free Coder" })
  const paid = modelValue({
    ...base,
    id: "expensive-text",
    name: "Expensive Text",
    cost: { input: 30, output: 120 },
    capabilities: { toolcall: false, input: { text: true }, output: { text: true } },
  })

  expect(free.score).toBeGreaterThan(paid.score)
  expect(free.affordability).toBeGreaterThan(paid.affordability)
  expect(free.quality).toBeGreaterThan(paid.quality)
  expect(free.grade).toMatch(/^[SABC]$/)
})

test("bestValue picks the strongest value and returns its chart", () => {
  const best = bestValue([
    { ...base, id: "cheap", name: "Cheap" },
    {
      ...base,
      id: "strong",
      name: "Strong Coder",
      limit: { context: 1_000_000 },
      capabilities: { toolcall: true, reasoning: true, input: { text: true, image: true }, output: { text: true } },
    },
  ])

  expect(best?.model.id).toBe("strong")
  expect(best?.value.context).toBeGreaterThan(90)
  expect(best?.value.quality).toBeGreaterThan(0)
})
