/**
 * Session-scoped proxy credentials.
 *
 * Credentials are the only secrets in this extension and they are stored
 * exclusively in `browser.storage.session`:
 *
 *   - never in `storage.local` or `storage.sync`
 *   - never inside a profile object, state snapshot or log line
 *   - never sent to a content script, page or GeoIP provider
 *
 * `storage.session` is cleared by Firefox when the browser exits, and its default
 * access level (`TRUSTED_CONTEXTS`) means content scripts cannot read it. This
 * module therefore always receives the *session* area; the local area is never
 * wired to it (see `src/background/index.ts`).
 */
import { CREDENTIAL_KEY_PREFIX } from "../shared/constants";
import { fail, ok, type Result } from "../shared/result";
import { readKey, type StorageAreaLike } from "../shared/storage";
import { parseCredentials, type ProxyCredentials } from "../profile/validation";

export type { ProxyCredentials };

export function credentialKey(profileId: string): string {
  return `${CREDENTIAL_KEY_PREFIX}${profileId}`;
}

export function credentialProfileIdFromKey(key: string): string | null {
  if (!key.startsWith(CREDENTIAL_KEY_PREFIX)) return null;
  const profileId = key.slice(CREDENTIAL_KEY_PREFIX.length);
  return profileId === "" ? null : profileId;
}

export interface CredentialStore {
  get(profileId: string): Promise<ProxyCredentials | null>;
  set(profileId: string, credentials: ProxyCredentials): Promise<void>;
  remove(profileId: string): Promise<void>;
  has(profileId: string): Promise<boolean>;
  /** Ids that currently hold credentials. Used by the UI to show a session badge. */
  listProfileIds(): Promise<string[]>;
  clear(): Promise<void>;
}

function parseStoredCredentials(raw: unknown): Result<ProxyCredentials> {
  return parseCredentials(raw);
}

export function createCredentialStore(area: StorageAreaLike): CredentialStore {
  return {
    async get(profileId) {
      const raw = await readKey(area, credentialKey(profileId));
      if (raw === undefined) return null;
      const parsed = parseStoredCredentials(raw);
      return parsed.ok ? parsed.value : null;
    },

    async set(profileId, credentials) {
      const parsed = parseCredentials(credentials);
      if (!parsed.ok) {
        // Empty username *and* empty password means "forget these credentials".
        await area.remove(credentialKey(profileId));
        return;
      }
      await area.set({ [credentialKey(profileId)]: parsed.value });
    },

    async remove(profileId) {
      await area.remove(credentialKey(profileId));
    },

    async has(profileId) {
      return (await readKey(area, credentialKey(profileId))) !== undefined;
    },

    async listProfileIds() {
      const everything = await area.get(null);
      const ids: string[] = [];
      for (const key of Object.keys(everything)) {
        const profileId = credentialProfileIdFromKey(key);
        if (profileId !== null) ids.push(profileId);
      }
      return ids;
    },

    async clear() {
      const ids = await this.listProfileIds();
      if (ids.length === 0) return;
      await area.remove(ids.map(credentialKey));
    },
  };
}

/** Rejects credentials that are valid but unusable for the given proxy type. */
export function validateCredentialsForProxyType(
  proxyType: string,
  credentials: ProxyCredentials,
): Result<ProxyCredentials> {
  if (proxyType === "direct") return fail("a direct connection does not use proxy credentials");
  return ok(credentials);
}
