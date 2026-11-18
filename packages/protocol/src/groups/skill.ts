import { Skill } from "@opencode/schema/skill"
import { Location } from "@opencode/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { InvalidRequestError } from "../errors.js"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

export const SkillGroup = HttpApiGroup.make("server.skill")
  .add(
    HttpApiEndpoint.get("skill.list", "/api/skill", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Skill.Info)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "skill.list",
          summary: "List skills",
          description: "Retrieve currently registered skills.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("skill.install", "/api/skill/install", {
      payload: Schema.Struct({ url: Schema.String, name: Schema.String.pipe(Schema.optional) }),
      success: Schema.Struct({ name: Schema.String }),
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "skill.install",
        summary: "Install skill",
        description:
          "Download a SKILL.md from an HTTPS URL into the global skills directory. The URL must return a SKILL.md with frontmatter.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "skill",
      description: "Experimental skill routes.",
    }),
  )
