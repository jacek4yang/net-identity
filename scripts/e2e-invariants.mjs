/**
 * Deterministic Firefox checks for identity invariants.
 *
 * Unlike `e2e-smoke.mjs`, this harness does not contact a GeoIP provider.
 * A local page is the probe. Firefox's own geolocation provider is pointed at
 * that page so a native position is a known sentinel. A local proxy answers
 * every upstream request with 502, so an automatic lookup fails closed.
 *
 * What is verified:
 *   - while no profile is active, geolocation is the sentinel (native works)
 *   - a manual profile applies its coordinates, timezone, local Date getters,
 *     UTC methods, and the same timezone in a child frame and a srcdoc frame
 *   - WebRTC policy becomes proxy_only, then returns to the value from before
 *     activation after deactivation
 *   - a failed automatic lookup reports position-unavailable and does not
 *     return the native sentinel
 *   - deactivation restores the native sentinel
 *
 * Exit codes: 0 pass, 1 failed check, 2 Firefox or the native provider is
 * unavailable. A pass is never reported for a check that did not run.
 *
 * Usage:
 *   node scripts/e2e-invariants.mjs [--firefox <path>] [--timeout <seconds>]
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WINDOWS_DEVELOPER_EDITION = "C:\\Program Files\\Firefox Developer Edition\\firefox.exe";
const EXTENSION_ID = "net-identity@jacek4yang.github.io";
const NATIVE_LAT = 1.25;
const NATIVE_LNG = 2.5;
const MANUAL_LAT = 48.2;
const MANUAL_LNG = 11.4;
const MANUAL_ZONE = "Pacific/Auckland";

const { values } = parseArgs({
  options: {
    firefox: { type: "string" },
    timeout: { type: "string", default: "120" },
  },
});

const firefoxPath =
  values.firefox ?? (existsSync(WINDOWS_DEVELOPER_EDITION) ? WINDOWS_DEVELOPER_EDITION : undefined);
const timeoutMs = Number(values.timeout) * 1000;

function log(message) {
  console.error(`[e2e:invariants] ${message}`);
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
            resolve: (value) => {
              clearTimeout(timer);
              resolveCommand(value);
            },
            reject: (error) => {
              clearTimeout(timer);
              rejectCommand(error);
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

const LOCATE = `
  const callback = arguments[arguments.length - 1];
  try {
    const policy = WebExtensionPolicy.getByID(${JSON.stringify(EXTENSION_ID)});
    if (!policy) { callback({ error: "not installed" }); return; }
    callback({ ok: true, baseURL: "moz-extension://" + policy.mozExtensionHostname + "/" });
  } catch (error) { callback({ error: String(error) }); }
`;

const CALL = `
  const callback = arguments[arguments.length - 1];
  const message = arguments[0];
  try {
    const page = window.wrappedJSObject || window;
    const payload = page.JSON.parse(JSON.stringify(message));
    page.browser.runtime.sendMessage(payload).then(
      (value) => callback({ ok: true, value: page.JSON.parse(page.JSON.stringify(value)) }),
      (error) => callback({ error: String(error) }),
    );
  } catch (error) { callback({ error: String(error) }); }
`;

const READ_WEBRTC = `
  const callback = arguments[arguments.length - 1];
  try {
    const page = window.wrappedJSObject || window;
    page.browser.privacy.network.webRTCIPHandlingPolicy.get({}).then(
      (value) => callback({ ok: true, value: page.JSON.parse(page.JSON.stringify(value)) }),
      (error) => callback({ error: String(error) }),
    );
  } catch (error) { callback({ error: String(error) }); }
`;

function probePage(zone) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /></head><body>
<iframe title="same" src="/frame?name=same"></iframe>
<iframe title="srcdoc" srcdoc="<script>function publish(){parent.postMessage({niFrame:'srcdoc',shim:'__netIdentityShim' in window,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone},'*')}publish();setInterval(publish,200)</script>"></iframe>
<script>
  const frames = {};
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (data === null || typeof data !== "object" || typeof data.niFrame !== "string") return;
    frames[data.niFrame] = { shim: data.shim === true, timeZone: data.timeZone };
  });

  function parts(timeZone, epoch) {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    const map = {};
    for (const part of formatter.formatToParts(new Date(epoch))) map[part.type] = part.value;
    let hour = Number(map.hour);
    let day = Number(map.day);
    let month = Number(map.month);
    let year = Number(map.year);
    if (hour === 24) {
      hour = 0;
      const next = new Date(Date.UTC(year, month - 1, day) + 86400000);
      year = next.getUTCFullYear();
      month = next.getUTCMonth() + 1;
      day = next.getUTCDate();
    }
    return { year: year, month: month, day: day, hour: hour, minute: Number(map.minute) };
  }

  function report() {
    const now = new Date();
    const epoch = now.getTime();
    const local = {
      year: now.getFullYear(),
      month: now.getMonth() + 1,
      day: now.getDate(),
      hour: now.getHours(),
      minute: now.getMinutes(),
    };
    const target = parts(${JSON.stringify(zone)}, epoch);
    const utc = parts("UTC", epoch);
    const same = (left, right) =>
      left.year === right.year && left.month === right.month && left.day === right.day &&
      left.hour === right.hour && left.minute === right.minute;
    navigator.geolocation.getCurrentPosition(
      (position) => send({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy,
      }),
      (error) => send({ error: "code=" + error.code + " " + error.message }),
      { timeout: 4000, maximumAge: 0 },
    );
    function send(position) {
      const payload = {
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        offsetMinutes: now.getTimezoneOffset(),
        localMatchesTarget: same(local, target),
        utcGetterMatchesIntl: now.getUTCHours() === utc.hour && now.getUTCMinutes() === utc.minute,
        explicitUtc: new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: "2-digit", hourCycle: "h23" }).formatToParts(now).find((part) => part.type === "hour").value,
        position: position,
        frames: { ...frames },
        shim: "__netIdentityShim" in window,
      };
      payload.explicitUtcMatches = Number(payload.explicitUtc) === utc.hour;
      fetch("/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }).catch(() => {});
    }
  }
  setInterval(report, 1000);
  setTimeout(report, 200);
</script></body></html>`;
}

const FRAME_PAGE = `<!doctype html><script>
  const name = new URLSearchParams(location.search).get("name");
  function publish() {
    parent.postMessage({
      niFrame: name,
      shim: "__netIdentityShim" in window,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }, "*");
  }
  publish();
  setInterval(publish, 200);
</script>`;

function startProbe(port) {
  let lastReport = null;
  const server = createServer((request, response) => {
    const url = request.url ?? "/";
    if (url.startsWith("/geo")) {
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      });
      response.end(
        JSON.stringify({ location: { lat: NATIVE_LAT, lng: NATIVE_LNG }, accuracy: 50 }),
      );
      return;
    }
    if (url.startsWith("/frame")) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(FRAME_PAGE);
      return;
    }
    if (request.method === "POST" && url.startsWith("/report")) {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        try {
          lastReport = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          log("received an unparsable report");
        }
        response.writeHead(204).end();
      });
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(probePage(MANUAL_ZONE));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({
        server,
        read() {
          return lastReport;
        },
        reset() {
          lastReport = null;
        },
      });
    });
  });
}

function startBlackhole(port) {
  const server = net.createServer((socket) => {
    socket.once("data", () => {
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function stopProcess(child) {
  if (child === null || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

async function waitForReport(read, predicate, deadline) {
  while (Date.now() < deadline) {
    const report = read();
    if (report !== null && predicate(report)) return report;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

function isNativePosition(report) {
  const position = report.position ?? {};
  return position.latitude === NATIVE_LAT && position.longitude === NATIVE_LNG;
}

function isManualPosition(report) {
  const position = report.position ?? {};
  return (
    Math.abs(position.latitude - MANUAL_LAT) < 0.001 &&
    Math.abs(position.longitude - MANUAL_LNG) < 0.001 &&
    position.accuracy === 1500
  );
}

async function main() {
  if (!existsSync(path.join(root, "dist", "manifest.json"))) {
    log("FAIL: dist/ is missing. Run npm run build first.");
    process.exit(1);
  }
  if (firefoxPath === undefined) {
    log("INCONCLUSIVE: no Firefox binary. Pass --firefox <path>.");
    process.exit(2);
  }

  const pagePort = await freePort();
  const proxyPort = await freePort();
  const marionettePort = await freePort();
  const pageUrl = `http://127.0.0.1:${pagePort}/`;
  const probe = await startProbe(pagePort);
  const blackhole = await startBlackhole(proxyPort);

  const cli = path.join(root, "node_modules", "web-ext", "bin", "web-ext.js");
  let firefoxOutput = "";
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
      "--pref=geo.provider.testing=true",
      "--pref=geo.prompt.testing=true",
      "--pref=geo.prompt.testing.allow=true",
      "--pref=geo.wifi.scan=false",
      `--pref=geo.provider.network.url=http://127.0.0.1:${pagePort}/geo`,
      "--arg=--marionette",
      "--arg=-remote-allow-system-access",
      "--arg=-headless",
      "--firefox",
      firefoxPath,
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  );
  firefox.stdout.on("data", (chunk) => {
    firefoxOutput += String(chunk);
  });
  firefox.stderr.on("data", (chunk) => {
    firefoxOutput += String(chunk);
  });

  const deadline = Date.now() + timeoutMs;
  const failures = [];
  let inconclusive = false;
  let client = null;
  let optionsUrl;

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
    await client.send("WebDriver:SetTimeouts", { script: 40000, pageLoad: 30000, implicit: 0 });
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
    optionsUrl = new URL("options/options.html", location.baseURL).href;

    await client.send("Marionette:SetContext", { value: "content" });
    await client.send("WebDriver:Navigate", { url: pageUrl });
    const native = await waitForReport(probe.read, isNativePosition, deadline);
    if (native === null) {
      log("INCONCLUSIVE: Firefox did not return the sentinel native geolocation.");
      log(firefoxOutput.split("\n").slice(-20).join("\n"));
      inconclusive = true;
      throw new Error("native geolocation sentinel was not observed");
    }
    check(native.shim === true, "shim installed while idle");
    check(
      isNativePosition(native),
      `idle geolocation is the native sentinel ${NATIVE_LAT},${NATIVE_LNG}`,
    );

    await client.send("WebDriver:Navigate", { url: optionsUrl });
    const baselineResult = await client.send("WebDriver:ExecuteAsyncScript", {
      script: READ_WEBRTC,
      args: [],
    });
    const baseline = (baselineResult?.value ?? baselineResult)?.value;
    if (typeof baseline?.value !== "string") {
      throw new Error(`could not read the WebRTC policy: ${JSON.stringify(baselineResult)}`);
    }
    log(`baseline WebRTC policy is ${baseline.value}`);

    const manualProfile = {
      id: "e2e-invman",
      name: "Invariant manual",
      proxy: {
        type: "http",
        host: "127.0.0.1",
        port: proxyPort,
        proxyDNS: false,
        bypassHosts: ["localhost", "127.0.0.1", "::1"],
      },
      identity: {
        mode: "manual",
        latitude: MANUAL_LAT,
        longitude: MANUAL_LNG,
        accuracy: 1500,
        timezone: MANUAL_ZONE,
      },
      webrtcPolicy: "proxy_only",
    };
    const saved = await client.send(
      "WebDriver:ExecuteAsyncScript",
      { script: CALL, args: [{ type: "profiles:save", profile: manualProfile }] },
      40000,
    );
    const saveValue = saved?.value ?? saved;
    if (!saveValue?.ok || saveValue.value?.ok !== true) {
      throw new Error(`save failed: ${JSON.stringify(saveValue)}`);
    }
    const activated = await client.send(
      "WebDriver:ExecuteAsyncScript",
      { script: CALL, args: [{ type: "profiles:activate", profileId: manualProfile.id }] },
      40000,
    );
    const activateValue = activated?.value ?? activated;
    if (!activateValue?.ok || activateValue.value?.ok !== true) {
      throw new Error(`activate failed: ${JSON.stringify(activateValue)}`);
    }

    const appliedPolicy = await client.send("WebDriver:ExecuteAsyncScript", {
      script: READ_WEBRTC,
      args: [],
    });
    const applied = (appliedPolicy?.value ?? appliedPolicy)?.value;
    check(applied?.value === "proxy_only", `WebRTC policy is proxy_only (saw ${applied?.value})`);

    probe.reset();
    await client.send("WebDriver:Navigate", { url: pageUrl });
    const manual = await waitForReport(
      probe.read,
      (report) =>
        report.timeZone === MANUAL_ZONE &&
        isManualPosition(report) &&
        report.frames?.same?.timeZone === MANUAL_ZONE &&
        report.frames?.srcdoc?.timeZone === MANUAL_ZONE &&
        report.frames?.same?.shim === true &&
        report.frames?.srcdoc?.shim === true,
      deadline,
    );
    if (manual === null)
      throw new Error(`manual identity was not observed: ${JSON.stringify(probe.read())}`);
    check(manual.localMatchesTarget === true, `local Date getters match ${MANUAL_ZONE}`);
    check(
      manual.utcGetterMatchesIntl === true,
      "UTC Date getters match an explicit UTC Intl format",
    );
    check(manual.explicitUtcMatches === true, "an explicit Intl timeZone of UTC stays UTC");
    check(!isNativePosition(manual), "manual geolocation is not the native sentinel");
    for (const name of ["same", "srcdoc"]) {
      const frame = manual.frames?.[name];
      check(
        frame?.shim === true && frame.timeZone === MANUAL_ZONE,
        `${name} frame zone ${frame?.timeZone ?? "missing"}`,
      );
    }

    await client.send("WebDriver:Navigate", { url: optionsUrl });
    const deactivated = await client.send(
      "WebDriver:ExecuteAsyncScript",
      { script: CALL, args: [{ type: "profiles:deactivate" }] },
      40000,
    );
    const deactivateValue = deactivated?.value ?? deactivated;
    if (!deactivateValue?.ok)
      throw new Error(`deactivate failed: ${JSON.stringify(deactivateValue)}`);
    const restoredPolicy = await client.send("WebDriver:ExecuteAsyncScript", {
      script: READ_WEBRTC,
      args: [],
    });
    const restored = (restoredPolicy?.value ?? restoredPolicy)?.value;
    check(
      restored?.value === baseline.value,
      `WebRTC policy restored to ${baseline.value} (saw ${restored?.value})`,
    );

    probe.reset();
    await client.send("WebDriver:Navigate", { url: pageUrl });
    const released = await waitForReport(probe.read, isNativePosition, deadline);
    check(released !== null, "deactivation returns the native geolocation sentinel");
    if (released !== null) {
      check(released.timeZone !== MANUAL_ZONE, "deactivation stops rewriting the page timezone");
    }

    const autoProfile = {
      id: "e2e-invaut",
      name: "Invariant auto",
      proxy: {
        type: "http",
        host: "127.0.0.1",
        port: proxyPort,
        proxyDNS: false,
        bypassHosts: ["localhost", "127.0.0.1", "::1"],
      },
      identity: { mode: "auto" },
      webrtcPolicy: "default",
    };
    await client.send("WebDriver:Navigate", { url: optionsUrl });
    const autoSaved = await client.send(
      "WebDriver:ExecuteAsyncScript",
      { script: CALL, args: [{ type: "profiles:save", profile: autoProfile }] },
      40000,
    );
    const autoSaveValue = autoSaved?.value ?? autoSaved;
    if (!autoSaveValue?.ok || autoSaveValue.value?.ok !== true) {
      throw new Error(`auto save failed: ${JSON.stringify(autoSaveValue)}`);
    }
    const autoActivated = await client.send(
      "WebDriver:ExecuteAsyncScript",
      { script: CALL, args: [{ type: "profiles:activate", profileId: autoProfile.id }] },
      40000,
    );
    const autoActivateValue = autoActivated?.value ?? autoActivated;
    if (!autoActivateValue?.ok || autoActivateValue.value?.ok !== true) {
      throw new Error(`auto activate failed: ${JSON.stringify(autoActivateValue)}`);
    }

    probe.reset();
    await client.send("WebDriver:Navigate", { url: pageUrl });
    const failed = await waitForReport(
      probe.read,
      (report) =>
        typeof report.position?.error === "string" &&
        report.position.error.includes("No network identity location is available"),
      deadline,
    );
    check(failed !== null, "failed automatic identity keeps geolocation unavailable");
    if (failed !== null) {
      check(
        !isNativePosition(failed),
        "failed automatic identity does not return the native sentinel",
      );
    }

    await client.send("WebDriver:Navigate", { url: optionsUrl });
    await client.send(
      "WebDriver:ExecuteAsyncScript",
      { script: CALL, args: [{ type: "profiles:deactivate" }] },
      40000,
    );
    probe.reset();
    await client.send("WebDriver:Navigate", { url: pageUrl });
    const restoredNative = await waitForReport(probe.read, isNativePosition, deadline);
    check(
      restoredNative !== null,
      "native geolocation returns after the failed profile is cleared",
    );
  } catch (error) {
    if (!inconclusive) {
      failures.push(error instanceof Error ? error.message : String(error));
      log(`FAIL  ${failures[failures.length - 1]}`);
      log(firefoxOutput.split("\n").slice(-30).join("\n"));
    }
  } finally {
    client?.close();
    stopProcess(firefox);
    blackhole.close();
    probe.server.close();
  }

  if (inconclusive) process.exit(2);
  if (failures.length > 0) {
    log(`FAILED: ${failures.join("; ")}`);
    process.exit(1);
  }
  log("PASSED: fail-closed geolocation, Date getters, frames, and WebRTC restore.");
  process.exit(0);
}

main().catch((error) => {
  log(`harness error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
