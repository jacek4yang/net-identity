/**
 * The only place in the UI/content code that touches the `browser` global.
 *
 * Everything returns a `Result` so callers cannot forget that a message may fail
 * (for example when the event page was terminated and could not be restarted).
 */
import { describeError, fail, ok, type Result } from "./result";

export async function request<T>(
  message: unknown,
  parse: (value: unknown) => Result<T>,
): Promise<Result<T>> {
  try {
    const response: unknown = await browser.runtime.sendMessage(message);
    return parse(response);
  } catch (error) {
    return fail(describeError(error, "The extension background script did not respond."));
  }
}

export async function sendToTab(tabId: number, message: unknown): Promise<Result<unknown>> {
  try {
    const response: unknown = await browser.tabs.sendMessage(tabId, message);
    return ok(response);
  } catch (error) {
    return fail(describeError(error, "No content script responded in that tab."));
  }
}

/**
 * A direct profile sends the user's own public IP to the GeoIP provider.
 * Firefox 140+ grants required location collection at install, but this
 * optional personal-data grant must be requested from a user gesture.
 * Returns false when the user declines or the consent API is missing.
 */
export async function ensureDirectIpConsent(proxyType: string): Promise<boolean> {
  if (proxyType !== "direct") return true;
  try {
    const current = await browser.permissions.getAll();
    const granted = current.data_collection;
    if (!Array.isArray(granted)) return false;
    if (granted.includes("personallyIdentifyingInfo")) return true;
    return await browser.permissions.request({
      data_collection: ["personallyIdentifyingInfo"],
    });
  } catch {
    return false;
  }
}

export function onRuntimeMessage(
  handler: (
    message: unknown,
    sender: browser.runtime.MessageSender,
  ) => Promise<unknown> | undefined,
): void {
  browser.runtime.onMessage.addListener(
    (message: unknown, sender: browser.runtime.MessageSender) => {
      return handler(message, sender);
    },
  );
}

export async function openOptionsPage(): Promise<void> {
  await browser.runtime.openOptionsPage();
}

export function runtimeId(): string {
  return browser.runtime.id;
}

export function extensionUrl(path: string): string {
  return browser.runtime.getURL(path);
}
