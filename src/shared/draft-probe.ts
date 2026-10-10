/** Isolated draft check contract. No route, profile or credentials are persisted. */
import {
  parseProxyConfig,
  parseCredentials,
  isValidProfileId,
  type ProxyCredentials,
} from "../profile/validation";
import type { ProxyConfig } from "../profile/schema";
import { parseIpWhoIsResponse } from "../geo/ipwhois";
import type { GeoIpResult } from "../geo/provider";
import { fail, isPlainObject, ok, type Result } from "./result";

export interface DraftInput {
  proxy: ProxyConfig;
  profileId?: string;
  credentials?: ProxyCredentials | null;
}
export type DraftRequest =
  | { type: "draft:cancel"; owner: string }
  | { type: "draft:probe"; owner: string; input: DraftInput };
export const DRAFT_ERRORS = [
  "invalid",
  "credentials",
  "consent",
  "busy",
  "cancelled",
  "timeout",
  "network",
  "provider",
] as const;
export type DraftError = (typeof DRAFT_ERRORS)[number];
export type DraftResponse = { ok: true; identity: GeoIpResult } | { ok: false; error: DraftError };

export function parseDraftRequest(value: unknown): Result<DraftRequest> {
  if (
    !isPlainObject(value) ||
    typeof value.owner !== "string" ||
    !/^[a-zA-Z0-9-]{16,80}$/.test(value.owner)
  )
    return fail("Invalid draft owner");
  if (value.type === "draft:cancel") return ok({ type: value.type, owner: value.owner });
  if (value.type !== "draft:probe" || !isPlainObject(value.input))
    return fail("Invalid draft request");
  const input = value.input;
  const proxy = parseProxyConfig(input.proxy);
  if (!proxy.ok || proxy.value.type === "direct") return fail("Draft checks require a proxy");
  if (input.profileId !== undefined && !isValidProfileId(input.profileId))
    return fail("Invalid profile id");
  const result: DraftInput = { proxy: proxy.value };
  if (typeof input.profileId === "string") result.profileId = input.profileId;
  if (input.credentials === null) result.credentials = null;
  else if (input.credentials !== undefined) {
    const credentials = parseCredentials(input.credentials);
    if (!credentials.ok || proxy.value.type === "socks4") return fail("Invalid draft credentials");
    result.credentials = credentials.value;
  }
  return ok({ type: "draft:probe", owner: value.owner, input: result });
}

export function parseDraftResponse(value: unknown): Result<DraftResponse> {
  if (!isPlainObject(value)) return fail("Invalid draft result");
  if (value.ok === false && DRAFT_ERRORS.some((error) => error === value.error))
    return ok({ ok: false, error: value.error as DraftError });
  if (value.ok !== true || !isPlainObject(value.identity)) return fail("Invalid draft identity");
  const identity = parseIpWhoIsResponse({
    ...value.identity,
    success: true,
    country_code: value.identity.countryCode,
  });
  return identity.ok ? ok({ ok: true, identity: identity.value }) : fail("Invalid draft identity");
}
