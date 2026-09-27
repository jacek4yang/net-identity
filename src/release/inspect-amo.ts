import { amoGet, inspectionSummary } from "./amo-api.ts";
import { parseSemver } from "./version.ts";

try {
  const version = process.argv[2] ?? process.env.AMO_VERSION ?? "1.0.0";
  if (!parseSemver(version)) throw new Error("Invalid version");
  const addon = await amoGet("");
  const detail = await amoGet(`versions/v${version}/`);
  console.error(JSON.stringify(inspectionSummary(addon, detail, version), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "AMO inspection failed");
  process.exitCode = 1;
}
