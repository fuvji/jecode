import { afterAll, beforeAll, expect, test } from "bun:test"
import { localFallbackResponse } from "../src/jetcode-impersonate-fetch.js"

const marker = "AGENTS_MARKER_THIS_MUST_SURVIVE"
let server: ReturnType<typeof Bun.serve>
let requests: Array<Record<string, unknown>> = []

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, unknown>
      requests.push(body)
      if (requests.length === 1) {
        return Response.json({ error: { message: "the request exceeds the context window of this model" } }, { status: 400 })
      }
      return Response.json({
        id: "mock",
        choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
      })
    },
  })
  process.env.JETCODE_LOCAL_OPENAI_URL = server.url.origin
  process.env.JETCODE_LOCAL_MODEL = "mock-coder"
  process.env.JETCODE_OLLAMA_URL = "http://127.0.0.1:9"
  process.env.JETCODE_LMSTUDIO_URL = "http://127.0.0.1:9"
  process.env.JETCODE_OFFLINE = "1"
})

afterAll(() => {
  server?.stop(true)
  delete process.env.JETCODE_LOCAL_OPENAI_URL
  delete process.env.JETCODE_LOCAL_MODEL
  delete process.env.JETCODE_OLLAMA_URL
  delete process.env.JETCODE_LMSTUDIO_URL
  delete process.env.JETCODE_OFFLINE
})

test("sends full AGENTS context and tools before compacting", async () => {
  const fullSystem = `${marker}\n${"project instruction ".repeat(1200)}`
  const body = Buffer.from(
    JSON.stringify({
      model: "big-pickle",
      stream: false,
      messages: [
        { role: "system", content: fullSystem },
        { role: "user", content: "Reply with OK." },
      ],
      tools: [{ type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object" } } }],
    }),
    "utf8",
  )

  const response = await localFallbackResponse(body, "test")
  expect(response?.status).toBe(200)
  expect(requests).toHaveLength(2)

  const first = requests[0]!
  const firstMessages = first.messages as Array<{ content: string }>
  expect(firstMessages[0]!.content).toContain(marker)
  expect((first.tools as unknown[]).length).toBe(1)

  const second = requests[1]!
  const secondMessages = second.messages as Array<{ content: string }>
  expect(secondMessages[0]!.content.length).toBeLessThan(firstMessages[0]!.content.length)
  expect((second.tools as unknown[]).length).toBe(1)
})
