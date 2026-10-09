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
import { mkdir, mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createLiveMapProxy } from "./live-map-proxy.mjs";
import { captureFrameFits } from "./capture-frame.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WINDOWS_DEVELOPER_EDITION = "C:\\Program Files\\Firefox Developer Edition\\firefox.exe";
const EXTENSION_ID = "net-identity@jacek4yang.github.io";

const { values } = parseArgs({
  options: {
    firefox: { type: "string" },
    timeout: { type: "string", default: "90" },
    screenshots: { type: "string" },
    light: { type: "boolean", default: false },
    review: { type: "boolean", default: false },
    scale: { type: "string", default: "1" },
    "live-map": { type: "boolean", default: false },
  },
});

const firefoxPath =
  values.firefox ?? (existsSync(WINDOWS_DEVELOPER_EDITION) ? WINDOWS_DEVELOPER_EDITION : undefined);
const timeoutMs = Number(values.timeout) * 1000;
if (!["1", "1.25", "1.5", "2"].includes(values.scale)) throw new Error("Unsupported UI scale");
if (values.screenshots && values.scale !== "1")
  throw new Error("Store captures require native scale");

const redact = (value) =>
  String(value).replace(/moz-extension:\/\/[a-z0-9-]+/gi, "moz-extension://<extension>");
function log(message) {
  console.error(`[e2e:ui] ${redact(message)}`);
}
function redactStream(stream) {
  let pending = "";
  stream.on("data", (chunk) => {
    pending += String(chunk);
    let end;
    while ((end = pending.indexOf("\n")) !== -1) {
      process.stderr.write(redact(pending.slice(0, end + 1)));
      pending = pending.slice(end + 1);
    }
  });
  stream.on("end", () => {
    if (pending) process.stderr.write(redact(pending));
  });
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
      await new Promise((resolve) => {
        killer.once("error", resolve);
        killer.once("exit", resolve);
      });
    }
    await stopped;
    return;
  }
  const signal = (name) => {
    try {
      process.kill(-child.pid, name);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  };
  const groupExists = () => {
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
      throw error;
    }
  };
  const groupStopped = async () => {
    if (!groupExists()) return true;
    // A container's PID 1 can delay reaping already-exited grandchildren. A
    // zombie is not a live process, but never infer this merely from parent exit.
    if (process.platform !== "linux" || (child.exitCode === null && child.signalCode === null))
      return false;
    try {
      let members = 0;
      for (const pid of await readdir("/proc")) {
        if (!/^\d+$/.test(pid)) continue;
        let stat;
        try {
          stat = await readFile(`/proc/${pid}/stat`, "utf8");
        } catch (error) {
          if (["ENOENT", "ESRCH"].includes(error?.code)) continue;
          return false;
        }
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (Number(fields[2]) !== child.pid) continue;
        members++;
        if (!["Z", "X"].includes(fields[0])) return false;
      }
      if (members > 0) {
        log("Owned Firefox group has only exited zombies; no live descendants remain.");
        return true;
      }
      return !groupExists();
    } catch {
      return false;
    }
  };
  const waitForGroup = async (milliseconds) => {
    const deadline = Date.now() + milliseconds;
    while (Date.now() < deadline) {
      if (await groupStopped()) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return groupStopped();
  };
  signal("SIGTERM");
  if (!(await waitForGroup(5000))) {
    signal("SIGKILL");
    if (!(await waitForGroup(5000)))
      throw new Error("Owned Firefox process group did not disappear after SIGKILL");
  }
  // Do not stop supervising descendants just because web-ext already closed.
  // The group is gone before its streams/profile/fixture are released.
  await stopped;
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
  if (values["live-map"] && (!values.screenshots || !process.env.DISPLAY)) {
    throw new Error(
      "--live-map requires --screenshots and a WebGL display (for example xvfb-run); no fallback export is permitted.",
    );
  }
  if (values["live-map"] && existsSync(path.resolve(values.screenshots))) {
    throw new Error(
      "Live captures require a new output directory; never overwrite released assets before review.",
    );
  }
  if (!existsSync(path.join(root, "dist", "manifest.json"))) {
    log("FAIL: dist/ is missing. Run npm run build first.");
    process.exit(1);
  }
  if (firefoxPath === undefined) {
    log("INCONCLUSIVE: no Firefox binary. Pass --firefox <path>.");
    process.exit(2);
  }

  const failures = [];
  let client = null,
    liveMap = null,
    firefox = null,
    directory = null;
  const check = (ok, label) => {
    log(`${ok ? "PASS" : "FAIL"}  ${label}`);
    if (!ok) failures.push(label);
  };
  try {
    let liveEnv = {};
    let profileArgs = [];
    if (values["live-map"]) {
      const output = path.resolve(values.screenshots);
      await mkdir(path.dirname(output), { recursive: true });
      // Atomic reservation: no concurrent export may overwrite this directory.
      await mkdir(output);
      directory = await mkdtemp(path.join(tmpdir(), "ni-live-map-"));
      for (const child of [
        "home",
        "tmp",
        "profile",
        "config",
        "cache",
        "data",
        "state",
        "runtime",
      ]) {
        await mkdir(path.join(directory, child), { mode: 0o700 });
      }
      liveEnv = {
        HOME: path.join(directory, "home"),
        TMPDIR: path.join(directory, "tmp"),
        TMP: path.join(directory, "tmp"),
        TEMP: path.join(directory, "tmp"),
        XDG_CONFIG_HOME: path.join(directory, "config"),
        XDG_CACHE_HOME: path.join(directory, "cache"),
        XDG_DATA_HOME: path.join(directory, "data"),
        XDG_STATE_HOME: path.join(directory, "state"),
        XDG_RUNTIME_DIR: path.join(directory, "runtime"),
        MOZ_HEADLESS: "",
      };
      profileArgs = [
        "--firefox-profile",
        path.join(directory, "profile"),
        "--keep-profile-changes",
      ];
      liveMap = await createLiveMapProxy(9999);
    }
    const marionettePort = await freePort();
    const cli = path.join(root, "node_modules", "web-ext", "bin", "web-ext.js");
    firefox = spawn(
      process.execPath,
      [
        cli,
        "run",
        "--source-dir",
        path.join(root, "dist"),
        ...profileArgs,
        "--no-input",
        "--no-reload",
        `--pref=marionette.port=${marionettePort}`,
        `--pref=layout.css.devPixelsPerPx=${values.scale}`,
        ...(values.screenshots ? [`--pref=ui.systemUsesDarkTheme=${values.light ? 0 : 1}`] : []),
        "--arg=--marionette",
        "--arg=-remote-allow-system-access",
        ...(liveMap
          ? [
              "--pref=webgl.force-enabled=true",
              "--pref=gfx.webrender.software=true",
              "--pref=network.proxy.type=1",
              "--pref=network.proxy.http=127.0.0.1",
              `--pref=network.proxy.http_port=${liveMap.port}`,
              "--pref=network.proxy.ssl=127.0.0.1",
              `--pref=network.proxy.ssl_port=${liveMap.port}`,
              "--pref=network.proxy.no_proxies_on=localhost,127.0.0.1",
              "--pref=network.trr.mode=5",
            ]
          : ["--arg=-headless"]),
        "--firefox",
        firefoxPath,
      ],
      {
        cwd: root,
        env: { ...process.env, ...liveEnv },
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    redactStream(firefox.stderr);
    redactStream(firefox.stdout);
    firefox.on("error", (error) => log(`Firefox launch failed: ${error}`));
    const deadline = Date.now() + timeoutMs;
    client = await connectMarionette(marionettePort, deadline);
    await client.send("WebDriver:NewSession", {
      capabilities: {
        alwaysMatch: {
          browserName: "firefox",
          acceptInsecureCerts: liveMap === null,
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
    async function waitFor(script, attempts = 100) {
      for (let i = 0; i < attempts; i++) {
        if (await execute(script)) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`UI condition not reached: ${script}`);
    }
    // Capture-only observer, installed in the actual options page. It forwards
    // every argument/receiver and returns the original value (including the same
    // Promise); the separate observer never retries or changes an API response.
    async function startMapRequestEvidence() {
      await execute(`const page = window.wrappedJSObject || window;
        const runtime = page.browser.runtime;
        if (page.__netIdentityCaptureMapRpc || !Object.getOwnPropertyDescriptor(runtime, "sendMessage")?.writable)
          throw new Error("Cannot safely install capture-only map RPC observer");
        const original = runtime.sendMessage;
        if (typeof original !== "function") throw new Error("Capture API method is not callable");
        const counters = { active:0, peak:0, total:0, glyphRequests:0,
          failures:0, glyphFailures:0, totalBytes:0, glyphBytes:0, observerErrors:0 };
        function wrapped(...args) {
          const message = typeof args[0] === "string" ? args[1] : args[0];
          if (!message || message.type !== "map:fetch") return Reflect.apply(original, this, args);
          const glyph = typeof message.url === "string" && message.url.startsWith("https://tiles.openfreemap.org/fonts/");
          counters.total++; counters.active++; counters.peak = Math.max(counters.peak, counters.active);
          if (glyph) counters.glyphRequests++;
          let settled = false;
          const finish = (response, rejected) => {
            if (settled) return;
            settled = true; counters.active--;
            try {
              if (rejected || response?.ok === false) {
                counters.failures++; if (glyph) counters.glyphFailures++;
              } else if (response?.ok === true) {
                const bytes = response.data?.byteLength;
                if (typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0) {
                  counters.totalBytes += bytes; if (glyph) counters.glyphBytes += bytes;
                }
              }
            } catch { counters.observerErrors++; }
          };
          let result;
          try { result = Reflect.apply(original, this, args); }
          catch (error) { finish(null, true); throw error; }
          try {
            if (result && typeof result.then === "function") result.then(value => finish(value, false), () => finish(null, true));
            else finish(result, false);
          } catch { counters.observerErrors++; finish(null, true); }
          return result;
        }
        runtime.sendMessage = wrapped;
        if (runtime.sendMessage !== wrapped) throw new Error("Capture-only map RPC wrapper did not install");
        page.__netIdentityCaptureMapRpc = { original, wrapped, counters };`);
    }
    async function readMapRequestEvidence(restore = false) {
      return execute(
        `const page = window.wrappedJSObject || window;
        const observer = page.__netIdentityCaptureMapRpc;
        if (!observer || page.browser.runtime.sendMessage !== observer.wrapped)
          throw new Error("Capture-only map RPC observer was replaced");
        const counters = {...observer.counters};
        if (arguments[0]) {
          if (counters.active !== 0) throw new Error("Map RPCs still active at observer teardown");
          page.browser.runtime.sendMessage = observer.original;
          delete page.__netIdentityCaptureMapRpc;
        }
        return counters;`,
        [restore],
      );
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
      if (!(await execute('return document.getElementById("section-identity").open;'))) {
        await click("#section-identity > summary");
      }
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
      if (!liveMap) await mkdir(directory, { recursive: true });
      const images = [];
      let mapRequestEvidence = null;
      const capture = async (name, selector, offset = 24, frame = null) => {
        if (frame === "picker") {
          await execute(
            `document.getElementById("location-map").closest("fieldset").scrollIntoView({block:"start"}); window.scrollBy(0, -16);`,
          );
        } else if (selector)
          await execute(
            'document.querySelector(arguments[0]).scrollIntoView({block:"start"}); window.scrollBy(0, -arguments[1]);',
            [selector, offset],
          );
        else await execute("window.scrollTo(0, 0);");
        await execute("document.activeElement?.blur();");
        await new Promise((resolve) => setTimeout(resolve, 150));
        const result = await client.send("WebDriver:TakeScreenshot", { full: values.review });
        let encoded = result.value;
        if (frame && !values.review) {
          // Reframe real pixels at native scale: either identity + audit or the
          // complete Identity & Privacy fieldset. The picker includes its legend,
          // policy controls, override warning, map, attribution, provider/privacy
          // disclosure, online state and all coordinate inputs. Never shorten or
          // hide these to make a picture fit; fail if the whole region won't fit.
          const framed = await client.send("WebDriver:ExecuteAsyncScript", {
            script: `const done = arguments[arguments.length - 1];
              const picker = document.getElementById("location-map")?.closest("fieldset");
              const top = (arguments[1] === "picker" ? picker : document.querySelector(".identity-card")).getBoundingClientRect();
              const bottom = (arguments[1] === "picker" ? picker : document.querySelector("#details-panel")).getBoundingClientRect();
              const x = Math.floor(top.left), y = Math.floor(top.top);
              const width = Math.ceil(top.right) - x, height = Math.ceil(bottom.bottom) - y;
              const fits = (${captureFrameFits.toString()})(arguments[1], {x,y,width,height}, {width:innerWidth,height:innerHeight});
              if (!fits) {
                done({error: "Real UI region does not fit fully inside the capture: " + JSON.stringify({y,height,bottom:bottom.bottom})}); return;
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
            args: [encoded, frame],
          });
          if (framed.value.error) throw new Error(framed.value.error);
          encoded = framed.value.image;
        }
        const bytes = Buffer.from(encoded, "base64");
        if (!values.review && (bytes.readUInt32BE(16) !== 1280 || bytes.readUInt32BE(20) !== 800)) {
          throw new Error(`Unexpected screenshot dimensions for ${name}`);
        }
        await writeFile(path.join(directory, name), bytes);
        images.push({
          file: name,
          width: bytes.readUInt32BE(16),
          height: bytes.readUInt32BE(20),
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
        log(`Wrote ${name} (${bytes.readUInt32BE(16)} × ${bytes.readUInt32BE(20)})`);
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
        "field-proxy-type": liveMap ? "http" : "socks5",
        "field-proxy-host": "127.0.0.1",
        "field-proxy-port": String(liveMap?.port ?? 9999),
      });
      if (!(await execute('return document.getElementById("section-identity").open;'))) {
        await click("#section-identity > summary");
      }
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
      if (!(await execute('return document.getElementById("section-identity").open;'))) {
        await click("#section-identity > summary");
      }
      if (liveMap) {
        await startMapRequestEvidence();
        if (!(await execute('return document.getElementById("section-identity").open;'))) {
          await click("#section-identity > summary");
        }
        await click("#load-online-map");
        await waitFor(
          `return document.getElementById("location-map-surface").dataset.online === "ready";`,
          2400,
        );
        await waitFor(`const canvas = document.querySelector("#location-map-tiles canvas");
          return !!canvas && canvas.width > 0 && canvas.height > 0;`);
        const attribution = await execute(
          `return [...document.querySelectorAll(".location-map-attribution a")].map(a => ({label:a.textContent, href:a.href}));`,
        );
        for (const expected of [
          "https://openfreemap.org/",
          "https://openmaptiles.org/",
          "https://www.openstreetmap.org/copyright",
        ]) {
          if (!attribution.some((link) => link.href === expected))
            throw new Error("Required map attribution missing");
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
        if (
          !(await execute(
            'return document.getElementById("location-map-surface").dataset.online === "ready";',
          ))
        )
          throw new Error("Live map became partial or unavailable; no final screenshot exported");
        if (liveMap.counts().accepted === 0)
          throw new Error("No actual provider connection occurred");
        await capture("04-local-location-picker.png", "#location-map", 24, "picker");
        await waitFor(
          `return (window.wrappedJSObject || window).__netIdentityCaptureMapRpc?.counters.active === 0;`,
          400,
        );
        mapRequestEvidence = await readMapRequestEvidence(true);
        if (
          mapRequestEvidence.observerErrors !== 0 ||
          mapRequestEvidence.peak > 8 ||
          mapRequestEvidence.glyphRequests < 1
        )
          throw new Error(
            `Live map capture did not establish bounded RPC and glyph request evidence: ${JSON.stringify(mapRequestEvidence)}`,
          );
        if (
          !(await execute(
            'return document.getElementById("location-map-surface").dataset.online === "ready";',
          ))
        )
          throw new Error(
            "Live map became incomplete during capture; no successful metadata exported",
          );
      } else {
        await capture("04-local-location-picker.png", ".identity-mode-group", 48, "picker");
      }
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
      await capture("03-identity-audit.png", "#details-panel", 0, "audit");
      await click("#toggle-details");
      await fill({ "ui-language": "zh_CN" });
      await waitFor('return document.documentElement.lang === "zh-CN";');
      await capture("05-switcher-chinese.png");
      await click("#quick-add-toggle");
      await execute('document.body.style.marginTop = "16px";');
      await fill({ "quick-host": "127.0.0.1", "quick-port": "10808" });
      await capture("06-quick-add-chinese.png");
      await client.send("WebDriver:Navigate", { url: optionsUrl });
      await waitFor(
        'return document.documentElement.lang === "zh-CN" && document.querySelectorAll("#profile-list li").length > 1;',
      );
      await execute(
        'const row = [...document.querySelectorAll("#profile-list li")].find(e => e.querySelector(".name span")?.textContent === "Tokyo · Local demo"); if (!row) throw new Error("Demo profile missing"); row.click();',
      );
      await waitFor(
        'return document.getElementById("form-title").textContent === "Tokyo · Local demo";',
      );
      await capture("07-options-chinese.png");
      await capture("08-help-community-chinese.png", ".page-footer", 16);
      await execute('document.getElementById("section-identity").open = true;');
      await capture("09-identity-controls-chinese.png", "#section-identity", 16);
      if (values.review) {
        await execute('document.querySelectorAll("details").forEach(e => e.open = true);');
        await capture("10-all-settings-expanded-chinese.png");
        await execute(`document.querySelector('[data-profile-id="builtin-direct"]').click();`);
        await capture("11-firefox-network-chinese.png");
        await click("#new-profile");
        await execute('document.querySelectorAll("details").forEach(e => e.open = true);');
        await capture("12-new-profile-defaults-chinese.png");
        await client.send("WebDriver:Navigate", { url: popupUrl });
        await waitFor('return document.documentElement.lang === "zh-CN";');
        await click("#quick-add-toggle");
        await execute('document.querySelectorAll("details").forEach(e => e.open = true);');
        await capture("13-quick-auth-protection-chinese.png");
      }

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
      if (liveMap) {
        for (const file of [
          "options/maplibre.js",
          "options/maplibre-worker.js",
          "options/maplibre.css",
        ]) {
          sourceHashes[file] = createHash("sha256")
            .update(await readFile(path.join(root, "dist", file)))
            .digest("hex");
        }
      }
      await writeFile(
        path.join(directory, "metadata.json"),
        redact(
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
              ...(liveMap
                ? {
                    mapCapture: {
                      provider: "OpenFreeMap",
                      style: "https://tiles.openfreemap.org/styles/liberty",
                      data: "live public provider data, not synthetic map geometry",
                      ready: true,
                      attribution: ["OpenFreeMap", "© OpenMapTiles", "Data from OpenStreetMap"],
                      requiresVisualReview: true,
                      requestEvidence: mapRequestEvidence,
                    },
                  }
                : {}),
              fixture: {
                profile: "Tokyo · Local demo",
                proxy: `127.0.0.1:${liveMap?.port ?? 9999}`,
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
          ),
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
    await startMapRequestEvidence();
    const observedStateProbe = await call({ type: "state:get" });
    const blockedMapProbe = await call({
      type: "map:fetch",
      sessionId: "capture-no-session",
      requestId: "capture-probe",
      url: "https://tiles.openfreemap.org/fonts/Noto%20Sans%20Regular/0-255.pbf",
    });
    const mapProbeEvidence = await readMapRequestEvidence(true);
    check(
      observedStateProbe.state?.activeProfileId === null &&
        blockedMapProbe.ok === false &&
        mapProbeEvidence.total === 1 &&
        mapProbeEvidence.glyphRequests === 1 &&
        mapProbeEvidence.failures === 1 &&
        mapProbeEvidence.glyphFailures === 1 &&
        mapProbeEvidence.totalBytes === 0 &&
        mapProbeEvidence.active === 0 &&
        mapProbeEvidence.peak === 1 &&
        mapProbeEvidence.observerErrors === 0,
      "Capture observer counts a blocked map RPC without changing its response or contacting the provider",
    );

    check(
      await execute('return document.getElementById("profile-form").hidden;'),
      "Built-in Direct is read-only",
    );
    await click("#new-profile");
    check(
      await execute(
        'return !document.getElementById("section-identity").open && !document.getElementById("section-advanced").open;',
      ),
      "New proxy keeps identity and advanced configuration collapsed",
    );
    check(
      await execute(
        'return document.getElementById("field-proxy-type").value === "socks5" && document.getElementById("field-proxy-dns").checked && document.getElementById("field-webrtc").value === "proxy_only" && document.getElementById("field-mode-auto").checked;',
      ),
      "New proxy defaults enable SOCKS DNS, strict WebRTC and automatic identity",
    );
    await fill({
      "field-name": "UI proxy",
      "field-proxy-host": "127.0.0.1",
      "field-proxy-port": "9999",
    });
    if (!(await execute('return document.getElementById("section-identity").open;'))) {
      await click("#section-identity > summary");
    }
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

    const optionsBeforeLanguage = (await call({ type: "state:get" })).state;
    await fill({ "field-name": "Unsaved bilingual draft", "ui-language": "zh_CN" });
    await waitFor(
      'return document.documentElement.lang === "zh-CN" && document.getElementById("save").textContent === "保存";',
    );
    check(
      await execute(
        'return document.getElementById("field-name").value === "Unsaved bilingual draft" && document.getElementById("guide-body").textContent.includes("配置的作用");',
      ),
      "Options language translates guidance without discarding edits",
    );
    check(
      (await call({ type: "state:get" })).state.generation === optionsBeforeLanguage.generation,
      "Options language does not apply a profile",
    );
    await fill({ "ui-language": "en" });
    await waitFor('return document.documentElement.lang === "en";');
    await client.send("WebDriver:Navigate", { url: popupUrl });
    await waitFor(`return !!document.querySelector('[data-profile-id="${id}"]');`);
    const beforeLanguage = (await call({ type: "state:get" })).state;
    await fill({ "ui-language": "zh_CN" });
    await waitFor(
      'return document.documentElement.lang === "zh-CN" && document.getElementById("quick-save").textContent === "保存";',
    );
    check(
      (await call({ type: "state:get" })).state.generation === beforeLanguage.generation,
      "Changing interface language never reactivates the route",
    );
    await client.send("WebDriver:Navigate", { url: popupUrl });
    await waitFor(
      'return document.documentElement.lang === "zh-CN" && document.getElementById("ui-language").value === "zh_CN";',
    );
    await fill({ "ui-language": "en" });
    await waitFor(
      'return document.documentElement.lang === "en" && document.getElementById("quick-save").textContent === "Save";',
    );
    check(
      await execute(
        'return Array.from(document.querySelectorAll("a")).some(a => a.href === "https://linux.do/" && a.rel.includes("noopener") && a.rel.includes("noreferrer"));',
      ),
      "Community link is visible and isolates its external browsing context",
    );
    const beforeSearch = (await call({ type: "state:get" })).state;
    await fill({ "route-search": "does-not-match-any-profile" });
    check(
      await execute(
        'return !document.getElementById("route-empty").hidden && document.querySelectorAll("#route-list button").length === 0;',
      ),
      "Search has an explicit empty state",
    );
    check(
      (await call({ type: "state:get" })).state.generation === beforeSearch.generation,
      "Filtering never switches or deactivates the route",
    );
    await fill({ "route-search": "" });
    const beforeQuick = (await call({ type: "state:get" })).state;
    await click("#quick-add-toggle");
    check(
      await execute(
        'return document.body.dataset.view === "add" && getComputedStyle(document.querySelector(".identity-card")).display === "none" && document.activeElement.id === "quick-host";',
      ),
      "Quick setup is a focused view with host focus",
    );
    await fill({
      "quick-host": "preserved.example",
      "quick-username": "fixture-user",
      "quick-password": "fixture-password",
    });
    await click("#quick-add-toggle");
    check(
      await execute(
        'return document.body.dataset.view === "routes" && document.getElementById("quick-password").value === "" && document.getElementById("quick-username").value === "" && document.activeElement.id === "quick-add-toggle";',
      ),
      "Back restores switcher focus and clears credential drafts",
    );
    await click("#quick-add-toggle");
    check(
      await execute('return document.getElementById("quick-host").value === "preserved.example";'),
      "Back retains the non-secret endpoint draft",
    );
    await fill({ "quick-host": "socks5://[::1]:10808", "quick-name": "Quick local fixture" });
    await click("#quick-save");
    await waitFor(
      'return document.getElementById("quick-status").textContent.startsWith("Saved.");',
    );
    const afterQuick = (await call({ type: "state:get" })).state;
    const quickProfiles = await call({ type: "profiles:list" });
    const quickProfile = quickProfiles.profiles.find((p) => p.name === "Quick local fixture");
    check(
      quickProfile?.proxy.type === "socks5" &&
        quickProfile.proxy.host === "::1" &&
        quickProfile.proxy.port === 10808,
      "Popup quick setup parses IPv6 and saves a validated proxy",
    );
    check(
      afterQuick.generation === beforeQuick.generation &&
        afterQuick.activeProfileId === beforeQuick.activeProfileId,
      "Popup Save does not activate or resolve identity",
    );
    await fill({ "quick-host": "http://fixture-secret:fixture-password@localhost:8080" });
    await click("#quick-save");
    await waitFor(
      'return document.getElementById("quick-status").textContent.includes("Remove credentials");',
    );
    check(
      !(await call({ type: "profiles:list" })).profiles.some((p) =>
        JSON.stringify(p).includes("fixture-secret"),
      ),
      "Credential-bearing pasted URL is not saved",
    );
    await click("#quick-add-toggle");
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
    // WebDriver click completion does not await the async runtime mutation.
    await waitFor(`return (document.getElementById("profile-form").hidden
      ? document.getElementById("direct-deactivate")
      : document.getElementById("deactivate")).disabled;`);
    check(
      (await call({ type: "state:get" })).state.activeProfileId === null,
      "Final Off releases the test profile",
    );
    await client.send("WebDriver:SetWindowRect", { width: 600, height: 800 });
    for (const language of ["zh_CN", "en"]) {
      await fill({ "ui-language": language });
      await waitFor(
        `return document.documentElement.lang === ${JSON.stringify(language === "zh_CN" ? "zh-CN" : "en")};`,
      );
      check(
        await execute(
          "return document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1;",
        ),
        `Options remain horizontally contained in a narrow window (${language})`,
      );
    }
  } finally {
    if (client !== null) client.close();
    let stopped = false;
    try {
      await stopFirefox(firefox);
      stopped = true;
    } finally {
      try {
        if (liveMap) await liveMap.close();
      } finally {
        if (directory && stopped) await rm(directory, { recursive: true, force: true });
        else if (directory)
          log(
            "Owned disposable profile retained because process termination could not be verified.",
          );
      }
    }
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
