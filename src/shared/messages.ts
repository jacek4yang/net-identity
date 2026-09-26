/**
 * Message contract between extension contexts.
 *
 * Three channels exist:
 *   - UI (popup/options) -> background: requests, validated with {@link parseInboundMessage}
 *   - content bridge -> background: handshake and untrusted diagnostic reports
 *   - background -> UI/content: state changes and identity updates
 *
 * Every inbound payload is validated before use. Nothing is trusted merely because
 * it "came from our own extension": a stale context or a bug must not be able to
 * corrupt state.
 *
 * Credential handling: the only message that carries a password is
 * `profiles:save`, which travels from the trusted options page to the background
 * script over `runtime.sendMessage`. It is never sent to a content script, never
 * broadcast, and never echoed back.
 */
import { isIntegerInRange, isNonEmptyString } from "./primitives";
import { parseIdentityEnvelope, type IdentityEnvelope } from "./public-identity";
import { fail, isPlainObject, ok, type Result } from "./result";
import { parseRuntimeState, type RuntimeState } from "./state";
import { parseProfile } from "../profile/validation";
import { BRIDGE_SOURCE } from "./constants";

import type { IdentityProfile } from "../profile/schema";

export const UI_REQUEST_TYPES = [
  "state:get",
  "profiles:list",
  "profiles:save",
  "profiles:delete",
  "profiles:duplicate",
  "profiles:activate",
  "profiles:deactivate",
  "identity:refresh",
] as const;

export const CONTENT_REQUEST_TYPES = ["content:hello", "content:report"] as const;

export interface ProfileCredentialsPayload {
  username?: string;
  password?: string;
}

export type UiRequest =
  | { type: "state:get" }
  | { type: "profiles:list" }
  | { type: "profiles:save"; profile: unknown; credentials?: ProfileCredentialsPayload | null }
  | { type: "profiles:delete"; profileId: string }
  | { type: "profiles:duplicate"; profileId: string }
  | { type: "profiles:activate"; profileId: string }
  | { type: "profiles:deactivate" }
  | { type: "identity:refresh" };

export type ContentRequest =
  { type: "content:hello" } | { type: "content:report"; payload: unknown };

export type InboundMessage = UiRequest | ContentRequest;

export interface StateResponse {
  state: RuntimeState;
}

export interface ProfilesResponse {
  profiles: IdentityProfile[];
  activeProfileId: string | null;
  /** Ids with session-scoped credentials present. Values never leave storage. */
  credentialProfileIds: string[];
}

export interface IdentityResponse {
  envelope: IdentityEnvelope;
}

export interface MutationResponse {
  ok: boolean;
  errors: string[];
  state: RuntimeState;
}

export interface ContentReportAck {
  accepted: boolean;
}

export interface ProbeResponse {
  generation: number;
  timezone: string | null;
  hasShim: boolean;
  url: string;
}

export type BackgroundToUiMessage = { type: "state:changed"; state: RuntimeState };

export type BackgroundToContentMessage =
  { type: "identity:update"; envelope: IdentityEnvelope } | { type: "content:probe" };

export type OutboundMessage = BackgroundToUiMessage | BackgroundToContentMessage;

function parseCredentialsPayload(value: unknown): Result<ProfileCredentialsPayload> {
  const payload: ProfileCredentialsPayload = {};
  if (value === undefined) return ok(payload);
  if (!isPlainObject(value)) return fail("credentials must be an object");
  if (value.username !== undefined) {
    if (typeof value.username !== "string") return fail("credentials username must be text");
    payload.username = value.username;
  }
  if (value.password !== undefined) {
    if (typeof value.password !== "string") return fail("credentials password must be text");
    payload.password = value.password;
  }
  return ok(payload);
}

export function parseInboundMessage(value: unknown): Result<InboundMessage> {
  if (!isPlainObject(value)) return fail("message must be an object");
  const type = value.type;
  if (typeof type !== "string") return fail("message type is required");

  switch (type) {
    case "state:get":
    case "profiles:list":
    case "profiles:deactivate":
    case "identity:refresh":
      return ok({ type });
    case "profiles:save": {
      if (!isPlainObject(value.profile)) return fail("profiles:save requires a profile object");
      // Credential intent is three-valued and must stay that way:
      //   absent -> keep whatever is stored, null -> forget it, object -> replace it.
      if (!("credentials" in value)) {
        return ok({ type: "profiles:save", profile: value.profile });
      }
      if (value.credentials === null) {
        return ok({ type: "profiles:save", profile: value.profile, credentials: null });
      }
      const credentials = parseCredentialsPayload(value.credentials);
      if (!credentials.ok) return fail(...credentials.errors);
      return ok({ type: "profiles:save", profile: value.profile, credentials: credentials.value });
    }
    case "profiles:delete":
    case "profiles:duplicate":
    case "profiles:activate": {
      if (!isNonEmptyString(value.profileId, 128)) return fail(`${type} requires a profileId`);
      return ok({ type, profileId: value.profileId });
    }
    case "content:hello":
      return ok({ type: "content:hello" });
    case "content:report":
      return ok({ type: "content:report", payload: value.payload });
    default:
      return fail(`unsupported message type: ${type}`);
  }
}

export function parseStateResponse(value: unknown): Result<StateResponse> {
  if (!isPlainObject(value)) return fail("state response must be an object");
  const state = parseRuntimeState(value.state);
  if (!state.ok) return fail(...state.errors);
  return ok({ state: state.value });
}

export function parseProfilesResponse(value: unknown): Result<ProfilesResponse> {
  if (!isPlainObject(value)) return fail("profiles response must be an object");
  if (!Array.isArray(value.profiles)) return fail("profiles response must contain a profile list");

  const profiles: IdentityProfile[] = [];
  for (const rawProfile of value.profiles) {
    const parsed = parseProfile(rawProfile);
    if (!parsed.ok) return fail(...parsed.errors);
    profiles.push(parsed.value);
  }

  const credentialProfileIds = Array.isArray(value.credentialProfileIds)
    ? value.credentialProfileIds.filter((entry): entry is string => typeof entry === "string")
    : [];

  return ok({
    profiles,
    activeProfileId: typeof value.activeProfileId === "string" ? value.activeProfileId : null,
    credentialProfileIds,
  });
}

export function parseIdentityResponse(value: unknown): Result<IdentityResponse> {
  if (!isPlainObject(value)) return fail("identity response must be an object");
  const parsed = parseIdentityEnvelope(value.envelope, BRIDGE_SOURCE);
  if (!parsed.ok) return fail(...parsed.errors);
  return ok({ envelope: parsed.value });
}

export function parseMutationResponse(value: unknown): Result<MutationResponse> {
  if (!isPlainObject(value)) return fail("mutation response must be an object");
  const state = parseRuntimeState(value.state);
  if (!state.ok) return fail(...state.errors);
  return ok({
    ok: value.ok === true,
    errors: Array.isArray(value.errors)
      ? value.errors.filter((entry): entry is string => typeof entry === "string")
      : [],
    state: state.value,
  });
}

export function parseProbeResponse(value: unknown): Result<ProbeResponse> {
  if (!isPlainObject(value)) return fail("probe response must be an object");
  if (!isIntegerInRange(value.generation, 0, Number.MAX_SAFE_INTEGER)) {
    return fail("probe response generation is invalid");
  }
  if (
    value.timezone !== null &&
    value.timezone !== undefined &&
    typeof value.timezone !== "string"
  ) {
    return fail("probe response timezone is invalid");
  }
  const timezone =
    typeof value.timezone === "string" && value.timezone !== "" ? value.timezone : null;
  return ok({
    generation: value.generation,
    timezone,
    hasShim: value.hasShim === true,
    url: typeof value.url === "string" ? value.url : "",
  });
}

/** Parses anything the background script may send to a UI page or a content script. */
export function parseOutboundMessage(value: unknown): Result<OutboundMessage> {
  if (!isPlainObject(value)) return fail("outbound message must be an object");
  switch (value.type) {
    case "content:probe":
      return ok({ type: "content:probe" });
    case "identity:update": {
      const parsed = parseIdentityEnvelope(value.envelope, BRIDGE_SOURCE);
      if (!parsed.ok) return fail(...parsed.errors);
      return ok({ type: "identity:update", envelope: parsed.value });
    }
    case "state:changed": {
      const parsed = parseRuntimeState(value.state);
      if (!parsed.ok) return fail(...parsed.errors);
      return ok({ type: "state:changed", state: parsed.value });
    }
    default:
      return fail(`unsupported outbound message type: ${String(value.type)}`);
  }
}
