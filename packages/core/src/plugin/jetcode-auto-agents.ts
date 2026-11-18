export * as JetcodeAutoAgentsPlugin from "./jetcode-auto-agents.js"

import { SystemPart } from "@opencode/ai/effect"
import { define } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Effect } from "effect"
import * as path from "node:path"
import { Location } from "../location.js"
import { JetcodeAbliterated } from "../jetcode-abliterated.js"

// jetcode deep auto-agents: reloads every relevant AGENTS.md on every model
// request instead of trusting the diff-based instruction cache.
//
// Why this exists on top of ConfigInstructionPlugin:
//   `session/compaction.ts` tells the summarizer to omit repository conventions
//   and AGENTS.md, relying on the next request to receive them separately. The
//   normal instruction path renders changes as diffs; after a compaction (or a
//   restart) a "no changes" diff can read as "no instructions".
//
// What is loaded, in precedence order:
//   1. the global config AGENTS.md (~/.config/opencode/AGENTS.md by default),
//   2. AGENTS.md from each ancestor of the active workspace up to the project
//      root,
//   3. every nested AGENTS.md under the project root, sorted by path.
//
// Caps keep a runaway tree from flooding the context: 64 files, 64 KiB per file,
// 256 KiB total, depth 6, with dependency/build directories ignored. The caps
// are deliberately generous for monorepos while still bounded. Every prompt,
// compaction and one-off generate call gets the full text, freshly re-read.
const MAX_FILES = 64
const MAX_FILE_BYTES = 64 * 1024
const MAX_TOTAL_BYTES = 256 * 1024
const MAX_DEPTH = 6
const IGNORED = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.hg/**",
  "**/.svn/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/target/**",
  "**/vendor/**",
  "**/.venv/**",
  "**/venv/**",
  "**/__pycache__/**",
  "**/.next/**",
  "**/.turbo/**",
  "**/.cache/**",
  "**/coverage/**",
]

type LoadedFile = { path: string; content: string }

export const Plugin = define({
  id: "jetcode.prompt.auto-agents",
  effect: Effect.fn("JetcodeAutoAgentsPlugin")(function* (ctx) {
    const location = yield* Location.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const project = yield* fs.resolve(location.project.directory)
    const workspace = yield* fs.resolve(location.directory)
    const globalFile = yield* fs.resolve(path.join(global.config, "AGENTS.md"))

    const collect = Effect.fn("JetcodeAutoAgentsPlugin.collect")(function* () {
      const found = new Map<string, number>()
      const add = (file: string, priority: number) => {
        const normalized = path.resolve(file)
        const previous = found.get(normalized)
        if (previous === undefined || priority < previous) found.set(normalized, priority)
      }

      // Global instructions come first, matching the normal instruction order.
      if (yield* fs.isFile(globalFile)) add(globalFile, 0)

      // Ancestors of the active workspace. The project root is included here;
      // walking above it is capped so a home-directory AGENTS.md is not missed
      // when the project lives under home.
      let current = workspace
      let depth = 0
      while (depth < 8) {
        add(path.join(current, "AGENTS.md"), 1 + depth)
        if (current === project) break
        const parent = path.dirname(current)
        if (parent === current) break
        current = parent
        depth++
      }
      add(path.join(project, "AGENTS.md"), 1)

      // Nested instructions are only discovered inside the project root. One
      // pattern per depth keeps the walk bounded instead of globbing an
      // arbitrarily deep tree just to discard files at the end.
      if (FSUtil.contains(project, workspace) || workspace === project) {
        const patterns = Array.from({ length: MAX_DEPTH + 1 }, (_, depth) => `${"*/".repeat(depth)}AGENTS.md`)
        const nested = yield* Effect.forEach(
          patterns,
          (pattern) =>
            fs
              .scan(pattern, {
                cwd: project,
                absolute: true,
                include: "file",
                dot: true,
                ignore: IGNORED,
              })
              .pipe(Effect.orElseSucceed(() => [] as string[])),
          { concurrency: 3 },
        ).pipe(Effect.map((groups) => groups.flat()))
        for (const file of nested) {
          const relative = path.relative(project, file)
          if (relative.split(path.sep).length - 1 > MAX_DEPTH) continue
          if (relative.split(path.sep).includes("node_modules")) continue
          add(file, 20)
        }
      }

      const ordered = Array.from(found.entries())
        .toSorted((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))
        .map(([file]) => file)

      const loaded: LoadedFile[] = []
      let total = 0
      for (const file of ordered) {
        if (loaded.length >= MAX_FILES) break
        if (total >= MAX_TOTAL_BYTES) break
        const content = yield* fs.readFileStringSafe(file)
        if (!content || !content.trim()) continue
        const bytes = Buffer.byteLength(content, "utf8")
        const clipped = bytes > MAX_FILE_BYTES ? Buffer.from(content, "utf8").subarray(0, MAX_FILE_BYTES).toString("utf8") : content
        const remaining = MAX_TOTAL_BYTES - total
        const body = Buffer.byteLength(clipped, "utf8") > remaining
          ? Buffer.from(clipped, "utf8").subarray(0, remaining).toString("utf8")
          : clipped
        if (!body.trim()) continue
        total += Buffer.byteLength(body, "utf8")
        loaded.push({ path: file, content: body.trimEnd() })
      }
      return loaded
    })

    const hook = (event: SessionHooks["context"] | SessionHooks["compaction"] | SessionHooks["generate"]) =>
      Effect.gen(function* () {
        // Auto JB is additive. It used to return here, which silently dropped
        // every project and global AGENTS.md whenever the switch was enabled.
        if (JetcodeAbliterated.enabled()) {
          const content = JetcodeAbliterated.content().trimEnd()
          if (content.trim()) {
            yield* Effect.logInfo("jetcode abliterated instruction set appended")
            event.system.push(
              SystemPart.make(
                [
                  '<project-agents-md path="builtin://jetcode/AGENTS.md" source="auto-jb">',
                  "The following is the bundled Auto JB instruction set. It is additive to",
                  "the project AGENTS.md files below; project-specific rules still win where",
                  "they are more specific. Any earlier conversational summary that elided",
                  "either source does not supersede them.",
                  "",
                  content,
                  "</project-agents-md>",
                ].join("\n"),
              ),
            )
          }
        }

        // Read fresh every time: the user may edit AGENTS.md mid-session, and a
        // restart or compaction must never leave the model without it.
        const files = yield* collect()
        if (files.length === 0) return
        const blocks = files.map((file) =>
          [
            `<agents-md path="${file.path}">`,
            file.content,
            "</agents-md>",
          ].join("\n"),
        )
        event.system.push(
          SystemPart.make(
            [
              `<project-agents-md count="${files.length}" reloaded="every-prompt">`,
              "The following AGENTS.md files apply to this workspace and were reloaded",
              "fresh for this step. They are the current source of truth; any earlier",
              "conversational summary that elided them does not supersede them.",
              "More specific (deeper) files take precedence over broader ones when they",
              "conflict, unless a file says otherwise.",
              "",
              blocks.join("\n\n"),
              "</project-agents-md>",
            ].join("\n"),
          ),
        )
      }).pipe(Effect.catch(() => Effect.void))

    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
})
