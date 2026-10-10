/** Deterministic local Firefox SOCKS5 outage, flap recovery, and full-restart leak test. */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { connectMarionette } from "./release-marionette.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    firefox: { type: "string" },
    flap: { type: "boolean", default: false },
    restart: { type: "boolean", default: false },
    auth: { type: "boolean", default: false },
    vault: { type: "boolean", default: false },
    timeout: { type: "string", default: "90" },
  },
});
const firefoxPath =
  values.firefox ??
  (process.platform === "win32"
    ? "C:\\Program Files\\Firefox Developer Edition\\firefox.exe"
    : "/usr/bin/firefox");
const deadline = Date.now() + Number(values.timeout) * 1000;
const extensionId = "net-identity@jacek4yang.github.io";
const log = (text) => console.error(`[e2e:fail-closed] ${text}`);

async function listen(server, port = 0, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server.address().port));
  });
}

async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function socksServer(seen, origin, preferAuth) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    let phase = 0;
    let selectedMethod = null;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (phase === 0 && buffer.length >= 2 + buffer[1]) {
        const methods = buffer.subarray(2, 2 + buffer[1]);
        // A real upstream may permit both authenticated and anonymous egress.
        // Losing session credentials must not silently select its anonymous mode.
        const method = preferAuth && methods.includes(2) ? 2 : 0;
        selectedMethod = methods.includes(method) ? method : 0xff;
        if (preferAuth) seen.push({ handshakeMethods: [...methods], selectedMethod });
        buffer = buffer.subarray(2 + buffer[1]);
        socket.write(Buffer.from([5, methods.includes(method) ? method : 0xff]));
        if (!methods.includes(method)) {
          socket.end();
          return;
        }
        phase = method === 2 ? 1 : 2;
      }
      if (phase === 1) {
        if (buffer.length < 2) return;
        if (buffer.length < 3 + buffer[1]) return;
        const username = buffer.subarray(2, 2 + buffer[1]).toString("utf8");
        const passwordLengthIndex = 2 + buffer[1];
        const total = passwordLengthIndex + 1 + buffer[passwordLengthIndex];
        if (buffer.length < total) return;
        const password = buffer.subarray(passwordLengthIndex + 1, total).toString("utf8");
        buffer = buffer.subarray(total);
        const accepted = username === "test-user" && password === "test-password";
        seen.push({
          authenticated: accepted,
          userLength: username.length,
          passwordLength: password.length,
        });
        socket.write(Buffer.from([1, accepted ? 0 : 1]));
        if (!accepted) {
          phase = -1;
          socket.end();
          return;
        }
        phase = 2;
      }
      if (phase !== 2 || buffer.length < 5) return;
      const atyp = buffer[3];
      const length = atyp === 1 ? 4 : atyp === 3 ? 1 + buffer[4] : 0;
      if (length === 0 || buffer.length < 4 + length + 2) return;
      const host =
        atyp === 1
          ? [...buffer.subarray(4, 8)].join(".")
          : buffer.subarray(5, 5 + buffer[4]).toString("utf8");
      const port = buffer.readUInt16BE(4 + length);
      seen.push({ host, port, ...(preferAuth ? { selectedMethod } : {}) });
      phase = 3;
      // Flap mode uses distinct origin and direct-sentinel ports. In every mode
      // the fixture accepts only its own local destinations.
      const localFixture = host === origin.address || host === "ni-fail-closed.invalid";
      if (!localFixture || ![origin.port, origin.securePort].includes(port)) {
        socket.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0]));
        return;
      }
      const destination = net.connect({
        host: localFixture ? "127.0.0.1" : host,
        port: values.flap
          ? port === origin.securePort
            ? origin.proxySecurePort
            : origin.proxyPort
          : port,
      });
      sockets.add(destination);
      destination.on("close", () => sockets.delete(destination));
      destination.on("error", () => socket.destroy());
      destination.on("connect", () => {
        socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        socket.pipe(destination);
        destination.pipe(socket);
      });
    });
  });
  return {
    server,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function anonymousSocksControl(port, origin) {
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let phase = 0;
    let buffer = Buffer.alloc(0);
    const finish = (error) => {
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(3000, () => finish(new Error("anonymous SOCKS positive control timed out")));
    socket.on("error", finish);
    socket.on("connect", () => socket.write(Buffer.from([5, 1, 0])));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (phase === 0 && buffer.length >= 2) {
        if (buffer[0] !== 5 || buffer[1] !== 0) {
          finish(new Error("fixture did not accept anonymous SOCKS"));
          return;
        }
        buffer = buffer.subarray(2);
        const host = Buffer.from(origin.address);
        const destinationPort = Buffer.alloc(2);
        destinationPort.writeUInt16BE(origin.port);
        socket.write(
          Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, destinationPort]),
        );
        phase = 1;
      }
      if (phase === 1 && buffer.length >= 10) {
        if (buffer[1] !== 0) {
          finish(new Error("anonymous SOCKS CONNECT was rejected"));
          return;
        }
        buffer = buffer.subarray(10);
        socket.write(
          `GET /anonymous-positive-control HTTP/1.1\r\nHost: ${origin.address}\r\nConnection: close\r\n\r\n`,
        );
        phase = 2;
      }
      if (phase === 2 && buffer.includes("\r\n\r\n")) {
        finish(
          buffer.toString().startsWith("HTTP/1.1 200")
            ? null
            : new Error("anonymous origin request failed"),
        );
      }
    });
  });
}

const locateExtension = `
  const done = arguments[arguments.length - 1];
  const policy = WebExtensionPolicy.getByID(${JSON.stringify(extensionId)});
  done(policy ? {baseURL: "moz-extension://" + policy.mozExtensionHostname + "/"} : null);
`;
const callExtension = `
  const done = arguments[arguments.length - 1];
  const payload = arguments[0];
  const page = window.wrappedJSObject || window;
  page.browser.runtime.sendMessage(page.JSON.parse(JSON.stringify(payload))).then(
    value => done(page.JSON.parse(page.JSON.stringify(value))),
    error => done({error: String(error)}));
`;
const probe = `
  const done = arguments[arguments.length - 1];
  const url = arguments[0];
  const wsUrl = arguments[1];
  const fetchProbe = fetch(url, {cache: "no-store", signal: AbortSignal.timeout(6000)}).then(r => r.text()).then(text => ({ok: true, text}), e => ({ok: false, error: String(e)}));
  const secureProbe = fetch(arguments[2], {cache: "no-store", signal: AbortSignal.timeout(6000)}).then(() => ({ok: true}), e => ({ok: false, error: String(e)}));
  const dnsProbe = fetch(arguments[3], {cache: "no-store", signal: AbortSignal.timeout(6000)}).then(r => r.text()).then(text => ({ok: true, text}), e => ({ok: false, error: String(e)}));
  const socketProbe = new Promise(resolve => {
    const socket = new WebSocket(wsUrl);
    const timer = setTimeout(() => { socket.close(); resolve({ok: false, timeout: true}); }, 6000);
    socket.onopen = () => { clearTimeout(timer); socket.close(); resolve({ok: true}); };
    socket.onerror = () => { clearTimeout(timer); resolve({ok: false}); };
  });
  const secureSocketProbe = new Promise(resolve => {
    const socket = new WebSocket(arguments[4]);
    const timer = setTimeout(() => { socket.close(); resolve({ok: false, timeout: true}); }, 6000);
    socket.onopen = () => { clearTimeout(timer); socket.close(); resolve({ok: true}); };
    socket.onerror = () => { clearTimeout(timer); resolve({ok: false}); };
  });
  Promise.all([fetchProbe, socketProbe, secureProbe, dnsProbe, secureSocketProbe]).then(
    ([http, ws, https, dns, wss]) => done({http, ws, https, dns, wss}));
`;
const httpOnlyProbe = `const done = arguments[arguments.length - 1];
  fetch(arguments[0], {cache: "no-store", signal: AbortSignal.timeout(6000)}).then(
    response => done({ok: true, status: response.status}),
    error => done({ok: false, error: String(error)}));`;

async function startFirefox(profileDir, marionettePort, pageUrl) {
  const args = [
    path.join(root, "node_modules", "web-ext", "bin", "web-ext.js"),
    "run",
    "--source-dir",
    path.join(root, "dist"),
    "--firefox-profile",
    profileDir,
    "--profile-create-if-missing",
    "--keep-profile-changes",
    "--no-input",
    "--no-reload",
    "--pre-install",
    "--url",
    pageUrl,
    `--pref=marionette.port=${marionettePort}`,
    "--pref=xpinstall.signatures.required=false",
    // A non-bypassed local name makes the sentinel reachable even in loopback-only
    // sandboxes. The separate .invalid name below is resolved exclusively by SOCKS.
    "--pref=network.dns.localDomains=ni-fail-closed-origin.test",
    "--arg=--marionette",
    "--arg=-remote-allow-system-access",
    "--arg=-headless",
    "--firefox",
    firefoxPath,
  ];
  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    // web-ext is a Node wrapper around Firefox. Kill the whole group on Linux,
    // otherwise Firefox retains the profile lock after only Node exits.
    detached: process.platform !== "win32",
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });
  try {
    const client = await connectMarionette(marionettePort, deadline);
    await client.send("WebDriver:NewSession", {
      browserName: "firefox",
      acceptInsecureCerts: values.flap,
    });
    await client.send("WebDriver:SetTimeouts", { script: 30000, pageLoad: 15000, implicit: 0 });
    await client.send("Marionette:SetContext", { value: "chrome" });
    let location = null;
    while (Date.now() < deadline) {
      location = (
        await client.send("WebDriver:ExecuteAsyncScript", { script: locateExtension, args: [] })
      )?.value;
      if (location?.baseURL) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!location?.baseURL) throw new Error("extension did not start");
    await client.send("Marionette:SetContext", { value: "content" });
    await client.send("WebDriver:Navigate", {
      url: new URL("options/options.html", location.baseURL).href,
    });
    return { child, client, profileDir, baseURL: location.baseURL, output: () => output };
  } catch (error) {
    await stopFirefox({ child, client: null });
    throw new Error(`${String(error)}\n${output.split("\n").slice(-15).join("\n")}`, {
      cause: error,
    });
  }
}

async function stopFirefox(browser) {
  browser.client?.close();
  if (process.platform === "win32") {
    if (browser.child.exitCode === null && browser.child.signalCode === null) {
      const killer = spawn("taskkill", ["/PID", String(browser.child.pid), "/T", "/F"], {
        stdio: "ignore",
      });
      await new Promise((resolve) => killer.once("exit", resolve));
    }
  } else {
    try {
      process.kill(-browser.child.pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  if (browser.child.exitCode === null && browser.child.signalCode === null)
    await new Promise((resolve) => browser.child.once("exit", resolve));
  if (process.platform !== "win32" && browser.profileDir) {
    const lock = path.join(browser.profileDir, "parent.lock");
    const lockDeadline = Date.now() + 15000;
    while (existsSync(lock) && Date.now() < lockDeadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    if (existsSync(lock)) throw new Error("Firefox did not release its profile lock");
  }
}

async function message(browser, payload) {
  await browser.client.send("WebDriver:Navigate", {
    url: new URL("options/options.html", browser.baseURL).href,
  });
  let ready = false;
  while (Date.now() < deadline) {
    const result = await browser.client.send("WebDriver:ExecuteScript", {
      script:
        'return {ready: document.readyState, form: !!document.querySelector("#profile-form"), browser: !!(window.wrappedJSObject || window).browser?.runtime, href: location.href};',
      args: [],
    });
    const status = result?.value ?? result;
    ready = status?.ready === "complete" && status?.form && status?.browser;
    if (!ready && Date.now() + 500 >= deadline) log(`options readiness: ${JSON.stringify(status)}`);
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error("options page did not become ready");
  const response = await browser.client.send("WebDriver:ExecuteAsyncScript", {
    script: callExtension,
    args: [payload],
  });
  return response?.value ?? response;
}

async function popupStatus(browser, profileId, expectedStatus) {
  await message(browser, { type: "state:get" });
  const opened = await browser.client.send("WebDriver:ExecuteAsyncScript", {
    script: `const done = arguments[arguments.length - 1];
      (window.wrappedJSObject || window).browser.action.openPopup().then(
        () => done(true), error => done(String(error)));`,
    args: [],
  });
  if ((opened?.value ?? opened) !== true) throw new Error("could not open the extension popup");
  await browser.client.send("Marionette:SetContext", { value: "chrome" });
  const popupUrl = new URL("popup/popup.html", browser.baseURL).href;
  const innerScript = `return {
    status: document.getElementById("status-text")?.textContent,
    selected: document.querySelector('[data-profile-id="' + arguments[0] + '"]')?.getAttribute("aria-checked"),
    off: document.getElementById("route-off")?.getAttribute("aria-checked")
  };`;
  let report = null;
  while (Date.now() < deadline) {
    const result = await browser.client.send("WebDriver:ExecuteAsyncScript", {
      script: `const done = arguments[arguments.length - 1];
        const b = [...document.querySelectorAll("panel")].filter(p => p.state === "open")
          .flatMap(p => [...p.querySelectorAll("browser")]).find(b => b.currentURI?.spec === arguments[0]);
        if (!b) { done(null); return; }
        b.browsingContext.currentWindowGlobal.getActor("MarionetteCommands")
          .executeScript(arguments[2], [arguments[1]],
            {sandboxName: "default", newSandbox: true}).then(value => done(value), error => done({error: String(error)}));`,
      args: [popupUrl, profileId, innerScript],
    });
    report = result?.value ?? result;
    if (report?.status === expectedStatus && report?.selected === "true") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await browser.client.send("WebDriver:ExecuteScript", {
    script: `for (const panel of document.querySelectorAll("panel")) if (panel.state === "open") panel.hidePopup();`,
    args: [],
  });
  await browser.client.send("Marionette:SetContext", { value: "content" });
  if (
    !report ||
    report.selected !== "true" ||
    report.off !== "false" ||
    report.status !== expectedStatus
  )
    throw new Error(`popup did not show ${expectedStatus} for Proxy A: ${JSON.stringify(report)}`);
  return report.status;
}

async function checkTraffic(browser, origin, phase) {
  // A locked vault intentionally blocks even loopback HTTP: its bypass list is
  // encrypted. Keep the probe document network-independent so cold-start tests
  // measure the actual requests, not a blocked harness-page navigation. This
  // ordinary opaque-origin page uses the same fetch/WebSocket probes and live
  // positive controls before and after locking; no extension-origin exemption.
  // Keep the HTTP document for other scenarios, especially the mixed HTTP/TLS
  // flap fixture, whose security context is part of its positive control.
  await browser.client.send("WebDriver:Navigate", {
    url: values.vault
      ? "data:text/html,<!doctype html><title>fail-closed probe</title>"
      : `http://127.0.0.1:${origin.pagePort}/`,
  });
  const response = await browser.client.send(
    "WebDriver:ExecuteAsyncScript",
    {
      script: probe,
      args: [
        `http://${origin.address}:${origin.port}/${phase}?r=${Date.now()}`,
        `ws://${origin.address}:${origin.port}/${phase}`,
        `https://${origin.address}:${origin.securePort ?? origin.port}/${phase}`,
        `http://ni-fail-closed.invalid:${origin.port}/${phase}-dns`,
        `wss://${origin.address}:${origin.securePort ?? origin.port}/${phase}`,
      ],
    },
    30000,
  );
  return response?.value ?? response;
}

async function checkOutageTraffic(browser, origin, phase, directHits) {
  const before = directHits.length;
  let result;
  // Corroborate failures across time and hosts. One refused origin is not proof
  // that the selected proxy is unavailable.
  for (let wave = 0; wave < 3; wave++) {
    result = await checkTraffic(browser, origin, `${phase}-${wave}`);
    if (
      ["http", "https", "ws", "wss", "dns"].some((scheme) => result[scheme]?.ok) ||
      directHits.length !== before
    )
      throw new Error(`${phase} leaked during outage: ${JSON.stringify({ result, directHits })}`);
    await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return result;
}

async function checkHttp(browser, origin, phase) {
  await browser.client.send("WebDriver:Navigate", { url: `http://127.0.0.1:${origin.pagePort}/` });
  const result = await browser.client.send("WebDriver:ExecuteAsyncScript", {
    script: httpOnlyProbe,
    args: [`http://${origin.address}:${origin.port}/${phase}`],
  });
  return result?.value ?? result;
}

function assertSameRoute(state, initial, phase) {
  if (
    state?.activeProfileId !== initial.activeProfileId ||
    state.generation !== initial.generation ||
    state.appliedRevision !== initial.appliedRevision ||
    state.desiredRoute !== "proxy" ||
    state.appliedRoute !== "proxy" ||
    JSON.stringify(state.identity) !== JSON.stringify(initial.identity) ||
    JSON.stringify(state.proxy) !== JSON.stringify(initial.proxy) ||
    JSON.stringify(state.webrtc) !== JSON.stringify(initial.webrtc)
  ) {
    throw new Error(
      `${phase} changed selected route/generation/identity: ${JSON.stringify(state)}`,
    );
  }
}

async function exerciseFlaps(browser, origin, initial, directHits, proxiedHits, seen, stop, start) {
  initial ??= (await message(browser, { type: "state:get" })).state;
  const assertNoDirect = () => {
    if (directHits.length !== 0)
      throw new Error(`direct sentinel received traffic: ${JSON.stringify(directHits)}`);
  };
  const assertHealthyTraffic = async (phase) => {
    const before = seen.length;
    const result = await checkTraffic(browser, origin, phase);
    if (!["http", "https", "ws", "wss", "dns"].every((scheme) => result[scheme]?.ok)) {
      throw new Error(
        `${phase} did not recover every protocol: ${JSON.stringify({ result, seen: seen.slice(before), proxiedHits })}`,
      );
    }
    if (!seen.slice(before).some((entry) => entry.host === "ni-fail-closed.invalid")) {
      throw new Error(`${phase} did not resolve DNS through SOCKS`);
    }
    const state = (await message(browser, { type: "state:get" })).state;
    assertSameRoute(state, initial, phase);
    if (state.runtimeHealth !== "healthy")
      throw new Error(
        `${phase} did not restore healthy status: ${JSON.stringify(state.lastError)}`,
      );
    assertNoDirect();
  };
  await assertHealthyTraffic("flap-baseline");
  for (let cycle = 0; cycle < 3; cycle++) {
    const downAt = Date.now();
    await stop();
    // A page burst contains non-idempotent requests too. They must terminate,
    // not be queued/replayed when the same proxy returns.
    await browser.client.send("WebDriver:Navigate", {
      url: `http://127.0.0.1:${origin.pagePort}/`,
    });
    const result = await browser.client.send("WebDriver:ExecuteAsyncScript", {
      script: `const done = arguments[arguments.length - 1];
        const bases = arguments[0];
        (async () => {
          const results = [];
          for (let wave = 0; wave < 3; wave++) {
            results.push(...await Promise.all(Array.from({length: 12}, (_, i) => fetch(bases[i % 2] + wave + "-" + i, {
              method: i % 2 ? "POST" : "GET", body: i % 2 ? "must-not-replay" : undefined,
              cache: "no-store", signal: AbortSignal.timeout(2000)
            }).then(r => ({ok: true, status: r.status}), e => ({ok: false, error: String(e)})))));
            await new Promise(resolve => setTimeout(resolve, 350));
          }
          done(results);
        })();`,
      args: [
        [
          `http://${origin.address}:${origin.port}/failed-${cycle}-`,
          `http://ni-fail-closed.invalid:${origin.port}/failed-${cycle}-`,
        ],
      ],
    });
    const burst = result?.value ?? result;
    if (!Array.isArray(burst) || burst.length !== 36 || burst.some((item) => item.ok))
      throw new Error(`flap burst escaped outage: ${JSON.stringify(burst)}`);
    const down = await checkTraffic(browser, origin, `flap-down-${cycle}`);
    if (["http", "https", "ws", "wss", "dns"].some((scheme) => down[scheme]?.ok))
      throw new Error(`flap outage leaked: ${JSON.stringify(down)}`);
    const state = (await message(browser, { type: "state:get" })).state;
    assertSameRoute(state, initial, `flap-down-${cycle}`);
    if (state.runtimeHealth === "healthy")
      throw new Error("SOCKS outage never affected runtime health");
    assertNoDirect();
    await start();
    log(
      `flap ${cycle + 1}: outage ${Date.now() - downAt}ms, 36-request burst blocked, direct sentinel 0`,
    );
    // Only new application requests trigger recovery. No Apply/Refresh, background
    // fetch, or replay is used. The deadline accommodates the bounded cooldown.
    const recoveryDeadline = Math.min(deadline, Date.now() + 12000);
    let recovered;
    do {
      recovered = await checkHttp(browser, origin, `flap-recovery-${cycle}`);
      if (recovered.ok) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < recoveryDeadline);
    if (!recovered?.ok) throw new Error(`flap ${cycle + 1} did not recover automatically`);
    // Health deliberately needs corroborated sustained success, rather than
    // oscillating on a single completion from a busy tab.
    for (let confirmation = 0; confirmation < 3; confirmation++) {
      await new Promise((resolve) => setTimeout(resolve, 550));
      const success = await checkHttp(browser, origin, `flap-confirm-${cycle}-${confirmation}`);
      if (!success.ok) throw new Error("recovery did not remain stable");
    }
    await assertHealthyTraffic(`flap-up-${cycle}`);
    if (proxiedHits.some((url) => url.startsWith("/failed-") || url.startsWith("/flap-down-")))
      throw new Error(`failed application request was replayed: ${JSON.stringify(proxiedHits)}`);
  }
  const error = await checkHttp(browser, origin, "origin-error");
  if (!error.ok || error.status !== 503)
    throw new Error("origin-error control did not reach origin");
  await browser.client.send("WebDriver:ExecuteAsyncScript", {
    script: `const done = arguments[arguments.length - 1];
      fetch(arguments[0], {signal: AbortSignal.timeout(100)}).then(() => done(false), () => done(true));`,
    args: [`http://${origin.address}:${origin.port}/cancel`],
  });
  const afterControls = (await message(browser, { type: "state:get" })).state;
  assertSameRoute(afterControls, initial, "origin error/cancellation");
  if (afterControls.runtimeHealth !== "healthy")
    throw new Error(
      `unrelated origin error/cancellation poisoned proxy health: ${JSON.stringify(afterControls.lastError)}`,
    );
  if (!proxiedHits.includes("/cancel"))
    throw new Error("cancellation control never reached proxy origin");
  assertNoDirect();
  log(
    "PASS: three SOCKS flaps, HTTP/HTTPS/WS/WSS/DNS recovery, stable identity/generation, no replay, zero direct sentinel hits",
  );
}

function acceptWebSocket(hits, request, socket) {
  hits.push(request.url);
  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.destroy();
    return;
  }
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.once("data", () => socket.end(Buffer.from([0x88, 0])));
}

async function main() {
  if (!existsSync(firefoxPath) || !existsSync(path.join(root, "dist", "manifest.json"))) {
    log("Firefox or dist/ is missing. Build first and pass --firefox if needed.");
    process.exitCode = 2;
    return;
  }
  const profileDir = await mkdtemp(path.join(tmpdir(), "ni-fail-closed-"));
  const address = "ni-fail-closed-origin.test";
  const directHits = [];
  const direct = createHttpServer((request, response) => {
    if (request.url !== "/page") directHits.push(request.url);
    response.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
    response.end("origin");
  });
  direct.on("upgrade", (request, socket) => acceptWebSocket(directHits, request, socket));
  direct.on("clientError", (_error, socket) => {
    directHits.push("tls-attempt");
    socket.destroy();
  });
  const page = createHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>fail-closed probe</title>");
  });
  const port = await listen(direct);
  const pagePort = await listen(page);
  const origin = { address, port, pagePort };
  const proxiedHits = [];
  const extraServers = [];
  if (values.flap) {
    // TLS is entirely local. Generate a short-lived test certificate, never a
    // production credential; Marionette accepts it only in this test profile.
    const keyFile = path.join(profileDir, "fixture-key.pem");
    const certFile = path.join(profileDir, "fixture-cert.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyFile,
        "-out",
        certFile,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
      ],
      { stdio: "ignore" },
    );
    const handler = (request, response) => {
      proxiedHits.push(request.url);
      if (request.url === "/cancel") return;
      response.writeHead(request.url === "/origin-error" ? 503 : 200, {
        "content-type": "text/plain",
        "access-control-allow-origin": "*",
        connection: "close",
      });
      response.end("proxied origin");
    };
    const plain = createHttpServer(handler);
    const secure = createHttpsServer(
      { key: readFileSync(keyFile), cert: readFileSync(certFile) },
      handler,
    );
    for (const server of [plain, secure]) {
      server.on("upgrade", (request, socket) => acceptWebSocket(proxiedHits, request, socket));
      extraServers.push(server);
    }
    const secureSentinel = net.createServer((socket) => {
      directHits.push("direct-secure-connection");
      socket.destroy();
    });
    extraServers.push(secureSentinel);
    origin.proxyPort = await listen(plain);
    origin.proxySecurePort = await listen(secure);
    origin.securePort = await listen(secureSentinel);
  }
  const seen = [];
  let socks = socksServer(seen, origin, values.auth);
  const socksPort = await listen(socks.server);
  let browser = null;
  let credentialLossSeen = null;
  const isFixtureConnection = (entry) =>
    entry.host === origin.address || entry.host === "ni-fail-closed.invalid";
  const credentiallessFixtureConnections = () =>
    seen.slice(credentialLossSeen ?? seen.length).filter(isFixtureConnection);
  try {
    if (values.auth) {
      await anonymousSocksControl(socksPort, origin);
      if (
        !seen.some((entry) => entry.selectedMethod === 0 && entry.host === origin.address) ||
        directHits.at(-1) !== "/anonymous-positive-control"
      )
        throw new Error("anonymous upstream positive control did not reach origin");
      log("Positive control: dual-mode upstream accepts anonymous SOCKS and reaches origin");
    }
    browser = await startFirefox(profileDir, await freePort(), `http://127.0.0.1:${pagePort}/`);
    // Ignore host-machine proxy environment during the positive control. The
    // recording Firefox fallback is configured explicitly below and retained
    // across the subsequent browser restarts.
    await browser.client.send("Marionette:SetContext", { value: "chrome" });
    await browser.client.send("WebDriver:ExecuteScript", {
      script: 'Services.prefs.setIntPref("network.proxy.type", 0);',
      args: [],
    });
    await browser.client.send("Marionette:SetContext", { value: "content" });
    if (values.flap) {
      // Positive controls prove the sentinels are reachable directly in Firefox,
      // before applying the route whose zero-leak interval we measure.
      const control = await checkHttp(browser, origin, "sentinel-control");
      if (!control.ok || directHits.at(-1) !== "/sentinel-control")
        throw new Error(
          `HTTP direct sentinel positive control failed: ${JSON.stringify({ control, directHits, state: await message(browser, { type: "state:get" }) })}`,
        );
      await browser.client.send("WebDriver:ExecuteAsyncScript", {
        script: httpOnlyProbe,
        args: [`https://${origin.address}:${origin.securePort}/sentinel-control`],
      });
      if (!directHits.includes("direct-secure-connection"))
        throw new Error("TLS direct sentinel positive control failed");
      directHits.length = 0;
    }
    const profile = {
      id: "failclosed01",
      name: "Proxy A",
      revision: 1,
      proxy: {
        type: "socks5",
        host: "127.0.0.1",
        port: socksPort,
        ...(values.auth ? { username: "test-user" } : {}),
        proxyDNS: true,
        bypassHosts: ["localhost", "127.0.0.1", "::1"],
      },
      identity: {
        mode: "manual",
        geoIpPolicy: "disabled",
        latitude: 0,
        longitude: 0,
        accuracy: 20000,
        timezone: "UTC",
      },
      webrtcPolicy: "default",
    };
    const saved = await message(browser, {
      type: "profiles:save",
      profile,
      ...(values.auth ? { credentials: { username: "test-user", password: "test-password" } } : {}),
    });
    if (!saved?.ok) throw new Error(`save failed: ${JSON.stringify(saved)}`);
    const activated = await message(browser, { type: "profiles:activate", profileId: profile.id });
    if (!activated?.ok) throw new Error(`activate failed: ${JSON.stringify(activated)}`);
    if (values.auth) {
      const credentialCheck = await browser.client.send("WebDriver:ExecuteAsyncScript", {
        script: `const done = arguments[arguments.length - 1];
          (window.wrappedJSObject || window).browser.storage.session.get("ni.active-target.v1").then(
            data => { const c = data["ni.active-target.v1"]?.credentials;
              done({usernameLength: c?.username?.length ?? 0, passwordLength: c?.password?.length ?? 0}); });`,
        args: [],
      });
      const lengths = credentialCheck?.value ?? credentialCheck;
      if (lengths?.usernameLength !== 9 || lengths?.passwordLength !== 13)
        throw new Error(
          `session snapshot did not retain test credentials: ${JSON.stringify(lengths)}`,
        );
    }
    if (values.vault) {
      if (!values.restart || !values.auth) throw new Error("Vault checks require restart and auth");
      const setup = await message(browser, {
        type: "vault:setup",
        password: "fixture vault master passphrase",
      });
      if (!setup?.ok || setup.status !== "unlocked") throw new Error("Vault setup failed");
      const stored = await browser.client.send("WebDriver:ExecuteAsyncScript", {
        script: `const done = arguments[arguments.length - 1];
          (window.wrappedJSObject || window).browser.storage.local.get(null).then(data => {
            const text = JSON.stringify(data);
            done({encrypted: !!data["ni.vault.v1"], exposed: ["test-user", "test-password", "Proxy A", "fixture vault master passphrase"].some(value => text.includes(value))});
          });`,
        args: [],
      });
      const result = stored?.value ?? stored;
      if (!result.encrypted || result.exposed)
        throw new Error("Vault leaked plaintext into durable storage");
      log("Encrypted vault migrated profiles, active target and proxy credentials");
    }
    if (values.flap) {
      // Establish the local TLS exception through a real document navigation;
      // Firefox does not apply Marionette's cert override to first-use subresources.
      await browser.client.send("WebDriver:Navigate", {
        url: `https://${origin.address}:${origin.securePort}/tls-bootstrap`,
      });
    }
    log("Proxy A active; probing live traffic");
    const live = await checkTraffic(browser, origin, "live");
    if (
      !live.http?.ok ||
      !live.dns?.ok ||
      seen.length < 4 ||
      !seen.some((entry) => entry.host === "ni-fail-closed.invalid")
    )
      throw new Error(
        `live traffic did not use SOCKS: ${JSON.stringify({ live, seen, directHits, origin, activated })}`,
      );
    await browser.client.send("Marionette:SetContext", { value: "chrome" });
    await browser.client.send("WebDriver:ExecuteScript", {
      script: `Services.prefs.setCharPref("network.proxy.http", arguments[0]);
        Services.prefs.setIntPref("network.proxy.http_port", arguments[1]);
        Services.prefs.setCharPref("network.proxy.ssl", arguments[0]);
        Services.prefs.setIntPref("network.proxy.ssl_port", arguments[1]);
        Services.prefs.setCharPref("network.proxy.socks", arguments[0]);
        Services.prefs.setIntPref("network.proxy.socks_port", arguments[1]);
        Services.prefs.setIntPref("network.proxy.socks_version", 5);
        Services.prefs.setIntPref("network.proxy.type", 1);`,
      args: [origin.address, origin.port],
    });
    await browser.client.send("Marionette:SetContext", { value: "content" });
    log("Firefox system fallback points at the recording origin");
    if (values.flap) {
      await exerciseFlaps(
        browser,
        origin,
        activated.state,
        directHits,
        proxiedHits,
        seen,
        async () => socks.close(),
        async () => {
          socks = socksServer(seen, origin, values.auth);
          await listen(socks.server, socksPort);
        },
      );
      return;
    }
    const baseline = directHits.length;
    await socks.close();
    log("SOCKS server stopped; probing outage");
    const httpFailure = await checkHttp(browser, origin, "http-diagnostic");
    const httpFailureState = await message(browser, { type: "state:get" });
    log(
      `early outage diagnostic: ${JSON.stringify({ http: httpFailure, error: httpFailureState?.state?.lastError })}`,
    );
    const down = await checkOutageTraffic(browser, origin, "down", directHits);
    if (
      down.http?.ok ||
      down.https?.ok ||
      down.ws?.ok ||
      down.wss?.ok ||
      down.dns?.ok ||
      directHits.length !== baseline
    )
      throw new Error(
        `outage leaked direct traffic: ${JSON.stringify({ down, baseline, directHits })}`,
      );
    const state = await message(browser, { type: "state:get" });
    if (state?.state?.activeProfileId !== profile.id) throw new Error("outage deselected Proxy A");
    log(`outage diagnostic: ${JSON.stringify(state.state.lastError)}`);
    await popupStatus(browser, profile.id, "Proxy connection uncertain");
    log(
      `outage: HTTP/HTTPS/WS/WSS/DNS failed; direct-origin leak count ${directHits.length - baseline}`,
    );
    log("Closing the extension event page while SOCKS remains unavailable");
    const closedResult = await browser.client.send("WebDriver:ExecuteAsyncScript", {
      script: `const done = arguments[arguments.length - 1];
        (window.wrappedJSObject || window).browser.runtime.getBackgroundPage().then(
          bg => { bg.close(); done({ok: true}); },
          error => done({error: String(error)}));`,
      args: [],
    });
    const closed = closedResult?.value ?? closedResult;
    if (!closed?.ok) throw new Error(`could not close event page: ${JSON.stringify(closed)}`);
    const beforeEventRestart = directHits.length;
    const afterEventRestart = await checkTraffic(browser, origin, "event-restart");
    if (
      afterEventRestart.http?.ok ||
      afterEventRestart.ws?.ok ||
      afterEventRestart.https?.ok ||
      afterEventRestart.wss?.ok ||
      afterEventRestart.dns?.ok ||
      directHits.length !== beforeEventRestart
    )
      throw new Error(
        `event-page restart leaked direct traffic: ${JSON.stringify({ afterEventRestart, directHits })}`,
      );
    const eventState = await message(browser, { type: "state:get" });
    if (eventState?.state?.activeProfileId !== profile.id)
      throw new Error("event-page restart deselected Proxy A");
    log(`event-page restart: direct-origin leak count ${directHits.length - beforeEventRestart}`);
    if (values.restart) {
      if (!values.auth) {
        // Save is a configuration edit, not an Apply. A full browser exit loses
        // storage.session, so the durable applied route must still be Proxy A.
        const savedDirect = await message(browser, {
          type: "profiles:save",
          profile: {
            ...profile,
            revision: 2,
            proxy: { type: "direct", proxyDNS: false, bypassHosts: [] },
          },
        });
        if (!savedDirect?.ok)
          throw new Error(`unapplied Save failed: ${JSON.stringify(savedDirect)}`);
        const stillApplied = await message(browser, { type: "state:get" });
        if (
          stillApplied?.state?.activeProfileId !== profile.id ||
          stillApplied.state.appliedRoute !== "proxy"
        )
          throw new Error("Save changed the active proxy before Apply");
        log("Saved Direct configuration without applying it; Proxy A remains active");
      }
      log(
        values.auth
          ? "Restarting Firefox with dual-mode SOCKS available and session credentials lost"
          : "Restarting Firefox with SOCKS unavailable",
      );
      await stopFirefox(browser);
      browser = null;
      const startupOriginHits = directHits.length;
      if (values.auth) {
        socks = socksServer(seen, origin, true);
        await listen(socks.server, socksPort);
        credentialLossSeen = seen.length;
      }
      browser = await startFirefox(
        profileDir,
        await freePort(),
        `http://${origin.address}:${origin.port}/startup`,
      );
      if (directHits.length !== startupOriginHits)
        throw new Error(
          `startup navigation reached origin despite required route: ${JSON.stringify({ hits: directHits.slice(startupOriginHits), socks: credentialLossSeen === null ? [] : seen.slice(credentialLossSeen) })}`,
        );
      log("Firefox restarted; probing cold traffic");
      const before = directHits.length;
      const cold = await checkOutageTraffic(browser, origin, "cold", directHits);
      if (
        cold.http?.ok ||
        cold.https?.ok ||
        cold.ws?.ok ||
        cold.wss?.ok ||
        cold.dns?.ok ||
        directHits.length !== before
      )
        throw new Error(
          `cold startup leaked direct traffic: ${JSON.stringify({ cold, directHits })}`,
        );
      if (values.vault) {
        const locked = await message(browser, { type: "vault:get" });
        if (locked?.status !== "locked")
          throw new Error("Full Firefox exit did not lock the vault");
        const wrong = await message(browser, {
          type: "vault:unlock",
          password: "wrong fixture master passphrase",
        });
        if (wrong?.ok || wrong?.status !== "locked")
          throw new Error("Wrong master password unlocked the vault");
        if (credentiallessFixtureConnections().length !== 0)
          throw new Error("Locked vault allowed anonymous upstream traffic");
        const unlocked = await message(browser, {
          type: "vault:unlock",
          password: "fixture vault master passphrase",
        });
        if (!unlocked?.ok || unlocked.status !== "unlocked")
          throw new Error("Could not unlock preserved vault after full restart");
        log(
          "Full Firefox restart: locked traffic blocked; wrong password rejected; explicit unlock restored encrypted credentials",
        );
      }
      const restored = await message(browser, { type: "state:get" });
      if (restored?.state?.activeProfileId !== profile.id)
        throw new Error("restart deselected Proxy A");
      if (
        values.auth &&
        !values.vault &&
        (restored.state.runtimeHealth !== "credentials_required" ||
          restored.state.proxy.hasCredentials !== false)
      )
        throw new Error(
          `missing SOCKS credentials were not reported: ${JSON.stringify(restored.state.runtimeHealth)}`,
        );
      if (!values.vault)
        await popupStatus(
          browser,
          profile.id,
          values.auth ? "Credentials required" : "Proxy connection uncertain",
        );
      if (values.auth && credentiallessFixtureConnections().length !== 0)
        throw new Error(
          `credentialless cold startup reached fixture via dual-mode SOCKS: ${JSON.stringify(credentiallessFixtureConnections())}`,
        );
      if (values.auth) {
        // Firefox excludes protected/system traffic from webRequest blocking even
        // when proxy.onRequest routes it. Every non-fixture CONNECT is rejected
        // locally above; do not mistake unrelated handshakes for page traffic or
        // claim the extension can cancel privileged Firefox service requests.
        const excluded = seen
          .slice(credentialLossSeen)
          .filter((entry) => entry.host && !isFixtureConnection(entry)).length;
        log(
          `Protected/background boundary: ${excluded} out-of-fixture SOCKS CONNECT attempts rejected locally`,
        );
      }
      log(
        `restart: direct-origin leak count ${directHits.length - before}; ${values.auth ? "credentialless fixture SOCKS CONNECT count 0" : "SOCKS unavailable"}`,
      );
    }
    if (!socks.server.listening) {
      socks = socksServer(seen, origin, values.auth);
      await listen(socks.server, socksPort);
    }
    if (values.auth && values.restart && !values.vault) {
      const beforeAuthFailure = directHits.length;
      const denied = await checkTraffic(browser, origin, "missing-auth");
      if (
        ["http", "https", "ws", "wss", "dns"].some((scheme) => denied[scheme]?.ok) ||
        directHits.length !== beforeAuthFailure ||
        credentiallessFixtureConnections().length !== 0
      )
        throw new Error(
          `missing SOCKS credentials leaked traffic: ${JSON.stringify({ denied, directHits, fixtureConnections: credentiallessFixtureConnections() })}`,
        );
      const resaved = await message(browser, {
        type: "profiles:save",
        profile,
        credentials: { username: "test-user", password: "test-password" },
      });
      if (!resaved?.ok) throw new Error("could not re-enter SOCKS credentials");
      const reapplied = await message(browser, {
        type: "profiles:activate",
        profileId: profile.id,
      });
      if (!reapplied?.ok) throw new Error("could not reapply Proxy A with credentials");
      log(
        `session credential loss: direct-origin leak count ${directHits.length - beforeAuthFailure}`,
      );
    }
    const beforeRecoveredHits = directHits.length;
    const beforeRecoveredSocks = seen.length;
    const recovered = await checkHttp(browser, origin, "recovered");
    if (!recovered.ok || recovered.status !== 200)
      throw new Error(`same proxy did not recover: ${JSON.stringify(recovered)}`);
    if (
      !seen
        .slice(beforeRecoveredSocks)
        .some((entry) => entry.host === origin.address && entry.port === origin.port) ||
      directHits.length !== beforeRecoveredHits + 1 ||
      directHits.at(-1) !== "/recovered"
    )
      throw new Error(
        `recovered request did not traverse only Proxy A: ${JSON.stringify({ seen: seen.slice(beforeRecoveredSocks), hits: directHits.slice(beforeRecoveredHits) })}`,
      );
    if (
      values.auth &&
      (!seen
        .slice(beforeRecoveredSocks)
        .some((entry) => isFixtureConnection(entry) && entry.selectedMethod === 2) ||
        seen
          .slice(beforeRecoveredSocks)
          .some((entry) => isFixtureConnection(entry) && entry.selectedMethod === 0))
    )
      throw new Error(
        "credential re-entry did not restore exclusively authenticated SOCKS traffic",
      );
    for (let confirmation = 0; confirmation < 3; confirmation++) {
      await new Promise((resolve) => setTimeout(resolve, 550));
      const success = await checkHttp(browser, origin, `recovery-confirm-${confirmation}`);
      if (!success.ok) throw new Error("same proxy recovery was not sustained");
    }
    const recoveredState = (await message(browser, { type: "state:get" })).state;
    if (recoveredState.runtimeHealth !== "healthy")
      throw new Error("sustained proxy success did not restore health");
    await popupStatus(browser, profile.id, "Active");
    log("PASS: Proxy A survived outage and recovered without a route switch");
    if (values.restart && !values.auth) {
      // Direct and Off are the two *explicit* operations permitted to release
      // the proxy restriction. Check their durable state across full exits too.
      await browser.client.send("Marionette:SetContext", { value: "chrome" });
      await browser.client.send("WebDriver:ExecuteScript", {
        script: 'Services.prefs.setIntPref("network.proxy.type", 0);',
        args: [],
      });
      await browser.client.send("Marionette:SetContext", { value: "content" });
      const directSelection = await message(browser, {
        type: "profiles:activate",
        profileId: "builtin-direct",
      });
      if (!directSelection?.ok || directSelection.state?.activeProfileId !== "builtin-direct")
        throw new Error(`explicit Direct failed: ${JSON.stringify(directSelection)}`);
      await stopFirefox(browser);
      browser = await startFirefox(profileDir, await freePort(), `http://127.0.0.1:${pagePort}/`);
      const directState = await message(browser, { type: "state:get" });
      const directResponse = await checkHttp(browser, origin, "explicit-direct");
      if (
        directState?.state?.activeProfileId !== "builtin-direct" ||
        directState.state.appliedRoute !== "direct" ||
        !directResponse.ok
      )
        throw new Error(
          `Direct did not survive full restart: ${JSON.stringify({ directState, directResponse })}`,
        );
      log("explicit Direct survived full Firefox restart");

      const offSelection = await message(browser, { type: "profiles:deactivate" });
      if (!offSelection?.ok || offSelection.state?.activeProfileId !== null)
        throw new Error(`explicit Off failed: ${JSON.stringify(offSelection)}`);
      await stopFirefox(browser);
      browser = await startFirefox(profileDir, await freePort(), `http://127.0.0.1:${pagePort}/`);
      const offState = await message(browser, { type: "state:get" });
      const offResponse = await checkHttp(browser, origin, "explicit-off");
      if (
        offState?.state?.activeProfileId !== null ||
        offState.state.appliedRoute !== "off" ||
        !offResponse.ok
      )
        throw new Error(
          `Off did not survive full restart: ${JSON.stringify({ offState, offResponse })}`,
        );
      log("explicit Off survived full Firefox restart");
    }
  } finally {
    if (browser) await stopFirefox(browser);
    if (socks.server.listening) await socks.close();
    for (const server of extraServers) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
    await new Promise((resolve) => direct.close(resolve));
    await new Promise((resolve) => page.close(resolve));
    await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

main().catch((error) => {
  log(`FAIL: ${String(error)}`);
  process.exitCode = 1;
});
