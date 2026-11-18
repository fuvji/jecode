import { afterAll, expect, test } from "bun:test"
import { nativeFallbackResponse, resetFallbackStateForTests } from "../src/jetcode-impersonate-fetch.js"

afterAll(() => resetFallbackStateForTests())

test("skips a country-blocked free model and answers with the next", async () => {
  const seen: string[] = []
  const original = (async (_url: string | URL | Request, init?: RequestInit) => {
    const raw = init?.body
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw as Uint8Array)
    const body = JSON.parse(text) as { model: string }
    seen.push(body.model)
    if (seen.length === 1) {
      return new Response("This model is not available in your country.", { status: 403 })
    }
    return Response.json({ choices: [{ message: { role: "assistant", content: "OK" } }] })
  }) as typeof globalThis.fetch

  const body = Buffer.from(
    JSON.stringify({
      model: "big-pickle",
      messages: [{ role: "user", content: "Reply with OK." }],
    }),
  )
  const response = await nativeFallbackResponse(
    original,
    "https://opencode.ai/zen/v1/chat/completions",
    body,
    new Headers({ "content-type": "application/json" }),
  )

  expect(response?.status).toBe(200)
  expect(seen).toHaveLength(2)
  expect(seen[0]).toBe("deepseek-v4.1-flash-free")
  expect(seen[1]).toBe("hy4-flash-free")
})
