/** Compact editor using the existing validated save and explicit activation commands. */
import { parseQuickEndpoint, quickProxyProfile, type QuickProxyType } from "../profile/quick-proxy";
import { createProfileId } from "../profile/store";
import type { IdentityProfile } from "../profile/schema";
import { parseCredentials } from "../profile/validation";
import { requireElement } from "../shared/dom";
import { parseMutationResponse } from "../shared/messages";
import { request } from "../shared/runtime";

export function bindQuickAdd(deps: {
  profiles: () => readonly IdentityProfile[];
  reload: () => Promise<unknown>;
  activate: (id: string) => Promise<void>;
  busy: (value: boolean) => void;
}): void {
  const toggle = requireElement<HTMLButtonElement>("#quick-add-toggle");
  const panel = requireElement<HTMLElement>("#quick-add-panel");
  const form = requireElement<HTMLFormElement>("#quick-add-form");
  const fields = requireElement<HTMLFieldSetElement>("#quick-add-fields");
  const protocol = requireElement<HTMLSelectElement>("#quick-protocol");
  const host = requireElement<HTMLInputElement>("#quick-host");
  const port = requireElement<HTMLInputElement>("#quick-port");
  const name = requireElement<HTMLInputElement>("#quick-name");
  const username = requireElement<HTMLInputElement>("#quick-username");
  const password = requireElement<HTMLInputElement>("#quick-password");
  const status = requireElement<HTMLElement>("#quick-status");
  let pending = false;
  // Reuse an id after a partial write/transport error rather than creating duplicates on retry.
  let draftId: string | undefined;
  toggle.addEventListener("click", () => {
    if (pending) return;
    panel.hidden = !panel.hidden;
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
    if (!panel.hidden) host.focus();
    else {
      username.value = "";
      password.value = "";
    }
  });
  async function submit(activate: boolean): Promise<void> {
    if (pending) return;
    const selected = protocol.value;
    if (!["http", "https", "socks4", "socks5"].includes(selected)) return;
    const endpoint = parseQuickEndpoint(host.value, port.value, selected as QuickProxyType);
    if (!endpoint.ok) {
      status.textContent = endpoint.errors.join(" ");
      return;
    }
    const credentials =
      username.value !== "" || password.value !== ""
        ? parseCredentials({ username: username.value, password: password.value })
        : undefined;
    if (credentials && !credentials.ok) {
      status.textContent = credentials.errors.join(" ");
      return;
    }
    if (credentials && endpoint.value.type === "socks4") {
      status.textContent = "SOCKS4 cannot authenticate. Choose SOCKS5, HTTP or HTTPS.";
      return;
    }
    draftId ??= createProfileId();
    const profile = quickProxyProfile(
      endpoint.value,
      name.value,
      draftId,
      deps.profiles().filter((item) => item.id !== draftId),
    );
    if (!profile.ok) {
      status.textContent = profile.errors.join(" ");
      return;
    }
    protocol.value = endpoint.value.type;
    host.value = endpoint.value.host.includes(":")
      ? `[${endpoint.value.host}]`
      : endpoint.value.host;
    port.value = String(endpoint.value.port);
    pending = true;
    fields.disabled = true;
    toggle.disabled = true;
    deps.busy(true);
    status.textContent = "Saving profile…";
    try {
      const response = await request(
        {
          type: "profiles:save",
          profile: profile.value,
          ...(credentials?.ok ? { credentials: credentials.value } : {}),
        },
        parseMutationResponse,
      );
      if (!response.ok || !response.value.ok) {
        status.textContent = response.ok
          ? response.value.errors.join(" ")
          : response.errors.join(" ");
        return;
      }
      const id = draftId;
      draftId = undefined;
      form.reset();
      username.value = "";
      password.value = "";
      await deps.reload();
      status.textContent = "Saved. Saving does not verify connectivity or change the active route.";
      if (activate) {
        status.textContent = "Saved. Applying route; identity lookup may finish separately…";
        await deps.activate(id);
        status.textContent =
          "Saved. See the current route and identity status for the activation result.";
      }
    } catch {
      // Do not expose exception text: a browser/transport error might contain pasted credentials.
      status.textContent = "Could not confirm the operation. Check the profile list and retry.";
    } finally {
      pending = false;
      fields.disabled = false;
      toggle.disabled = false;
      deps.busy(false);
    }
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submit(event.submitter?.id === "quick-save-activate");
  });
}
