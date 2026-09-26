/**
 * Manifest and packaging contract.
 *
 * These assertions pin the decisions that are easy to break by accident and
 * expensive to debug in a browser: Firefox-only Manifest V3 with an event page
 * (never a service worker), the host permission that `proxy.onRequest` requires, the
 * absence of the `tabs` permission, and an honest AMO data-collection declaration.
 */
import { describe, expect, it } from "vitest";
import manifestJson from "../public/manifest.json";
import packageJson from "../package.json";

interface ContentScriptShape {
  matches?: string[];
  js?: string[];
  run_at?: string;
  world?: string;
  all_frames?: boolean;
  match_about_blank?: boolean;
}

interface ManifestShape {
  manifest_version: number;
  name: string;
  version: string;
  description: string;
  background?: { scripts?: string[]; type?: string; service_worker?: string; persistent?: boolean };
  browser_specific_settings?: {
    gecko?: {
      id?: string;
      strict_min_version?: string;
      strict_max_version?: string;
      data_collection_permissions?: { required?: string[]; optional?: string[] };
    };
  };
  permissions?: string[];
  host_permissions?: string[];
  content_scripts?: ContentScriptShape[];
  icons?: Record<string, string>;
  action?: { default_popup?: string; default_icon?: Record<string, string> };
  options_ui?: { page?: string; open_in_tab?: boolean };
  content_security_policy?: unknown;
}

const manifest = manifestJson as ManifestShape;

/** Values accepted by `browser_specific_settings.gecko.data_collection_permissions`. */
const DATA_CATEGORIES = [
  "authenticationInfo",
  "bookmarksInfo",
  "browsingActivity",
  "financialAndPaymentInfo",
  "healthInfo",
  "locationInfo",
  "personalCommunications",
  "personallyIdentifyingInfo",
  "searchTerms",
  "websiteActivity",
  "websiteContent",
];

describe("manifest", () => {
  it("is Manifest V3 with matching version metadata", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.version).toBe(packageJson.version);
    expect(manifest.name).toBe("net-identity");
    expect(manifest.description).toContain("Firefox network identity manager");
  });

  it("uses a Firefox event page instead of a Chrome-style service worker", () => {
    expect(manifest.background?.scripts).toEqual(["background.js"]);
    expect(manifest.background?.type).toBe("module");
    expect(manifest.background?.service_worker).toBeUndefined();
    // `persistent` is Manifest V2 only.
    expect(manifest.background?.persistent).toBeUndefined();
  });

  it("declares the Firefox target with an id and a version floor", () => {
    const gecko = manifest.browser_specific_settings?.gecko;
    expect(gecko?.id).toBe("net-identity@jacek4yang.github.io");
    expect(gecko?.strict_min_version).toBe("140.0");
    // No upper bound: the extension must keep working on newer Firefox builds.
    expect(gecko?.strict_max_version).toBeUndefined();
  });

  it("declares data collection honestly while a GeoIP provider is in use", () => {
    const declared = manifest.browser_specific_settings?.gecko?.data_collection_permissions;
    expect(declared).toBeDefined();
    expect(Array.isArray(declared?.required)).toBe(true);

    // Automatic profiles contact a third-party GeoIP provider, so claiming "none"
    // would be false.
    expect(declared?.required).not.toEqual(["none"]);
    for (const entry of [...(declared?.required ?? []), ...(declared?.optional ?? [])]) {
      expect(DATA_CATEGORIES, `unknown data category ${entry}`).toContain(entry);
    }
    expect(declared?.required).toContain("locationInfo");
    expect(declared?.optional).toContain("personallyIdentifyingInfo");
  });

  it("runs both content scripts at document_start, with the shim in the page world", () => {
    const scripts = manifest.content_scripts ?? [];
    expect(scripts).toHaveLength(2);

    const bridge = scripts.find((script) => script.js?.includes("content/bridge.js"));
    const shim = scripts.find((script) => script.js?.includes("content/page-shim.js"));

    expect(bridge).toBeDefined();
    expect(shim).toBeDefined();
    // The isolated bridge must keep the default world; only the shim needs MAIN.
    expect(bridge?.world).toBeUndefined();
    expect(shim?.world).toBe("MAIN");

    for (const script of scripts) {
      expect(script.run_at).toBe("document_start");
      expect(script.matches).toEqual(["<all_urls>"]);
      // Subframes, about:blank and about:srcdoc must see the same identity.
      expect(script.all_frames).toBe(true);
      expect(script.match_about_blank).toBe(true);
    }
  });

  it("requests only the permissions the implementation uses", () => {
    expect([...(manifest.permissions ?? [])].sort()).toEqual([
      "privacy",
      "proxy",
      "storage",
      "webRequest",
      "webRequestBlocking",
    ]);
    // Tab metadata is never read; `tabs.query` works through the host permission.
    expect(manifest.permissions).not.toContain("tabs");
  });

  it("requests the host permission that proxy.onRequest requires", () => {
    // Firefox only calls proxy.onRequest for URLs inside the extension's host
    // permissions, so <all_urls> is a functional requirement.
    expect(manifest.host_permissions).toEqual(["<all_urls>"]);
  });

  it("wires up icons, the popup and the options page", () => {
    expect(Object.keys(manifest.icons ?? {}).sort()).toEqual(["128", "48", "96"]);
    expect(manifest.action?.default_popup).toBe("popup/popup.html");
    expect(manifest.options_ui?.page).toBe("options/options.html");
    expect(manifest.options_ui?.open_in_tab).toBe(true);
    for (const path of Object.values(manifest.icons ?? {})) {
      expect(path.startsWith("icons/")).toBe(true);
    }
  });

  it("does not relax the content security policy", () => {
    expect(manifest.content_security_policy).toBeUndefined();
  });
});

describe("package metadata", () => {
  it("is MIT licensed with a Node floor matching the toolchain", () => {
    expect(packageJson.license).toBe("MIT");
    expect(packageJson.engines.node).toBe(">=22");
    expect(packageJson.type).toBe("module");
  });

  it("ships no runtime dependencies", () => {
    expect(packageJson).not.toHaveProperty("dependencies");
    expect(packageJson).not.toHaveProperty("optionalDependencies");
  });

  it("keeps the documented scripts available", () => {
    for (const script of ["build", "check", "dev", "package", "test", "typecheck", "lint:ext"]) {
      expect(packageJson.scripts, script).toHaveProperty(script);
    }
  });
});
