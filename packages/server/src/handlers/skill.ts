import { Skill } from "@opencode/core/skill"
import { InvalidRequestError } from "@opencode/protocol/errors"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import path from "path"
import { Api } from "../api"
import { response } from "../location"

export const SkillHandler = HttpApiBuilder.group(Api, "server.skill", (handlers) =>
  handlers
    .handle("skill.list", () => response(Skill.Service.use((skill) => skill.list())))
    .handle("skill.install", (ctx) =>
      Effect.gen(function* () {
        const url = yield* parseUrl(ctx.payload.url)
        const source = yield* fetchSkill(url)
        const name = yield* skillName(ctx.payload.name, source)
        const global = yield* Global.Service
        const fs = yield* FSUtil.Service
        const file = path.join(global.config, "skills", name, "SKILL.md")

        yield* fs
          .writeWithDirs(file, source.endsWith("\n") ? source : `${source}\n`)
          .pipe(Effect.mapError(() => invalid("Could not write the skill into the global config folder.", "url")))

        return { name }
      }),
    ),
)

const MAX_SKILL_BYTES = 512_000

function parseUrl(input: string) {
  return Effect.try({
    try: () => new URL(input.trim()),
    catch: () => invalid("Enter a valid HTTPS URL to a SKILL.md file.", "url"),
  }).pipe(
    Effect.flatMap((url) =>
      url.protocol === "https:"
        ? Effect.succeed(url)
        : Effect.fail(invalid("Only HTTPS skill URLs are supported.", "url")),
    ),
  )
}

function fetchSkill(url: URL) {
  return Effect.gen(function* () {
    const response = yield* Effect.tryPromise({
      try: () => fetch(url, { redirect: "follow", headers: { accept: "text/plain, text/markdown;q=0.9, */*;q=0.8" } }),
      catch: () => invalid("Could not reach that skill URL.", "url"),
    })
    if (!response.ok) return yield* invalid(`The skill URL returned ${response.status}.`, "url")
    const length = Number(response.headers.get("content-length"))
    if (Number.isFinite(length) && length > MAX_SKILL_BYTES)
      return yield* invalid("That skill is larger than 512 KB.", "url")
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () => invalid("Could not read the skill URL.", "url"),
    })
    if (text.length > MAX_SKILL_BYTES) return yield* invalid("That skill is larger than 512 KB.", "url")
    if (!/^---\r?\n[\s\S]*?\r?\n---/.test(text))
      return yield* invalid("The URL must return a SKILL.md that starts with YAML frontmatter.", "url")
    return text
  })
}

function skillName(provided: string | undefined, source: string) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1] ?? ""
  const documented = /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(frontmatter)?.[1]?.trim()
  const name = (provided?.trim() || documented || "").toLowerCase()
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))
    return Effect.fail(
      invalid("The skill needs a lowercase hyphenated name in its frontmatter, or type one below.", "name"),
    )
  return Effect.succeed(name)
}

function invalid(message: string, field: string) {
  return new InvalidRequestError({ message, field })
}
