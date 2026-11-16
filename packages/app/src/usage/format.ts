import { useLanguage } from "@/runtime/i18n/language"

/** Dollar amounts and reset times as the usage surfaces write them. */
export function useUsageFormat() {
  const language = useLanguage()
  return {
    /** `auto` drops the cents of a whole amount, the way limits are set. */
    money: (value: number, cents: "always" | "auto" = "always") =>
      new Intl.NumberFormat(language.intl(), {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: cents === "auto" && Number.isInteger(value) ? 0 : 2,
        maximumFractionDigits: 2,
      }).format(value),
    /** Compact token counts in the locale's number system. */
    tokens: (value: number) =>
      new Intl.NumberFormat(language.intl(), { notation: "compact", maximumFractionDigits: 1 }).format(value),
    /** A whole-number percentage; the value is 0-100, not a 0-1 ratio. */
    percent: (value: number) =>
      new Intl.NumberFormat(language.intl(), { style: "percent", maximumFractionDigits: 0 }).format(value / 100),
    time: (at: number) =>
      language.t("usage.time", {
        date: new Intl.DateTimeFormat(language.intl(), { month: "short", day: "numeric" }).format(at),
        time: new Intl.DateTimeFormat(language.intl(), { timeStyle: "short" }).format(at),
        zone:
          new Intl.DateTimeFormat(language.intl(), { timeZoneName: "shortOffset" })
            .formatToParts(at)
            .find((part) => part.type === "timeZoneName")?.value ?? "",
      }),
    /** A reset time where there is no room for its time zone. */
    shortTime: (at: number) =>
      new Intl.DateTimeFormat(language.intl(), {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }).format(at),
  }
}
