/**
 * Session snapshot of the active target.
 *
 * WHY THIS EXISTS: a Manifest V3 Firefox background script is an *event page* and
 * can be suspended while the browser stays open. If the in-memory proxy target
 * were the only source of truth, a suspended-then-restarted background script
 * would answer `proxy.onRequest` with "direct" until something re-activated the
 * profile — a silent privacy failure.
 *
 * The snapshot therefore lives in `browser.storage.session` (never `local`),
 * because it contains the active proxy credentials. Firefox clears it when the
 * browser exits, so a fresh browser start always performs a full activation and
 * re-resolves the identity from the observed egress IP.
 */
import { ACTIVE_TARGET_KEY } from "../shared/constants";
import { isIntegerInRange, parseWebRtcPolicy } from "../shared/primitives";
import { fail, isPlainObject, ok, type Result } from "../shared/result";
import {
  parseResolvedIdentity,
  parseWebRtcState,
  RUNTIME_STATUSES,
  type ResolvedIdentity,
  type RuntimeStatus,
  type WebRtcRuntimeState,
} from "../shared/state";
import { readKey, type StorageAreaLike } from "../shared/storage";
import {
  isValidProfileId,
  parseCredentials,
  parseProxyConfig,
  type ProxyCredentials,
} from "../profile/validation";

import type { ProxyConfig, WebRTCPolicy } from "../profile/schema";

export const ACTIVE_TARGET_SCHEMA_VERSION = 1;

export interface ActiveTargetSnapshot {
  schemaVersion: typeof ACTIVE_TARGET_SCHEMA_VERSION;
  generation: number;
  profileId: string;
  profileName: string;
  proxy: ProxyConfig;
  /** Secret: session storage only. */
  credentials: ProxyCredentials | null;
  webrtcPolicy: WebRTCPolicy;
  identity: ResolvedIdentity;
  webrtc: WebRtcRuntimeState;
  status: RuntimeStatus;
  updatedAt: number;
}

export function parseActiveTargetSnapshot(value: unknown): Result<ActiveTargetSnapshot> {
  if (!isPlainObject(value)) return fail("active target snapshot must be an object");
  if (value.schemaVersion !== ACTIVE_TARGET_SCHEMA_VERSION) {
    return fail(`unsupported active target schema version: ${String(value.schemaVersion)}`);
  }
  if (!isIntegerInRange(value.generation, 0, Number.MAX_SAFE_INTEGER)) {
    return fail("active target generation is invalid");
  }
  if (!isValidProfileId(value.profileId)) return fail("active target profile id is invalid");
  if (typeof value.profileName !== "string" || value.profileName === "") {
    return fail("active target profile name is invalid");
  }
  if (
    typeof value.status !== "string" ||
    !(RUNTIME_STATUSES as readonly string[]).includes(value.status)
  ) {
    return fail("active target status is invalid");
  }

  const proxy = parseProxyConfig(value.proxy);
  if (!proxy.ok) return fail(...proxy.errors);

  const policy = parseWebRtcPolicy(value.webrtcPolicy);
  if (!policy.ok) return fail(...policy.errors);

  const identity = parseResolvedIdentity(value.identity);
  if (!identity.ok) return fail(...identity.errors);

  const webrtc = parseWebRtcState(value.webrtc);
  if (!webrtc.ok) return fail(...webrtc.errors);

  let credentials: ProxyCredentials | null = null;
  if (value.credentials !== null && value.credentials !== undefined) {
    const parsed = parseCredentials(value.credentials);
    if (!parsed.ok) return fail(...parsed.errors);
    credentials = parsed.value;
  }

  return ok({
    schemaVersion: ACTIVE_TARGET_SCHEMA_VERSION,
    generation: value.generation,
    profileId: value.profileId,
    profileName: value.profileName,
    proxy: proxy.value,
    credentials,
    webrtcPolicy: policy.value,
    identity: identity.value,
    webrtc: webrtc.value,
    status: value.status as RuntimeStatus,
    updatedAt: isIntegerInRange(value.updatedAt, 0, Number.MAX_SAFE_INTEGER) ? value.updatedAt : 0,
  });
}

export interface ActiveTargetStore {
  load(): Promise<ActiveTargetSnapshot | null>;
  save(snapshot: ActiveTargetSnapshot): Promise<void>;
  clear(): Promise<void>;
}

export function createActiveTargetStore(area: StorageAreaLike): ActiveTargetStore {
  return {
    async load() {
      const raw = await readKey(area, ACTIVE_TARGET_KEY);
      if (raw === undefined) return null;
      const parsed = parseActiveTargetSnapshot(raw);
      return parsed.ok ? parsed.value : null;
    },
    async save(snapshot) {
      await area.set({ [ACTIVE_TARGET_KEY]: snapshot });
    },
    async clear() {
      await area.remove(ACTIVE_TARGET_KEY);
    },
  };
}
