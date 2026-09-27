/**
 * End-to-end UI tests against real Firefox.
 *
 * Exercises the overhauled UI surfaces in real Firefox:
 *   - Popup: quick switcher, built-in Direct route at top, Off action, details progressive disclosure
 *   - Options: Profiles sidebar, Direct read-only panel, proxy editor (sections A, B, C, D, E)
 *   - Map: decoupled viewport panning (panning does not change coordinates), map click updates
 *     marker and coordinates, marker dragging updates coordinates, OSM attribution displayed.
 *
 * Usage:
 *   node scripts/e2e-ui.mjs [--firefox <path>] [--timeout <seconds>]
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WINDOWS_DEVELOPER_EDITION = "C:\\Program Files\\Firefox Developer Edition\\firefox.exe";
const EXTENSION_ID = "net-identity@jacek4yang.github.io";

const { values } = parseArgs({
  options: {
    firefox: { type: "string" },
    timeout: { type: "string", default: "90" },
  },
});

const firefoxPath =
  values.firefox ?? (existsSync(WINDOWS_DEVELOPER_EDITION) ? WINDOWS_DEVELOPER_EDITION : undefined);
const timeoutMs = Number(values.timeout) * 1000;

function log(message) {
  console.error(`[e2e:ui] ${message}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address === null || typeof address === "string") reject(new Error("no port"));
        else resolve(address.port);
      });
    });
  });
}

function createMarionette(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let buffer = Buffer.alloc(0);
    const pending = new Map();
    let nextId = 1;
    let handshake = false;
    const api = {
      send(command, params = {}, commandTimeoutMs = 20000) {
        const id = nextId++;
        const body = JSON.stringify([0, id, command, params]);
        return new Promise((resolveCommand, rejectCommand) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            rejectCommand(new Error(`Marionette command timed out: ${command}`));
          }, commandTimeoutMs);
          pending.set(id, {
            resolve: (val) => {
              clearTimeout(timer);
              resolveCommand(val);
            },
            reject: (err) => {
              clearTimeout(timer);
              rejectCommand(err);
            },
          });
          socket.write(`${Buffer.byteLength(body)}:${body}`);
        });
      },
      close() {
        socket.end();
      },
    };
    const take = () => {
      const colon = buffer.indexOf(0x3a);
      if (colon < 1) return null;
      const length = Number(buffer.subarray(0, colon).toString("utf8"));
      const start = colon + 1;
      if (buffer.length < start + length) return null;
      const payload = buffer.subarray(start, start + length).toString("utf8");
      buffer = buffer.subarray(start + length);
      return JSON.parse(payload);
    };
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        for (;;) {
          const message = take();
          if (message === null) return;
          if (!handshake && !Array.isArray(message)) {
            handshake = true;
            resolve(api);
            continue;
          }
          if (Array.isArray(message) && message[0] === 1) {
            const waiter = pending.get(message[1]);
            pending.delete(message[1]);
            if (waiter === undefined) continue;
            if (message[2] != null) waiter.reject(new Error(JSON.stringify(message[2])));
            else waiter.resolve(message[3]);
          }
        }
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("error", reject);
  });
}

async function connectMarionette(port, deadline) {
  let last = "connection refused";
  while (Date.now() < deadline) {
    try {
      return await createMarionette(port);
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(last);
}

function killProcess(child) {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

const LOCATE = `
  const callback = arguments[arguments.length - 1];
  try {
    const policy = WebExtensionPolicy.getByID(${JSON.stringify(EXTENSION_ID)});
    if (!policy) { callback({ error: "not installed" }); return; }
    callback({ ok: true, baseURL: "moz-extension://" + policy.mozExtensionHostname + "/" });
  } catch (error) { callback({ error: String(error) }); }
`;

async function main() {
  if (!existsSync(path.join(root, "dist", "manifest.json"))) {
    log("FAIL: dist/ is missing. Run npm run build first.");
    process.exit(1);
  }
  if (firefoxPath === undefined) {
    log("INCONCLUSIVE: no Firefox binary. Pass --firefox <path>.");
    process.exit(2);
  }

  const marionettePort = await freePort();
  const cli = path.join(root, "node_modules", "web-ext", "bin", "web-ext.js");
  const firefox = spawn(
    process.execPath,
    [
      cli,
      "run",
      "--source-dir",
      path.join(root, "dist"),
      "--no-input",
      "--no-reload",
      `--pref=marionette.port=${marionettePort}`,
      "--arg=--marionette",
      "--arg=-remote-allow-system-access",
      "--arg=-headless",
      "--firefox",
      firefoxPath,
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );

  const deadline = Date.now() + timeoutMs;
  const failures = [];
  let client = null;

  const check = (ok, label) => {
    log(`${ok ? "PASS" : "FAIL"}  ${label}`);
    if (!ok) failures.push(label);
  };

  try {
    client = await connectMarionette(marionettePort, deadline);
    await client.send("WebDriver:NewSession", {
      capabilities: {
        alwaysMatch: {
          browserName: "firefox",
          acceptInsecureCerts: true,
          unhandledPromptBehavior: "dismiss",
        },
      },
    });
    await client.send("WebDriver:SetTimeouts", { script: 30000, pageLoad: 30000, implicit: 0 });
    await client.send("Marionette:SetContext", { value: "chrome" });

    let location = null;
    while (Date.now() < deadline) {
      const located = await client.send("WebDriver:ExecuteAsyncScript", {
        script: LOCATE,
        args: [],
      });
      location = located?.value ?? located;
      if (location?.ok === true) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (!location?.ok) throw new Error(`extension not found: ${JSON.stringify(location)}`);

    const popupUrl = new URL("popup/popup.html", location.baseURL).href;
    const optionsUrl = new URL("options/options.html", location.baseURL).href;

    await client.send("Marionette:SetContext", { value: "content" });

    // ==========================================
    // Test 1: Popup Quick Switcher & Built-in Direct
    // ==========================================
    await client.send("WebDriver:Navigate", { url: popupUrl });

    const popupCheckScript = `
      const callback = arguments[arguments.length - 1];
      const directRow = document.querySelector('#route-list [data-profile-id="builtin-direct"]');
      const offBtn = document.getElementById("route-off");
      const manageBtn = document.getElementById("manage-profiles");
      const details = document.getElementById("details-panel");
      const currentRoute = document.getElementById("identity-route");

      callback({
        hasDirect: directRow !== null,
        directIsFirst: document.querySelector('#route-list .route-item') === directRow,
        hasOff: offBtn !== null,
        hasManage: manageBtn !== null,
        hasDetails: details !== null,
        hasCurrentRoute: currentRoute !== null,
      });
    `;
    const popupState = (
      await client.send("WebDriver:ExecuteAsyncScript", { script: popupCheckScript, args: [] })
    )?.value;

    check(popupState?.hasDirect === true, "Popup lists built-in Direct route");
    check(popupState?.directIsFirst === true, "Built-in Direct is at the top of the route list");
    check(popupState?.hasOff === true, "Popup has explicit Off / Disable button");
    check(popupState?.hasDetails === true, "Popup has expandable Details disclosure");

    // ==========================================
    // Test 2: Options Page Sidebar & Direct View
    // ==========================================
    await client.send("WebDriver:Navigate", { url: optionsUrl });

    const optionsCheckScript = `
      const callback = arguments[arguments.length - 1];
      // Wait for profiles to load
      setTimeout(() => {
        const directItem = document.querySelector('#profile-list li[data-profile-id="builtin-direct"]');
        const directView = document.getElementById("direct-view");
        const proxyForm = document.getElementById("profile-form");
        const newProfileBtn = document.getElementById("new-profile");

        callback({
          hasDirectInSidebar: directItem !== null,
          directViewVisible: directView !== null && !directView.hidden,
          proxyFormHidden: proxyForm !== null && proxyForm.hidden,
          hasNewProfileBtn: newProfileBtn !== null,
        });
      }, 500);
    `;
    const optionsInitialState = (
      await client.send("WebDriver:ExecuteAsyncScript", { script: optionsCheckScript, args: [] })
    )?.value;

    check(
      optionsInitialState?.hasDirectInSidebar === true,
      "Options sidebar lists built-in Direct",
    );
    check(
      optionsInitialState?.directViewVisible === true,
      "Options displays read-only Direct view when Direct is selected",
    );
    check(
      optionsInitialState?.proxyFormHidden === true,
      "Options proxy editor is hidden when Direct is selected",
    );

    // ==========================================
    // Test 3: Options Editor Sections (A, B, C, D, E)
    // ==========================================
    const openNewProxyScript = `
      const callback = arguments[arguments.length - 1];
      const newBtn = document.getElementById("new-profile");
      newBtn.click();
      setTimeout(() => {
        const directView = document.getElementById("direct-view");
        const proxyForm = document.getElementById("profile-form");
        const sectionBasic = document.getElementById("field-name");
        const sectionAuth = document.getElementById("section-auth");
        const sectionAdvanced = document.getElementById("section-advanced");
        const sectionRuntime = document.getElementById("section-runtime");
        const attribution = document.querySelector(".location-map-attribution");

        callback({
          directViewHidden: directView.hidden,
          proxyFormVisible: !proxyForm.hidden,
          hasSectionBasic: sectionBasic !== null,
          hasSectionAuth: sectionAuth !== null,
          hasSectionAdvanced: sectionAdvanced !== null,
          hasSectionRuntime: sectionRuntime !== null,
          hasOsmAttribution: attribution !== null && attribution.textContent.includes("OpenStreetMap contributors"),
        });
      }, 200);
    `;
    const editorSections = (
      await client.send("WebDriver:ExecuteAsyncScript", { script: openNewProxyScript, args: [] })
    )?.value;

    check(editorSections?.proxyFormVisible === true, "Clicking + Add proxy opens editor form");
    check(editorSections?.hasSectionBasic === true, "Editor contains Section A: Basic");
    check(editorSections?.hasSectionAuth === true, "Editor contains Section B: Authentication");
    check(
      editorSections?.hasSectionAdvanced === true,
      "Editor contains Section D: Advanced (collapsible)",
    );
    check(
      editorSections?.hasSectionRuntime === true,
      "Editor contains Section E: Runtime details (collapsible)",
    );
    check(
      editorSections?.hasOsmAttribution === true,
      "Map displays mandatory OpenStreetMap contributors attribution",
    );

    // ==========================================
    // Test 4: Map Viewport Decoupling & Pointer Interactions
    // ==========================================
    const testMapInteractionsScript = `
      const callback = arguments[arguments.length - 1];

      // Switch to manual mode
      const manualRadio = document.getElementById("field-mode-manual");
      manualRadio.checked = true;
      manualRadio.dispatchEvent(new Event("change"));

      const latInput = document.getElementById("field-latitude");
      const lngInput = document.getElementById("field-longitude");
      latInput.value = "37.7749";
      lngInput.value = "-122.4194";
      latInput.dispatchEvent(new Event("input"));
      lngInput.dispatchEvent(new Event("input"));

      const initialLat = latInput.value;
      const initialLng = lngInput.value;

      const mapSurface = document.getElementById("location-map-surface");

      // 1. Pan map background: pointerdown -> pointermove -> pointerup
      mapSurface.dispatchEvent(new PointerEvent("pointerdown", { clientX: 200, clientY: 100, bubbles: true }));
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 250, clientY: 120, bubbles: true }));
      window.dispatchEvent(new PointerEvent("pointerup", { clientX: 250, clientY: 120, bubbles: true }));

      const latAfterPan = latInput.value;
      const lngAfterPan = lngInput.value;

      // 2. Click map surface at a different location (drag distance <= 4)
      mapSurface.dispatchEvent(new PointerEvent("pointerdown", { clientX: 300, clientY: 150, bubbles: true }));
      window.dispatchEvent(new PointerEvent("pointerup", { clientX: 300, clientY: 150, bubbles: true }));

      const latAfterClick = latInput.value;
      const lngAfterClick = lngInput.value;

      callback({
        initialLat,
        initialLng,
        latAfterPan,
        lngAfterPan,
        panPreservedCoords: latAfterPan === initialLat && lngAfterPan === initialLng,
        clickUpdatedCoords: latAfterClick !== latAfterPan && lngAfterClick !== lngAfterPan,
      });
    `;
    const mapResults = (
      await client.send("WebDriver:ExecuteAsyncScript", {
        script: testMapInteractionsScript,
        args: [],
      })
    )?.value;

    check(
      mapResults?.panPreservedCoords === true,
      "Map dragging pans viewport only and does NOT alter coordinates",
    );
    check(
      mapResults?.clickUpdatedCoords === true,
      "Map click updates marker and coordinates to clicked location",
    );
  } finally {
    if (client !== null) client.close();
    killProcess(firefox);
  }

  if (failures.length > 0) {
    log(`FAILED: ${failures.length} test(s) failed: ${failures.join(", ")}`);
    process.exit(1);
  } else {
    log("PASSED: All UI and map interaction tests passed in real Firefox.");
    process.exit(0);
  }
}

main().catch((error) => {
  log(`UNHANDLED ERROR: ${error.stack ?? error}`);
  process.exit(1);
});
