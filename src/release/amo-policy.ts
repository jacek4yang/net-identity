import { record } from "./amo-api.ts";
import { compareSemver, EXTENSION_ID, parseSemver } from "./version.ts";

export const HISTORICAL_TAG = "v1.0.0";
export const HISTORICAL_COMMIT = "e3f8b22ed08e2acc13e93aad180b2e4e28f69325";
export const LISTED_110_COMMIT = "e257b057a3c93e8b90fbd8de792429af2202ea35";
export const SHA256 = /^[a-f0-9]{64}$/;
export type ReleaseChannel = "listed" | "unlisted";

export function releaseChannel(value: unknown): ReleaseChannel {
  if (value === null) return "listed"; // Immutable tags predating channel selection.
  const config = record(value);
  if (config.channel !== "listed" && config.channel !== "unlisted")
    throw new Error("Invalid release channel");
  return config.channel;
}

export function releaseVersion(tag: string): string {
  const version = tag.startsWith("v") ? parseSemver(tag.slice(1)) : null;
  if (!version || compareSemver(version, { major: 1, minor: 0, patch: 0 }) <= 0) {
    throw new Error("Only new semantic-version tags above immutable v1.0.0 are eligible");
  }
  return tag.slice(1);
}

export function mozillaUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) throw new Error("Missing AMO file URL");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    !["addons.mozilla.org", "addons.cdn.mozilla.net"].includes(url.hostname)
  ) {
    throw new Error("Untrusted Mozilla download URL");
  }
  return url.href;
}

export type AmoState =
  | { state: "absent" }
  | { state: "pending" | "rejected"; status: string }
  | {
      state: "approved";
      status: "public";
      version: string;
      channel: ReleaseChannel;
      versionId: number;
      fileId: number;
      url: string;
      sha256: string;
      internalCertificate: boolean;
      listingUrl: string;
    };

export function amoState(
  addonValue: unknown,
  versionValue: unknown,
  version: string,
  channel: ReleaseChannel = "listed",
): AmoState {
  if (!parseSemver(version)) throw new Error("Invalid version");
  const addon = record(addonValue);
  if (
    addon.guid !== EXTENSION_ID ||
    typeof addon.is_disabled !== "boolean" ||
    !["public", "nominated", "incomplete", "disabled", "deleted", "rejected"].includes(
      String(addon.status),
    )
  ) {
    throw new Error("Malformed AMO add-on or wrong extension ID");
  }
  if (addon.is_disabled || ["disabled", "deleted", "rejected"].includes(String(addon.status))) {
    return { state: "rejected", status: `addon:${String(addon.status)}` };
  }
  if (versionValue === null) return { state: "absent" };
  const detail = record(versionValue);
  const file = record(detail.file);
  if (
    detail.version !== version ||
    detail.channel !== channel ||
    (detail.is_disabled !== undefined && typeof detail.is_disabled !== "boolean") ||
    typeof file.is_mozilla_signed_extension !== "boolean"
  ) {
    throw new Error("Wrong AMO version/channel or malformed signature/disabled state");
  }
  if (detail.is_disabled || file.status === "disabled")
    return { state: "rejected", status: "file:disabled" };
  if (file.status === "unreviewed") return { state: "pending", status: "unreviewed" };
  if (file.status !== "public") throw new Error("Unknown AMO file status");
  if (channel === "listed" && addon.status !== "public")
    return { state: "pending", status: `addon:${String(addon.status)}` };
  if (
    typeof detail.id !== "number" ||
    !Number.isSafeInteger(detail.id) ||
    detail.id < 1 ||
    typeof file.id !== "number" ||
    !Number.isSafeInteger(file.id) ||
    file.id < 1 ||
    typeof file.hash !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(file.hash)
  ) {
    throw new Error("Approved AMO file lacks a valid id or SHA-256");
  }
  const listingUrl = channel === "listed" ? mozillaUrl(addon.url) : "";
  if (
    channel === "listed" &&
    (!listingUrl.startsWith("https://addons.mozilla.org/") ||
      !new URL(listingUrl).pathname.includes("/addon/"))
  ) {
    throw new Error("Invalid canonical AMO listing");
  }
  return {
    state: "approved",
    status: "public",
    version,
    channel,
    versionId: detail.id,
    fileId: file.id,
    url: mozillaUrl(file.url),
    sha256: file.hash.slice(7),
    internalCertificate: file.is_mozilla_signed_extension,
    listingUrl,
  };
}

/** Only an actual absent version permits a POST. Duplicate text is not evidence. */
export async function ensureSubmission(
  query: () => Promise<AmoState>,
  submit: () => Promise<void>,
): Promise<AmoState> {
  let state = await query();
  if (state.state === "rejected") throw new Error(`AMO rejected/disabled: ${state.status}`);
  if (state.state !== "absent") return state;
  await submit();
  state = await query();
  if (state.state === "absent" || state.state === "rejected")
    throw new Error("AMO did not accept the exact configured version");
  return state;
}
