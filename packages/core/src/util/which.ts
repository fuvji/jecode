import whichPkg from "which"
import path from "path"
import { existsSync, lstatSync } from "fs"

export function which(cmd: string, env?: NodeJS.ProcessEnv, bin?: string) {
  const base = env?.PATH ?? env?.Path ?? process.env.PATH ?? process.env.Path ?? ""
  const full = base && bin ? base + path.delimiter + bin : base || bin
  return (
    whichPkg.sync(cmd, {
      nothrow: true,
      path: full,
      pathExt: env?.PATHEXT ?? env?.PathExt ?? process.env.PATHEXT ?? process.env.PathExt,
    }) ?? appExecutionAlias(cmd, full)
  )
}

// Microsoft Store apps, such as PowerShell 7, put app execution aliases in WindowsApps on PATH. They launch like
// any executable, but stat rejects them with EACCES, so `which` skips them.
//
// jetcode hardening: wrap BOTH fs calls in try/catch. Upstream's
// `lstatSync(file, { throwIfNoEntry: false })` swallows ENOENT only — any
// other errno (EACCES on protected WindowsApps entries, EUNKNOWN on broken
// reparse points left behind by uninstalled apps like OpenAI's Codex CLI,
// EPERM on files quarantined by antivirus) still throws. Field reports
// showed an EUNKNOWN from a stale
// `C:\Users\<name>\AppData\Local\Programs\OpenAI\Codex\bin\pwsh.exe`
// reparse point killing every command that touched this path during shell
// discovery. Treat any failure here as "not an app execution alias" and
// move on — we only need a positive confirmation, never a negative one.
export function isAppExecutionAlias(file: string) {
  if (process.platform !== "win32") return false
  try {
    const stat = lstatSync(file, { throwIfNoEntry: false })
    if (stat?.isSymbolicLink() !== true) return false
    return existsSync(file)
  } catch {
    // EACCES, EUNKNOWN, EPERM, ELOOP on a dangling reparse point — not our
    // problem, not our file, keep scanning.
    return false
  }
}

function appExecutionAlias(cmd: string, search: string | undefined) {
  if (process.platform !== "win32" || !search || path.win32.dirname(cmd) !== ".") return null
  const name = path.win32.extname(cmd).toLowerCase() === ".exe" ? cmd : cmd + ".exe"
  return (
    search
      .split(path.win32.delimiter)
      .filter(Boolean)
      .map((dir) => path.win32.join(dir.replace(/^"(.*)"$/, "$1"), name))
      .find(isAppExecutionAlias) ?? null
  )
}
