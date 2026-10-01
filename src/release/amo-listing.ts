/** Listing-only API policy. Does not submit versions or alter signing/finalization. */
import { AMO_BASE, createJwt, record } from "./amo-api.ts";
import { amoState, mozillaUrl, SHA256 } from "./amo-policy.ts";
import { parseSignatureProof, parseSubmission } from "./distribution.ts";
import { EXTENSION_ID } from "./version.ts";

export const SCREENSHOTS = [
  "01-active-profile.png",
  "02-profile-management.png",
  "03-identity-audit.png",
  "04-local-location-picker.png",
] as const;
export type ListingOperation =
  "read" | "privacy-read" | "copy" | "privacy" | "icon" | "preview-create" | "preview-caption";
export interface ListingCopy {
  summary: { "en-US": string };
  description: { "en-US": string };
  privacy_policy: { "en-US": string };
  captions: string[];
}
export function parseListingCopy(value: unknown): ListingCopy {
  const data = record(value);
  const localized = (key: string, max: number) => {
    const field = record(data[key]);
    const text = field["en-US"];
    if (
      Object.keys(field).length !== 1 ||
      typeof text !== "string" ||
      !text.trim() ||
      text.length > max
    )
      throw new Error(`Invalid listing ${key}`);
    return { "en-US": text };
  };
  if (
    !Array.isArray(data.captions) ||
    data.captions.length !== 4 ||
    data.captions.some((c) => typeof c !== "string" || !c.trim() || c.length > 250)
  )
    throw new Error("Invalid listing captions");
  return {
    summary: localized("summary", 250),
    description: localized("description", 15000),
    privacy_policy: localized("privacy_policy", 150000),
    captions: data.captions as string[],
  };
}
/** Preserve every existing locale. Never send null, change name/slug or touch EULA. */
export function withEnglish(existing: unknown, english: string): Record<string, string> {
  const locales = existing === null || existing === undefined ? {} : record(existing);
  if (Object.values(locales).some((v) => typeof v !== "string"))
    throw new Error("Malformed localized field");
  return { ...locales, "en-US": english };
}
export function assertPublishable(
  addonValue: unknown,
  detail: unknown,
  version: string,
  channel: unknown,
) {
  if (channel !== "listed") throw new Error("Listing writes require tagged listed channel");
  const state = amoState(addonValue, detail, version, "listed");
  const addon = record(addonValue);
  if (state.state !== "approved" || record(addon.current_version).version !== version)
    throw new Error("Exact listed version must be public and current before listing writes");
  return state;
}
export function assertFinalizedRelease(
  value: unknown,
  version: string,
  commit: string,
  amoHash: string,
): void {
  const metadata = record(value);
  const submission = parseSubmission(metadata.submission);
  if (
    submission.version !== version ||
    submission.commit !== commit ||
    submission.channel !== "listed" ||
    !submission.accepted ||
    metadata.mozillaSigned !== true
  )
    throw new Error("Finalized listed release proof mismatch");
  parseSignatureProof(metadata.signatureVerification, version, amoHash);
}
export interface Preview {
  id: number;
  caption: Record<string, string>;
  url: string;
  position: number;
}
export function previewsFrom(value: unknown): Preview[] {
  const data = record(value);
  if (!Array.isArray(data.previews) || data.previews.length > 100)
    throw new Error("Malformed preview list");
  const previews = data.previews.map((raw) => {
    const p = record(raw);
    if (!Number.isSafeInteger(p.id) || Number(p.id) < 1) throw new Error("Invalid preview ID");
    return {
      id: Number(p.id),
      caption: withEnglish(
        p.caption,
        typeof record(p.caption ?? {})["en-US"] === "string"
          ? String(record(p.caption ?? {})["en-US"])
          : "",
      ),
      url: mozillaUrl(p.image_url),
      position: Number.isSafeInteger(p.position) ? Number(p.position) : -1,
    };
  });
  if (new Set(previews.map((p) => p.id)).size !== previews.length)
    throw new Error("Duplicate preview IDs");
  return previews;
}
export interface ListingReceipt {
  schemaVersion: 1;
  extensionId: string;
  version: string;
  planSha256: string;
  dryRun: boolean;
  attemptedWrites: boolean;
  pending?: {
    operation: ListingOperation;
    sourceSha256?: string;
    position?: number;
    beforeIds?: number[];
  };
  copyAccepted?: true;
  privacyAccepted?: true;
  icon?: { sha256: string; url: string };
  previews: Array<{ sha256: string; id: number; url: string }>;
  status:
    | "in-progress"
    | "accepted-public-readback-pending"
    | "public-text-and-preview-metadata-verified";
}
export function parseReceipt(value: unknown, version: string, planSha256: string): ListingReceipt {
  const r = record(value);
  if (
    typeof r.dryRun !== "boolean" ||
    typeof r.attemptedWrites !== "boolean" ||
    r.schemaVersion !== 1 ||
    r.extensionId !== EXTENSION_ID ||
    r.version !== version ||
    r.planSha256 !== planSha256 ||
    !SHA256.test(planSha256) ||
    !Array.isArray(r.previews) ||
    r.previews.length > 4 ||
    ![
      "in-progress",
      "accepted-public-readback-pending",
      "public-text-and-preview-metadata-verified",
    ].includes(String(r.status))
  )
    throw new Error("Receipt does not match this listing plan");
  if (
    (r.copyAccepted !== undefined && r.copyAccepted !== true) ||
    (r.privacyAccepted !== undefined && r.privacyAccepted !== true)
  )
    throw new Error("Invalid copy receipt");
  const entries = r.previews.map((raw) => {
    const p = record(raw);
    if (
      typeof p.sha256 !== "string" ||
      !SHA256.test(p.sha256) ||
      !Number.isSafeInteger(p.id) ||
      Number(p.id) < 1
    )
      throw new Error("Malformed preview receipt");
    return { sha256: p.sha256, id: Number(p.id), url: mozillaUrl(p.url) };
  });
  if (
    new Set(entries.map((p) => p.id)).size !== entries.length ||
    new Set(entries.map((p) => p.sha256)).size !== entries.length
  )
    throw new Error("Duplicate receipt identity");
  let icon: ListingReceipt["icon"];
  if (r.icon !== undefined) {
    const i = record(r.icon);
    if (typeof i.sha256 !== "string" || !SHA256.test(i.sha256))
      throw new Error("Malformed icon receipt");
    icon = { sha256: i.sha256, url: mozillaUrl(i.url) };
  }
  let pending: ListingReceipt["pending"];
  if (r.pending !== undefined) {
    const p = record(r.pending);
    if (
      !r.attemptedWrites ||
      !["copy", "privacy", "icon", "preview-create", "preview-caption"].includes(
        String(p.operation),
      )
    )
      throw new Error("Malformed pending operation");
    pending = { operation: p.operation as ListingOperation };
    if (p.operation === "preview-create") {
      if (
        typeof p.sourceSha256 !== "string" ||
        !SHA256.test(p.sourceSha256) ||
        !Number.isInteger(p.position) ||
        Number(p.position) < 0 ||
        Number(p.position) > 3 ||
        !Array.isArray(p.beforeIds) ||
        p.beforeIds.length > 4 ||
        p.beforeIds.some((id) => !Number.isSafeInteger(id) || Number(id) < 1)
      )
        throw new Error("Malformed pending preview intent");
      pending = {
        ...pending,
        sourceSha256: p.sourceSha256,
        position: Number(p.position),
        beforeIds: p.beforeIds as number[],
      };
    }
  }
  return {
    schemaVersion: 1,
    dryRun: r.dryRun,
    attemptedWrites: r.attemptedWrites,
    ...(pending ? { pending } : {}),
    extensionId: EXTENSION_ID,
    version,
    planSha256,
    previews: entries,
    ...(r.copyAccepted === true ? { copyAccepted: true as const } : {}),
    ...(r.privacyAccepted === true ? { privacyAccepted: true as const } : {}),
    ...(icon ? { icon } : {}),
    status: r.status as ListingReceipt["status"],
  };
}
/** Mozilla's Preview.modified changes on caption saves and asynchronous resizing. */
export function samePreviewImage(first: string, second: string): boolean {
  const identity = (value: string) => {
    const url = new URL(mozillaUrl(value));
    const modified = url.searchParams.getAll("modified");
    if (modified.length > 1 || modified.some((v) => !/^\d+$/.test(v)))
      throw new Error("Malformed preview cache-buster");
    url.searchParams.delete("modified");
    return url.href;
  };
  return identity(first) === identity(second);
}
/** Existing images must have a trusted receipt. Never infer ownership from captions. */
export function checkPreviewOwnership(remote: Preview[], receipt: ListingReceipt): void {
  if (
    remote.length !== receipt.previews.length ||
    remote.some(
      (p) => !receipt.previews.some((r) => r.id === p.id && samePreviewImage(r.url, p.url)),
    )
  )
    throw new Error(
      `Existing previews require operator reconciliation; IDs: ${remote.map((p) => p.id).join(",") || "none"}`,
    );
}
export function listingClient(token: () => string, request: typeof fetch = fetch) {
  return async (
    operation: ListingOperation,
    body?: object | FormData,
    id?: number,
    publicRead = false,
  ): Promise<unknown> => {
    if (
      ![
        "read",
        "privacy-read",
        "copy",
        "privacy",
        "icon",
        "preview-create",
        "preview-caption",
      ].includes(operation)
    )
      throw new Error("Unknown listing operation");
    const allowedKeys: Record<string, string[]> = {
      copy: ["summary", "description"],
      privacy: ["privacy_policy"],
      icon: ["icon"],
      "preview-create": ["image", "position"],
      "preview-caption": ["caption", "position"],
    };
    if (body !== undefined) {
      const keys = body instanceof FormData ? [...body.keys()] : Object.keys(record(body));
      const allowed = allowedKeys[operation];
      if (!allowed || keys.length === 0 || keys.some((key) => !allowed.includes(key)))
        throw new Error("Unexpected listing field");
      const needsMultipart = operation === "icon" || operation === "preview-create";
      if (needsMultipart !== body instanceof FormData)
        throw new Error("Invalid listing body format");
    }
    const read = operation === "read" || operation === "privacy-read";
    if (publicRead && !read) throw new Error("Unauthenticated writes forbidden");
    if (operation === "preview-caption" && (!Number.isSafeInteger(id) || Number(id) < 1))
      throw new Error("Invalid preview target");
    const suffix =
      operation === "privacy" || operation === "privacy-read"
        ? "eula_policy/"
        : operation === "preview-create"
          ? "previews/"
          : operation === "preview-caption"
            ? `previews/${id}/`
            : "";
    const method = read ? "GET" : operation === "preview-create" ? "POST" : "PATCH";
    const multipart = body instanceof FormData;
    if (!read && body === undefined) throw new Error("Missing listing body");
    // The caller cannot provide any URL, redirect target, request headers or method.
    let response: Response;
    try {
      response = await request(AMO_BASE + suffix, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(30000),
        headers: {
          Accept: "application/json",
          ...(publicRead ? {} : { Authorization: `JWT ${token()}` }),
          ...(read || multipart ? {} : { "Content-Type": "application/json" }),
        },
        ...(read ? {} : { body: multipart ? body : JSON.stringify(body) }),
      });
    } catch {
      throw new Error(`AMO ${operation} outcome uncertain; no automatic write retry`);
    }
    if (!response.ok)
      throw new Error(`AMO ${operation} HTTP ${response.status}; stop without credential changes`);
    if (!response.body) throw new Error("Empty listing response; reconcile before retry");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 2000000) throw new Error("size");
        chunks.push(chunk);
      }
    } catch {
      throw new Error("Listing response failed or exceeds limit; reconcile before retry");
    }

    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new Error("Invalid listing response; reconcile before retry");
    }
  };
}
export const environmentListingClient = () =>
  listingClient(() =>
    createJwt(process.env.AMO_JWT_ISSUER ?? "", process.env.AMO_JWT_SECRET ?? ""),
  );

/** An uncertain request remains uncertain even when a subsequent read is empty. */
export function assertNoPending(receipt: ListingReceipt): void {
  if (receipt.pending)
    throw new Error(
      `Pending ${receipt.pending.operation} requires operator reconciliation; remote absence does not prove failure`,
    );
}
export function assertSameApproval(
  initial: ReturnType<typeof assertPublishable>,
  current: ReturnType<typeof assertPublishable>,
): void {
  if (
    initial.versionId !== current.versionId ||
    initial.fileId !== current.fileId ||
    initial.sha256 !== current.sha256
  )
    throw new Error("Approved file changed since finalized release verification");
}
/** Persist intent first. Confirmed results and clearing intent are one atomic receipt write. */
export async function recordedMutation<T>(
  receipt: ListingReceipt,
  pending: NonNullable<ListingReceipt["pending"]>,
  persist: () => void,
  request: () => Promise<T>,
  accept: (result: T) => void,
): Promise<void> {
  assertNoPending(receipt);
  receipt.attemptedWrites = true;
  receipt.pending = pending;
  persist();
  const result = await request();
  accept(result);
  delete receipt.pending;
  persist();
}
export function assertUnchangedLocales(previous: unknown, current: unknown): void {
  const normalized = (v: unknown) =>
    Object.entries(v == null ? {} : record(v)).sort(([a], [b]) => a.localeCompare(b));
  if (JSON.stringify(normalized(previous)) !== JSON.stringify(normalized(current)))
    throw new Error("Localized listing field changed concurrently; review a fresh plan");
}

/** GitHub job reruns reuse the run ID/number and cannot prove the previous attempt's writes. */
export function assertFreshRunAttempt(attempt: unknown): void {
  if (attempt !== "1")
    throw new Error(
      "Job reruns are unsafe; start a fresh workflow_dispatch with the prior run receipt",
    );
}
export function assertFirstInitialization(currentNumber: number, hasPrior: boolean): void {
  if (!hasPrior && currentNumber !== 1)
    throw new Error("Prior listing history is missing; operator reconciliation required");
}
