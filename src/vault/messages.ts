/** Narrow trusted-UI vault protocol; never exposed through the page bridge. */
import { fail, isPlainObject, ok, type Result } from "../shared/result";
import { MAX_VAULT_BYTES } from "./crypto";
import type { VaultStatus, VaultStore } from "./store";
export interface VaultResponse {
  ok: boolean;
  status: VaultStatus;
  error?: string;
  backup?: string;
}
export function parseVaultResponse(value: unknown): Result<VaultResponse> {
  if (
    !isPlainObject(value) ||
    typeof value.ok !== "boolean" ||
    !["unencrypted", "locked", "unlocked", "damaged"].includes(String(value.status))
  )
    return fail("Invalid vault response.");
  if (value.error !== undefined && typeof value.error !== "string")
    return fail("Invalid vault error.");
  if (
    value.backup !== undefined &&
    (typeof value.backup !== "string" || value.backup.length > MAX_VAULT_BYTES * 2)
  )
    return fail("Invalid backup response.");
  return ok({
    ok: value.ok,
    status: value.status as VaultStatus,
    ...(typeof value.error === "string" ? { error: value.error } : {}),
    ...(typeof value.backup === "string" ? { backup: value.backup } : {}),
  });
}

export function createVaultHandler(vault: VaultStore, afterUnlock: () => Promise<unknown>) {
  return async (value: unknown): Promise<VaultResponse> => {
    try {
      if (!isPlainObject(value)) throw new Error("Invalid vault request.");
      switch (value.type) {
        case "vault:get":
          break;
        case "vault:backup":
          return {
            ok: true,
            status: await vault.status(),
            backup: await vault.backup(value.previous === true),
          };
        case "vault:setup":
        case "vault:unlock":
        case "vault:restore": {
          if (typeof value.password !== "string" || value.password.length > 1024)
            throw new Error("Invalid master password.");
          if (value.type === "vault:setup") await vault.setup(value.password);
          else if (value.type === "vault:unlock") {
            await vault.unlock(value.password);
            await afterUnlock();
          } else {
            if (typeof value.backup !== "string" || value.backup.length > MAX_VAULT_BYTES * 2)
              throw new Error("Invalid backup size.");
            const backup: unknown = JSON.parse(value.backup);
            await vault.restore(backup, value.password);
            await afterUnlock();
          }
          break;
        }
        default:
          throw new Error("Invalid vault request.");
      }
      return { ok: true, status: await vault.status() };
    } catch {
      // Never reflect password, backup contents or parser exceptions to logs/UI.
      return { ok: false, status: await vault.status(), error: "vaultOperationFailed" };
    }
  };
}
