import { Project } from "@opencode/core/project"
import { Session } from "@opencode/core/session"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api"
import path from "path"
import { Api } from "../api"
import { ForbiddenError, InvalidRequestError, ProjectNotFoundError } from "@opencode/protocol/errors"

export const ProjectHandler = HttpApiBuilder.group(Api, "server.project", (handlers) =>
  handlers
    .handle("project.list", (ctx) => Project.Service.use((project) => project.list(ctx.query)))
    .handle("project.update", (ctx) =>
      Project.Service.use((project) =>
        project.update({ ...ctx.payload, projectID: ctx.params.projectID }).pipe(
          Effect.mapError(
            () =>
              new ProjectNotFoundError({
                projectID: ctx.params.projectID,
                message: `Project not found: ${ctx.params.projectID}`,
              }),
          ),
        ),
      ),
    )
    .handle(
      "project.remove",
      Effect.fn(function* (ctx) {
        if (ctx.params.projectID === Project.ID.global)
          return yield* new ForbiddenError({
            message: "The shared global project cannot be erased. Erase a specific checkout instead.",
          })

        const projects = yield* Project.Service
        const project = (yield* projects.list()).find((item) => item.id === ctx.params.projectID)
        if (!project)
          return yield* new ProjectNotFoundError({
            projectID: ctx.params.projectID,
            message: `Project not found: ${ctx.params.projectID}`,
          })

        // The folder is the project. Refuse only the paths whose removal would take the
        // machine or the user's home directory with it.
        const global = yield* Global.Service
        if (!erasable(project.canonical, global.home))
          return yield* new ForbiddenError({
            message: `Refusing to erase ${project.canonical}: choose a project folder, not your home or filesystem root.`,
          })

        const fs = yield* FSUtil.Service
        yield* fs.remove(project.canonical, { recursive: true, force: true }).pipe(Effect.orDie)

        // Stop runs and publish session.deleted for every top-level session. Child sessions are removed with them.
        const sessions = yield* Session.Service
        const page = yield* sessions.list({ project: ctx.params.projectID, parentID: null, limit: 10_000 }).pipe(
          Effect.mapError((error) => new InvalidRequestError({ message: String(error) })),
        )
        yield* Effect.forEach(
          page.data,
          (session) =>
            sessions.remove(session.id).pipe(Effect.catchTag("Session.NotFoundError", () => Effect.void)),
          { concurrency: 1, discard: true },
        )

        yield* projects.remove(ctx.params.projectID).pipe(
          Effect.mapError(
            () =>
              new ProjectNotFoundError({
                projectID: ctx.params.projectID,
                message: `Project not found: ${ctx.params.projectID}`,
              }),
          ),
        )
        return HttpApiSchema.NoContent.make()
      }),
    ),
)

function erasable(target: string, home: string) {
  const directory = path.resolve(target)
  const root = path.parse(directory).root
  if (directory === root) return false
  return !FSUtil.contains(directory, path.resolve(home))
}
