import { describe, expect, test } from "bun:test"
import {
  bestFreeModel,
  fallbackBody,
  freeModelOrder,
  installNativeFallbackFetchOverride,
  isContextLengthRejection,
  isRegionBlockText,
  parseResponseHead,
  requestHasImage,
  requestModel,
  rewriteModel,
} from "../src/jetcode-impersonate-fetch.js"

const bytes = (input: string) => Buffer.from(input, "utf8")
const contentType = (head: ReturnType<typeof parseResponseHead>) =>
  head?.headers.find(([name]: [string, string]) => name.toLowerCase() === "content-type")?.[1]

describe("provider error routing", () => {
  test("recognizes country-block responses as retryable routing signals", () => {
    expect(isRegionBlockText("This model is not available in your country.")).toBe(true)
    expect(isRegionBlockText("The selected model is not available in your region.")).toBe(true)
    expect(isRegionBlockText('{"error":{"message":"Unsupported country"}}')).toBe(true)
    expect(isRegionBlockText("Free usage limit reached")).toBe(false)
    expect(isRegionBlockText("Invalid API key")).toBe(false)
  })

  test("only compacts local requests after a context-length rejection", () => {
    expect(isContextLengthRejection("the request exceeds the context window of this model")).toBe(true)
    expect(isContextLengthRejection("input is too long for this model")).toBe(true)
    expect(isContextLengthRejection('{"error":{"message":"n_ctx is too small"}}')).toBe(true)
    expect(isContextLengthRejection("model does not support tools")).toBe(false)
    expect(isContextLengthRejection("invalid api key")).toBe(false)
  })
})

describe("curl-impersonate response head", () => {
  test("skips the proxy CONNECT block and keeps the real 429", () => {
    const head = parseResponseHead(
      bytes(
        "HTTP/1.1 200 Connection established\r\n" +
          "Proxy-Agent: warp\r\n" +
          "\r\n" +
          "HTTP/1.1 429 Too Many Requests\r\n" +
          "Content-Type: application/json\r\n" +
          "Retry-After: 2231\r\n" +
          "\r\n" +
          '{"type":"error","error":{"type":"FreeUsageLimitError"}}',
      ),
    )
    expect(head?.status).toBe(429)
    expect(contentType(head)).toBe("application/json")
    expect(head && head.bodyOffset).toBeDefined()
  })

  test("keeps a plain SSE response intact", () => {
    const head = parseResponseHead(
      bytes(
        "HTTP/2 200 \r\n" +
          "content-type: text/event-stream\r\n" +
          "\r\n" +
          'data: {"choices":[]}\r\n\r\n',
      ),
    )
    expect(head?.status).toBe(200)
    expect(contentType(head)).toBe("text/event-stream")
  })

  test("skips an informational 100 Continue block", () => {
    const head = parseResponseHead(
      bytes(
        "HTTP/1.1 100 Continue\r\n" +
          "\r\n" +
          "HTTP/1.1 200 OK\r\n" +
          "Content-Type: text/event-stream\r\n" +
          "\r\n" +
          "data: x\r\n\r\n",
      ),
    )
    expect(head?.status).toBe(200)
    expect(contentType(head)).toBe("text/event-stream")
  })

  test("skips a proxy CONNECT block that says 200 OK when a proxy is in use", () => {
    const head = parseResponseHead(
      bytes(
        "HTTP/1.1 200 OK\r\n" +
          "\r\n" +
          "HTTP/1.1 429 Too Many Requests\r\n" +
          "Content-Type: application/json\r\n" +
          "Retry-After: 156\r\n" +
          "\r\n" +
          '{"type":"error","error":{"type":"FreeUsageLimitError"}}',
      ),
      true,
    )
    expect(head?.status).toBe(429)
    expect(contentType(head)).toBe("application/json")
  })

  test("handles LF-only proxy blocks", () => {
    const head = parseResponseHead(
      bytes(
        "HTTP/1.1 200 Connection established\n" +
          "\n" +
          "HTTP/1.1 403 Forbidden\n" +
          "Content-Type: application/json\n" +
          "\n" +
          "denied",
      ),
    )
    expect(head?.status).toBe(403)
    expect(contentType(head)).toBe("application/json")
  })
})

describe("vision routing", () => {
  test("detects image_url, inline file images, and nested content", () => {
    const one = Buffer.from(
      JSON.stringify({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look" },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            ],
          },
        ],
      }),
    )
    expect(requestHasImage(one)).toBe(true)
    const two = Buffer.from(
      JSON.stringify({
        messages: [{ role: "user", content: [{ type: "file", file: { mime_type: "image/jpeg", file_data: "AA" } }] }],
      }),
    )
    expect(requestHasImage(two)).toBe(true)
    const three = Buffer.from(
      JSON.stringify({
        messages: [{ role: "user", content: [{ type: "tool_result", content: [{ type: "image", source: {} }] }] }],
      }),
    )
    expect(requestHasImage(three)).toBe(true)
  })

  test("leaves text-only and malformed bodies alone", () => {
    const text = Buffer.from(
      JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text: "image_url is a field" }] }] }),
    )
    expect(requestHasImage(text)).toBe(false)
    expect(requestHasImage(null)).toBe(false)
    expect(requestHasImage(Buffer.from("{not json"))).toBe(false)
  })
})

describe("free-limit fallback body", () => {
  test("orders the requested free model first without duplicates", () => {
    const order = freeModelOrder("hy4-flash-free")
    expect(order[0]).toBe("hy4-flash-free")
    expect(new Set(order).size).toBe(order.length)
    expect(order).toContain("deepseek-v4.1-flash-free")
    expect(freeModelOrder()[0]).toBe("big-pickle")
  })

  test("rewrites only the model and preserves tools and messages", () => {
    const body = Buffer.from(
      JSON.stringify({
        model: "big-pickle",
        stream: true,
        messages: [{ role: "user", content: "hello" }],
        tools: [{ type: "function", function: { name: "read" } }],
      }),
    )
    const rewritten = JSON.parse(rewriteModel(body, "deepseek-v4.1-flash-free")!.toString("utf8")) as Record<
      string,
      unknown
    >
    expect(rewritten.model).toBe("deepseek-v4.1-flash-free")
    expect(rewritten.stream).toBe(true)
    expect(rewritten.tools).toEqual([{ type: "function", function: { name: "read" } }])
    expect(rewritten.messages).toEqual([{ role: "user", content: "hello" }])
    expect(requestModel(body)).toBe("big-pickle")
  })

  test("skips a text-only first model for an image request", () => {
    const body = Buffer.from(
      JSON.stringify({
        model: "big-pickle",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "look" },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            ],
          },
        ],
      }),
    )
    expect(bestFreeModel(body)).not.toBe("big-pickle")
    expect(bestFreeModel(body)).toContain("free")
  })

  test("replaces image parts with text for text-only fallback providers", async () => {
    const body = Buffer.from(
      JSON.stringify({
        stream: true,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is in this image?" },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            ],
          },
          {
            role: "user",
            content: [{ type: "file", file: { mime_type: "image/jpeg", file_data: "AAAA" } }],
          },
        ],
      }),
      "utf8",
    )

    const parsed = JSON.parse((await fallbackBody(body)) ?? "{}") as {
      messages: Array<{ content: Array<{ type: string; text?: string }> }>
    }

    expect(parsed.messages[0].content).toEqual([
      { type: "text", text: "what is in this image?" },
      { type: "text", text: "[image omitted: the fallback model does not accept images and OCR found no text]" },
    ])
    expect(parsed.messages[1].content).toEqual([
      { type: "text", text: "[image omitted: the fallback model does not accept images and OCR found no text]" },
    ])
  })

  test("keeps images when the fallback model supports vision", async () => {
    const image = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }
    const body = Buffer.from(
      JSON.stringify({
        messages: [{ role: "user", content: [{ type: "text", text: "what is this?" }, image] }],
      }),
      "utf8",
    )
    const parsed = JSON.parse((await fallbackBody(body, "deepseek-chat", true)) ?? "{}") as {
      messages: Array<{ content: unknown[] }>
    }
    expect(parsed.messages[0].content).toEqual([{ type: "text", text: "what is this?" }, image])
  })

  test("compacts the Pollinations fallback body", async () => {
    const big = "x".repeat(20000)
    const body = Buffer.from(
      JSON.stringify({
        messages: [
          { role: "system", content: big },
          ...Array.from({ length: 8 }, (_, index) => ({ role: "user", content: `${index} ${big}` })),
          { role: "user", content: "last" },
        ],
        tools: [
          { type: "function", function: { name: "read" } },
          { type: "function", function: { name: "webfetch" } },
        ],
        max_tokens: 8000,
      }),
    )

    const parsed = JSON.parse((await fallbackBody(body, "openai", false, true)) ?? "{}") as {
      messages: Array<{ role: string; content: string }>
      tools: unknown[]
      max_tokens: number
    }

    expect(parsed.messages.length).toBeLessThanOrEqual(8)
    expect(parsed.messages[1].content.length).toBeLessThan(5000)
    expect(parsed.tools).toEqual([{ type: "function", function: { name: "read" } }])
    expect(parsed.max_tokens).toBe(2048)
    expect(parsed.messages.at(-1)?.content).toBe("last")
  })

  test("keeps ordinary text and tool messages unchanged", async () => {
    const body = Buffer.from(
      JSON.stringify({
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: "hello" },
          { role: "tool", tool_call_id: "call_1", content: '{"ok":true}' },
        ],
      }),
      "utf8",
    )

    const parsed = JSON.parse((await fallbackBody(body)) ?? "{}") as { messages: unknown[] }
    expect(parsed.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hello" },
      { role: "tool", tool_call_id: "call_1", content: '{"ok":true}' },
    ])
  })

  test("native override retries the next free model after a free-limit 429", async () => {
    const original = globalThis.fetch
    const calls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input as RequestInfo, init)
      const body = (await request.json()) as { model: string }
      calls.push(body.model)
      if (body.model === "big-pickle")
        return new Response(JSON.stringify({ error: { type: "FreeUsageLimitError", message: "free usage limit" } }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "60" },
        })
      return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } })
    }) as typeof globalThis.fetch

    try {
      expect(installNativeFallbackFetchOverride()).toMatchObject({ installed: true })
      const response = await globalThis.fetch("https://opencode.ai/api/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "big-pickle", stream: true, messages: [{ role: "user", content: "hello" }] }),
      })
      expect(response.status).toBe(200)
      expect(calls).toEqual(["big-pickle", "deepseek-v4.1-flash-free"])
    } finally {
      globalThis.fetch = original
      delete (globalThis as { __jetcodeNativeFallbackInstalled?: boolean }).__jetcodeNativeFallbackInstalled
    }
  })
})
