/** Permanent install in a fresh, signature-enforcing normal Firefox profile. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { connectMarionette } from "./release-marionette.mjs";

const { values } = parseArgs({
  options: {
    firefox: { type: "string", default: "/usr/bin/firefox" },
    xpi: { type: "string" },
    version: { type: "string" },
    output: { type: "string", default: "artifacts/signature-proof.json" },
    "expect-unsigned": { type: "boolean", default: false },
  },
});
if (!values.xpi || !values.version) throw new Error("--xpi and --version required");
const xpi = path.resolve(values.xpi);
const hash = createHash("sha256")
  .update(await readFile(xpi))
  .digest("hex");
const profile = await mkdtemp(path.join(os.tmpdir(), "ni-signature-"));
const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => resolve(address.port));
  });
});
await writeFile(
  path.join(profile, "user.js"),
  [
    `user_pref("marionette.port", ${port});`,
    'user_pref("xpinstall.signatures.required", true);',
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("browser.startup.homepage_override.mstone", "ignore");',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
  ].join("\n"),
);
const child = spawn(
  values.firefox,
  [
    "--no-remote",
    "--headless",
    "--marionette",
    "--remote-allow-system-access",
    "--profile",
    profile,
  ],
  { stdio: "ignore", windowsHide: true },
);
let launchError;
child.on("error", (error) => {
  launchError = error;
});
let client;
try {
  client = await connectMarionette(port, Date.now() + 30_000);
  if (launchError) throw launchError;
  const session = await client.send("WebDriver:NewSession", {
    capabilities: { alwaysMatch: { browserName: "firefox" } },
  });
  const capabilities = session.value?.capabilities ?? session.capabilities;
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(capabilities?.browserVersion ?? ""))
    throw new Error("Normal stable Firefox required");
  await client.send("Marionette:SetContext", { value: "chrome" });
  const result = await client.send("WebDriver:ExecuteAsyncScript", {
    script: `
      const [filename, expectedId, expectedVersion] = arguments;
      const done = arguments[arguments.length - 1];
      (async () => {
        const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
        const { FileUtils } = ChromeUtils.importESModule("resource://gre/modules/FileUtils.sys.mjs");
        if (!Services.prefs.getBoolPref("xpinstall.signatures.required")) throw new Error("Signature enforcement disabled");
        const install = await AddonManager.getInstallForFile(new FileUtils.File(filename));
        if (install.error) { done({ installError: install.error, signatureError: AddonManager.ERROR_SIGNEDSTATE_REQUIRED }); return; }
        await install.install();
        const addon = await AddonManager.getAddonByID(expectedId);
        if (!addon || addon.version !== expectedVersion || addon.appDisabled || addon.temporarilyInstalled) throw new Error("Permanent installation mismatch");
        done({ signed: [AddonManager.SIGNEDSTATE_SIGNED, AddonManager.SIGNEDSTATE_PRIVILEGED].includes(addon.signedState),
          extensionId: addon.id, version: addon.version, signedState: addon.signedState,
          signatureRequired: Services.prefs.getBoolPref("xpinstall.signatures.required"),
          temporarilyInstalled: addon.temporarilyInstalled, updateUrl: addon.updateURL ?? null });
      })().catch(() => done({ error: "Firefox signature/install verification failed" }));
    `,
    args: [xpi, "net-identity@jacek4yang.github.io", values.version],
  });
  const proof = result.value ?? result;
  if (values["expect-unsigned"]) {
    if (typeof proof.installError !== "number" || proof.installError !== proof.signatureError)
      throw new Error("Unsigned fixture was not rejected by signature enforcement");
    console.error("PASS: normal Firefox rejects unsigned installer");
  } else {
    if (proof.signed !== true || proof.error || proof.installError)
      throw new Error("Firefox rejected signed installation");
    await writeFile(
      values.output,
      JSON.stringify(
        { ...proof, sha256: hash, firefoxVersion: capabilities.browserVersion },
        null,
        2,
      ) + "\n",
    );
    console.error("PASS: normal Firefox permanently installed and verified Mozilla signature");
  }
} finally {
  if (client) {
    await client.send("Marionette:Quit", { flags: ["eForceQuit"] }).catch(() => {});
    client.close();
  }
  if (child.exitCode === null) child.kill();
  await new Promise((resolve) => setTimeout(resolve, 500));
  // Only the freshly generated temporary profile is removed.
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
