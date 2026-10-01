import { execFileSync } from "node:child_process";
import { it } from "vitest";

it("validates the provider glyph fixture and rejects tofu/blank pixel evidence", () => {
  execFileSync(process.execPath, ["--test", "scripts/fixtures/map-glyph.test.mjs"], {
    encoding: "utf8",
    timeout: 15000,
  });
});
