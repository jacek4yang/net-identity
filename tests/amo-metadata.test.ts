import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const metadata = JSON.parse(readFileSync("amo-metadata.json", "utf8")) as {
  summary?: Record<string, string>;
  categories?: string[];
  homepage?: Record<string, string>;
  support_url?: Record<string, string>;
  version?: { license?: string; approval_notes?: string };
};
const privacy = readFileSync("docs/PRIVACY.md", "utf8");
const review = readFileSync("docs/AMO-REVIEW.md", "utf8");
const readme = readFileSync("README.md", "utf8");

describe("AMO reviewer package", () => {
  it("carries the first-listing metadata web-ext requires", () => {
    expect(metadata.summary?.["en-US"]).toBeTruthy();
    expect(metadata.categories).toEqual(["privacy-security"]);
    expect(metadata.version?.license).toBe("MIT");
    expect(metadata.version?.approval_notes).toContain("docs/AMO-REVIEW.md");
  });

  it("links a homepage and privacy policy a reviewer can open", () => {
    expect(metadata.homepage?.["en-US"]).toContain("github.com/jacek4yang/net-identity");
    expect(metadata.support_url?.["en-US"]).toContain("docs/PRIVACY.md");
  });

  it("does not claim anonymity, undetectability or guarantees in the listing copy", () => {
    const summary = metadata.summary?.["en-US"] ?? "";
    expect(summary).not.toMatch(/anonym|undetectab|anti-detect|guarantee/i);
  });

  it("documents the GeoIP, tile and session-credential behaviour a reviewer must check", () => {
    expect(privacy).toContain("ipwho.is");
    expect(privacy).toContain("no map requests leave the options page");
    expect(privacy).not.toContain("standard extension Referer");
    expect(privacy).toMatch(/storage\.session|session storage/);
    expect(privacy).toMatch(/does not include telemetry/i);
    expect(review).toContain("proxy.onRequest");
    expect(review).toContain("storage.session");
    expect(review).toMatch(/MAIN-world/i);
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
