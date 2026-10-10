import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertAmoMetadata } from "../src/release/amo-metadata";

const metadata = JSON.parse(readFileSync("amo-metadata.json", "utf8")) as {
  summary?: Record<string, string>;
  categories?: string[];
  homepage?: Record<string, string>;
  support_url?: Record<string, string>;
  version?: { license?: string; approval_notes?: string };
};
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
const privacy = readFileSync("docs/PRIVACY.md", "utf8");
const review = readFileSync("docs/AMO-REVIEW.md", "utf8");
const readme = readFileSync("README.md", "utf8");

describe("AMO reviewer package", () => {
  it("carries the first-listing metadata web-ext requires", () => {
    expect(() => assertAmoMetadata(metadata)).not.toThrow();
    expect(metadata.summary?.["en-US"]).toBeTruthy();
    expect(metadata.summary?.["en-US"]?.length).toBeLessThanOrEqual(250);
    expect(metadata.categories).toEqual(["privacy-security"]);
    expect(metadata.version?.license).toBe("MIT");
    expect(metadata.version?.approval_notes).toContain("docs/AMO-REVIEW.md");
    expect(metadata.version?.approval_notes).toContain(packageJson.version);
  });

  it("links a homepage and privacy policy a reviewer can open", () => {
    expect(metadata.homepage?.["en-US"]).toContain("github.com/jacek4yang/net-identity");
    expect(metadata.support_url?.["en-US"]).toBe(
      "https://github.com/jacek4yang/net-identity/issues",
    );
  });

  it("does not claim anonymity, undetectability or guarantees in the listing copy", () => {
    const summary = metadata.summary?.["en-US"] ?? "";
    expect(summary).not.toMatch(/anonym|undetectab|anti-detect|guarantee/i);
  });

  it("documents the GeoIP, tile and session-credential behaviour a reviewer must check", () => {
    expect(privacy).toContain("ipwho.is");
    expect(privacy).toContain("Load online map");
    expect(privacy).toContain("tiles.openfreemap.org");
    expect(privacy).toContain("no map\nnetwork request");
    expect(privacy).toContain("not private from the map provider");
    expect(privacy).toContain("optional personal-data consent");
    expect(privacy).toContain("unreleased bilingual/quick-setup");
    expect(privacy).toContain("Public listed 1.1.5 retains its immutable tagged policy");
    expect(privacy).not.toContain("standard extension Referer");
    expect(privacy).toMatch(/storage\.session|session storage/);
    expect(privacy).toMatch(/does not include telemetry/i);
    expect(review).toContain("proxy.onRequest");
    expect(review).toContain("storage.session");
    expect(review).toMatch(/MAIN-world/i);
  });

  it("discloses draft preview and remembered map loading before publication", () => {
    expect(privacy).toContain("before Save or enable");
    expect(privacy).toContain("existing ordinary-page routing is");
    expect(privacy).toContain("unchanged");
    expect(privacy).toContain("remembers automatic loading");
    expect(privacy).toContain("Unchecking automatic loading");
    expect(privacy).toContain("Save and enable saves the visible form");
    expect(privacy).not.toContain("Do not activate a profile, and the extension does not contact");
    expect(metadata.version?.approval_notes).toContain("before Save/enable");
    expect(metadata.version?.approval_notes).toContain(
      "fresh generation/route-bound authorization",
    );
    expect(review).toContain("Current unreleased quick-setup candidate");
  });

  it("states the shim limitation instead of promising invisibility", () => {
    expect(privacy).toMatch(/not a claim that the browser is anonymous or undetectable/i);
    expect(privacy).toMatch(/visible to a page that inspects them/i);
  });

  it("points ordinary users at AMO and separates the developer build", () => {
    expect(readme).toContain("addons.mozilla.org");
    expect(readme).toMatch(/not the signed installer/i);
    expect(readme).toContain("docs/RELEASE-CHECKLIST.md");
  });
});
