import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { TextField } from "@opencode/ui/text-field"
import { createSignal, Show } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { useData } from "@/runtime/server/current"
import { useServerSDK } from "@/runtime/server/client"
import { showToast } from "@/shell/notifications/toast"

export type ExtensionKind = "mcps" | "plugins" | "skills"

/**
 * The install paths that used to live behind documentation links. Everything is
 * written through the server so the UI never needs a folder picker or a shell.
 */
export function DialogInstallExtension(props: {
  kind: ExtensionKind
  directory?: string
  onInstalled?: () => void
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const serverSdk = useServerSDK()
  const data = useData()

  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()

  const [skillUrl, setSkillUrl] = createSignal("")
  const [skillName, setSkillName] = createSignal("")

  const [pluginPackage, setPluginPackage] = createSignal("")

  const [mcpName, setMcpName] = createSignal("")
  const [mcpType, setMcpType] = createSignal<"local" | "remote">("local")
  const [mcpCommand, setMcpCommand] = createSignal("")
  const [mcpUrl, setMcpUrl] = createSignal("")

  const title = () => {
    if (props.kind === "skills") return language.t("settings.extensions.install.skill.title")
    if (props.kind === "plugins") return language.t("settings.extensions.install.plugin.title")
    return language.t("settings.extensions.install.mcp.title")
  }

  const description = () => {
    if (props.kind === "skills") return language.t("settings.extensions.install.skill.description")
    if (props.kind === "plugins") return language.t("settings.extensions.install.plugin.description")
    return language.t("settings.extensions.install.mcp.description")
  }

  const ready = () => {
    if (props.kind === "skills") return skillUrl().trim().length > 0
    if (props.kind === "plugins") return pluginPackage().trim().length > 0
    if (!mcpName().trim()) return false
    return mcpType() === "local" ? mcpCommand().trim().length > 0 : mcpUrl().trim().length > 0
  }

  const install = async () => {
    if (!ready() || busy()) return
    setBusy(true)
    setError(undefined)
    try {
      if (props.kind === "skills") {
        const result = await serverSdk.api.skill.install({
          url: skillUrl().trim(),
          name: skillName().trim() || undefined,
        })
        await data.location.skill.sync().catch(() => undefined)
        props.onInstalled?.()
        showToast({
          variant: "success",
          title: language.t("settings.extensions.install.success", { name: result.name }),
        })
      }

      if (props.kind === "plugins") {
        const name = pluginPackage().trim()
        await serverSdk.api.plugin.install({ package: name })
        props.onInstalled?.()
        showToast({
          variant: "success",
          title: language.t("settings.extensions.install.successPlugin", { name }),
        })
      }

      if (props.kind === "mcps") {
        const name = mcpName().trim()
        const location = props.directory ? { directory: props.directory } : undefined
        await serverSdk.api.experimental.mcp.add({
          server: name,
          location,
          config:
            mcpType() === "local"
              ? { type: "local", command: mcpCommand().trim().split(/\s+/) }
              : { type: "remote", url: mcpUrl().trim() },
        })
        await data.location.mcp.server.sync(location).catch(() => undefined)
        props.onInstalled?.()
        showToast({
          variant: "success",
          title: language.t("settings.extensions.install.successMcp", { name }),
        })
      }

      dialog.close()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitleGroup title={title()} description={description()} />
      </DialogHeader>
      <DialogBody class="flex flex-col gap-5">
        <Show when={props.kind === "skills"}>
          <TextField
            label={language.t("settings.extensions.install.skill.url")}
            placeholder="https://raw.githubusercontent.com/owner/repo/main/SKILL.md"
            value={skillUrl()}
            autofocus
            onInput={(event: InputEvent) => setSkillUrl((event.currentTarget as HTMLInputElement).value)}
          />
          <TextField
            label={language.t("settings.extensions.install.skill.name")}
            placeholder={language.t("settings.extensions.install.skill.namePlaceholder")}
            value={skillName()}
            onInput={(event: InputEvent) => setSkillName((event.currentTarget as HTMLInputElement).value)}
          />
        </Show>

        <Show when={props.kind === "plugins"}>
          <TextField
            label={language.t("settings.extensions.install.plugin.package")}
            placeholder={language.t("settings.extensions.install.plugin.placeholder")}
            value={pluginPackage()}
            autofocus
            onInput={(event: InputEvent) => setPluginPackage((event.currentTarget as HTMLInputElement).value)}
            onKeyDown={(event: KeyboardEvent) => {
              if (event.key === "Enter") void install()
            }}
          />
        </Show>

        <Show when={props.kind === "mcps"}>
          <TextField
            label={language.t("settings.extensions.install.mcp.name")}
            placeholder="my-server"
            value={mcpName()}
            autofocus
            onInput={(event: InputEvent) => setMcpName((event.currentTarget as HTMLInputElement).value)}
          />
          <div class="settings-install-segmented" role="group" aria-label={language.t("settings.extensions.install.mcp.type")}>
            <button
              type="button"
              aria-pressed={mcpType() === "local"}
              data-active={mcpType() === "local" ? "" : undefined}
              onClick={() => setMcpType("local")}
            >
              {language.t("settings.extensions.install.mcp.local")}
            </button>
            <button
              type="button"
              aria-pressed={mcpType() === "remote"}
              data-active={mcpType() === "remote" ? "" : undefined}
              onClick={() => setMcpType("remote")}
            >
              {language.t("settings.extensions.install.mcp.remote")}
            </button>
          </div>
          <Show
            when={mcpType() === "local"}
            fallback={
              <TextField
                label={language.t("settings.extensions.install.mcp.url")}
                placeholder="https://example.com/mcp"
                value={mcpUrl()}
                onInput={(event: InputEvent) => setMcpUrl((event.currentTarget as HTMLInputElement).value)}
              />
            }
          >
            <TextField
              label={language.t("settings.extensions.install.mcp.command")}
              placeholder={language.t("settings.extensions.install.mcp.commandPlaceholder")}
              value={mcpCommand()}
              onInput={(event: InputEvent) => setMcpCommand((event.currentTarget as HTMLInputElement).value)}
              onKeyDown={(event: KeyboardEvent) => {
                if (event.key === "Enter") void install()
              }}
            />
          </Show>
        </Show>

        <p class="text-12-regular leading-5 text-v2-text-text-muted">
          {language.t("settings.extensions.install.hint")}
        </p>
        <Show when={error()}>
          <p class="rounded-xl border border-v2-border-border-critical bg-v2-background-bg-critical px-3 py-2 text-12-regular text-v2-text-text-critical">
            {error()}
          </p>
        </Show>
      </DialogBody>
      <DialogFooter>
        <Button variant="neutral" onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </Button>
        <Button variant="contrast" disabled={!ready() || busy()} onClick={() => void install()}>
          {busy()
            ? language.t("settings.extensions.install.installing")
            : language.t("settings.extensions.install.action")}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
