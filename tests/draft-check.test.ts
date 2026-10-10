import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bindDraftCheck } from "../src/shared/draft-check";
import type { DraftInput } from "../src/shared/draft-probe";
import { message, setUiLocale } from "../src/shared/i18n";

const input: DraftInput = {
  proxy: { type: "socks5", host: "127.0.0.1", port: 9999, proxyDNS: true, bypassHosts: [] },
};
const send = vi
  .fn<(request: { type: string }) => Promise<unknown>>()
  .mockResolvedValue({ ok: false, error: "cancelled" });
function harness() {
  const field = new EventTarget() as HTMLElement;
  const status = Object.assign(new EventTarget(), { dataset: {}, textContent: "" }) as HTMLElement;
  const retry = Object.assign(new EventTarget(), { disabled: false }) as HTMLButtonElement;
  let value: DraftInput | null = null;
  let disabled = false;
  const check = bindDraftCheck({
    fields: [field],
    status,
    retry,
    read: () => value,
    disabled: () => disabled,
  });
  return {
    field,
    status,
    retry,
    check,
    setInput: (next: DraftInput | null) => {
      value = next;
    },
    setDisabled: (next: boolean) => {
      disabled = next;
    },
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  send.mockClear();
  setUiLocale("en");
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("document", new EventTarget());
  vi.stubGlobal("browser", { runtime: { sendMessage: send } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setUiLocale("en");
});

describe("draft status presentation", () => {
  it("distinguishes an empty editor from a loaded valid endpoint without probing", () => {
    const h = harness();
    expect(h.status.textContent).toBe(message("draftIdle"));
    h.setInput(input);
    h.check.refresh();
    expect(h.status.textContent).toBe(message("draftUnchecked"));
    expect(h.retry.disabled).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
  it("shows disabled policy after profile load and language changes without probing", async () => {
    const h = harness();
    h.setInput(input);
    h.setDisabled(true);
    h.check.refresh();
    expect(h.status.textContent).toBe(message("draftDisabled"));
    expect(h.retry.disabled).toBe(true);
    setUiLocale("zh_CN");
    document.dispatchEvent(new Event("ni:language-changed"));
    expect(h.status.textContent).toBe(message("draftDisabled"));
    h.field.dispatchEvent(new Event("input"));
    h.retry.dispatchEvent(new Event("click"));
    await vi.runAllTimersAsync();
    expect(send.mock.calls.every(([request]) => request.type === "draft:cancel")).toBe(true);
  });
  it("cancels a pending preview on disabling and permits explicit retry after re-enabling", async () => {
    const h = harness();
    h.setInput(input);
    h.field.dispatchEvent(new Event("input"));
    expect(h.status.dataset.state).toBe("waiting");
    h.setDisabled(true);
    h.field.dispatchEvent(new Event("input"));
    await vi.runAllTimersAsync();
    expect(h.status.textContent).toBe(message("draftDisabled"));
    expect(send.mock.calls.every(([request]) => request.type === "draft:cancel")).toBe(true);
    h.setDisabled(false);
    h.check.refresh();
    expect(h.status.textContent).toBe(message("draftUnchecked"));
    h.retry.dispatchEvent(new Event("click"));
    await vi.runAllTimersAsync();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "draft:probe", input }));
  });
});
