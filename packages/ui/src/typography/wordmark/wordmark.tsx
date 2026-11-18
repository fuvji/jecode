import { type ComponentProps } from "solid-js"

// jetcode splash + hero wordmark. The old nine-glyph jetcode path set is
// gone; the brand is the same J-and-spark product name used everywhere else.
export function Wordmark(
  props: Pick<ComponentProps<"svg">, "class"> & { fade?: boolean; muted?: boolean; outline?: boolean },
) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 234 42"
      fill="none"
      classList={{
        [props.class ?? ""]: !!props.class,
        "overflow-visible [&_text]:[vector-effect:non-scaling-stroke]": props.outline,
      }}
    >
      <g opacity={props.muted === false ? 1 : 0.6} class="[[data-color-scheme=dark]_&]:opacity-100">
        <text
          x="0"
          y="34"
          fill={props.outline ? "none" : "currentColor"}
          stroke={props.outline ? "currentColor" : undefined}
          stroke-width={props.outline ? 0.6 : undefined}
          font-family="Inter, ui-sans-serif, system-ui, sans-serif"
          font-size="39"
          font-weight="700"
          letter-spacing="-2.4"
        >
          jetcode
        </text>
        <circle cx="151" cy="9" r="3.5" fill="currentColor" />
      </g>
    </svg>
  )
}
