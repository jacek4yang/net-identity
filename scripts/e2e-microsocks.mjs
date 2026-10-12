import { checkNativePopup } from "./check-native-popup.mjs";
/** Independent microsocks interoperability through the actual Firefox options editor.
 * Requires microsocks from its official upstream or the operating system package.
 * Synthetic credentials, loopback listener/origin, no auth-once/anonymous whitelist.
 */
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
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
    microsocks: { type: "string", default: "microsocks" },
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
const log = (text) => console.error(`[e2e:microsocks] ${text}`);

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
    "--url",
    pageUrl,
    `--pref=marionette.port=${marionettePort}`,
    "--pref=xpinstall.signatures.required=false",
    // A non-bypassed local name makes the sentinel reachable even in loopback-only
    // sandboxes. The separate .invalid name below is resolved exclusively by SOCKS.
    "--pref=network.dns.localDomains=ni-fail-closed-origin.test",
    "--pref=network.proxy.allow_hijacking_localhost=true",
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
    process.stderr.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
    process.stderr.write(chunk);
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

let expected = { username: "test-user", password: "test-password" };
async function main() {
  const profileDir = await mkdtemp(path.join(tmpdir(), "ni-micro-profile-"));
  const originServer = createHttpServer((req, res) => {
    res.writeHead(200, { "access-control-allow-origin": "*", connection: "close" });
    res.end("authenticated origin");
  });
  const origin = { address: "127.0.0.1", port: await listen(originServer) };
  const proxyPort = await freePort();
  let server, browser;
  let startupError;
  async function stop() {
    if (server) {
      const child = server;
      server = null;
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
      const closed = new Promise((resolve) => child.once("close", resolve));
      child.kill("SIGTERM");
      await closed;
    }
  }
  async function start() {
    await stop();
    startupError = undefined;
    server = spawn(
      values.microsocks,
      [
        "-i",
        "127.0.0.1",
        "-p",
        String(proxyPort),
        "-u",
        expected.username,
        "-P",
        expected.password,
      ],
      { stdio: "ignore" },
    );
    server.once("error", (error) => {
      startupError = error;
    });
    for (let i = 0; i < 100; i++) {
      if (startupError) throw startupError;
      if (server.exitCode !== null) throw Error("microsocks exited");
      const ready = await new Promise((r) => {
        const s = net.connect(proxyPort, "127.0.0.1");
        s.once("connect", () => {
          s.destroy();
          r(true);
        });
        s.once("error", () => r(false));
      });
      if (ready) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw Error("microsocks startup failed");
  }
  try {
    await start();
    browser = await startFirefox(profileDir, await freePort(), "about:blank");
    const profile = {
      id: "authmatrix01",
      name: "Microsocks real server",
      revision: 1,
      proxy: {
        type: "socks5",
        host: "127.0.0.1",
        port: proxyPort,
        authenticationRequired: true,
        proxyDNS: true,
        bypassHosts: [],
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
    async function probe(name, want = true, count = 1) {
      await browser.client.send("WebDriver:Navigate", {
        url: "data:text/html,<title>auth probe</title>",
      });
      const result = await browser.client.send("WebDriver:ExecuteAsyncScript", {
        script: `const done=arguments[arguments.length-1];Promise.all(Array.from({length:arguments[1]},(_,i)=>fetch(arguments[0]+i,{cache:"no-store",signal:AbortSignal.timeout(3500)}).then(r=>r.status===200,()=>false))).then(done);`,
        args: [`http://${origin.address}:${origin.port}/${name}-`, count],
      });
      const actual = result.value ?? result;
      if (!Array.isArray(actual) || actual.length !== count || actual.some((x) => x !== want))
        throw Error(name + " unexpected result " + JSON.stringify(actual));
      console.log(JSON.stringify({ name, passed: true, requests: count }));
    }
    async function execute(script, args = []) {
      const r = await browser.client.send("WebDriver:ExecuteScript", { script, args });
      return r?.value ?? r;
    }
    async function waitFor(script) {
      for (let i = 0; i < 200; i++) {
        if (await execute(script)) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw Error("UI condition failed: " + script);
    }
    async function click(selector) {
      const r = await browser.client.send("WebDriver:FindElement", {
        using: "css selector",
        value: selector,
      });
      await browser.client.send("WebDriver:ElementClick", {
        id: r.value["element-6066-11e4-a52e-4f735466cecf"],
      });
    }
    const seed = await message(browser, {
      type: "profiles:save",
      profile,
      credentials: { ...expected },
    });
    if (!seed.ok) throw Error("seed failed");
    async function test(name, credentials, want = true, count = 1) {
      await browser.client.send("WebDriver:Navigate", {
        url: new URL("options/options.html", browser.baseURL).href,
      });
      await waitFor(`return !!document.querySelector('[data-profile-id="authmatrix01"]');`);
      await click('[data-profile-id="authmatrix01"]');
      await waitFor('return !document.getElementById("profile-form").hidden;');
      await execute('document.getElementById("section-auth").open=true;');
      for (const [id, value] of Object.entries({
        "field-proxy-username": credentials.username,
        "field-password": credentials.password,
      }))
        await execute(
          'const f=document.getElementById(arguments[0]);f.value=arguments[1];f.dispatchEvent(new Event("input",{bubbles:true}));f.dispatchEvent(new Event("change",{bubbles:true}));',
          [id, value],
        );
      await click("#save-activate");
      await waitFor(
        'return !document.getElementById("save-activate").disabled && !document.getElementById("profile-form").inert;',
      );
      const retained = await execute(
        'return document.getElementById("field-proxy-username").value===arguments[0] && document.getElementById("field-password").value===arguments[1] && document.getElementById("section-auth").open;',
        [credentials.username, credentials.password],
      );
      if (!retained) throw Error("UI cleared credentials " + name);
      await probe(name, want, count);
    }

    await test("correct", { ...expected });
    await test("wrong-password", { ...expected, password: "incorrect" }, false);
    await test("correct-after-wrong", { ...expected });
    await test("concurrent", { ...expected }, true, 24);
    for (let i = 0; i < 3; i++) {
      await stop();
      await probe("outage-" + i, false, 12);
      await start();
      await probe("recovery-" + i, true, 12);
    }
    expected = { username: "second-user", password: "second-password" };
    await start();
    await test("changed-same-endpoint", { ...expected });
    expected = { username: " spaced user ", password: " spaced password " };
    await start();
    await test("whitespace", { ...expected });
    expected = { username: "тест用户", password: "пароль🔑" };
    await start();
    await test("unicode", { ...expected });
    await checkNativePopup(browser, proxyPort, expected);
    console.log("PASS: real microsocks strict authentication matrix");
  } finally {
    if (browser) await stopFirefox(browser);
    await stop();
    await new Promise((r) => originServer.close(r));
    await rm(profileDir, { recursive: true, force: true });
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
