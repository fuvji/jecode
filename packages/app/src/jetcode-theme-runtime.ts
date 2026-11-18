import { DEFAULT_THEME, KITS, palette, STORAGE_KEY, themeKit } from "./jetcode-themes"
type ThemeBridge = { themeGet?: () => Promise<string | null>; themeSet?: (id: string) => Promise<{ ok: boolean }> }
function bridge() {
  return (window as unknown as { electron?: { jetcode?: ThemeBridge } }).electron?.jetcode
}
export function readTheme() {
  if (typeof window === "undefined") return DEFAULT_THEME
  try {
    return themeKit(window.localStorage.getItem(STORAGE_KEY)).id
  } catch {
    return DEFAULT_THEME
  }
}
let writes: Promise<unknown> = Promise.resolve()
export function applyTheme(id: string, persist = true) {
  if (typeof document === "undefined") return
  const kit = themeKit(id)
  const root = document.documentElement
  root.dataset.ollieTheme = kit.id
  root.dataset.ollieAppearance = kit.family
  root.style.colorScheme = kit.family
  root.removeAttribute("data-fx")
  Object.entries(palette(kit)).forEach(([key, value]) => root.style.setProperty(`--kit-${key}`, value))
  if (persist) {
    try {
      window.localStorage.setItem(STORAGE_KEY, kit.id)
    } catch {
      /* IPC can still save the preference. */
    }
    // Serial writes ensure rapid selections finish in selection order.
    writes = writes.then(() => bridge()?.themeSet?.(kit.id)).catch(() => undefined)
  }
  window.dispatchEvent(new CustomEvent("jetcode:theme-changed", { detail: kit.id }))
}
// HMR guard. Vite + React Fast Refresh re-executes this module on every edit
// in dev, and without a sentinel the module-level `storage` listener stacks —
// N edits land N listeners, so one cross-tab event runs applyTheme N times.
// A window-scoped boolean makes the side-effect block idempotent across
// re-executions. Prod build runs it exactly once anyway.
if (typeof document !== "undefined" && !(window as { __ollieThemeRuntimeInstalled?: boolean }).__ollieThemeRuntimeInstalled) {
  (window as { __ollieThemeRuntimeInstalled?: boolean }).__ollieThemeRuntimeInstalled = true
  applyTheme(readTheme(), false)
  // A delayed startup read must never overwrite a user's newer selection.
  let chosen = false
  const onChoice = () => {
    chosen = true
  }
  window.addEventListener("jetcode:theme-changed", onChoice)
  Promise.resolve(bridge()?.themeGet?.())
    .then((id) => {
      if (!chosen && id && KITS.some((kit) => kit.id === id)) {
        applyTheme(id, false)
        try {
          window.localStorage.setItem(STORAGE_KEY, id)
        } catch {
          /* Storage is optional. */
        }
      }
    })
    .catch(() => undefined)
    .finally(() => window.removeEventListener("jetcode:theme-changed", onChoice))
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) applyTheme(themeKit(event.newValue).id, false)
  })
}
