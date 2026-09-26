/**
 * End-to-end smoke test against real Firefox.
 *
 * This is the only check that exercises the whole pipeline: Firefox loads the built
 * extension, the harness activates an HTTP profile through a local forwarding
 * proxy (install-time location consent; the user's own IP is not sent), the
 * GeoIP provider
 * is queried through the active route, the identity is broadcast to a content script,
 * and the MAIN-world shim changes what the page observes.
 *
 * What is verified against reality:
 *   - the extension installs and loads (from web-ext's own output)
 *   - a probe page sees the page shim installed
 *   - the page's timezone and timezone offset match the identity that was resolved
 *     from the provider for the current egress IP
 *   - `navigator.geolocation.getCurrentPosition` returns the identity's approximate
 *     coordinates with a coarse accuracy, without a permission prompt
 *   - the returned position is a real `GeolocationPosition` prototype instance
 *
 * Exit codes: 0 = all checks passed, 1 = a check failed, 2 = inconclusive because the
 * environment (no browser, no network) cannot produce the data. It never reports a
 * pass that did not happen.
 *
 * Privacy: like the extension itself, this script contacts the configured GeoIP
 * provider to learn the expected identity. That request comes from this machine's
 * normal network route.
 *
 * Usage:
 *   node scripts/e2e-smoke.mjs [--firefox <path>] [--timeout <seconds>] [--keep-open]
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { values } = parseArgs({
  options: {
    firefox: { type: "string" },
    timeout: { type: "string", default: "90" },
    "keep-open": { type: "boolean", default: false },
  },
});

const WINDOWS_DEVELOPER_EDITION = "C:\\Program Files\\Firefox Developer Edition\\firefox.exe";
const firefoxPath =
  values.firefox ?? (existsSync(WINDOWS_DEVELOPER_EDITION) ? WINDOWS_DEVELOPER_EDITION : undefined);
const timeoutMs = Number(values.timeout) * 1000;

// Ports below 50000 avoid the Windows reserved ranges; 45871 is also used by no tool.
const PAGE_PORT = 45871;
const CROSS_PORT = 45872;
const PAGE_URL = `http://127.0.0.1:${PAGE_PORT}/`;
const CROSS_FRAME_URL = `http://127.0.0.1:${CROSS_PORT}/frame?name=cross`;

const PROBE_PAGE = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>net-identity probe</title></head>
  <body>
    <h1>net-identity probe</h1>
    <pre id="out">waiting for the extension…</pre>
    <iframe title="same" src="/frame?name=same"></iframe>
    <iframe title="srcdoc" srcdoc="<script>function publish(){parent.postMessage({niFrame:'srcdoc',shim:'__netIdentityShim' in window,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone},'*')}publish();var timer=setInterval(publish,200);setTimeout(function(){clearInterval(timer)},4000)</script>"></iframe>
    <iframe title="cross" src="${CROSS_FRAME_URL}"></iframe>
    <iframe title="sandbox" sandbox="allow-scripts" srcdoc="<script>parent.postMessage({niFrame:'sandbox',shim:'__netIdentityShim' in window,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone},'*')</script>"></iframe>
    <script>
      const output = document.getElementById("out");

      function timezoneSnapshot() {
        const now = new Date();
        return {
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          intlTimeZone: new Intl.DateTimeFormat("en-US").resolvedOptions().timeZone,
          offsetMinutes: now.getTimezoneOffset(),
          epoch: now.getTime(),
          localYear: now.getFullYear(),
          localMonth: now.getMonth(),
          localDay: now.getDate(),
          localHour: now.getHours(),
          localMinute: now.getMinutes(),
          utcHour: now.getUTCHours(),
          dateString: new Date(Date.UTC(2024, 0, 1, 12, 0, 0)).toString(),
          shimInstalled: "__netIdentityShim" in window,
        };
      }

      function geolocationSnapshot() {
        return new Promise((resolve) => {
          if (navigator.geolocation === undefined) {
            resolve({ error: "no geolocation API" });
            return;
          }
          let settled = false;
          const finish = (value) => {
            if (settled) return;
            settled = true;
            resolve(value);
          };
          setTimeout(() => finish({ error: "geolocation timeout (no prompt was possible)" }), 6000);
          navigator.geolocation.getCurrentPosition(
            (position) => finish({
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              accuracy: position.coords.accuracy,
              isGeolocationPosition: position instanceof GeolocationPosition,
              hasTimestamp: typeof position.timestamp === "number",
            }),
            (error) => finish({ error: "code=" + error.code + " message=" + error.message }),
            { timeout: 5000 },
          );
        });
      }

      const frames = {};
      window.addEventListener("message", (event) => {
        const data = event.data;
        if (data === null || typeof data !== "object" || typeof data.niFrame !== "string") return;
        frames[data.niFrame] = { shim: data.shim === true, timeZone: data.timeZone };
      });

      async function report() {
        const names = ["same", "srcdoc", "cross"];
        const frameDeadline = Date.now() + 5000;
        while (Date.now() < frameDeadline) {
          const topZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
          const ready = names.every(
            (name) => frames[name]?.shim === true && frames[name].timeZone === topZone,
          );
          if (ready) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        let geolocationPermission = "unavailable";
        try {
          geolocationPermission = (await navigator.permissions.query({ name: "geolocation" })).state;
        } catch (error) {
          geolocationPermission = String(error);
        }
        const payload = {
          at: Date.now(),
          url: location.href,
          ...timezoneSnapshot(),
          position: await geolocationSnapshot(),
          geolocationPermission,
          frames: { ...frames },
        };
        output.textContent = JSON.stringify(payload, null, 2);
        try {
          await fetch("/report", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
        } catch (error) {
          /* the server is gone; nothing to do */
        }
      }

      // Report repeatedly: the identity is resolved asynchronously at startup, and a
      // watch loop makes the harness independent of exact startup timing.
      setInterval(report, 3000);
      setTimeout(report, 1200);
    </script>
  </body>
</html>`;

let lastReport = null;
let reportCount = 0;

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
  const timer = setInterval(publish, 200);
  setTimeout(() => clearInterval(timer), 4000);
</script>`;

function serveProbe(request, response) {
  const path = request.url ?? "/";
  if (path.startsWith("/frame")) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(FRAME_PAGE);
    return;
  }
  if (request.method === "POST" && path === "/report") {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        lastReport = JSON.parse(body);
        reportCount += 1;
        console.error(`[e2e] report #${reportCount} received`);
      } catch {
        console.error("[e2e] received an unparsable report");
      }
      response.writeHead(204).end();
    });
    return;
  }

  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(PROBE_PAGE);
}

const server = createServer(serveProbe);
const crossServer = createServer(serveProbe);

function fetchExpectedIdentity() {
  const endpoint =
    "https://ipwho.is/?fields=success,ip,country_code,region,city,latitude,longitude,timezone";
  return fetch(endpoint, { headers: { accept: "application/json" }, cache: "no-store" })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
}

function zonedWallClock(timeZone, epochMs) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(epochMs)).map((part) => [part.type, part.value]),
  );
  let hour = Number(parts.hour);
  let day = Number(parts.day);
  let month = Number(parts.month);
  let year = Number(parts.year);
  if (hour === 24) {
    hour = 0;
    const next = new Date(Date.UTC(year, month - 1, day) + 24 * 60 * 60 * 1000);
    year = next.getUTCFullYear();
    month = next.getUTCMonth() + 1;
    day = next.getUTCDate();
  }
  return { year, month: month - 1, day, hour, minute: Number(parts.minute) };
}

function offsetMinutesFor(timeZone, epochMs) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(epochMs)).map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const seconds = Math.floor(epochMs / 1000) * 1000;
  const offset = -Math.round((asUtc - seconds) / 60000);
  return offset === 0 ? 0 : offset;
}

function createMarionette(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let buffer = Buffer.alloc(0);
    const pending = new Map();
    let nextId = 1;
    let handshake = false;
    const take = () => {
      const colon = buffer.indexOf(0x3a);
      if (colon < 1) return null;
      const length = Number(buffer.subarray(0, colon).toString("utf8"));
      if (!Number.isInteger(length) || length < 0) throw new Error("bad marionette packet");
      const start = colon + 1;
      if (buffer.length < start + length) return null;
      const payload = buffer.subarray(start, start + length).toString("utf8");
      buffer = buffer.subarray(start + length);
      return JSON.parse(payload);
    };
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

const LOCATE_EXTENSION = `
  const callback = arguments[arguments.length - 1];
  try {
    const policy = WebExtensionPolicy.getByID("net-identity@jacek4yang.github.io");
    if (!policy) {
      callback({ error: "extension policy is not installed yet" });
      return;
    }
    callback({ ok: true, baseURL: "moz-extension://" + policy.mozExtensionHostname + "/" });
  } catch (error) {
    callback({ error: String(error) });
  }
`;

const OPTIONS_CALL = `
  const callback = arguments[arguments.length - 1];
  const message = arguments[0];
  try {
    const page = window.wrappedJSObject || window;
    const payload = page.JSON.parse(JSON.stringify(message));
    page.browser.runtime.sendMessage(payload).then(
      (value) => callback({ ok: true, value: page.JSON.parse(page.JSON.stringify(value)) }),
      (error) => callback({ error: String(error) }),
    );
  } catch (error) {
    callback({ error: String(error) });
  }
`;

async function activateProxiedProfile(port, proxyPort, deadline) {
  let client = null;
  try {
    client = await connectMarionette(port, deadline);
    await client.send("WebDriver:NewSession", {
      capabilities: { alwaysMatch: { browserName: "firefox", acceptInsecureCerts: true } },
    });
    await client.send("WebDriver:SetTimeouts", { script: 30000, pageLoad: 30000, implicit: 0 });
    await client.send("Marionette:SetContext", { value: "chrome" });

    let location = null;
    while (Date.now() < deadline) {
      const located = await client.send("WebDriver:ExecuteAsyncScript", {
        script: LOCATE_EXTENSION,
        args: [],
      });
      location = located?.value ?? located;
      if (location && location.ok === true) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (!location || location.ok !== true) return { ok: false, error: JSON.stringify(location) };

    await client.send("Marionette:SetContext", { value: "content" });
    await client.send("WebDriver:Navigate", {
      url: new URL("options/options.html", location.baseURL).href,
    });
    const profile = {
      id: "e2e-proxy01",
      name: "E2E proxy",
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
    const saved = await client.send("WebDriver:ExecuteAsyncScript", {
      script: OPTIONS_CALL,
      args: [{ type: "profiles:save", profile }],
    });
    const saveResult = saved?.value ?? saved;
    if (!saveResult?.ok || saveResult.value?.ok !== true) {
      return { ok: false, error: JSON.stringify(saveResult) };
    }
    const activated = await client.send(
      "WebDriver:ExecuteAsyncScript",
      { script: OPTIONS_CALL, args: [{ type: "profiles:activate", profileId: profile.id }] },
      40000,
    );
    const activateResult = activated?.value ?? activated;
    if (!activateResult?.ok || activateResult.value?.ok !== true) {
      return { ok: false, error: JSON.stringify(activateResult) };
    }
    await client.send("WebDriver:Navigate", { url: PAGE_URL });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    client?.close();
  }
}

function startFirefox(marionettePort, onOutput) {
  const cli = path.join(root, "node_modules", "web-ext", "bin", "web-ext.js");
  const args = [
    cli,
    "run",
    "--source-dir",
    path.join(root, "dist"),
    "--url",
    PAGE_URL,
    "--no-input",
    "--no-reload",
    "--browser-console",
    `--pref=marionette.port=${marionettePort}`,
    "--arg=--marionette",
    "--arg=-remote-allow-system-access",
  ];
  if (firefoxPath !== undefined) args.push("--firefox", firefoxPath);

  const child = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => onOutput(String(chunk)));
  child.stderr.on("data", (chunk) => onOutput(String(chunk)));
  return child;
}

function stopFirefox(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    // Kill the whole tree: the launcher spawns firefox.exe as a child process.
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

async function waitForReport(predicate, deadline) {
  while (Date.now() < deadline) {
    if (lastReport !== null && predicate(lastReport)) return lastReport;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

async function main() {
  if (!existsSync(path.join(root, "dist", "manifest.json"))) {
    console.error("[e2e] dist/ is missing. Run `npm run build` first.");
    process.exit(1);
  }

  console.error("[e2e] requesting the expected identity from the GeoIP provider…");
  const expected = await fetchExpectedIdentity();
  if (expected === null || expected.success !== true) {
    console.error(
      "[e2e] INCONCLUSIVE: the GeoIP provider could not be reached from this machine, so the expected identity is unknown.",
    );
    process.exit(2);
  }
  console.error(
    `[e2e] expected identity: ${expected.ip} / ${expected.city ?? "?"} / ${expected.timezone?.id ?? "?"}`,
  );

  await new Promise((resolve) => server.listen(PAGE_PORT, "127.0.0.1", resolve));
  await new Promise((resolve) => crossServer.listen(CROSS_PORT, "127.0.0.1", resolve));
  console.error(`[e2e] probe page served at ${PAGE_URL}`);

  const marionettePort = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address === null || typeof address === "string")
          reject(new Error("no marionette port"));
        else resolve(address.port);
      });
    });
  });

  const proxyPort = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        if (address === null || typeof address === "string") reject(new Error("no proxy port"));
        else resolve(address.port);
      });
    });
  });
  const devProxy = spawn(
    process.execPath,
    [path.join(root, "scripts", "dev-proxy.mjs"), "--port", String(proxyPort)],
    { cwd: root, stdio: "ignore" },
  );

  let firefoxOutput = "";
  const firefox = startFirefox(marionettePort, (chunk) => {
    firefoxOutput += chunk;
  });

  const deadline = Date.now() + timeoutMs;
  const activated = await activateProxiedProfile(marionettePort, proxyPort, deadline);
  if (!activated.ok) {
    console.error(`[e2e] FAIL: could not activate the proxied profile: ${activated.error}`);
    if (values["keep-open"] !== true) stopFirefox(firefox);
    devProxy.kill();
    server.close();
    crossServer.close();
    process.exit(1);
  }
  console.error("[e2e] proxied profile activated under install-time location consent");

  const report = await waitForReport((candidate) => candidate.shimInstalled === true, deadline);

  if (values["keep-open"] !== true) stopFirefox(firefox);
  devProxy.kill();
  server.close();
  crossServer.close();

  if (report === null) {
    console.error("[e2e] FAIL: the probe page never reported that the shim was installed.");
    console.error("[e2e] Firefox output (tail):");
    console.error(firefoxOutput.split("\n").slice(-25).join("\n"));
    process.exit(1);
  }

  const expectedTimeZone = expected.timezone?.id ?? null;
  const failures = [];

  const installed = /Installed .* as a temporary add-on|The extension was installed/i.test(
    firefoxOutput,
  );
  console.error(`[e2e] ${installed ? "PASS" : "WARN"}  extension installed (web-ext log)`);

  console.error(`[e2e] PASS  page shim installed (reports: ${reportCount})`);
  console.error(
    `[e2e] ${report.intlTimeZone === report.timeZone ? "PASS" : "FAIL"}  Intl.DateTimeFormat agrees (${report.timeZone})`,
  );
  if (report.intlTimeZone !== report.timeZone) failures.push("Intl.DateTimeFormat disagreement");

  const timezoneMatches = expectedTimeZone === null || report.timeZone === expectedTimeZone;
  console.error(
    `[e2e] ${timezoneMatches ? "PASS" : "FAIL"}  page timezone "${report.timeZone}" ${timezoneMatches ? "==" : "!="} expected "${expectedTimeZone}"`,
  );
  if (!timezoneMatches) failures.push("timezone does not match the observed egress identity");

  const expectedOffset =
    expectedTimeZone === null ? null : offsetMinutesFor(report.timeZone, report.at);
  const offsetMatches = expectedOffset === null || report.offsetMinutes === expectedOffset;
  console.error(
    `[e2e] ${offsetMatches ? "PASS" : "FAIL"}  getTimezoneOffset() = ${report.offsetMinutes} (expected ${expectedOffset} for ${report.timeZone})`,
  );
  if (!offsetMatches) failures.push("getTimezoneOffset() does not match the applied timezone");

  const permissionOk = report.geolocationPermission === "granted";
  console.error(
    `[e2e] ${permissionOk ? "PASS" : "FAIL"}  geolocation permission ${report.geolocationPermission}`,
  );
  if (!permissionOk) failures.push("geolocation permission does not match the active shim");

  for (const name of ["same", "srcdoc", "cross"]) {
    const frame = report.frames?.[name];
    const frameOk = frame?.shim === true && frame.timeZone === report.timeZone;
    console.error(
      `[e2e] ${frameOk ? "PASS" : "FAIL"}  ${name} frame shim=${String(frame?.shim)} zone=${String(frame?.timeZone)}`,
    );
    if (!frameOk) failures.push(`${name} frame did not observe the same timezone shim`);
  }
  const sandbox = report.frames?.sandbox;
  if (sandbox?.shim === true && sandbox.timeZone !== report.timeZone) {
    failures.push("sandboxed frame shim observed a different timezone");
  } else {
    console.error(
      `[e2e] ${sandbox?.shim === true ? "PASS" : "WARN"}  sandbox frame shim=${String(sandbox?.shim)} zone=${String(sandbox?.timeZone)}`,
    );
  }

  if (typeof report.timeZone === "string" && typeof report.epoch === "number") {
    const wall = zonedWallClock(report.timeZone, report.epoch);
    const localMatches =
      report.localYear === wall.year &&
      report.localMonth === wall.month &&
      report.localDay === wall.day &&
      report.localHour === wall.hour &&
      report.localMinute === wall.minute;
    console.error(
      `[e2e] ${localMatches ? "PASS" : "FAIL"}  local getters ${report.localYear}-${report.localMonth + 1}-${report.localDay} ${report.localHour}:${report.localMinute} vs ${report.timeZone}`,
    );
    if (!localMatches) {
      failures.push("local Date getters do not match the applied timezone");
    }
  }

  const position = report.position ?? {};
  if (position.error !== undefined) {
    console.error(`[e2e] FAIL  geolocation: ${position.error}`);
    failures.push(`geolocation unavailable: ${position.error}`);
  } else {
    const latitudeOk = Math.abs(position.latitude - expected.latitude) < 1.5;
    const longitudeOk = Math.abs(position.longitude - expected.longitude) < 1.5;
    const accuracyOk = position.accuracy === 20000;
    console.error(
      `[e2e] ${latitudeOk && longitudeOk ? "PASS" : "FAIL"}  geolocation ${position.latitude}, ${position.longitude} vs provider ${expected.latitude}, ${expected.longitude}`,
    );
    console.error(
      `[e2e] ${accuracyOk ? "PASS" : "FAIL"}  accuracy ${position.accuracy} m is the documented coarse value`,
    );
    console.error(
      `[e2e] ${position.isGeolocationPosition === true ? "PASS" : "WARN"}  position instanceof GeolocationPosition = ${String(position.isGeolocationPosition)}`,
    );
    if (!latitudeOk || !longitudeOk)
      failures.push("geolocation coordinates do not match the provider");
    if (!accuracyOk) failures.push("geolocation accuracy is not the coarse GeoIP value");
  }

  if (failures.length > 0) {
    console.error(`[e2e] FAILED: ${failures.join("; ")}`);
    process.exit(1);
  }

  console.error("[e2e] PASSED: the page observed the identity resolved from the proxy egress IP.");
  process.exit(0);
}

main().catch((error) => {
  console.error(`[e2e] harness error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
