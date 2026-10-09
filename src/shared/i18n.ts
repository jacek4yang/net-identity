/** The packaged Firefox catalogs are the single source for automatic and manual UI locales. */
import en from "../../public/_locales/en/messages.json";
import zh from "../../public/_locales/zh_CN/messages.json";

export type LanguagePreference = "auto" | "en" | "zh_CN";
export type Locale = "en" | "zh_CN";
export type MessageKey = keyof typeof en;
let locale: Locale = "en";

export function parseLanguage(value: unknown): LanguagePreference {
  return value === "en" || value === "zh_CN" ? value : "auto";
}
export function resolveLocale(preference: LanguagePreference, browserLanguage: string): Locale {
  if (preference !== "auto") return preference;
  return /^zh(?:[-_](?:cn|sg|hans)(?:[-_]|$)|$)/i.test(browserLanguage) ? "zh_CN" : "en";
}
export function setUiLocale(value: Locale): void {
  locale = value;
}
export function message(key: MessageKey, selected: Locale = locale): string {
  return (selected === "zh_CN" ? zh[key] : en[key]).message;
}
// Transitional boundary for existing stable English diagnostics; never inspects DOM/user content.
const diagnosticKeys = new Map<string, MessageKey>(
  (Object.keys(en) as MessageKey[]).map((key) => [en[key].message, key]),
);
export function localizeKnownText(text: string): string {
  const key = diagnosticKeys.get(text);
  return key === undefined ? text : message(key);
}
export function translateDocument(root: Document): void {
  root.documentElement.lang = locale === "zh_CN" ? "zh-CN" : "en";
  for (const element of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = element.dataset.i18n;
    if (key && Object.hasOwn(en, key)) element.textContent = message(key as MessageKey);
  }
  for (const element of root.querySelectorAll<HTMLElement>("[data-i18n-placeholder]")) {
    const key = element.dataset.i18nPlaceholder;
    if (key && Object.hasOwn(en, key))
      element.setAttribute("placeholder", message(key as MessageKey));
  }
  for (const element of root.querySelectorAll<HTMLElement>("[data-i18n-aria]")) {
    const key = element.dataset.i18nAria;
    if (key && Object.hasOwn(en, key))
      element.setAttribute("aria-label", message(key as MessageKey));
  }
}
