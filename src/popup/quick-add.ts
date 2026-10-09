import { bindDraftCheck } from "../shared/draft-check";
import { localizeKnownText as lt, message } from "../shared/i18n";
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
  const draftCheck = bindDraftCheck({
    fields: [protocol, host, port, username, password],
    status: requireElement<HTMLElement>("#quick-draft-status"),
    retry: requireElement<HTMLButtonElement>("#quick-draft-retry"),
    read: () => {
      if (
        panel.hidden ||
        pending ||
        !["http", "https", "socks4", "socks5"].includes(protocol.value)
      )
        return null;
      const endpoint = parseQuickEndpoint(host.value, port.value, protocol.value as QuickProxyType);
      if (!endpoint.ok) return null;
      const credentials =
        username.value !== "" || password.value !== ""
          ? parseCredentials({ username: username.value, password: password.value })
          : null;
      if (credentials && (!credentials.ok || endpoint.value.type === "socks4")) return null;
      return {
        proxy: { ...endpoint.value, proxyDNS: true, bypassHosts: [] },
        ...(credentials?.ok ? { credentials: credentials.value } : {}),
      };
    },
  });
  let lastStatus: readonly string[] = [];
  function show(text: string | readonly string[]): void {
    lastStatus = typeof text === "string" ? [text] : [...text];
    status.textContent = lastStatus.map(lt).join(" ");
  }
  document.addEventListener("ni:language-changed", () => {
    status.textContent = lastStatus.map(lt).join(" ");
    toggle.textContent = message(panel.hidden ? "addProxy" : "backToRoutes");
  });
  let pending = false;
  // Reuse an id after a partial write/transport error rather than creating duplicates on retry.
  let draftId: string | undefined;
  toggle.addEventListener("click", () => {
    if (pending) return;
    draftCheck.cancel();
    panel.hidden = !panel.hidden;
    document.body.dataset.view = panel.hidden ? "routes" : "add";
    toggle.dataset.i18n = panel.hidden ? "addProxy" : "backToRoutes";
    toggle.textContent = message(panel.hidden ? "addProxy" : "backToRoutes");
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
    if (!panel.hidden) host.focus();
    else {
      username.value = "";
      password.value = "";
      toggle.focus();
    }
  });
  async function submit(activate: boolean): Promise<void> {
    if (pending) return;
    const selected = protocol.value;
    if (!["http", "https", "socks4", "socks5"].includes(selected)) return;
    const endpoint = parseQuickEndpoint(host.value, port.value, selected as QuickProxyType);
    if (!endpoint.ok) {
      show(endpoint.errors);
      return;
    }
    const credentials =
      username.value !== "" || password.value !== ""
        ? parseCredentials({ username: username.value, password: password.value })
        : undefined;
    if (credentials && !credentials.ok) {
      show(credentials.errors);
      return;
    }
    if (credentials && endpoint.value.type === "socks4") {
      show("SOCKS4 cannot authenticate. Choose SOCKS5, HTTP or HTTPS.");
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
      show(profile.errors);
      return;
    }
    protocol.value = endpoint.value.type;
    host.value = endpoint.value.host.includes(":")
      ? `[${endpoint.value.host}]`
      : endpoint.value.host;
    port.value = String(endpoint.value.port);
    draftCheck.cancel();
    pending = true;
    fields.disabled = true;
    toggle.disabled = true;
    deps.busy(true);
    show("Saving profile…");
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
        show(response.ok ? response.value.errors : response.errors);
        return;
      }
      const id = draftId;
      draftId = undefined;
      form.reset();
      username.value = "";
      password.value = "";
      await deps.reload();
      show("Saved. Saving does not verify connectivity or change the active route.");
      if (activate) {
        show("Saved. Applying route; identity lookup may finish separately…");
        await deps.activate(id);
        show("Saved. See the current route and identity status for the activation result.");
      }
    } catch {
      // Do not expose exception text: a browser/transport error might contain pasted credentials.
      show("Could not confirm the operation. Check the profile list and retry.");
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
