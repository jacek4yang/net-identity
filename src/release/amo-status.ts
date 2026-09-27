/** Exit codes: approved 0, error 1, pending 20, rejected/disabled 30, absent 40. */
import { amoGet } from "./amo-api.ts";
import { amoState, releaseChannel } from "./amo-policy.ts";
import { parseSemver } from "./version.ts";

try {
  const version = process.argv[2] ?? "";
  if (!parseSemver(version)) throw new Error("Expected semantic version");
  const channel = releaseChannel({ channel: process.argv[3] ?? "listed" });
  const state = amoState(await amoGet(""), await amoGet(`versions/v${version}/`), version, channel);
  console.error(JSON.stringify(state, null, 2));
  process.exitCode = { approved: 0, pending: 20, rejected: 30, absent: 40 }[state.state];
} catch {
  console.error("AMO status query or validation failed");
  process.exitCode = 1;
}
