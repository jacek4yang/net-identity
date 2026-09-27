import { createHmac, randomUUID } from "node:crypto";
import { EXTENSION_ID, parseSemver } from "./version.ts";

export const AMO_BASE = `https://addons.mozilla.org/api/v5/addons/addon/${EXTENSION_ID}/`;

export function createJwt(issuer: string, secret: string, now = Date.now()): string {
  if (!issuer || !secret) throw new Error("Missing AMO credentials");
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const iat = Math.floor(now / 1000);
  const body = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ iss: issuer, jti: randomUUID(), iat, exp: iat + 60 })}`;
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Malformed AMO object");
  }
  return value as Record<string, unknown>;
}

/** Fixed-origin GET only; authorization is never forwarded to redirects or logged. */
export async function amoGet(suffix: string, request = fetch): Promise<unknown> {
  if (!/^(?:|versions\/(?:v\d+\.\d+\.\d+\/|\?filter=all_with_unlisted))$/.test(suffix)) {
    throw new Error("Invalid AMO endpoint");
  }
  const token = createJwt(process.env.AMO_JWT_ISSUER ?? "", process.env.AMO_JWT_SECRET ?? "");
  let response: Response;
  try {
    response = await request(AMO_BASE + suffix, {
      headers: { Authorization: `JWT ${token}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error("AMO request failed (network, redirect or timeout)");
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`AMO HTTP ${response.status}`);
  const bytes: Uint8Array[] = [];
  let length = 0;
  if (!response.body) throw new Error("Empty AMO response");
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > 2_000_000) throw new Error("AMO response too large");
    bytes.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(bytes).toString("utf8")) as unknown;
  } catch {
    throw new Error("Malformed AMO JSON");
  }
}

/** A whitelist of status fields, never raw API data, tokens or reviewer notes. */
export function inspectionSummary(addonValue: unknown, versionValue: unknown, version: string) {
  if (!parseSemver(version)) throw new Error("Invalid version");
  const addon = record(addonValue);
  if (
    addon.guid !== EXTENSION_ID ||
    typeof addon.status !== "string" ||
    typeof addon.is_disabled !== "boolean"
  ) {
    throw new Error("Unexpected AMO add-on identity/status");
  }
  if (versionValue === null)
    return { extensionId: EXTENSION_ID, addonStatus: addon.status, version, exists: false };
  const detail = record(versionValue);
  const file = record(detail.file);
  if (
    detail.version !== version ||
    (detail.channel !== "listed" && detail.channel !== "unlisted") ||
    typeof file.status !== "string" ||
    typeof file.is_mozilla_signed_extension !== "boolean"
  ) {
    throw new Error("Unexpected AMO version/channel/file");
  }
  return {
    extensionId: EXTENSION_ID,
    addonStatus: addon.status,
    addonDisabled: addon.is_disabled,
    version,
    exists: true,
    channel: detail.channel,
    fileStatus: file.status,
    mozillaInternalCertificate: file.is_mozilla_signed_extension,
    hasDownloadUrl: typeof file.url === "string" && file.url.length > 0,
    hasSha256: typeof file.hash === "string" && /^sha256:[a-f0-9]{64}$/.test(file.hash),
    versionDisabled: detail.is_disabled === true,
  };
}
