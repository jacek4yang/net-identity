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
