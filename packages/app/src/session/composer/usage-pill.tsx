import { lastAssistantWithUsage } from "@opencode/client/solid"
import { useDialog } from "@opencode/ui/context/dialog"
import { createMemo } from "solid-js"
import type { ModelSelection } from "@/providers/models/selection"
import { useLanguage } from "@/runtime/i18n/language"
import { useUsageFormat } from "@/usage/format"
import { usageLevel, usagePercent, usageTokenTotal } from "@/usage/tokens"
import { useWorkspaceLocation } from "@/workspaces/location"
import type { SessionModel } from "../model"
import "./usage-pill.css"

const RADIUS = 5.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/**
 * The session's context use in the composer lane: the tokens held by the latest assistant step over the selected
 * model's context window. Clicking opens the session's local usage dialog, with plan budgets one step further.
 */
export function SessionUsagePill(props: {
  session: SessionModel
  selection: () => ModelSelection | undefined
}) {
  const language = useLanguage()
  const format = useUsageFormat()
  const dialog = useDialog()
  const location = useWorkspaceLocation()
  const model = createMemo(() => props.selection()?.current())
  const latest = createMemo(() =>
    lastAssistantWithUsage(props.session.history.messages(), props.session.data.revertMessageID()),
  )
  const used = createMemo(() => usageTokenTotal(latest()?.tokens))
  const limit = createMemo(() => model()?.limit.context ?? 0)
  const percent = createMemo(() => usagePercent(used(), limit()))
  const info = createMemo(() => props.session.data.info())
  const level = createMemo(() => usageLevel(percent()))
  const title = createMemo(() =>
    limit()
      ? language.t("usage.context.openWithLimit", {
          used: format.tokens(used()),
          limit: format.tokens(limit()),
          percent: format.percent(percent()),
        })
      : language.t("usage.context.open"),
  )
  const label = createMemo(() =>
    limit()
      ? language.t("usage.context.openLabel", { percent: format.percent(percent()) })
      : language.t("usage.context.openLabelNoLimit"),
  )
  const open = () => {
    const current = model()
    void import("./usage-dialog").then(({ SessionUsageDialog }) =>
      dialog.show(() => (
        <SessionUsageDialog
          location={location().ref}
          model={
            current
              ? { providerID: current.provider.id, modelID: current.id, name: current.name }
              : undefined
          }
          used={used()}
          limit={limit()}
          percent={percent()}
          tokens={latest()?.tokens}
          sessionTokens={info()?.tokens}
          cost={info()?.cost}
        />
      )),
    )
  }

  return (
    <button
      type="button"
      data-slot="session-usage-pill"
      data-composer-pill
      data-level={level()}
      aria-label={label()}
      title={title()}
      onClick={open}
    >
      <svg data-slot="session-usage-ring" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <circle cx="8" cy="8" r={RADIUS} fill="none" stroke="var(--v2-border-border-muted)" stroke-width="2" />
        <circle
          cx="8"
          cy="8"
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-dasharray={String(CIRCUMFERENCE)}
          stroke-dashoffset={String(CIRCUMFERENCE - (CIRCUMFERENCE * percent()) / 100)}
          transform="rotate(-90 8 8)"
        />
      </svg>
      <span data-slot="session-usage-value" class="tabular-nums">
        {limit() ? format.percent(percent()) : language.t("usage.context.value")}
      </span>
      {limit() ? <span data-slot="session-usage-unit">{language.t("usage.context.unit")}</span> : null}
    </button>
  )
}
