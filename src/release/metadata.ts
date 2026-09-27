/**
 * Release metadata rules.
 *
 * A GitHub Release is the engineering record for a tag: the tested package, the
 * human-readable source archive, their SHA-256 checksums, and a machine-readable
 * manifest that ties them to the exact commit. This module is pure so the rules are
 * unit tested; `write-metadata.ts` writes the files from the workflow.
 */
import { EXTENSION_ID } from "./version.ts";

export const RELEASE_NAME = "net-identity";

export interface ReleaseArtifact {
  name: string;
  sha256: string;
}

export interface ReleaseMetadataInput {
  version: string;
  tag: string;
  commit: string;
  channel: string;
  artifacts: readonly ReleaseArtifact[];
}

export interface ReleaseMetadata {
  name: string;
  version: string;
  tag: string;
  commit: string;
  extensionId: string;
  channel: string;
  artifacts: ReleaseArtifact[];
}

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{7,40}$/;

/** Validates and normalizes the manifest for one tag. Throws on anything inconsistent. */
export function buildReleaseMetadata(input: ReleaseMetadataInput): ReleaseMetadata {
  if (input.tag !== `v${input.version}`) {
    throw new Error(`tag ${input.tag} must be v${input.version}`);
  }
  if (!COMMIT.test(input.commit)) {
    throw new Error(`commit ${input.commit} is not a git object id`);
  }
  if (input.channel !== "listed" && input.channel !== "unlisted") {
    throw new Error(`release channel ${input.channel} must be listed or unlisted`);
  }
  if (input.artifacts.length === 0) {
    throw new Error("at least one artifact is required");
  }
  for (const artifact of input.artifacts) {
    if (artifact.name.trim() === "") throw new Error("an artifact needs a name");
    if (!SHA256.test(artifact.sha256)) {
      throw new Error(`artifact ${artifact.name} needs a lowercase sha256`);
    }
  }
  return {
    name: RELEASE_NAME,
    version: input.version,
    tag: input.tag,
    commit: input.commit,
    extensionId: EXTENSION_ID,
    channel: input.channel,
    artifacts: input.artifacts.map((artifact) => ({ ...artifact })),
  };
}

/** The body of a `sha256sum`-compatible checksum file. */
export function formatChecksums(artifacts: readonly ReleaseArtifact[]): string {
  return `${artifacts.map((artifact) => `${artifact.sha256}  ${artifact.name}`).join("\n")}\n`;
}
