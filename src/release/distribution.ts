import { record } from "./amo-api.ts";
import { releaseVersion, SHA256, type AmoState } from "./amo-policy.ts";
import { buildReleaseMetadata } from "./metadata.ts";
import { EXTENSION_ID } from "./version.ts";

export interface Submission {
  schemaVersion: 1;
  tag: string;
  version: string;
  commit: string;
  extensionId: typeof EXTENSION_ID;
  channel: "listed";
  accepted: boolean;
  sourceSha256: string;
  payload: Record<string, string>;
}

export function parseSubmission(value: unknown): Submission {
  const data = record(value);
  if (
    typeof data.tag !== "string" ||
    releaseVersion(data.tag) !== data.version ||
    data.schemaVersion !== 1 ||
    data.extensionId !== EXTENSION_ID ||
    data.channel !== "listed" ||
    typeof data.commit !== "string" ||
    !/^[a-f0-9]{40}$/.test(data.commit) ||
    typeof data.accepted !== "boolean" ||
    typeof data.sourceSha256 !== "string" ||
    !SHA256.test(data.sourceSha256)
  ) {
    throw new Error("Invalid release submission record");
  }
  const payload = record(data.payload);
  if (
    !Object.hasOwn(payload, "manifest.json") ||
    Object.keys(payload).length > 2000 ||
    Object.entries(payload).some(
      ([name, hash]) => !name || typeof hash !== "string" || !SHA256.test(hash),
    )
  ) {
    throw new Error("Invalid submission payload hashes");
  }
  return {
    schemaVersion: 1,
    tag: data.tag,
    version: String(data.version),
    commit: data.commit,
    extensionId: EXTENSION_ID,
    channel: "listed",
    accepted: data.accepted,
    sourceSha256: data.sourceSha256,
    payload: Object.fromEntries(
      Object.entries(payload).map(([name, hash]) => [name, String(hash)]),
    ),
  };
}

export function sameSubmission(a: Submission, b: Submission): boolean {
  return (
    a.tag === b.tag &&
    a.commit === b.commit &&
    a.sourceSha256 === b.sourceSha256 &&
    Object.keys(a.payload).length === Object.keys(b.payload).length &&
    Object.keys(a.payload).every((name) => a.payload[name] === b.payload[name])
  );
}

export interface SignatureProof {
  signed: true;
  extensionId: string;
  version: string;
  sha256: string;
  firefoxVersion: string;
  signedState: number;
  signatureRequired: true;
  temporarilyInstalled: false;
  updateUrl: null;
}

export function parseSignatureProof(value: unknown, version: string, hash: string): SignatureProof {
  const data = record(value);
  if (
    data.signed !== true ||
    data.extensionId !== EXTENSION_ID ||
    data.version !== version ||
    data.sha256 !== hash ||
    !SHA256.test(hash) ||
    typeof data.firefoxVersion !== "string" ||
    !/^\d+\.\d+(?:\.\d+)?$/.test(data.firefoxVersion) ||
    data.signatureRequired !== true ||
    data.temporarilyInstalled !== false ||
    data.updateUrl !== null ||
    typeof data.signedState !== "number" ||
    ![2, 3].includes(data.signedState)
  ) {
    throw new Error("Firefox did not verify a normal permanent AMO-signed installation");
  }
  return {
    signed: true,
    extensionId: EXTENSION_ID,
    version,
    sha256: hash,
    firefoxVersion: data.firefoxVersion,
    signedState: data.signedState,
    signatureRequired: true,
    temporarilyInstalled: false,
    updateUrl: null,
  };
}

export function distributionMetadata(submission: Submission, state: AmoState, proofValue: unknown) {
  if (!submission.accepted || state.state !== "approved" || state.version !== submission.version) {
    throw new Error("Cannot finalize without accepted, approved exact listed version");
  }
  const proof = parseSignatureProof(proofValue, submission.version, state.sha256);
  const signedXpi = {
    name: `net-identity-${submission.version}-firefox-signed.xpi`,
    sha256: state.sha256,
  };
  const source = { name: "net-identity-source.zip", sha256: submission.sourceSha256 };
  return {
    ...buildReleaseMetadata({
      version: submission.version,
      tag: submission.tag,
      commit: submission.commit,
      channel: "listed",
      artifacts: [signedXpi, source],
    }),
    mozillaSigned: true,
    submission,
    amo: {
      version: state.version,
      versionId: state.versionId,
      fileId: state.fileId,
      status: state.status,
      url: state.listingUrl,
      fileUrl: state.url,
      reportedSha256: state.sha256,
      isMozillaInternalCertificate: state.internalCertificate,
    },
    signedXpi,
    source,
    signatureVerification: proof,
    provenance:
      "Downloaded from Mozilla after approval; not rebuilt or modified. Payload matches the tested tag submission.",
  };
}
