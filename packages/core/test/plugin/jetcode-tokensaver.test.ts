import { describe, expect } from "bun:test"
import { SystemPart } from "@opencode/ai/effect"
import { Agent } from "@opencode/core/agent"
import { Config } from "@opencode/core/config"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginHost } from "@opencode/core/plugin/host"
import { JetcodeTokenSaverPlugin } from "@opencode/core/plugin/jetcode-tokensaver"
import { Provider } from "@opencode/core/provider"
import { Session } from "@opencode/core/session"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { ConfigCompaction } from "@opencode/schema/config/compaction"
import { Document, Info } from "@opencode/schema/config"
import { Model } from "@opencode/schema/model"
import { SessionCompaction } from "@opencode/core/session/compaction"
import { Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

// The focused test only exercises the prompt hook; the compaction preset is
// covered by the plugin's real layer in the app. Stub it so the fixture does
// not need the whole model/runner graph.
const compaction = Layer.succeed(
  SessionCompaction.Service,
  SessionCompaction.Service.of({
    transform: () => Effect.void,
    reload: Effect.void,
    compact: () => Effect.succeed({ status: "skipped" }),
    precompute: () => Effect.void,
  } as unknown as SessionCompaction.Interface),
)

const it = testEffect(Layer.merge(PluginTestLayer, compaction))

const MARKER = "<jetcode-token-saver>"

const context = (): SessionHooks["context"] => ({
  sessionID: Session.ID.make("ses_token_saver"),
  agent: Agent.ID.make("build"),
  model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("test-model") }),
  system: [SystemPart.make("Agent prompt")],
  messages: [],
  tools: {},
  options: {},
})

const run = (tokenSaver?: boolean) =>
  Effect.gen(function* () {
    const config = yield* Config.Test
    if (tokenSaver !== undefined) {
      yield* config.setEntries([
        new Document({
          type: "document",
          info: new Info({ compaction: new ConfigCompaction.Info({ token_saver: tokenSaver }) }),
        }),
      ])
    }

    const hooks = yield* PluginHooks.Service
    const plugins = yield* Plugin.Service
    yield* JetcodeTokenSaverPlugin.Plugin.effect(yield* PluginHost.make(plugins, "test"))

    const event = context()
    yield* hooks.trigger("session", "context", event)
    return event.system.map((part) => part.text)
  })

describe("JetcodeTokenSaverPlugin", () => {
  it.effect("appends guidance when config does not opt out", () =>
    run().pipe(
      Effect.tap((system) =>
        Effect.sync(() => {
          expect(system).toHaveLength(2)
          expect(system[1]).toContain(MARKER)
        }),
      ),
    ),
  )

  it.effect("appends guidance when token_saver is explicitly true", () =>
    run(true).pipe(
      Effect.tap((system) =>
        Effect.sync(() => {
          expect(system).toHaveLength(2)
          expect(system[1]).toContain(MARKER)
        }),
      ),
    ),
  )

  it.effect("skips guidance when compaction.token_saver is false", () =>
    run(false).pipe(
      Effect.tap((system) =>
        Effect.sync(() => {
          expect(system).toEqual(["Agent prompt"])
        }),
      ),
    ),
  )

  it.effect("keeps a lower-priority opt-out when a higher-priority document only sets another compaction leaf", () =>
    Effect.gen(function* () {
      const config = yield* Config.Test
      yield* config.setEntries([
        new Document({
          type: "document",
          info: new Info({ compaction: new ConfigCompaction.Info({ token_saver: false }) }),
        }),
        new Document({
          type: "document",
          info: new Info({ compaction: new ConfigCompaction.Info({ buffer: "20%" }) }),
        }),
      ])

      const hooks = yield* PluginHooks.Service
      const plugins = yield* Plugin.Service
      yield* JetcodeTokenSaverPlugin.Plugin.effect(yield* PluginHost.make(plugins, "test"))

      const event = context()
      yield* hooks.trigger("session", "context", event)
      expect(event.system.map((part) => part.text)).toEqual(["Agent prompt"])
    }),
  )
})
