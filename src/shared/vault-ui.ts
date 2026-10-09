/** Compact shared vault controls. Passwords stay in trusted extension UI messages. */
import { el } from "./dom";
import { message, type MessageKey } from "./i18n";
import { request } from "./runtime";
import { MAX_VAULT_BYTES } from "../vault/crypto";
import { parseVaultResponse, type VaultResponse } from "../vault/messages";

function downloadBackup(text: string, previous: boolean): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = el("a", {
    attrs: { href: url, download: `net-identity-encrypted${previous ? "-previous" : ""}.json` },
  });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export async function bindVaultControls(): Promise<boolean> {
  const main = document.querySelector<HTMLElement>("main");
  const panel = el("details", { className: "vault-panel", id: "vault-panel" });
  const summary = el("summary");
  const description = el("p", { className: "hint" });
  const form = el("form", { id: "vault-form" });
  const password = el("input", {
    type: "password",
    id: "vault-password",
    attrs: {
      autocomplete: "current-password",
      maxlength: "1024",
      required: "",
      "aria-label": message("vaultPassword"),
    },
  });
  const confirm = el("input", {
    type: "password",
    id: "vault-confirm",
    attrs: {
      autocomplete: "new-password",
      maxlength: "1024",
      "aria-label": message("vaultConfirm"),
    },
  });
  const submit = el("button", { type: "submit", id: "vault-submit" });
  const error = el("p", {
    id: "vault-error",
    attrs: { role: "status", "aria-live": "polite" },
    hidden: true,
  });
  const exportButton = el("button", { type: "button", id: "vault-export" });
  const previousButton = el("button", { type: "button", id: "vault-export-previous" });
  const restore = el("details");
  const restoreSummary = el("summary");
  const restoreHint = el("p", { className: "hint" });
  const file = el("input", {
    type: "file",
    id: "vault-file",
    attrs: { accept: ".json,application/json", "aria-label": message("vaultRestore") },
  });
  const restoreButton = el("button", { type: "button", id: "vault-restore" });
  restore.append(restoreSummary, restoreHint, file, restoreButton);
  form.append(password, confirm, submit);
  panel.append(summary, description, form, exportButton, previousButton, restore, error);
  main?.before(panel);
  let state: VaultResponse = { ok: false, status: "damaged" };
  let busy = false;
  function render(): void {
    const labels: Record<VaultResponse["status"], MessageKey> = {
      unencrypted: "vaultSetupTitle",
      locked: "vaultLockedTitle",
      unlocked: "vaultUnlockedTitle",
      damaged: "vaultDamagedTitle",
    };
    summary.textContent = message(labels[state.status]);
    description.textContent = message(
      state.status === "unencrypted"
        ? "vaultSetupHint"
        : state.status === "unlocked"
          ? "vaultUnlockedHint"
          : "vaultLockedHint",
    );
    password.placeholder = message("vaultPassword");
    confirm.placeholder = message("vaultConfirm");
    password.setAttribute("aria-label", message("vaultPassword"));
    confirm.setAttribute("aria-label", message("vaultConfirm"));
    submit.textContent = message(state.status === "unencrypted" ? "vaultEnable" : "vaultUnlock");
    form.hidden = state.status === "unlocked" || state.status === "damaged";
    confirm.hidden = state.status !== "unencrypted";
    confirm.required = state.status === "unencrypted";
    password.autocomplete = state.status === "unencrypted" ? "new-password" : "current-password";
    exportButton.textContent = message("vaultExport");
    previousButton.textContent = message("vaultExportPrevious");
    exportButton.hidden = previousButton.hidden = state.status === "unencrypted";
    restore.hidden = state.status !== "unencrypted";
    restoreSummary.textContent = restoreButton.textContent = message("vaultRestore");
    restoreHint.textContent = message("vaultRestoreHint");
    const locked = state.status === "locked" || state.status === "damaged";
    if (main) {
      main.inert = busy || locked;
      main.hidden = locked;
    }
    if (locked) panel.open = true;
    for (const input of panel.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
      "input,button",
    ))
      input.disabled = busy;
  }
  async function operation(payload: unknown): Promise<VaultResponse | null> {
    if (busy) return null;
    busy = true;
    error.hidden = true;
    render();
    try {
      const response = await request(payload, parseVaultResponse);
      if (!response.ok || !response.value.ok) {
        if (response.ok) state = response.value;
        error.textContent = message("vaultOperationFailed");
        error.hidden = false;
        return null;
      }
      state = response.value;
      return state;
    } finally {
      busy = false;
      password.value = "";
      confirm.value = "";
      render();
    }
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy) return;
    if (state.status === "unencrypted" && password.value !== confirm.value) {
      error.textContent = message("vaultMismatch");
      error.hidden = false;
      return;
    }
    const type = state.status === "unencrypted" ? "vault:setup" : "vault:unlock";
    void operation({ type, password: password.value }).then((result) => {
      if (result) location.reload();
    });
  });
  for (const [button, previous] of [
    [exportButton, false],
    [previousButton, true],
  ] as const) {
    button.addEventListener("click", () => {
      void operation({ type: "vault:backup", previous }).then((result) => {
        if (result?.backup) downloadBackup(result.backup, previous);
      });
    });
  }
  restoreButton.addEventListener("click", () => {
    if (busy) return;
    const selected = file.files?.[0];
    if (!selected || selected.size > MAX_VAULT_BYTES * 2 || !password.value) {
      error.textContent = message("vaultOperationFailed");
      error.hidden = false;
      return;
    }
    const passphrase = password.value;
    // Capture once; later edits cannot pair a different password/file with this action.
    busy = true;
    render();
    void selected
      .text()
      .then(async (backup) => {
        busy = false;
        const result = await operation({ type: "vault:restore", backup, password: passphrase });
        if (result) location.reload();
      })
      .catch(() => {
        busy = false;
        password.value = "";
        error.textContent = message("vaultOperationFailed");
        error.hidden = false;
        render();
      });
  });
  document.addEventListener("ni:language-changed", render);
  const initial = await request({ type: "vault:get" }, parseVaultResponse);
  if (initial.ok) state = initial.value;
  render();
  return state.status === "unencrypted" || state.status === "unlocked";
}
