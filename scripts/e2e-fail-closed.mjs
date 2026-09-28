/** Deterministic Firefox SOCKS5 outage and full-restart leak test. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { networkInterfaces } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
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
    restart: { type: "boolean", default: false },
    auth: { type: "boolean", default: false },
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

function privateAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal && !address.address.startsWith("169.254."))
        return address.address;
    }
  }
  throw new Error("No private IPv4 interface for the direct-origin leak fixture");
}

function socksServer(seen, origin, requireAuth) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    let phase = 0;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (phase === 0 && buffer.length >= 2 + buffer[1]) {
        const methods = buffer.subarray(2, 2 + buffer[1]);
        if (requireAuth) seen.push({ handshakeMethods: [...methods] });
        buffer = buffer.subarray(2 + buffer[1]);
        const method = requireAuth ? 2 : 0;
        socket.write(Buffer.from([5, methods.includes(method) ? method : 0xff]));
        if (!methods.includes(method)) {
          socket.end();
          return;
        }
        phase = requireAuth ? 1 : 2;
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
      seen.push({ host, port });
      phase = 3;
      const destination = net.connect({
        host: host === "ni-fail-closed.invalid" ? origin.address : host,
        port,
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
      capabilities: { alwaysMatch: { browserName: "firefox" } },
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
  await browser.client.send("WebDriver:Navigate", { url: `http://127.0.0.1:${origin.pagePort}/` });
  const response = await browser.client.send(
    "WebDriver:ExecuteAsyncScript",
    {
      script: probe,
      args: [
        `http://${origin.address}:${origin.port}/${phase}?r=${Date.now()}`,
        `ws://${origin.address}:${origin.port}/${phase}`,
        `https://${origin.address}:${origin.port}/${phase}`,
        `http://ni-fail-closed.invalid:${origin.port}/${phase}-dns`,
        `wss://${origin.address}:${origin.port}/${phase}`,
      ],
    },
    30000,
  );
  return response?.value ?? response;
}

async function checkHttp(browser, origin, phase) {
  await browser.client.send("WebDriver:Navigate", { url: `http://127.0.0.1:${origin.pagePort}/` });
  const result = await browser.client.send("WebDriver:ExecuteAsyncScript", {
    script: httpOnlyProbe,
    args: [`http://${origin.address}:${origin.port}/${phase}`],
  });
  return result?.value ?? result;
}

async function main() {
  if (!existsSync(firefoxPath) || !existsSync(path.join(root, "dist", "manifest.json"))) {
    log("Firefox or dist/ is missing. Build first and pass --firefox if needed.");
    process.exitCode = 2;
    return;
  }
  const profileDir = await mkdtemp(path.join(tmpdir(), "ni-fail-closed-"));
  const address = privateAddress();
  const directHits = [];
  const direct = createHttpServer((request, response) => {
    if (request.url !== "/page") directHits.push(request.url);
    response.writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" });
    response.end("origin");
  });
  direct.on("upgrade", (request, socket) => {
    directHits.push(request.url);
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.end(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
  });
  direct.on("clientError", (_error, socket) => {
    directHits.push("tls-attempt");
    socket.destroy();
  });
  const page = createHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>fail-closed probe</title>");
  });
  const port = await listen(direct, 0, "0.0.0.0");
  const pagePort = await listen(page);
  const origin = { address, port, pagePort };
  const seen = [];
  let socks = socksServer(seen, origin, values.auth);
  const socksPort = await listen(socks.server);
  let browser = null;
  try {
    browser = await startFirefox(profileDir, await freePort(), `http://127.0.0.1:${pagePort}/`);
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
    const baseline = directHits.length;
    await socks.close();
    log("SOCKS server stopped; probing outage");
    const httpFailure = await checkHttp(browser, origin, "http-diagnostic");
    const httpFailureState = await message(browser, { type: "state:get" });
    log(
      `early outage diagnostic: ${JSON.stringify({ http: httpFailure.http, error: httpFailureState?.state?.lastError })}`,
    );
    const down = await checkTraffic(browser, origin, "down");
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
    await popupStatus(browser, profile.id, "Proxy unavailable");
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
      log("Restarting Firefox with SOCKS unavailable");
      await stopFirefox(browser);
      browser = null;
      const startupOriginHits = directHits.length;
      browser = await startFirefox(
        profileDir,
        await freePort(),
        `http://${origin.address}:${origin.port}/startup`,
      );
      if (directHits.length !== startupOriginHits)
        throw new Error("startup navigation reached the origin directly");
      log("Firefox restarted; probing cold traffic");
      const before = directHits.length;
      const cold = await checkTraffic(browser, origin, "cold");
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
      const restored = await message(browser, { type: "state:get" });
      if (restored?.state?.activeProfileId !== profile.id)
        throw new Error("restart deselected Proxy A");
      if (values.auth && restored.state.runtimeHealth !== "credentials_required")
        throw new Error(
          `missing SOCKS credentials were not reported: ${JSON.stringify(restored.state.runtimeHealth)}`,
        );
      await popupStatus(
        browser,
        profile.id,
        values.auth ? "Credentials required" : "Proxy unavailable",
      );
      log(`restart with SOCKS down: direct-origin leak count ${directHits.length - before}`);
    }
    socks = socksServer(seen, origin, values.auth);
    await listen(socks.server, socksPort);
    if (values.auth && values.restart) {
      const beforeAuthFailure = directHits.length;
      const denied = await checkTraffic(browser, origin, "missing-auth");
      if (denied.http?.ok || directHits.length !== beforeAuthFailure)
        throw new Error(
          `missing SOCKS credentials leaked traffic: ${JSON.stringify({ denied, directHits })}`,
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
    await new Promise((resolve) => direct.close(resolve));
    await new Promise((resolve) => page.close(resolve));
    await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

main().catch((error) => {
  log(`FAIL: ${String(error)}`);
  process.exitCode = 1;
});
