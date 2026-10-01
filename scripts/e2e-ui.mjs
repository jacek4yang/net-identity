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
 *   node scripts/e2e-ui.mjs --firefox <path> --screenshots store-assets/screenshots
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
    screenshots: { type: "string" },
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
      ...(values.screenshots ? ["--pref=ui.systemUsesDarkTheme=1"] : []),
      "--arg=--marionette",
      "--arg=-remote-allow-system-access",
      "--arg=-headless",
      "--firefox",
      firefoxPath,
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );

  firefox.stderr.on("data", (chunk) => process.stderr.write(chunk));
  firefox.stdout.on("data", (chunk) => process.stderr.write(chunk));
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

    const execute = async (script, args = []) =>
      (await client.send("WebDriver:ExecuteScript", { script, args }))?.value;
    const call = async (message) =>
      (
        await client.send("WebDriver:ExecuteAsyncScript", {
          script: `const done = arguments[arguments.length - 1]; const page = window.wrappedJSObject || window;
        page.browser.runtime.sendMessage(page.JSON.parse(JSON.stringify(arguments[0]))).then(v => done(page.JSON.parse(page.JSON.stringify(v))), e => done({error: String(e)}));`,
          args: [message],
        })
      )?.value;
    async function waitFor(script) {
      for (let i = 0; i < 100; i++) {
        if (await execute(script)) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`UI condition not reached: ${script}`);
    }
    async function click(selector) {
      const found = (
        await client.send("WebDriver:FindElement", { using: "css selector", value: selector })
      )?.value;
      await client.send("WebDriver:ElementClick", {
        id: found["element-6066-11e4-a52e-4f735466cecf"],
      });
    }
    async function fill(values) {
      await execute(
        `for (const [id, value] of Object.entries(arguments[0])) {
        const field = document.getElementById(id); field.value = value;
        field.dispatchEvent(new Event("input", {bubbles: true}));
        field.dispatchEvent(new Event("change", {bubbles: true}));
      }`,
        [values],
      );
    }
    async function readMap() {
      return execute(`const m=document.getElementById("location-map-surface");
        return {lat:document.getElementById("field-latitude").value, lng:document.getElementById("field-longitude").value, center:m.dataset.center, zoom:m.dataset.zoom};`);
    }
    async function point(selector, x = 0.5, y = 0.5) {
      return execute(
        `const e=document.querySelector(arguments[0]); e.scrollIntoView({block:"center"}); const r=e.getBoundingClientRect(); return {x:Math.round(r.left+r.width*arguments[1]), y:Math.round(r.top+r.height*arguments[2])};`,
        [selector, x, y],
      );
    }
    async function pointer(from, to = from) {
      await client.send("WebDriver:PerformActions", {
        actions: [
          {
            type: "pointer",
            id: "mouse",
            parameters: { pointerType: "mouse" },
            actions: [
              { type: "pointerMove", duration: 0, origin: "viewport", ...from },
              { type: "pointerDown", button: 0 },
              { type: "pointerMove", duration: 150, origin: "viewport", ...to },
              { type: "pointerUp", button: 0 },
            ],
          },
        ],
      });
    }

    // Store images use this same real-Firefox fixture and shipped UI. Only
    // synthetic local proxy coordinates are entered; GeoIP is explicitly off.
    if (values.screenshots) {
      const directory = path.resolve(values.screenshots);
      await mkdir(directory, { recursive: true });
      const images = [];
      const capture = async (name, selector, offset = 24, frameIdentityAudit = false) => {
        if (selector)
          await execute(
            'document.querySelector(arguments[0]).scrollIntoView({block:"start"}); window.scrollBy(0, -arguments[1]);',
            [selector, offset],
          );
        else await execute("window.scrollTo(0, 0);");
        await execute("document.activeElement?.blur();");
        await new Promise((resolve) => setTimeout(resolve, 150));
        const result = await client.send("WebDriver:TakeScreenshot", { full: false });
        let encoded = result.value;
        if (frameIdentityAudit) {
          // Reframe only the real, fully visible identity + audit pixels. No
          // status text is removed or altered; surrounding canvas is the same
          // background as the popup. Keep the native scale and 380px layout.
          const framed = await client.send("WebDriver:ExecuteAsyncScript", {
            script: `const done = arguments[arguments.length - 1];
              const top = document.querySelector(".identity-card").getBoundingClientRect();
              const bottom = document.querySelector("#details-panel").getBoundingClientRect();
              const x = Math.floor(top.left), y = Math.floor(top.top);
              const width = Math.ceil(top.right) - x, height = Math.ceil(bottom.bottom) - y;
              if (y < 0 || bottom.bottom > innerHeight || height > 768) {
                done({error: "Identity/audit content does not fit fully inside the capture"}); return;
              }
              const screenshot = new Image();
              screenshot.onload = () => {
                const canvas = document.createElement("canvas");
                canvas.width = 1280; canvas.height = 800;
                const context = canvas.getContext("2d");
                context.fillStyle = getComputedStyle(document.body).backgroundColor;
                context.fillRect(0, 0, 1280, 800);
                context.drawImage(screenshot, x, y, width, height,
                  Math.floor((1280 - width) / 2), Math.floor((800 - height) / 2), width, height);
                done({image: canvas.toDataURL("image/png").split(",")[1]});
              };
              screenshot.onerror = () => done({error: "Could not decode the real Firefox capture"});
              screenshot.src = "data:image/png;base64," + arguments[0];`,
            args: [encoded],
          });
          if (framed.value.error) throw new Error(framed.value.error);
          encoded = framed.value.image;
        }
        const bytes = Buffer.from(encoded, "base64");
        if (bytes.readUInt32BE(16) !== 1280 || bytes.readUInt32BE(20) !== 800) {
          throw new Error(`Unexpected screenshot dimensions for ${name}`);
        }
        await writeFile(path.join(directory, name), bytes);
        images.push({
          file: name,
          width: 1280,
          height: 800,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
        log(`Wrote ${name} (1280 × 800)`);
      };
      // Size by content viewport, not OS-dependent browser decoration height.
      await client.send("WebDriver:SetWindowRect", { width: 1280, height: 900 });
      const windowRect = await client.send("WebDriver:GetWindowRect");
      const rect = windowRect.value ?? windowRect;
      const viewport = await execute("return {width:innerWidth,height:innerHeight};");
      await client.send("WebDriver:SetWindowRect", {
        width: rect.width + 1280 - viewport.width,
        height: rect.height + 800 - viewport.height,
      });
      await client.send("WebDriver:Navigate", { url: optionsUrl });
      await waitFor('return !document.getElementById("direct-view").hidden;');
      await click("#new-profile");
      await fill({
        "field-name": "Tokyo · Local demo",
        "field-proxy-host": "127.0.0.1",
        "field-proxy-port": "9999",
      });
      await click("#field-mode-manual");
      await fill({
        "field-geoip-policy": "disabled",
        "field-latitude": "35.68",
        "field-longitude": "139.76",
        "field-accuracy": "20000",
        "field-timezone": "Asia/Tokyo",
      });
      await click("#save");
      await waitFor(
        'return document.getElementById("form-title").textContent === "Tokyo · Local demo";',
      );
      await click("#save-activate");
      await waitFor(
        'return document.getElementById("options-status").textContent.includes("Asia/Tokyo");',
      );
      await capture("02-profile-management.png");
      await capture("04-local-location-picker.png", ".identity-mode-group", 48);
      await client.send("WebDriver:Navigate", { url: popupUrl });
      await waitFor(
        'return document.getElementById("identity-timezone").textContent === "Asia/Tokyo";',
      );
      // The popup is intrinsically 380px wide. Center the unchanged popup on a
      // plain canvas, without scaling, invented chrome, captions, or overlays.
      await execute(`document.body.style.margin = "0 auto";
        document.body.style.marginTop = Math.max(16, Math.floor((innerHeight - document.body.getBoundingClientRect().height) / 2)) + "px";`);
      await capture("01-active-profile.png");
      await click("#toggle-details");
      await capture("03-identity-audit.png", "#details-panel", 0, true);
      const userAgent = await execute("return navigator.userAgent;");
      const manifest = JSON.parse(await readFile(path.join(root, "dist", "manifest.json"), "utf8"));
      const sourceHashes = {};
      for (const surface of ["popup", "options"]) {
        for (const extension of ["html", "css", "js"]) {
          const file = `${surface}/${surface}.${extension}`;
          sourceHashes[file] = createHash("sha256")
            .update(await readFile(path.join(root, "dist", file)))
            .digest("hex");
        }
      }
      await writeFile(
        path.join(directory, "metadata.json"),
        JSON.stringify(
          {
            extensionVersion: manifest.version,
            provenance: {
              build: "unsigned local candidate",
              installation: "temporary add-on installed by web-ext in disposable Firefox profile",
              sourceDirectory: "dist",
              signedRelease: false,
            },
            userAgent,
            theme: "dark",
            sourceHashes,
            fixture: {
              profile: "Tokyo · Local demo",
              proxy: "127.0.0.1:9999",
              geoip: "disabled",
              credentials: false,
              latitude: 35.68,
              longitude: 139.76,
              accuracy: 20000,
              timezone: "Asia/Tokyo",
            },
            images,
          },
          null,
          2,
        ) + "\n",
      );
      await call({ type: "profiles:deactivate" });
      log("Store captures complete: synthetic local fixture, GeoIP disabled.");
      return;
    }

    await client.send("WebDriver:Navigate", { url: popupUrl });
    await waitFor(
      `return !!document.querySelector('#route-list [data-profile-id="builtin-direct"]');`,
    );
    check(
      await execute("return document.body.offsetWidth >= 360 && document.body.offsetWidth <= 420;"),
      "Popup opens at compact utility width",
    );
    check(
      await execute(
        'return document.querySelector("#route-list button").dataset.profileId === "builtin-direct";',
      ),
      "Direct always exists on fresh install",
    );
    check(
      await execute('return document.getElementById("details-panel").hidden;'),
      "Advanced diagnostics are collapsed",
    );
    await click('[data-profile-id="builtin-direct"]');
    await waitFor('return document.getElementById("status-text").textContent === "Active";');
    const direct = await call({ type: "state:get" });
    check(
      direct.state.activeProfileId === "builtin-direct" &&
        direct.state.lastError?.code === "consent_required",
      "One click activates Direct without optional GeoIP consent",
    );
    await click("#route-off");
    await waitFor('return document.getElementById("status-text").textContent === "Off";');
    check(
      (await call({ type: "state:get" })).state.activeProfileId === null,
      "One click Off deactivates",
    );

    await client.send("WebDriver:Navigate", { url: optionsUrl });
    await waitFor('return !document.getElementById("direct-view").hidden;');
    check(
      await execute('return document.getElementById("profile-form").hidden;'),
      "Built-in Direct is read-only",
    );
    await click("#new-profile");
    await fill({
      "field-name": "UI proxy",
      "field-proxy-host": "127.0.0.1",
      "field-proxy-port": "9999",
    });
    await click("#field-mode-manual");
    await fill({
      "field-geoip-policy": "disabled",
      "field-latitude": "35",
      "field-longitude": "139",
      "field-accuracy": "1000",
      "field-timezone": "Asia/Tokyo",
    });
    await click("#save");
    await waitFor('return document.getElementById("form-title").textContent === "UI proxy";');
    const list = await call({ type: "profiles:list" });
    const id = list.profiles.find((p) => p.name === "UI proxy").id;
    check(
      (await call({ type: "state:get" })).state.activeProfileId === null,
      "Save creates a profile without activation",
    );
    check(
      await execute(
        'return !document.getElementById("section-advanced").open && !document.getElementById("section-runtime").open;',
      ),
      "Advanced and runtime sections start collapsed",
    );

    const originalWindow = (await client.send("WebDriver:GetWindowHandle"))?.value;
    // openPopup resolves before the chrome panel finishes opening. Its <browser>
    // is separate from the selected Options tab and is not a new window handle.
    const opened = await client.send("WebDriver:ExecuteAsyncScript", {
      script: `const done=arguments[arguments.length-1]; const page=window.wrappedJSObject || window;
        page.browser.action.openPopup().then(()=>done(true),e=>done(String(e)));`,
      args: [],
    });
    if (opened?.value !== true) throw new Error(`openPopup failed: ${JSON.stringify(opened)}`);
    await client.send("Marionette:SetContext", { value: "chrome" });
    await waitFor(`return [...document.querySelectorAll('panel')].some(p =>
      p.state === 'open' && [...p.querySelectorAll('browser')].some(b => b.currentURI?.spec === ${JSON.stringify(popupUrl)}));`);
    // Remote extension panels are not tab frames. Address the panel's own
    // Marionette actor from chrome rather than accidentally querying Options.
    const popupExecute = async (script) => {
      const result = await client.send("WebDriver:ExecuteAsyncScript", {
        script: `const done=arguments[arguments.length-1];
          const b=[...document.querySelectorAll('panel')].filter(p=>p.state==='open')
            .flatMap(p=>[...p.querySelectorAll('browser')]).find(b=>b.currentURI?.spec===arguments[0]);
          if (!b) { done({error:'Popup browser missing'}); return; }
          b.browsingContext.currentWindowGlobal.getActor('MarionetteCommands')
            .executeScript(arguments[1], [], {sandboxName:'default',newSandbox:true})
            .then(value=>done({value}), e=>done({error:String(e)}));`,
        args: [popupUrl, script],
      });
      if (result.value.error) throw new Error(result.value.error);
      return result.value.value;
    };
    const popupWait = async (script) => {
      for (let i = 0; i < 100; i++) {
        if (await popupExecute(script)) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`Popup condition not reached: ${script}`);
    };
    await popupWait(`return !!document.querySelector('[data-profile-id="builtin-direct"]');`);
    check(
      await popupExecute(`return document.URL === ${JSON.stringify(popupUrl)};`),
      "Firefox browser action opens the actual popup panel",
    );
    await popupExecute(`document.querySelector('[data-profile-id="builtin-direct"]').click();`);
    await popupWait('return document.getElementById("status-text").textContent === "Active";');
    check(
      await popupExecute(
        'return document.getElementById("identity-route").textContent === "Direct";',
      ),
      "Actual toolbar popup switches Direct without consent",
    );
    await popupExecute(`document.querySelector('[data-profile-id="${id}"]').click();`);
    await popupWait(
      'return document.getElementById("identity-timezone").textContent === "Asia/Tokyo";',
    );
    check(
      await popupExecute(
        'return document.getElementById("identity-route").textContent === "UI proxy";',
      ),
      "Actual toolbar popup switches the proxy and displays its identity",
    );
    await popupExecute(`document.querySelector('[data-profile-id="builtin-direct"]').click();`);
    await popupWait(
      'return document.getElementById("identity-route").textContent === "Direct" && document.getElementById("status-text").textContent === "Active";',
    );
    check(
      await popupExecute(
        'return document.getElementById("identity-timezone").textContent !== "Asia/Tokyo";',
      ),
      "Actual toolbar popup clears stale proxy identity on Direct",
    );
    await popupExecute('document.getElementById("route-off").click();');
    await popupWait('return document.getElementById("status-text").textContent === "Off";');
    await execute(`for (const p of document.querySelectorAll("panel"))
      if (p.state === "open") p.hidePopup();`);
    await client.send("Marionette:SetContext", { value: "content" });
    await client.send("WebDriver:SwitchToWindow", { handle: originalWindow });
    await client.send("WebDriver:SwitchToFrame", { id: null });
    await waitFor(
      `return document.URL === ${JSON.stringify(optionsUrl)} && document.getElementById("field-name").value === "UI proxy";`,
    );

    await client.send("WebDriver:Navigate", { url: popupUrl });
    await waitFor(`return !!document.querySelector('[data-profile-id="${id}"]');`);
    await click(`[data-profile-id="${id}"]`);
    await waitFor(
      'return document.getElementById("identity-timezone").textContent === "Asia/Tokyo";',
    );
    check(
      (await call({ type: "state:get" })).state.proxy.port === 9999,
      "Proxy row switches in one click and identity summary updates",
    );
    await click('[data-profile-id="builtin-direct"]');
    await waitFor(
      'return document.getElementById("identity-route").textContent === "Direct" && document.getElementById("status-text").textContent === "Active";',
    );
    check(
      (await call({ type: "state:get" })).state.identity.timezone === undefined,
      "Direct switches back in one click and clears proxy identity",
    );
    await click(`[data-profile-id="${id}"]`);
    await waitFor(
      'return document.getElementById("identity-timezone").textContent === "Asia/Tokyo";',
    );

    await client.send("WebDriver:Navigate", { url: optionsUrl });
    await waitFor(`return !!document.querySelector('[data-profile-id="${id}"]');`);
    await click(`[data-profile-id="${id}"]`);
    check(
      await execute('return document.getElementById("field-name").value === "UI proxy";'),
      "Existing profile opens naturally for editing",
    );
    const before = (await call({ type: "state:get" })).state;
    await fill({ "field-proxy-port": "9998", "field-timezone": "Europe/Paris" });
    await click("#save");
    await waitFor('return document.getElementById("save-status").textContent.includes("pending");');
    const saved = (await call({ type: "state:get" })).state;
    check(
      saved.generation === before.generation &&
        saved.proxy.port === 9999 &&
        saved.identity.timezone === "Asia/Tokyo",
      "Save preserves runtime and shows pending changes",
    );
    const savedRevision = (await call({ type: "profiles:list" })).profiles.find(
      (p) => p.id === id,
    ).revision;
    await fill({ "field-proxy-port": "9997", "field-timezone": "America/New_York" });
    await click("#save-activate");
    await waitFor(
      'return document.getElementById("options-status").textContent.includes("Europe/Paris");',
    );
    const applied = (await call({ type: "state:get" })).state;
    check(
      applied.generation > saved.generation &&
        applied.proxy.port === 9998 &&
        applied.identity.timezone === "Europe/Paris" &&
        applied.appliedRevision === savedRevision,
      "Apply commits saved routing and identity together",
    );
    check(
      (await execute('return document.getElementById("field-proxy-port").value === "9997";')) &&
        (await call({ type: "profiles:list" })).profiles.find((p) => p.id === id).revision ===
          savedRevision,
      "Apply neither saves nor discards unsaved form edits",
    );

    await fill({ "field-latitude": "35", "field-longitude": "139" });
    for (const cancellation of ["pointercancel", "lostpointercapture", "blur"]) {
      const prior = await readMap();
      await execute(`const s=document.getElementById('location-map-surface');
        s.addEventListener('pointerdown',e=>s.dataset.testPointerId=String(e.pointerId),{once:true});`);
      const p = await point("#location-map-surface", 0.25, 0.55);
      await client.send("WebDriver:PerformActions", {
        actions: [
          {
            type: "pointer",
            id: "mouse",
            parameters: { pointerType: "mouse" },
            actions: [
              { type: "pointerMove", duration: 0, origin: "viewport", ...p },
              { type: "pointerDown", button: 0 },
              { type: "pointerMove", duration: 0, origin: "viewport", x: p.x + 1, y: p.y },
            ],
          },
        ],
      });
      await execute(
        `const s=document.getElementById('location-map-surface');
        const id=Number(s.dataset.testPointerId);
        if(arguments[0]==='blur') window.dispatchEvent(new Event('blur'));
        else if(arguments[0]==='lostpointercapture') s.releasePointerCapture(id);
        else s.dispatchEvent(new PointerEvent('pointercancel',{pointerId:id,bubbles:true}));`,
        [cancellation],
      );
      await client.send("WebDriver:PerformActions", {
        actions: [
          {
            type: "pointer",
            id: "mouse",
            parameters: { pointerType: "mouse" },
            actions: [
              { type: "pointerMove", duration: 0, origin: "viewport", x: p.x + 1, y: p.y },
              { type: "pointerUp", button: 0 },
            ],
          },
        ],
      });
      const after = await readMap();
      check(
        after.lat === prior.lat &&
          after.lng === prior.lng &&
          after.center === prior.center &&
          (await execute(
            'return !document.getElementById("location-map-surface").classList.contains("is-grabbing");',
          )),
        `${cancellation} cancels a real pointer gesture without selecting`,
      );
    }
    const original = await readMap();
    const background = await point("#location-map-surface", 0.25, 0.55);
    await pointer(background, { x: background.x + 65, y: background.y + 15 });
    let next = await readMap();
    check(
      next.lat === original.lat && next.lng === original.lng && next.center !== original.center,
      "Real pointer drag pans without changing selection",
    );
    await pointer(await point("#location-map-surface", 0.25, 0.7));
    let selected = await readMap();
    check(
      selected.lat !== next.lat || selected.lng !== next.lng,
      "Real map click selects a location",
    );
    const marker = await point("#location-map-marker");
    await pointer(marker, { x: marker.x + 2, y: marker.y + 1 });
    const jittered = await readMap();
    check(
      jittered.lat === selected.lat &&
        jittered.lng === selected.lng &&
        jittered.center === selected.center,
      "Marker pointer jitter does not change selection or viewport",
    );
    await pointer(marker, { x: marker.x + 35, y: marker.y - 15 });
    next = await readMap();
    check(
      (next.lat !== selected.lat || next.lng !== selected.lng) && next.center === selected.center,
      "Real marker drag changes selection without panning",
    );
    const wheelPoint = await point("#location-map-surface", 0.4, 0.6);
    await client.send("WebDriver:PerformActions", {
      actions: [
        {
          type: "wheel",
          id: "wheel",
          actions: [
            {
              type: "scroll",
              duration: 0,
              origin: "viewport",
              ...wheelPoint,
              deltaX: 0,
              deltaY: -120,
            },
          ],
        },
      ],
    });
    await waitFor(
      `return Number(document.getElementById("location-map-surface").dataset.zoom) > ${Number(next.zoom)};`,
    );
    selected = await readMap();
    check(
      Number(selected.zoom) === Number(next.zoom) + 1 && selected.lat === next.lat,
      "Wheel zoom works independently of selection",
    );
    await fill({ "field-latitude": "-33", "field-longitude": "151" });
    next = await readMap();
    check(next.center === "-33,151", "Typed coordinates update marker and recenter predictably");
    check(
      await execute(
        'return document.querySelector(".location-map-attribution").textContent.includes("No map imagery") && document.querySelectorAll("#location-map-tiles img").length === 0;',
      ),
      "Production tile provider makes no requests and discloses local grid",
    );

    await client.send("Marionette:SetContext", { value: "chrome" });
    await client.send("WebDriver:ExecuteScript", {
      script: "Services.io.offline = true;",
      args: [],
    });
    await client.send("Marionette:SetContext", { value: "content" });
    await fill({ "field-latitude": "12", "field-longitude": "45" });
    next = await readMap();
    await pointer(await point("#location-map-surface", 0.2, 0.6));
    selected = await readMap();
    check(
      next.center === "12,45" && selected.lat !== next.lat,
      "Offline/no-tile mode preserves typed and pointer selection",
    );
    await client.send("Marionette:SetContext", { value: "chrome" });
    await client.send("WebDriver:ExecuteScript", {
      script: "Services.io.offline = false;",
      args: [],
    });
    await client.send("Marionette:SetContext", { value: "content" });
    const beforeResize = await readMap();
    const oldWidth = await execute(
      'return document.getElementById("location-map-surface").clientWidth;',
    );
    await client.send("WebDriver:SetWindowRect", { width: 900, height: 900 });
    await waitFor(
      `return document.getElementById("location-map-surface").clientWidth !== ${oldWidth};`,
    );
    const afterResize = await readMap();
    check(
      afterResize.lat === beforeResize.lat &&
        afterResize.lng === beforeResize.lng &&
        afterResize.center === beforeResize.center &&
        afterResize.zoom === beforeResize.zoom,
      "Resize preserves geographic selection, viewport center and zoom",
    );
    await click("#new-profile");
    const reset = await readMap();
    check(
      reset.lat === "" && reset.lng === "" && Number(reset.zoom) === 2,
      "New profile resets old selection and zoom",
    );
    const autoPoint = await point("#location-map-surface", 0.25, 0.5);
    await pointer(autoPoint, { x: autoPoint.x + 40, y: autoPoint.y + 10 });
    const autoPan = await readMap();
    await pointer(await point("#location-map-surface", 0.25, 0.5));
    const autoClick = await readMap();
    check(
      autoPan.center !== reset.center && autoClick.lat === "" && autoClick.lng === "",
      "Automatic preview permits panning but never selects on click",
    );
    await click("#deactivate");
    check(
      (await call({ type: "state:get" })).state.activeProfileId === null,
      "Final Off releases the test profile",
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
