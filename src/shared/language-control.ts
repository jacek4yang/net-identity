import { readUiLanguage, writeUiLanguage, browserUiLanguage } from "./runtime";
/** UI-only preference; never sends a route mutation or alters page timezone shims. */
import { message, parseLanguage, resolveLocale, setUiLocale, translateDocument } from "./i18n";

export async function bindLanguageControl(render: () => void): Promise<void> {
  const selected = document.querySelector<HTMLSelectElement>("#ui-language");
  const error = document.querySelector<HTMLElement>("#language-error");
  if (!selected || !error) return;
  const select = selected;
  let preference = "auto";
  try {
    preference = parseLanguage(await readUiLanguage());
  } catch {
    /* A language-storage failure must not block proxy controls. */
  }
  function apply(value: unknown): void {
    preference = parseLanguage(value);
    select.value = preference;
    setUiLocale(resolveLocale(parseLanguage(preference), browserUiLanguage()));
    translateDocument(document);
    render();
    document.dispatchEvent(new Event("ni:language-changed"));
  }
  apply(preference);
  select.addEventListener("change", () => {
    const next = parseLanguage(select.value);
    select.disabled = true;
    void writeUiLanguage(next)
      .then(() => {
        error.hidden = true;
        apply(next);
      })
      .catch(() => {
        select.value = preference;
        error.textContent = message("languageSaveFailed");
        error.hidden = false;
      })
      .finally(() => {
        select.disabled = false;
      });
  });
}
