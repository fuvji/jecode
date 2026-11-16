import type { LocationRef, TokenUsageInfo } from "@opencode/client/promise"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { For, Show } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { useUsageFormat } from "@/usage/format"
import type { CurrentModel } from "@/usage/limits"
import { usageLevel, usageTokenTotal } from "@/usage/tokens"

const LEVEL_KEYS = {
  ok: "usage.context.healthy",
  warn: "usage.context.high",
  danger: "usage.context.nearLimit",
} as const

/**
 * Local usage for the open session. Console budgets need a signed-in workspace, but context and token spend are
 * always available from the session itself, so the composer pill never opens to an empty screen.
 */
export function SessionUsageDialog(props: {
  location: LocationRef
  model?: CurrentModel
  used: number
  limit: number
  percent: number
  tokens?: TokenUsageInfo
  sessionTokens?: TokenUsageInfo
  cost?: number
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const format = useUsageFormat()
  const rows = () => {
    const value = props.tokens

    if (!value) return []
    return [
      { label: language.t("usage.context.input"), value: value.input },
      { label: language.t("usage.context.cached"), value: value.cache.read + value.cache.write },
      { label: language.t("usage.context.output"), value: value.output },
      { label: language.t("usage.context.reasoning"), value: value.reasoning },
    ]
  }
  const level = () => usageLevel(props.percent)
  const openPlan = () => {
    dialog.close()
    void import("@/usage/dialog").then(({ DialogUsage }) =>
      dialog.show(() => <DialogUsage location={props.location} model={props.model} />),
    )
  }

  return (
    <Dialog fit containerClass="w-[min(calc(100vw-32px),448px)]!">
      <div data-component="session-usage-dialog" class="flex flex-col self-stretch">
        <DialogHeader>
          <DialogTitleGroup
            title={language.t("usage.context.title")}
            description={
              props.model
                ? language.t("usage.context.description", { model: props.model.name })
                : language.t("usage.context.descriptionFallback")
            }
          />
        </DialogHeader>
        <DialogBody>
          <div class="flex flex-col gap-4 px-4 pb-2">
            <div class="rounded-lg border-[0.5px] border-v2-border-border-base bg-v2-background-bg-base p-4">
              <div class="flex items-start justify-between gap-4">
                <div class="flex min-w-0 flex-col gap-1">
                  <span class="text-[32px] leading-text-compact font-[530] tracking-[-0.04px] text-v2-text-text-base tabular-nums">
                    {props.limit ? format.percent(props.percent) : "—"}
                  </span>
                  <span class="text-[13px] leading-text-compact font-[440] tracking-[-0.04px] text-v2-text-text-muted">
                    {props.limit
                      ? language.t("usage.context.usedOf", {
                          used: format.tokens(props.used),
                          limit: format.tokens(props.limit),
                        })
                      : language.t("usage.context.used", { used: format.tokens(props.used) })}
                  </span>
                </div>
                <span
                  class="shrink-0 rounded-[2px] px-1.5 py-0.5 text-[11px] leading-text-tight font-[530] tracking-[0.05px]"
                  classList={{
                    "bg-v2-state-bg-danger text-v2-state-fg-danger": level() === "danger",
                    "bg-v2-state-bg-warning text-v2-state-fg-warning": level() === "warn",
                    "bg-v2-background-bg-layer-03 text-v2-text-text-muted": level() === "ok",
                  }}
                >
                  {language.t(LEVEL_KEYS[level()])}
                </span>
              </div>
              <div class="mt-4 flex h-2 items-center overflow-hidden rounded-[2px] bg-v2-background-bg-layer-03">
                <div
                  class="h-2"
                  classList={{
                    "bg-v2-state-bg-danger": level() === "danger",
                    "bg-v2-state-bg-warning": level() === "warn",
                    "bg-v2-background-bg-inverse": level() === "ok",
                  }}
                  style={{ width: `${Math.max(0, Math.min(100, props.percent))}%` }}
                />
              </div>
            </div>

            <Show when={rows().length > 0}>
              <div class="grid grid-cols-2 gap-2">
                <For each={rows()}>
                  {(row) => (
                    <div class="flex flex-col gap-1 rounded-md bg-v2-background-bg-layer-02 px-3 py-2.5">
                      <span class="text-[11px] leading-text-tight font-[530] tracking-[0.05px] text-v2-text-text-muted">
                        {row.label}
                      </span>
                      <span class="text-[13px] leading-text-compact font-[530] tracking-[-0.04px] text-v2-text-text-base tabular-nums">
                        {format.tokens(row.value)}
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </Show>

            <div class="flex items-center justify-between gap-4 rounded-md bg-v2-background-bg-layer-02 px-3 py-2.5">
              <span class="text-[13px] leading-text-compact font-[440] tracking-[-0.04px] text-v2-text-text-muted">
                {language.t("usage.context.sessionTotal")}
              </span>
              <span class="text-[13px] leading-text-compact font-[530] tracking-[-0.04px] text-v2-text-text-base tabular-nums">
                {language.t("usage.context.tokensCost", {
                  tokens: format.tokens(usageTokenTotal(props.sessionTokens)),
                  cost: format.money(props.cost ?? 0),
                })}
              </span>
            </div>

            <Show when={!props.limit}>
              <p class="m-0 px-1 text-[12px] leading-text-compact font-[440] tracking-[-0.04px] text-v2-text-text-faint">
                {language.t("usage.context.noLimit")}
              </p>
            </Show>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="neutral" onClick={openPlan}>
            {language.t("usage.context.plan")}
          </Button>
        </DialogFooter>
      </div>
    </Dialog>
  )
}
