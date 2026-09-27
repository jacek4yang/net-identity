/**
 * Background message router.
 *
 * Responsibilities:
 *   - reject anything that does not come from this extension
 *   - validate every inbound payload
 *   - keep credential handling in one place (session storage only)
 *   - re-activate a profile when it is edited while active
 *
 * The router is pure with respect to Firefox: it receives plain sender
 * information, so the whole request surface is unit testable.
 */
import { parsePageAppliedReport } from "../shared/public-identity";
import {
  parseInboundMessage,
  type ContentReportAck,
  type IdentityResponse,
  type MutationResponse,
  type ProfilesResponse,
  type StateResponse,
  type UiRequest,
} from "../shared/messages";
import {
  BUILTIN_DIRECT_NAME,
  createProfile,
  canStoreMoreProfiles,
  isBuiltinDirectProfile,
  type IdentityProfile,
} from "../profile/schema";
import {
  createProfileId,
  mutateProfiles,
  removeProfile,
  upsertProfile,
  findProfile,
  type ProfileStore,
} from "../profile/store";
import { isValidProfileId, parseCredentials, parseProfile } from "../profile/validation";
import type { CredentialStore } from "./credentials";
import type { ActivationController } from "./identity";

export interface SenderInfo {
  /** Extension id of the sender, when the browser supplies one. */
  id: string | undefined;
  /** True when the message came from a content script (it has a tab). */
  fromContentScript: boolean;
  url: string | undefined;
  /** Present when a content script in a tab sent the message. */
  tabId?: number;
  frameId?: number;
}

export interface MessageRouterDeps {
  profiles: ProfileStore;
  credentials: CredentialStore;
  controller: ActivationController;
  runtimeId: string;
}

function mutation(
  ok: boolean,
  errors: string[],
  controller: ActivationController,
): MutationResponse {
  return { ok, errors, state: controller.getState() };
}

async function listProfiles(deps: MessageRouterDeps): Promise<ProfilesResponse> {
  const stored = await deps.profiles.load();
  return {
    profiles: stored.profiles,
    activeProfileId: stored.activeProfileId,
    credentialProfileIds: await deps.credentials.listProfileIds(),
  };
}

async function saveProfile(
  deps: MessageRouterDeps,
  request: Extract<UiRequest, { type: "profiles:save" }>,
): Promise<MutationResponse> {
  const parsed = parseProfile(request.profile);
  if (!parsed.ok) return mutation(false, parsed.errors, deps.controller);
  const profile = parsed.value;

  if (isBuiltinDirectProfile(profile.id)) {
    if (
      profile.proxy.type !== "direct" ||
      profile.name !== BUILTIN_DIRECT_NAME ||
      profile.webrtcPolicy !== "default" ||
      profile.identity.mode !== "auto"
    ) {
      return mutation(
        false,
        ["The built-in Direct profile is read-only and cannot be modified."],
        deps.controller,
      );
    }
  }

  if (request.credentials === null) {
    await deps.credentials.remove(profile.id);
  } else if (request.credentials !== undefined) {
    const username = request.credentials.username ?? "";
    const password = request.credentials.password ?? "";
    if (username === "" && password === "") {
      await deps.credentials.remove(profile.id);
    } else {
      const credentials = parseCredentials({ username, password });
      if (!credentials.ok) return mutation(false, credentials.errors, deps.controller);
      await deps.credentials.set(profile.id, credentials.value);
    }
  }

  const existing = await deps.profiles.load();
  const isNew = findProfile(existing, profile.id) === null;
  if (isNew && !canStoreMoreProfiles(existing)) {
    return mutation(false, ["The profile limit has been reached."], deps.controller);
  }

  const saved = await mutateProfiles(deps.profiles, (current) => upsertProfile(current, profile));
  if (!saved.ok) return mutation(false, saved.errors, deps.controller);

  // Editing the active profile applies the change immediately.
  if (saved.value.activeProfileId === profile.id) {
    await deps.controller.activate(profile.id);
  }
  return mutation(true, [], deps.controller);
}

async function deleteProfile(
  deps: MessageRouterDeps,
  profileId: string,
): Promise<MutationResponse> {
  if (isBuiltinDirectProfile(profileId)) {
    return mutation(false, ["The built-in Direct profile cannot be deleted."], deps.controller);
  }
  const stored = await deps.profiles.load();
  if (findProfile(stored, profileId) === null) {
    return mutation(false, ["Profile not found."], deps.controller);
  }
  const wasActive = stored.activeProfileId === profileId;
  await deps.credentials.remove(profileId);
  await deps.profiles.save(removeProfile(stored, profileId));
  if (wasActive) {
    // Removing the active profile also removes its routing.
    await deps.controller.deactivate();
  }
  return mutation(true, [], deps.controller);
}

async function duplicateProfile(
  deps: MessageRouterDeps,
  profileId: string,
): Promise<MutationResponse> {
  if (isBuiltinDirectProfile(profileId)) {
    return mutation(false, ["The built-in Direct profile cannot be duplicated."], deps.controller);
  }
  const stored = await deps.profiles.load();
  const source = findProfile(stored, profileId);
  if (source === null) return mutation(false, ["Profile not found."], deps.controller);
  if (!canStoreMoreProfiles(stored)) {
    return mutation(false, ["The profile limit has been reached."], deps.controller);
  }

  const copy: IdentityProfile = {
    ...source,
    id: createProfileId(),
    name: `${source.name} copy`.slice(0, 64),
    proxy: { ...source.proxy, bypassHosts: [...source.proxy.bypassHosts] },
    identity: { ...source.identity },
  };
  const saved = await mutateProfiles(deps.profiles, (current) => upsertProfile(current, copy));
  if (!saved.ok) return mutation(false, saved.errors, deps.controller);
  // Credentials are intentionally NOT copied: they must be entered again so a
  // duplicate never silently reuses a stored password.
  return mutation(true, [], deps.controller);
}

export function createMessageHandler(
  deps: MessageRouterDeps,
): (message: unknown, sender: SenderInfo) => Promise<unknown> {
  return async (message: unknown, sender: SenderInfo): Promise<unknown> => {
    // Other extensions can reach this listener through runtime.sendMessage; they
    // must never be able to read or change network identity.
    if (sender.id !== deps.runtimeId) return undefined;

    const parsed = parseInboundMessage(message);
    if (!parsed.ok) return undefined;

    switch (parsed.value.type) {
      case "state:get": {
        const response: StateResponse = { state: deps.controller.getState() };
        return response;
      }

      case "profiles:list":
        return await listProfiles(deps);

      case "profiles:save":
        return await saveProfile(deps, parsed.value);

      case "profiles:delete":
        if (!isValidProfileId(parsed.value.profileId)) {
          return mutation(false, ["Malformed profile id."], deps.controller);
        }
        return await deleteProfile(deps, parsed.value.profileId);

      case "profiles:duplicate":
        if (!isValidProfileId(parsed.value.profileId)) {
          return mutation(false, ["Malformed profile id."], deps.controller);
        }
        return await duplicateProfile(deps, parsed.value.profileId);

      case "profiles:activate":
        if (!isValidProfileId(parsed.value.profileId)) {
          return mutation(false, ["Malformed profile id."], deps.controller);
        }
        await deps.controller.activate(parsed.value.profileId);
        return mutation(deps.controller.getState().status !== "error", [], deps.controller);

      case "profiles:deactivate":
        await deps.controller.deactivate();
        return mutation(true, [], deps.controller);

      case "identity:refresh":
        await deps.controller.refresh();
        return mutation(true, [], deps.controller);

      case "content:hello": {
        if (!sender.fromContentScript) return undefined;
        const response: IdentityResponse = { envelope: deps.controller.getEnvelope() };
        return response;
      }

      case "content:report": {
        if (!sender.fromContentScript) return undefined;
        const report = parsePageAppliedReport(parsed.value.payload);
        const ack: ContentReportAck = { accepted: false };
        if (!report.ok) return ack;
        if (sender.tabId === undefined || sender.frameId === undefined) return ack;
        deps.controller.recordContentReport(report.value, {
          tabId: sender.tabId,
          frameId: sender.frameId,
        });
        ack.accepted = true;
        return ack;
      }
    }
  };
}

/** Creates the default profile on a fresh install so the popup is never empty. */
export function createDefaultProfile(): IdentityProfile {
  return createProfile(createProfileId(), "Direct (default)", "direct");
}
