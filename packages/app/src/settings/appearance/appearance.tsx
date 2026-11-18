import { Component, createSignal, onMount, Show } from "solid-js"
import { Button } from "@opencode/ui/button"
import { Select } from "@opencode/ui/select"
import { TextInput } from "@opencode/ui/text-input"
import { useLanguage } from "@/runtime/i18n/language"
import { ExternalLink } from "@/runtime/platform/external-link"
import { SettingsList } from "@/settings/list"
import { SettingsRow } from "@/settings/row"
import { createAppearanceSettingsController, type AppearanceSettingsController } from "@/settings/general/controllers"
import { clearWallpaper, hasWallpaper, readClear, saveClear, saveWallpaper } from "@/jetcode-clear"
import "@/settings/settings.css"

const schemeOptions: ("system" | "light" | "dark")[] = ["system", "light", "dark"]

const reduceMotionOptions = [
  { value: "system" as const, label: "settings.appearance.row.reduceMotion.system" as const },
  { value: "on" as const, label: "settings.appearance.row.reduceMotion.on" as const },
  { value: "off" as const, label: "settings.appearance.row.reduceMotion.off" as const },
]

const fontSettings = {
  ui: {
    action: "settings-ui-font",
    title: "settings.general.row.uiFont.title",
    description: "settings.general.row.uiFont.description",
    font: "ui",
    input: "setUI",
  },
  code: {
    action: "settings-code-font",
    title: "settings.general.row.font.title",
    description: "settings.general.row.font.description",
    font: "code",
    input: "setCode",
  },
  terminal: {
    action: "settings-terminal-font",
    title: "settings.general.row.terminalFont.title",
    description: "settings.general.row.terminalFont.description",
    font: "terminal",
    input: "setTerminal",
  },
} as const

const FontSetting: Component<{
  kind: "ui" | "code" | "terminal"
  fonts: AppearanceSettingsController["fonts"]
}> = (props) => {
  const language = useLanguage()
  const config = () => fontSettings[props.kind]

  return (
    <SettingsRow title={language.t(config().title)} description={language.t(config().description)}>
      <div class="w-full sm:w-[220px]">
        <TextInput
          data-action={config().action}
          type="text"
          appearance="base"
          value={props.fonts[config().font]().value}
          onInput={(event) => props.fonts[config().input](event.currentTarget.value)}
          placeholder={props.fonts[config().font]().placeholder}
          spellcheck={false}
          autocorrect="off"
          autocomplete="off"
          autocapitalize="off"
          aria-label={language.t(config().title)}
          style={{ "font-family": props.fonts[config().font]().family }}
        />
      </div>
    </SettingsRow>
  )
}

const WallpaperSetting: Component = () => {
  const language = useLanguage()
  const [present, setPresent] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  let input: HTMLInputElement | undefined

  onMount(() => {
    void hasWallpaper().then(setPresent)
  })

  const choose = async (file: File | undefined) => {
    if (!file || busy()) return
    setBusy(true)
    setError(undefined)
    const failure = await saveWallpaper(file)
    if (failure) {
      setError(failure)
      setBusy(false)
      return
    }
    saveClear({ ...readClear(), wallpaper: "custom" })
    setPresent(true)
    setBusy(false)
  }

  const remove = async () => {
    if (busy()) return
    setBusy(true)
    await clearWallpaper()
    saveClear({ ...readClear(), wallpaper: "none" })
    setPresent(false)
    setBusy(false)
  }

  return (
    <SettingsRow
      title={language.t("settings.appearance.row.wallpaper.title")}
      description={language.t("settings.appearance.row.wallpaper.description")}
    >
      <div class="flex flex-col items-end gap-1">
        <div class="flex items-center gap-2">
          <input
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            class="sr-only"
            onChange={(event) => void choose(event.currentTarget.files?.[0])}
          />
          <Button
            size="normal"
            variant="outline"
            disabled={busy()}
            onClick={() => input?.click()}
          >
            {present()
              ? language.t("settings.appearance.row.wallpaper.replace")
              : language.t("settings.appearance.row.wallpaper.upload")}
          </Button>
          <Show when={present()}>
            <Button size="normal" variant="ghost-muted" disabled={busy()} onClick={() => void remove()}>
              {language.t("settings.appearance.row.wallpaper.remove")}
            </Button>
          </Show>
        </div>
        <Show when={error()}>
          {(message) => <span class="text-11-regular text-v2-state-fg-danger">{message()}</span>}
        </Show>
      </div>
    </SettingsRow>
  )
}

export const SettingsAppearance: Component = () => {
  const language = useLanguage()
  const appearance = createAppearanceSettingsController()

  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="flex flex-col gap-1">
            <h2 class="settings-tab-title">{language.t("settings.general.section.appearance")}</h2>
            <span class="text-11-regular text-v2-text-text-muted">{language.t("settings.appearance.description")}</span>
          </div>
        </div>
      </div>

      <div class="settings-tab-body">
        <div class="settings-section">
          <SettingsList>
            <SettingsRow
              title={language.t("settings.general.row.colorScheme.title")}
              description={language.t("settings.general.row.colorScheme.description")}
            >
              <Select
                data-action="settings-color-scheme"
                options={schemeOptions}
                current={schemeOptions.find((option) => option === appearance.scheme.current())}
                placement="bottom-end"
                gutter={6}
                label={(option) => {
                  if (option === "system") return language.t("theme.scheme.system")

                  if (option === "light") return language.t("theme.scheme.light")

                  return language.t("theme.scheme.dark")
                }}
                onSelect={(option) => option && appearance.scheme.select(option)}
              />
            </SettingsRow>

            <SettingsRow
              title={language.t("settings.general.row.theme.title")}
              description={
                <>
                  {language.t("settings.general.row.theme.description")}{" "}
                  <ExternalLink class="settings-link" href="https://opencode.ai/docs/themes">
                    {language.t("common.learnMore")}
                  </ExternalLink>
                </>
              }
            >
              <Select
                data-action="settings-theme"
                options={appearance.theme.options()}
                current={appearance.theme.current()}
                placement="bottom-end"
                gutter={6}
                value={(option) => option.id}
                label={(option) => option.name}
                onSelect={appearance.theme.select}
              />
            </SettingsRow>

            <WallpaperSetting />

            <FontSetting kind="ui" fonts={appearance.fonts} />
            <FontSetting kind="code" fonts={appearance.fonts} />
            <FontSetting kind="terminal" fonts={appearance.fonts} />

            <Show when={appearance.zoom.available()}>
              <SettingsRow
                title={language.t("settings.appearance.row.zoom.title")}
                description={language.t("settings.appearance.row.zoom.description")}
              >
                <Select
                  data-action="settings-zoom"
                  options={appearance.zoom.options}
                  current={appearance.zoom.current()}
                  placement="bottom-end"
                  gutter={6}
                  value={(level) => String(level)}
                  label={appearance.zoom.label}
                  onSelect={(level) => level && appearance.zoom.select(level)}
                />
              </SettingsRow>
            </Show>

            <SettingsRow
              title={language.t("settings.appearance.row.reduceMotion.title")}
              description={language.t("settings.appearance.row.reduceMotion.description")}
            >
              <Select
                data-action="settings-reduce-motion"
                options={reduceMotionOptions}
                current={reduceMotionOptions.find((option) => option.value === appearance.reduceMotion.current())}
                placement="bottom-end"
                gutter={6}
                value={(option) => option.value}
                label={(option) => language.t(option.label)}
                onSelect={(option) => option && appearance.reduceMotion.select(option.value)}
              />
            </SettingsRow>
          </SettingsList>
        </div>
      </div>
    </>
  )
}
