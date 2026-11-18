export * as JetcodeTokenSaverPlugin from "./jetcode-tokensaver.js"

import { SystemPart } from "@opencode/ai/effect"
import { define } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Effect } from "effect"
import { Config } from "../config.js"
import { SessionCompaction } from "../session/compaction.js"

// Built-in token saver. Two pieces, both model-agnostic:
//
//  1. Compaction preset. Automatic compaction stays on, keeps a smaller
//     verbatim tail than the upstream default, and precomputes the summary
//     before the window fills. Repository config still wins: this runs in
//     the pre phase, ConfigCompactionPlugin applies the user's values after.
//
//  2. One short instruction appended to the primary and compaction system
//     prompts. It asks for targeted reads, surgical edits and short answers
//     rather than restating work already visible in the timeline. The marker
//     makes the addition idempotent across retries and repeated hooks.
//
// The prompt is deliberately small (about 70 tokens). A larger preamble
// would cost more than it saves on short sessions.
//
// `compaction.token_saver: false` opts out. The hooks read the current config
// on every request, so toggling it applies without a restart; the compaction
// preset is only installed when the saver is enabled during boot.

const MARKER = "<jetcode-token-saver>"

const GUIDANCE = `${MARKER}
Work in the fewest tokens that keep the result correct:
- Search before opening files, then read only the ranges a decision needs.
- Prefer one precise edit over rewriting a whole file.
- Answer with what changed, where it changed, and what was verified. Do not restate the request or the plan.
- Do not quote tool output, file contents or diffs back to the user unless they asked for them.
- Stop once the requested work is done and checked.
</jetcode-token-saver>`

export const Plugin = define({
  id: "jetcode.token-saver",
  effect: Effect.fn("JetcodeTokenSaverPlugin")(function* (ctx) {
    const config = yield* Config.Service
    const compaction = yield* SessionCompaction.Service

    // Read the explicit leaf from every document, not just the last document
    // that mentions compaction: a project's `compaction.buffer` must not hide
    // the global `compaction.token_saver: false` in a lower-priority file.
    const enabled = Effect.gen(function* () {
      let value = true
      for (const entry of yield* config.entries()) {
        if (entry.type === "document" && entry.info.compaction?.token_saver !== undefined)
          value = entry.info.compaction.token_saver
      }
      return value
    })

    if (yield* enabled) {
      yield* compaction.transform((editor) =>
        editor.configure({
          auto: true,
          buffer: "20%",
          keep: 10_000,
          precompute: true,
        }),
      )
    }

    const hook = (event: SessionHooks["context"] | SessionHooks["compaction"]) =>
      Effect.gen(function* () {
        if (!(yield* enabled)) return
        if (event.system.some((part) => part.text.includes(MARKER))) return
        event.system.push(SystemPart.make(GUIDANCE))
      })

    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
  }),
})
