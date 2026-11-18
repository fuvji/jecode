import { createSignal, ErrorBoundary, onCleanup, onMount, Show } from "solid-js"
import { Portal } from "solid-js/web"

// jetcode ambient background layer. Rendered into <body> via a Portal so it
// can never affect the stacking / layout / clipping of vendor panels (file
// explorer, chat pane, dialogs). Behind everything with z-index: 0 +
// isolation: isolate — children can't escape this stacking context.
//
// The theme runtime writes `data-ollie-theme` on <html>. This layer reads
// that attribute (not the upstream `data-theme`, which the fork never sets)
// and falls back to aurora so the default window always has its backdrop.
//
// Aurora is the default kit: a clean, slow aurora field with a constellation
// graph drifting behind the panels. It is painted only for that kit; every
// other theme keeps its own surface treatment. Static kits render no
// decoration and no listeners, so they pay nothing.
//
// If a decoration throws during paint (exotic drivers / GPU memory pressure),
// the ErrorBoundary swallows it and the app keeps working without the layer.

const DEFAULT_KIT = "aurora"

const GRAPH_LINKS = [
  "M96 306 C196 282 242 214 352 232",
  "M352 232 C456 250 494 164 614 190",
  "M614 190 C732 158 804 236 924 202",
  "M924 202 C1036 172 1104 112 1224 152",
  "M1224 152 C1306 176 1342 224 1388 258",
  "M352 232 C388 282 420 314 496 336",
  "M614 190 C566 138 548 96 612 58",
  "M924 202 C950 264 998 294 1076 322",
  "M1224 152 C1196 102 1162 72 1116 44",
  "M188 356 C238 336 288 288 352 232",
  "M760 292 C826 264 868 232 924 202",
  "M462 118 C516 138 560 164 614 190",
  "M1076 322 C1136 286 1184 214 1224 152",
  "M96 306 C132 350 174 380 236 388",
  "M496 336 C574 354 646 350 760 292",
  "M1076 322 C1174 342 1268 334 1352 300",
  "M760 292 C742 226 724 174 708 124",
  "M708 124 C766 96 832 82 896 92",
  "M896 92 C960 102 1016 124 1076 162",
]

const GRAPH_NODES = [
  { x: 96, y: 306, r: 4.4 },
  { x: 352, y: 232, r: 6 },
  { x: 614, y: 190, r: 3.6 },
  { x: 924, y: 202, r: 5.2 },
  { x: 1224, y: 152, r: 4.2 },
  { x: 1388, y: 258, r: 3.2 },
  { x: 496, y: 336, r: 3.4 },
  { x: 612, y: 58, r: 3.8 },
  { x: 1076, y: 322, r: 4.6 },
  { x: 1116, y: 44, r: 3 },
  { x: 188, y: 356, r: 3.8 },
  { x: 760, y: 292, r: 5.4 },
  { x: 462, y: 118, r: 3.2 },
  { x: 236, y: 388, r: 2.8 },
  { x: 1352, y: 300, r: 3.4 },
  { x: 708, y: 124, r: 4.8 },
  { x: 896, y: 92, r: 3.4 },
  { x: 1076, y: 162, r: 3.2 },
  { x: 112, y: 200, r: 2.6 },
  { x: 824, y: 122, r: 2.8 },
  { x: 1290, y: 352, r: 2.6 },
]

const GRAPH_SPARKS = [
  { x: 286, y: 132 },
  { x: 678, y: 248 },
  { x: 1006, y: 116 },
  { x: 1140, y: 260 },
  { x: 528, y: 66 },
  { x: 970, y: 356 },
]

function readTheme(): string {
  if (typeof document === "undefined") return DEFAULT_KIT
  return document.documentElement.dataset.ollieTheme ?? DEFAULT_KIT
}

function JetcodeConstellation() {
  return (
    <svg
      class="jc-constellation"
      viewBox="0 0 1440 420"
      preserveAspectRatio="xMidYMax meet"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="jc-constellation-line" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stop-color="#67e8f9" stop-opacity="0" />
          <stop offset=".34" stop-color="#67e8f9" stop-opacity=".5" />
          <stop offset=".68" stop-color="#a78bfa" stop-opacity=".62" />
          <stop offset="1" stop-color="#f0abfc" stop-opacity="0" />
        </linearGradient>
        <radialGradient id="jc-constellation-node">
          <stop offset="0" stop-color="#ffffff" stop-opacity=".95" />
          <stop offset=".28" stop-color="#c4b5fd" stop-opacity=".9" />
          <stop offset="1" stop-color="#8b5cf6" stop-opacity="0" />
        </radialGradient>
        <filter id="jc-constellation-glow" x="-120%" y="-120%" width="340%" height="340%">
          <feGaussianBlur stdDeviation="7" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      <g class="jc-constellation-orbits" fill="none">
        <ellipse cx="720" cy="250" rx="560" ry="156" />
        <ellipse cx="720" cy="250" rx="400" ry="108" />
        <ellipse cx="720" cy="250" rx="250" ry="64" />
        <path d="M160 342 C420 140 1000 96 1300 260" />
      </g>

      <g class="jc-constellation-links" fill="none">
        {GRAPH_LINKS.map((path, index) => (
          <path d={path} class={index % 4 === 0 ? "jc-constellation-link is-accent" : "jc-constellation-link"} />
        ))}
      </g>

      <g class="jc-constellation-nodes" filter="url(#jc-constellation-glow)">
        {GRAPH_NODES.map((node, index) => (
          <circle
            cx={node.x}
            cy={node.y}
            r={node.r}
            class={index % 5 === 0 ? "jc-constellation-node is-cyan" : "jc-constellation-node"}
            style={{ "animation-delay": `${(index % 7) * -1.1}s` }}
          />
        ))}
      </g>

      <g class="jc-constellation-sparks">
        {GRAPH_SPARKS.map((spark, index) => (
          <path
            d={`M${spark.x - 7} ${spark.y}H${spark.x + 7}M${spark.x} ${spark.y - 7}V${spark.y + 7}`}
            style={{ "animation-delay": `${(index % 5) * -1.4}s` }}
          />
        ))}
      </g>
    </svg>
  )
}

export function JetcodeFxAmbient() {
  const [theme, setTheme] = createSignal<string>(readTheme())

  onMount(() => {
    const html = document.documentElement
    setTheme(readTheme())
    const obs = new MutationObserver(() => {
      const next = readTheme()
      if (next !== theme()) setTheme(next)
    })
    obs.observe(html, { attributes: true, attributeFilter: ["data-ollie-theme"] })
    onCleanup(() => obs.disconnect())
  })

  return (
    <ErrorBoundary fallback={<></>}>
      <Portal mount={document.body}>
        <div
          class="olliE-ambient pointer-events-none fixed inset-0 overflow-hidden"
          style={{ "z-index": "-1", isolation: "isolate" }}
          aria-hidden="true"
        >
          <Show when={theme() === "aurora"}>
            <div class="olliE-aurora olliE-aurora-a" />
            <div class="olliE-aurora olliE-aurora-b" />
            <div class="olliE-aurora olliE-aurora-c" />
            <div class="olliE-aurora-glow" />
            <JetcodeConstellation />
          </Show>
          <Show when={theme() === "frost"}>
            <div class="olliE-orb olliE-orb-a" />
            <div class="olliE-orb olliE-orb-b" />
            <div class="olliE-orb olliE-orb-c" />
          </Show>
          <Show when={theme() === "porcelain"}>
            <div class="olliE-blob olliE-blob-a" />
            <div class="olliE-blob olliE-blob-b" />
            <div class="olliE-blob olliE-blob-c" />
          </Show>
          <Show when={theme() === "prism"}>
            <div class="olliE-aura olliE-aura-a" />
            <div class="olliE-aura olliE-aura-b" />
          </Show>
          <Show when={theme() === "vapor"}>
            <div class="olliE-sky" />
          </Show>
          <Show when={theme() === "obsidian"}>
            <div class="olliE-grain" />
          </Show>
        </div>
      </Portal>
    </ErrorBoundary>
  )
}
