/**
 * Real Firefox MapLibre + OpenFreeMap integration, using the production bundle.
 * Every network destination is a loopback recording proxy; no public provider is
 * used. The HTTPS fixture keeps the exact production origin and exercises real
 * vector-tile parsing, packaged workers, CSP, and rasterized canvas pixels.
 *
 * node scripts/e2e-map.mjs --firefox /path/to/firefox --screenshots /tmp/map-shots
 * xvfb-run -a node scripts/e2e-map.mjs --firefox /path/to/firefox --no-local-cjk
 * node scripts/e2e-map.mjs --firefox /path/to/firefox --no-webgl
 *
 * The render run requires a working WebGL display; it never silently substitutes
 * mocks or reports the no-WebGL fallback as a rendering pass. --no-local-cjk
 * uses a temporary Latin-only fontconfig (fontconfig + fonts-dejavu-core needed)
 * to prove that CJK provider glyphs render even when local CJK fonts are absent.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { nativeGraphicsDiagnostic } from "./fixtures/graphics-diagnostics.mjs";
import { connectMarionette } from "./release-marionette.mjs";
import {
  createMapFixture,
  GLYPH_PATH,
  inspectGlyphPixels,
  isolateLatinFonts,
  listen,
  PROVIDER,
  readPng,
} from "./fixtures/map-provider.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    firefox: { type: "string" },
    timeout: { type: "string", default: "120" },
    screenshots: { type: "string" },
    "no-webgl": { type: "boolean", default: false },
    "no-local-cjk": { type: "boolean", default: false },
  },
});
const redactExtensionOrigin = (value) =>
  String(value).replace(/moz-extension:\/\/[a-z0-9-]+/gi, "moz-extension://<extension>");
const log = (message) => console.error(`[e2e:map] ${redactExtensionOrigin(message)}`);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";

// Buffer whole lines so an extension origin split across stream chunks is never
// forwarded unredacted. Only native graphics messages survive the verbose filter.
function redactStream(stream) {
  let pending = "";
  stream.on("data", (chunk) => {
    pending += String(chunk);
    let end;
    while ((end = pending.indexOf("\n")) !== -1) {
      const diagnostic = nativeGraphicsDiagnostic(pending.slice(0, end));
      if (diagnostic !== null) log(`Native graphics: ${diagnostic}`);
      pending = pending.slice(end + 1);
    }
  });
  stream.on("end", () => {
    const diagnostic = nativeGraphicsDiagnostic(pending);
    if (diagnostic !== null) log(`Native graphics: ${diagnostic}`);
  });
}

async function stopFirefox(child) {
  if (!child?.pid) return;
  const stopped =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => child.once("close", resolve));
  if (process.platform === "win32") {
    if (child.exitCode === null && child.signalCode === null) {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      await new Promise((resolve) => killer.once("exit", resolve));
    }
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  await stopped;
}

const graphicsEnvironment = {
  softwareRendering: process.env.LIBGL_ALWAYS_SOFTWARE === "1",
  llvmpipeThreads: /^[0-9]{1,3}$/.test(process.env.LP_NUM_THREADS ?? "")
    ? Number(process.env.LP_NUM_THREADS)
    : "default",
  displayPresent: Boolean(process.env.DISPLAY),
};

async function main() {
  log(`Graphics fixture configuration: ${JSON.stringify(graphicsEnvironment)}`);
  if (
    !values.firefox ||
    !existsSync(values.firefox) ||
    !existsSync(path.join(root, "dist/manifest.json"))
  )
    throw new Error("Pass --firefox and build dist/ first");
  const sourceMapsPresent = [
    "background.js.map",
    "popup/popup.js.map",
    "content/bridge.js.map",
    "content/page-shim.js.map",
    "options/options.js.map",
    "options/maplibre.js.map",
    "options/maplibre-worker.js.map",
  ].filter((file) => existsSync(path.join(root, "dist", file)));
  const productionBundle = sourceMapsPresent.length === 0;
  if (!productionBundle)
    throw new Error(
      "The map release gate requires npm run build:prod; development source maps were found.",
    );
  const directory = await mkdtemp(path.join(tmpdir(), "ni-map-"));
  let fixture, firefox, client;
  try {
    const fonts = values["no-local-cjk"]
      ? await isolateLatinFonts(directory)
      : { env: {}, evidence: { isolated: false } };
    if (fonts.evidence.isolated)
      log("Fontconfig isolated: Latin coverage present, CJK U+65E5 coverage absent");
    fixture = await createMapFixture(directory);
    const probe = net.createServer();
    const marionettePort = await listen(probe);
    await new Promise((resolve) => probe.close(resolve));
    const home = path.join(directory, "home");
    const profileDirectory = path.join(directory, "firefox-profile");
    await mkdir(profileDirectory, { mode: 0o700 });
    for (const child of ["", "config", "cache", "data", "runtime"])
      await mkdir(path.join(home, child), { recursive: true, mode: 0o700 });
    const prefs = {
      "marionette.port": marionettePort,
      "network.proxy.type": 1,
      "network.proxy.http": "127.0.0.1",
      "network.proxy.http_port": fixture.sentinelPort,
      "network.proxy.ssl": "127.0.0.1",
      "network.proxy.ssl_port": fixture.sentinelPort,
      "network.proxy.no_proxies_on": "localhost,127.0.0.1",
      "network.trr.mode": 5,
      "webgl.disabled": values["no-webgl"],
      "webgl.force-enabled": true,
      "gfx.webrender.software": true,
    };
    const headless = values["no-webgl"] || !process.env.DISPLAY;
    firefox = spawn(
      process.execPath,
      [
        path.join(root, "node_modules/web-ext/bin/web-ext.js"),
        "run",
        "--verbose",
        "--source-dir",
        path.join(root, "dist"),
        "--firefox-profile",
        profileDirectory,
        "--keep-profile-changes",
        "--no-input",
        "--no-reload",
        ...Object.entries(prefs).map(([key, value]) => `--pref=${key}=${value}`),
        "--arg=--marionette",
        "--arg=-remote-allow-system-access",
        ...(headless ? ["--arg=-headless"] : []),
        "--firefox",
        values.firefox,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          ...fonts.env,
          HOME: home,
          TMPDIR: directory,
          TMP: directory,
          TEMP: directory,
          XDG_CONFIG_HOME: path.join(home, "config"),
          XDG_CACHE_HOME: path.join(home, "cache"),
          XDG_DATA_HOME: path.join(home, "data"),
          XDG_RUNTIME_DIR: path.join(home, "runtime"),
          ...(headless ? { MOZ_HEADLESS: "1" } : { MOZ_HEADLESS: "" }),
        },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    );
    redactStream(firefox.stdout);
    redactStream(firefox.stderr);
    firefox.on("error", (error) => log(`Firefox launch failed: ${String(error)}`));
    const failures = [];
    const check = (ok, label) => {
      log(`${ok ? "PASS" : "FAIL"}  ${label}`);
      if (!ok) failures.push(label);
    };
    client = await connectMarionette(marionettePort, Date.now() + Number(values.timeout) * 1000);
    await client.send("WebDriver:NewSession", {
      capabilities: {
        alwaysMatch: {
          browserName: "firefox",
          acceptInsecureCerts: false,
          unhandledPromptBehavior: "dismiss",
        },
      },
    });
    await client.send("WebDriver:SetTimeouts", { script: 20000, pageLoad: 20000, implicit: 0 });
    const execute = async (script, args = []) =>
      (await client.send("WebDriver:ExecuteScript", { script, args })).value;
    const asyncScript = async (script, args = []) =>
      (await client.send("WebDriver:ExecuteAsyncScript", { script, args })).value;
    const chrome = async (script, args = []) => {
      await client.send("Marionette:SetContext", { value: "chrome" });
      try {
        return await execute(script, args);
      } finally {
        await client.send("Marionette:SetContext", { value: "content" });
      }
    };
    const waitFor = async (script, args = [], timeout = 10000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const value = await execute(script, args);
        if (value) return value;
        await pause(50);
      }
      throw new Error(`UI condition not reached: ${script}`);
    };
    const call = async (message) =>
      asyncScript(
        `const done=arguments[arguments.length-1], p=window.wrappedJSObject||window; p.browser.runtime.sendMessage(p.JSON.parse(JSON.stringify(arguments[0]))).then(v=>done((v===undefined?{undefined:true}:p.JSON.parse(p.JSON.stringify(v)))),e=>done({error:String(e)}));`,
        [message],
      );
    const click = async (selector) => {
      if (
        (selector.startsWith("#map-") ||
          selector.startsWith("#field-mode-") ||
          selector === "#load-online-map" ||
          selector === "#unload-online-map") &&
        !(await execute('return document.getElementById("section-identity").open;'))
      ) {
        await click("#section-identity > summary");
      }
      const element = (
        await client.send("WebDriver:FindElement", { using: "css selector", value: selector })
      ).value;
      await client.send("WebDriver:ElementClick", { id: element[ELEMENT] });
    };
    const fill = async (fields) =>
      execute(
        `for(const [id,value] of Object.entries(arguments[0])){const e=document.getElementById(id);e.value=value;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));}`,
        [fields],
      );
    const state = () => call({ type: "state:get" });
    const point = (selector) =>
      execute(
        `const e=document.querySelector(arguments[0]);e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:Math.round(r.left+r.width*.27),y:Math.round(r.top+r.height*.63)};`,
        [selector],
      );
    const pointer = async (from, to = from) =>
      client.send("WebDriver:PerformActions", {
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
    const readMap = () =>
      execute(
        `const s=document.getElementById('location-map-surface');return {lat:document.getElementById('field-latitude').value,lng:document.getElementById('field-longitude').value,center:s.dataset.center,zoom:s.dataset.zoom};`,
      );
    const setFallback = (port) =>
      chrome(
        `Services.prefs.setIntPref('network.proxy.type',1);Services.prefs.setCharPref('network.proxy.http','127.0.0.1');Services.prefs.setIntPref('network.proxy.http_port',arguments[0]);Services.prefs.setCharPref('network.proxy.ssl','127.0.0.1');Services.prefs.setIntPref('network.proxy.ssl_port',arguments[0]);`,
        [port],
      );
    let baseURL;
    for (let i = 0; i < 100; i++) {
      baseURL = await chrome(
        `const p=WebExtensionPolicy.getByID('net-identity@jacek4yang.github.io');return p?'moz-extension://'+p.mozExtensionHostname+'/':null;`,
      );
      if (baseURL) break;
      await pause(100);
    }
    if (!baseURL) throw new Error("Extension never installed");
    const optionsURL = `${baseURL}options/options.html`;
    await client.send("WebDriver:Navigate", { url: optionsURL });
    await waitFor(`return !document.getElementById('direct-view').hidden;`);
    await click("#new-profile");
    await pause(250);
    check(
      !fixture.connects.some((x) => x.target === "tiles.openfreemap.org:443") &&
        !fixture.direct.some((x) => x.includes("openfreemap")),
      "Fresh install and opening an editor make zero provider requests",
    );
    check(
      await execute(`return document.querySelectorAll('#location-map-tiles canvas').length===0;`),
      "Online canvas is not created before explicit opt-in",
    );

    // A positive control proves the fallback sentinel really receives a direct
    // provider attempt; the protected zero-leak interval begins after this.
    try {
      await client.send("WebDriver:Navigate", { url: `${PROVIDER}/sentinel-positive-control` });
    } catch {
      /* The recording sentinel intentionally rejects the tunnel. */
    }
    check(
      fixture.direct.some((x) => x === "tiles.openfreemap.org:443"),
      "Direct/fallback sentinel positive control is reachable",
    );
    fixture.direct.length = 0;

    // Trust the generated fixture CA only in this disposable test profile.
    // No certificate warning is clicked through; production trust is unchanged.
    const fixtureCertificate = (
      await readFile(path.join(directory, "map-fixture-ca.pem"), "utf8")
    ).replace(/-----[^-]+-----|\s/g, "");
    await chrome(
      `Cc["@mozilla.org/security/x509certdb;1"].getService(Ci.nsIX509CertDB).addCertFromBase64(arguments[0], "C,,");return true;`,
      [fixtureCertificate],
    );
    await setFallback(fixture.proxyPort);
    try {
      await client.send("WebDriver:Navigate", { url: `${PROVIDER}/tls-bootstrap` });
    } catch (error) {
      log(
        JSON.stringify(
          await execute("return {uri:document.documentURI,text:document.body?.innerText};"),
        ),
      );
      throw error;
    }
    await setFallback(fixture.sentinelPort);
    fixture.requireAuthentication();
    fixture.requests.length = 0;
    fixture.connects.length = 0;
    await client.send("WebDriver:Navigate", { url: optionsURL });
    await waitFor(`return !document.getElementById('direct-view').hidden;`);
    await click("#new-profile");
    const baseCount = fixture.requests.length;
    const offDenied = await call({
      type: "map:open",
      generation: (await state()).state.generation,
    });
    await pause(250);
    check(
      !offDenied.ok && fixture.requests.length === baseCount,
      "Off without direct-IP consent cannot issue map requests",
    );

    const profile = {
      id: "map-e2e-a",
      name: "Map fixture A",
      proxy: {
        type: "http",
        host: "127.0.0.1",
        port: fixture.proxyPort,
        proxyDNS: false,
        bypassHosts: ["localhost", "127.0.0.1", "::1"],
      },
      identity: {
        mode: "manual",
        geoIpPolicy: "disabled",
        latitude: 0,
        longitude: 0,
        accuracy: 1000000,
        timezone: "UTC",
      },
      webrtcPolicy: "default",
    };
    const save = await call({
      type: "profiles:save",
      profile,
      credentials: { username: "fixture-user", password: "fixture-password" },
    });
    if (!save?.ok) throw new Error(`save failed: ${JSON.stringify(save)}`);
    const active = await call({ type: "profiles:activate", profileId: profile.id });
    if (!active?.ok) throw new Error(`activate failed: ${JSON.stringify(active)}`);
    await client.send("WebDriver:Navigate", { url: optionsURL });
    await waitFor(`return !!document.querySelector('[data-profile-id="${profile.id}"]');`);
    await click(`[data-profile-id="${profile.id}"]`);
    await waitFor(`return document.getElementById('field-name').value==='Map fixture A';`);
    while (Number((await readMap()).zoom) > 2) await click("#map-zoom-out");
    await execute(
      `window.__mapCsp=[];document.addEventListener('securitypolicyviolation',e=>window.__mapCsp.push({directive:e.violatedDirective,blocked:e.blockedURI.startsWith("moz-extension:")?"extension-resource":e.blockedURI}));`,
    );
    // The production renderer and pixel assertions below prove WebGL support.
    // Do not allocate a disposable probe context before testing its real lifecycle.
    if (!(await execute('return document.getElementById("section-identity").open;'))) {
      await click("#section-identity > summary");
    }
    await click("#load-online-map");

    if (values["no-webgl"]) {
      await waitFor(
        `return /unavailable|failed|WebGL|not available/i.test(document.getElementById('map-online-status').textContent);`,
      );
      await fill({ "field-latitude": "12", "field-longitude": "45" });
      const before = await readMap();
      await pointer(await point("#location-map-surface"));
      const after = await readMap();
      check(
        before.center === "12,45" && after.lat !== before.lat,
        "WebGL failure preserves numeric editing and map click selection",
      );
      check(
        await execute(
          `return !document.getElementById('location-map-surface').classList.contains('is-grabbing');`,
        ),
        "WebGL fallback leaves picker interactive",
      );
      await click("#field-mode-auto");
      const readOnly = await readMap();
      await pointer(await point("#location-map-surface"));
      const afterReadOnly = await readMap();
      log(
        `Fallback automatic preview: ${JSON.stringify({ before: readOnly, after: afterReadOnly, mode: await execute("return {auto:document.getElementById('field-mode-auto').checked,manual:document.getElementById('field-mode-manual').checked,preview:document.getElementById('location-map-surface').classList.contains('is-preview')};") })}`,
      );
      check(
        afterReadOnly.lat === readOnly.lat && afterReadOnly.lng === readOnly.lng,
        "Automatic preview remains read-only without WebGL",
      );
      await click("#field-mode-manual");
    } else {
      await waitFor(`return document.querySelector('#location-map-tiles canvas')?.width>0;`);
      await waitFor(
        `return document.getElementById('location-map-surface').dataset.online==='ready';`,
        [],
        20000,
      );
      const initialGraphics = await execute(`
        const canvas=document.querySelector('#location-map-tiles canvas');
        const gl=canvas?.getContext('webgl2');
        return {contextLost:gl?.isContextLost(),version:gl?.getParameter(gl.VERSION),
          renderer:gl?.getParameter(gl.RENDERER)};
      `);
      log(`Initial production canvas: ${JSON.stringify(initialGraphics)}`);
      await pause(800);
      const element = (
        await client.send("WebDriver:FindElement", {
          using: "css selector",
          value: "#location-map-surface",
        })
      ).value;
      const encoded = (
        await client.send("WebDriver:TakeScreenshot", { id: element[ELEMENT], full: false })
      ).value;
      const pngBytes = Buffer.from(encoded, "base64");
      const decoded = readPng(pngBytes);
      const glyph = inspectGlyphPixels(decoded);
      const glyphRequests = fixture.requests.filter((x) => x.path.startsWith("/fonts/"));
      const colors = { water: 0, land: 0, roads: 0, cities: 0 };
      const expected = {
        water: [34, 102, 221],
        land: [85, 187, 102],
        roads: [255, 51, 85],
        cities: [255, 238, 34],
      };
      for (let i = 0; i < decoded.pixels.length; i += decoded.channels)
        for (const [key, rgb] of Object.entries(expected))
          if (rgb.every((v, c) => Math.abs(decoded.pixels[i + c] - v) <= 8)) colors[key]++;
      check(
        colors.water > 1000 && colors.land > 1000 && colors.roads > 100 && colors.cities > 50,
        `Real Firefox rasterizes vector water/land/roads/city features: ${JSON.stringify(colors)}`,
      );
      check(
        fixture.requests.some((x) => x.path.startsWith("/planet/") && x.path.endsWith(".pbf")),
        "Packaged MapLibre worker processes a fetched vector tile",
      );
      check(
        glyphRequests.some((x) => x.path === GLYPH_PATH) &&
          glyphRequests.every((x) => x.path === GLYPH_PATH),
        "CJK U+65E5 requests its exact provider glyph PBF range through the broker",
      );
      check(
        glyph.rendered,
        `Provider CJK glyph rasterizes five strokes and two open holes (not tofu): ${JSON.stringify(glyph)}`,
      );
      check(
        fixture.requests.some((x) => /\/sprites\/.+\.png$/.test(x.path)) &&
          fixture.requests.some((x) => /\/sprites\/.+\.json$/.test(x.path)),
        "Packaged renderer loads deterministic raster sprite data through the same broker",
      );
      check(
        (await execute(`return window.__mapCsp;`)).length === 0,
        "Production CSP permits packaged MapLibre worker without violations",
      );
      if (values.screenshots) {
        const out = path.resolve(values.screenshots);
        await mkdir(out, { recursive: true });
        await writeFile(path.join(out, "map-rendered.png"), pngBytes);
        const sourceHashes = {};
        for (const file of [
          "manifest.json",
          "options/options.js",
          "options/maplibre.js",
          "options/maplibre-worker.js",
        ])
          sourceHashes[file] = createHash("sha256")
            .update(await readFile(path.join(root, "dist", file)))
            .digest("hex");
        await writeFile(
          path.join(out, "metadata.json"),
          redactExtensionOrigin(
            JSON.stringify(
              {
                userAgent: await execute("return navigator.userAgent;"),
                fixture: "exact production OpenFreeMap origin via loopback CONNECT proxy",
                productionBundle,
                graphicsEnvironment,
                initialGraphics,
                sourceMapsPresent,
                sourceHashes,
                colors,
                glyph,
                glyphRequests: glyphRequests.map((x) => x.path),
                localFonts: fonts.evidence,
                cspViolations: await execute("return window.__mapCsp;"),
                manifest: JSON.parse(await readFile(path.join(root, "dist/manifest.json"), "utf8")),
              },
              null,
              2,
            ),
          ),
        );
      }
      for (let reloadCycle = 1; reloadCycle <= 3; reloadCycle++) {
        const failureStart = fixture.requests.length;
        fixture.setFailRaster(true);
        await click("#map-zoom-in");
        await waitFor(
          `return document.getElementById('location-map-surface').dataset.online==='partial';`,
        );
        check(
          fixture.requests.slice(failureStart).some((x) => x.status === 503) &&
            (await execute(
              `return document.querySelectorAll('#location-map-tiles canvas').length===1 && /Reload/.test(document.getElementById('load-online-map').textContent);`,
            )),
          `Reload cycle ${reloadCycle}: a post-load raster failure retains geography and exposes Reload`,
        );
        if (values.screenshots && reloadCycle === 1) {
          const partial = (
            await client.send("WebDriver:TakeScreenshot", { id: element[ELEMENT], full: false })
          ).value;
          await writeFile(
            path.join(path.resolve(values.screenshots), "map-partial.png"),
            Buffer.from(partial, "base64"),
          );
        }
        await execute(
          "window.__reloadCanvas = document.querySelector('#location-map-tiles canvas');",
        );
        fixture.setFailRaster(false);
        if (!(await execute('return document.getElementById("section-identity").open;'))) {
          await click("#section-identity > summary");
        }
        await click("#load-online-map");
        await waitFor(
          `return document.getElementById('location-map-surface').dataset.online==='ready';`,
        );
        check(
          await execute(
            `return document.querySelectorAll('#location-map-tiles canvas').length===1 && document.querySelector('#location-map-tiles canvas')===window.__reloadCanvas;`,
          ),
          `Reload cycle ${reloadCycle}: immediate Reload recovers partial data without duplicate canvases`,
        );
        const diagnostics = await execute(
          `
        const canvas=document.querySelector('#location-map-tiles canvas');
        const gl=canvas?.getContext('webgl2');
        return {cycle:arguments[0],online:document.getElementById('location-map-surface').dataset.online,
          canvases:document.querySelectorAll('#location-map-tiles canvas').length,
          width:canvas?.width,height:canvas?.height,contextLost:gl?.isContextLost(),
          version:gl?.getParameter(gl.VERSION),renderer:gl?.getParameter(gl.RENDERER)};
      `,
          [reloadCycle],
        );
        check(
          diagnostics.contextLost === false,
          `Reload cycle ${reloadCycle}: production WebGL context remains live`,
        );
        log(`Production canvas diagnostics: ${JSON.stringify(diagnostics)}`);
      }
      const before = await readMap();
      const p = await point("#location-map-surface");
      await pointer(p, { x: p.x + 65, y: p.y + 15 });
      const panned = await readMap();
      check(
        panned.lat === before.lat && panned.lng === before.lng && panned.center !== before.center,
        "Loaded geographic map pans without moving selection",
      );
      await pointer(await point("#location-map-surface"));
      const selected = await readMap();
      check(
        selected.lat !== panned.lat || selected.lng !== panned.lng,
        "Loaded geographic map click updates selection",
      );
      await fill({ "field-latitude": "-12", "field-longitude": "31", "field-accuracy": "200000" });
      check(
        (await readMap()).center === "-12,31",
        "Loaded geographic map follows numeric coordinate edits",
      );
      const accuracyBefore = await execute(
        `return parseFloat(document.getElementById('location-map-accuracy').style.width);`,
      );
      await fill({ "field-accuracy": "400000" });
      const accuracyAfter = await execute(
        `return parseFloat(document.getElementById('location-map-accuracy').style.width);`,
      );
      check(
        accuracyAfter > accuracyBefore && (await readMap()).lat === "-12",
        "Accuracy overlay updates without changing selected coordinates",
      );
      const markerPoint = await execute(
        `const r=document.getElementById('location-map-marker').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};`,
      );
      const beforeMarker = await readMap();
      await pointer(markerPoint, { x: markerPoint.x + 35, y: markerPoint.y - 15 });
      const afterMarker = await readMap();
      check(
        afterMarker.lat !== beforeMarker.lat && afterMarker.center === beforeMarker.center,
        "Marker drag over real geography changes selection without panning",
      );
      await click("#map-zoom-in");
      const zoomed = await readMap();
      check(
        Number(zoomed.zoom) === Number(afterMarker.zoom) + 1 && zoomed.lat === afterMarker.lat,
        "Online zoom keeps the chosen coordinates stable",
      );
      await click("#field-mode-auto");
      const readOnly = await readMap();
      await pointer(await point("#location-map-surface"));
      const afterReadOnly = await readMap();
      log(
        `Automatic preview transition: ${JSON.stringify({ before: readOnly, after: afterReadOnly, mode: await execute("return {auto:document.getElementById('field-mode-auto').checked,manual:document.getElementById('field-mode-manual').checked,preview:document.getElementById('location-map-surface').classList.contains('is-preview')};") })}`,
      );
      check(
        afterReadOnly.lat === readOnly.lat && afterReadOnly.lng === readOnly.lng,
        "Automatic preview remains read-only over loaded geographic imagery",
      );
      if (!(await execute('return document.getElementById("section-identity").open;'))) {
        await click("#section-identity > summary");
      }
      await click("#field-mode-manual");
      await click("#unload-online-map");
      await waitFor(`return document.querySelectorAll('#location-map-tiles canvas').length===0;`);
      const afterUnload = fixture.requests.length;
      await pointer(await point("#location-map-surface"));
      await pause(150);
      check(
        fixture.requests.length === afterUnload,
        "Unload removes canvas and stops subsequent viewport requests",
      );
      if (!(await execute('return document.getElementById("section-identity").open;'))) {
        await click("#section-identity > summary");
      }
      await click("#load-online-map");
      await waitFor(`return document.querySelectorAll('#location-map-tiles canvas').length===1;`);
      await click("#section-identity > summary");
      await waitFor(
        `return document.querySelectorAll('#location-map-tiles canvas').length===0 && document.getElementById('location-map-surface').dataset.online==='off';`,
      );
      await click("#section-identity > summary");
      await waitFor(`return document.querySelectorAll('#location-map-tiles canvas').length===1;`);
      check(
        await execute(`return document.getElementById('map-autoload').checked;`),
        "Reopening the map reloads its view after the explicit remembered opt-in",
      );
      await waitFor(`return document.querySelectorAll('#location-map-tiles canvas').length===1;`);
      await client.send("WebDriver:Navigate", { url: optionsURL });
      await waitFor(`return !!document.querySelector('[data-profile-id="${profile.id}"]');`);
      await click(`[data-profile-id="${profile.id}"]`);
      await click("#section-identity > summary");
      await waitFor(`return document.querySelectorAll('#location-map-tiles canvas').length===1;`);
      check(
        await execute(`return document.getElementById('map-autoload').checked;`),
        "Automatic map choice survives options-page reload without a second enable click",
      );
      await click("#map-autoload");
      await waitFor(`return document.querySelectorAll('#location-map-tiles canvas').length===0;`);
      await click("#section-identity > summary");
      await click("#section-identity > summary");
      await pause(150);
      check(
        await execute(
          `return !document.getElementById('map-autoload').checked && document.querySelectorAll('#location-map-tiles canvas').length===0;`,
        ),
        "Disabling automatic loading keeps the reopened map offline",
      );
      await click("#load-online-map");
      await waitFor(`return document.querySelectorAll('#location-map-tiles canvas').length===1;`);
      await click("#new-profile");
      check(
        await execute(`return document.querySelectorAll('#location-map-tiles canvas').length===0;`),
        "Opening another editor destroys the old map before any new visible view loads",
      );
    }

    // The gate must recognize extension-background originUrl/documentUrl, not
    // merely rely on the options page's stricter connect-src CSP.
    const beforeUnbrokered = fixture.requests.length;
    const unbrokered = await asyncScript(
      `const done=arguments[arguments.length-1],p=window.wrappedJSObject||window;p.browser.runtime.getBackgroundPage().then(bg=>{if(!bg){done({error:'No event page'});return;}bg.fetch(arguments[0],{credentials:'omit',referrerPolicy:'no-referrer',cache:'no-store'}).then(()=>done({unexpected:true}),()=>done({blocked:true}));},e=>done({error:String(e)}));`,
      [`${PROVIDER}/styles/liberty`],
    );
    check(
      unbrokered.blocked === true && fixture.requests.length === beforeUnbrokered,
      "Background-origin map fetch without a broker session is blocked before provider contact",
    );

    // Exercise the actual event-page gateway even in the deliberate no-WebGL run.
    const openSession = async () =>
      call({ type: "map:open", generation: (await state()).state.generation });
    const session = await openSession();
    check(
      session.ok && typeof session.sessionId === "string",
      "Options page receives a generation-bound map session",
    );
    const resource = await call({
      type: "map:fetch",
      sessionId: session.sessionId,
      requestId: "fixture-style",
      url: `${PROVIDER}/styles/liberty`,
    });
    if (!resource.ok) {
      log(
        `Gateway diagnostic: ${JSON.stringify(resource)}; fixture requests=${JSON.stringify(fixture.requests.map((x) => x.path))}; connects=${JSON.stringify(fixture.connects)}`,
      );
      log(
        JSON.stringify(
          await chrome(
            `return Services.console.getMessageArray().map(m=>m.message).filter(m=>/openfreemap|CSP|Content Security|map:|MapResource/i.test(m)).slice(-15);`,
          ),
        ),
      );
    }
    check(resource.ok, "Background gateway fetches exact provider data through the active route");
    for (const [id, url] of [
      ["raw-space", `${PROVIDER}/fonts/Fixture Sans/25856-26111.pbf`],
      ["encoded-space", `${PROVIDER}${GLYPH_PATH}`],
      ["canonical-host-port", `https://TILES.OPENFREEMAP.ORG:443${GLYPH_PATH}`],
    ]) {
      const beforeGlyph = fixture.requests.length;
      const glyph = await call({
        type: "map:fetch",
        sessionId: session.sessionId,
        requestId: `glyph-${id}`,
        url,
      });
      check(
        glyph.ok &&
          fixture.requests.length === beforeGlyph + 1 &&
          fixture.requests[beforeGlyph].path === GLYPH_PATH,
        `The ${id} glyph URL reaches only its canonical allowlisted provider resource`,
      );
    }
    const beforeRejected = fixture.requests.length;
    for (const url of [
      "https://example.com/tile.pbf",
      `${PROVIDER}/not-a-map`,
      `${PROVIDER}/styles/liberty?token=secret`,
      "https://user:password@tiles.openfreemap.org/styles/liberty",
      `${PROVIDER}/fonts/Fixture%2fSans/25856-26111.pbf`,
      `${PROVIDER}/fonts/Fixture%5cSans/25856-26111.pbf`,
      "http://tiles.openfreemap.org/styles/liberty",
    ]) {
      const denied = await call({
        type: "map:fetch",
        sessionId: session.sessionId,
        requestId: "invalid-resource",
        url,
      });
      check(
        denied.ok === false,
        `Provider allowlist rejects ${new URL(url).pathname}${new URL(url).search ? " with query" : ""} (${new URL(url).protocol})`,
      );
    }
    check(fixture.requests.length === beforeRejected, "Rejected resources never reach the network");
    await call({ type: "map:close", sessionId: session.sessionId });

    fixture.setHold(true);
    const pendingSession = await openSession();
    const heldStart = fixture.requests.length;
    await execute(
      `const p=window.wrappedJSObject||window;p.__mapPending=null;p.browser.runtime.sendMessage(p.JSON.parse(JSON.stringify(arguments[0]))).then(v=>p.__mapPending=v,e=>p.__mapPending={error:String(e)});`,
      [
        {
          type: "map:fetch",
          sessionId: pendingSession.sessionId,
          requestId: "held-generation",
          url: `${PROVIDER}/styles/liberty`,
        },
      ],
    );
    const holdDeadline = Date.now() + 10000;
    while (fixture.requests.length === heldStart && Date.now() < holdDeadline) await pause(50);
    check(
      fixture.requests.length > heldStart && fixture.held.size > 0,
      "Generation-race fixture has a real in-flight provider response",
    );
    await call({ type: "profiles:deactivate" });
    await waitFor(`return (window.wrappedJSObject||window).__mapPending!==null;`);
    const closedDeadline = Date.now() + 3000;
    while (fixture.held.size && Date.now() < closedDeadline) await pause(50);
    check(
      fixture.held.size === 0 &&
        (await execute(`return (window.wrappedJSObject||window).__mapPending.ok===false;`)),
      "Proxy to Off aborts the actual provider connection and rejects its stale result",
    );
    const stale = await call({
      type: "map:fetch",
      sessionId: pendingSession.sessionId,
      requestId: "after-off",
      url: `${PROVIDER}/styles/liberty`,
    });
    check(stale.ok === false, "An invalidated session cannot request data after switching to Off");
    fixture.setHold(false);
    const directActive = await call({ type: "profiles:activate", profileId: "builtin-direct" });
    check(
      directActive.ok && (await openSession()).ok === false,
      "Direct without optional public-IP consent cannot open a map session",
    );

    const bypassProfile = {
      ...profile,
      id: "map-e2e-bypass",
      name: "Map bypass denied",
      proxy: { ...profile.proxy, bypassHosts: ["tiles.openfreemap.org"] },
    };
    await call({ type: "profiles:save", profile: bypassProfile });
    await call({ type: "profiles:activate", profileId: bypassProfile.id });
    check(
      (await openSession()).ok === false,
      "Provider bypass is denied instead of sending the map directly",
    );

    await asyncScript(
      `const done=arguments[arguments.length-1],p=window.wrappedJSObject||window;p.browser.storage.session.remove("ni.cred.v1.map-e2e-a").then(()=>done(true));`,
    );
    await call({ type: "profiles:activate", profileId: profile.id });
    const providerConnections = () =>
      fixture.connects.filter((x) => x.target === "tiles.openfreemap.org:443").length;
    const beforeCredentialLoss = providerConnections();
    check(
      (await openSession()).ok === false,
      "Required credential loss denies map sessions while preserving the proxy route",
    );
    await pause(150);
    check(
      providerConnections() === beforeCredentialLoss,
      "Credential loss issues no provider CONNECT attempt",
    );

    const originHeaders = fixture.requests
      .filter((x) => x.path !== "/favicon.ico" && x.headers.origin)
      .map((x) =>
        String(x.headers.origin).startsWith("moz-extension:") ? "extension-origin" : "other-origin",
      );
    if (originHeaders.length)
      log(`Provider Origin header presence: ${JSON.stringify(originHeaders)} (values redacted)`);
    check(
      fixture.requests
        .filter((x) => x.path !== "/favicon.ico")
        .every(
          (x) =>
            !x.headers.origin &&
            !x.headers.cookie &&
            !x.headers.authorization &&
            !x.headers.referer &&
            !x.headers["proxy-authorization"],
        ),
      "Provider receives no Origin, cookies, credentials, proxy auth, or referrer",
    );
    check(
      fixture.connects.some((x) => x.target === "tiles.openfreemap.org:443" && x.authenticated),
      "Provider connections follow the active authenticated proxy",
    );
    check(
      !fixture.direct.some((x) => x.includes("openfreemap")),
      "No provider connection reaches Firefox's direct/fallback sentinel",
    );
    // Baseline route stays selected after any renderer failure.
    check(
      (await state()).state.activeProfileId === profile.id,
      "Renderer lifecycle never changes the selected proxy route",
    );
    await call({ type: "profiles:deactivate" });
    if (failures.length)
      throw new Error(`${failures.length} failed assertion(s): ${failures.join("; ")}`);
    log(
      values["no-webgl"]
        ? "PASSED: deterministic no-WebGL fallback and privacy checks"
        : "PASSED: real MapLibre canvas/worker/CSP rendering and privacy checks",
    );
  } catch (error) {
    if (client && values.screenshots) {
      try {
        const out = path.resolve(values.screenshots);
        await mkdir(out, { recursive: true });
        const screenshot = await client.send("WebDriver:TakeScreenshot", { full: false });
        await writeFile(path.join(out, "map-failure.png"), Buffer.from(screenshot.value, "base64"));
        const ui = await client.send("WebDriver:ExecuteScript", {
          script:
            "return {status:document.getElementById('map-online-status')?.textContent,online:document.getElementById('location-map-surface')?.dataset.online,canvases:document.querySelectorAll('#location-map-tiles canvas').length,csp:window.__mapCsp||[]};",
          args: [],
        });
        await client.send("Marionette:SetContext", { value: "chrome" });
        const diagnostics = await client.send("WebDriver:ExecuteScript", {
          script:
            "return Services.console.getMessageArray().map(m=>m.message).filter(m=>/maplibre|openfreemap|Content Security|WebGL/i.test(m)).slice(-30);",
          args: [],
        });
        await writeFile(
          path.join(out, "failure.json"),
          redactExtensionOrigin(
            JSON.stringify(
              {
                error: String(error),
                graphicsEnvironment,
                console: diagnostics.value,
                ui: ui.value,
                requests: fixture?.requests.map((entry) => ({
                  path: entry.path,
                  status: entry.status ?? 200,
                  closed: entry.closed,
                })),
                connects: fixture?.connects,
              },
              null,
              2,
            ),
          ),
        );
      } catch (captureError) {
        log(`Failure capture unavailable: ${String(captureError)}`);
      }
    }
    throw error;
  } finally {
    client?.close();
    try {
      await stopFirefox(firefox);
    } finally {
      try {
        await fixture?.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}
main().catch((error) => {
  log(error.stack ?? String(error));
  process.exitCode = 1;
});
