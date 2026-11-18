import { Show, createMemo } from "solid-js"
import { modelValue, type ValueModel } from "./value"

const bars = (value: ReturnType<typeof modelValue>) => [
  { label: "quality", value: value.quality },
  { label: "context", value: value.context },
  { label: "cost", value: value.affordability },
  { label: "speed", value: value.speed },
]

export function ModelValueTag(props: { model: ValueModel; best?: boolean; compact?: boolean }) {
  const value = createMemo(() => modelValue(props.model))

  return (
    <span
      class="inline-flex shrink-0 items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-v2-text-text-muted"
      title={`Model value ${value().score}/100 (${value().grade})
quality ${value().quality} · context ${value().context} · cost ${value().affordability} · speed ${value().speed}`}
      aria-label={`Model value ${value().score} out of 100`}
    >
      <Show when={props.best}>
        <span class="rounded-[3px] bg-v2-text-text-base px-1 py-0.5 text-[9px] font-semibold text-text-invert-base">
          best
        </span>
      </Show>
      <span class="font-semibold text-v2-text-text-base">{value().grade}</span>
      <span class="flex h-2 items-end gap-[1px]" aria-hidden="true">
        {bars(value()).map((bar) => (
          <span
            class="w-[2px] rounded-[1px] bg-v2-text-text-muted"
            style={{ height: `${Math.max(2, Math.round((bar.value / 100) * 8))}px`, opacity: 0.45 + bar.value / 180 }}
          />
        ))}
      </span>
      <span>{value().score}</span>
    </span>
  )
}

export function ModelValueChart(props: { model: ValueModel }) {
  const value = createMemo(() => modelValue(props.model))

  return (
    <div class="flex w-full flex-col gap-1.5 border-t border-v2-border-border-muted pt-2">
      <div class="flex items-center justify-between gap-3">
        <span class="text-v2-text-text-muted">Value</span>
        <span class="font-semibold text-v2-text-text-base">
          {value().score}/100 <span class="text-v2-text-text-muted">({value().grade})</span>
        </span>
      </div>
      <div class="flex flex-col gap-1">
        {bars(value()).map((bar) => (
          <div class="flex items-center gap-2">
            <span class="w-12 text-[10px] capitalize text-v2-text-text-muted">{bar.label}</span>
            <span class="h-1.5 flex-1 overflow-hidden rounded-full bg-v2-overlay-simple-overlay-hover">
              <span
                class="block h-full rounded-full bg-v2-text-text-base"
                style={{ width: `${bar.value}%`, opacity: 0.45 + bar.value / 180 }}
              />
            </span>
            <span class="w-6 text-right text-[10px] tabular-nums text-v2-text-text-muted">{bar.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
