import { type ComponentProps } from "solid-js"

// jetcode brand marks. The J-and-spark geometry is shared with the desktop
// icon so the splash, sidebar, and installed application all carry one mark.

const JMark = () => (
  <>
    <defs>
      <linearGradient id="jetcode-mark-gradient" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#22D3EE" />
        <stop offset=".42" stop-color="#4F8CFF" />
        <stop offset=".72" stop-color="#8B5CF6" />
        <stop offset="1" stop-color="#D946EF" />
      </linearGradient>
    </defs>
    <path
      d="M300 300H690C735 300 760 330 760 378V600C760 738 668 812 540 812C442 812 366 756 334 672"
      fill="none"
      stroke="url(#jetcode-mark-gradient)"
      stroke-width="148"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <path
      d="M828 150L845 195L890 212L845 229L828 274L811 229L766 212L811 195Z"
      fill="url(#jetcode-mark-gradient)"
      stroke="#fff"
      stroke-opacity=".43"
      stroke-width="10"
      stroke-linejoin="round"
    />
  </>
)

export const Mark = (props: { class?: string }) => (
  <svg
    data-component="logo-mark"
    classList={{ [props.class ?? ""]: !!props.class }}
    viewBox="0 0 1024 1024"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <JMark />
  </svg>
)

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => (
  <svg
    ref={props.ref}
    data-component="logo-splash"
    classList={{ [props.class ?? ""]: !!props.class }}
    viewBox="0 0 1024 1024"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <JMark />
  </svg>
)

export const Logo = (props: { class?: string }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 234 42"
    fill="none"
    classList={{ [props.class ?? ""]: !!props.class }}
  >
    <text
      x="0"
      y="33"
      font-family="Inter, ui-sans-serif, system-ui, sans-serif"
      font-size="38"
      font-weight="700"
      letter-spacing="-2.2"
    >
      <tspan fill="var(--icon-base)">jet</tspan>
      <tspan fill="var(--icon-strong-base)">code</tspan>
    </text>
    <circle cx="151" cy="9" r="3.5" fill="var(--icon-strong-base)" />
  </svg>
)
