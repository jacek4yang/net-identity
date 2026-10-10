/** Debounced editor-local preview. Editing, navigation and cancellation invalidate late replies. */
import type { GeoIpResult } from "../geo/provider";
import { parseDraftResponse, type DraftInput, type DraftResponse } from "./draft-probe";
import { message, type MessageKey } from "./i18n";
import { request } from "./runtime";

export type DraftCheckState = "idle" | "waiting" | "checking" | "success" | "error";
export class DraftCheck {
  private revision = 0;
  private settled = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly deps: {
      send: (type: "draft:probe" | "draft:cancel", input?: DraftInput) => Promise<DraftResponse>;
      render: (state: DraftCheckState, result?: DraftResponse) => void;
    },
  ) {}
  cancel(preserveResult = false): void {
    this.revision++;
    clearTimeout(this.timer);
    this.timer = undefined;
    void this.deps.send("draft:cancel").catch(() => {});
    if (!preserveResult || !this.settled) {
      this.settled = false;
      this.deps.render("idle");
    }
  }
  schedule(input: DraftInput | null, delay = 700): void {
    this.cancel();
    if (input === null) return;
    const revision = this.revision;
    this.deps.render("waiting");
    this.timer = setTimeout(() => {
      void this.run(revision, input);
    }, delay);
  }
  private async run(revision: number, input: DraftInput): Promise<void> {
    this.deps.render("checking");
    let result: DraftResponse;
    try {
      result = await this.deps.send("draft:probe", input);
    } catch {
      result = { ok: false, error: "network" };
    }
    if (revision !== this.revision) return;
    this.settled = true;
    this.deps.render(result.ok ? "success" : "error", result);
  }
}

export function bindDraftCheck(deps: {
  fields: readonly HTMLElement[];
  status: HTMLElement;
  retry: HTMLButtonElement;
  read: () => DraftInput | null;
  disabled?: () => boolean;
  resolved?: (identity: GeoIpResult) => void;
  invalidated?: () => void;
}): DraftCheck & { refresh: () => void } {
  const owner = crypto.randomUUID();
  let current: { state: DraftCheckState; result?: DraftResponse } = { state: "idle" };
  function render(): void {
    deps.status.dataset.state = current.state;
    const keys: Record<DraftCheckState, MessageKey> = {
      idle: "draftIdle",
      waiting: "draftWaiting",
      checking: "draftChecking",
      success: "draftSuccess",
      error: "draftNetwork",
    };
    const disabled = deps.disabled?.() === true;
    const idleKey = disabled
      ? "draftDisabled"
      : deps.read() === null
        ? "draftIdle"
        : "draftUnchecked";
    let text = message(current.state === "idle" ? idleKey : keys[current.state]);
    const result = current.result;
    if (
      result?.ok &&
      (result.identity.latitude === undefined || result.identity.timezone === undefined)
    )
      text = message("draftPartial");
    if (result?.ok)
      text += ` ${[result.identity.ip, result.identity.city, result.identity.timezone].filter(Boolean).join(" · ")}`;
    else if (result) {
      const errors: Record<typeof result.error, MessageKey> = {
        invalid: "draftIdle",
        credentials: "draftCredentials",
        consent: "draftConsent",
        busy: "draftBusy",
        cancelled: "draftCancelled",
        timeout: "draftTimeout",
        network: "draftNetwork",
        provider: "draftProvider",
      };
      text = message(errors[result.error]);
    }
    deps.status.textContent = text;
    deps.retry.disabled = disabled || current.state === "checking" || current.state === "waiting";
  }
  const check = new DraftCheck({
    send: async (type, input) => {
      const result = await request(
        { type, owner, ...(input ? { input } : {}) },
        parseDraftResponse,
      );
      return result.ok ? result.value : { ok: false, error: "network" };
    },
    render: (state, result) => {
      current = { state, ...(result ? { result } : {}) };
      if (state === "idle") deps.invalidated?.();
      if (result?.ok) deps.resolved?.(result.identity);
      render();
    },
  });
  const read = () => (deps.disabled?.() === true ? null : deps.read());
  const schedule = () => check.schedule(read());
  for (const field of deps.fields) field.addEventListener("input", schedule);
  deps.retry.addEventListener("click", () => check.schedule(read(), 0));
  window.addEventListener("pagehide", () => check.cancel());
  document.addEventListener("ni:language-changed", render);
  render();
  return Object.assign(check, { refresh: render });
}
