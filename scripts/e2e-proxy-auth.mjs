/**
 * Real-Firefox check for authenticated HTTP proxy routing.
 *
 * Starts the bundled dev proxy with required Basic credentials, installs the
 * extension, and activates an HTTP profile. A correct password must reach the
 * proxy (preemptive header or a single challenge) and must not be logged.
 * A wrong password must not produce an unbounded 407 loop.
 *
 * Exit codes: 0 pass, 1 failed check, 2 Firefox is unavailable.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WINDOWS_DEVELOPER_EDITION = "C:\\Program Files\\Firefox Developer Edition\\firefox.exe";
const { values } = parseArgs({
  options: { firefox: { type: "string" }, timeout: { type: "string", default: "90" } },
});
const firefoxPath =
  values.firefox ?? (existsSync(WINDOWS_DEVELOPER_EDITION) ? WINDOWS_DEVELOPER_EDITION : undefined);
const timeoutMs = Number(values.timeout) * 1000;

function log(message) {
  console.error(`[e2e:auth] ${message}`);
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
    const policy = WebExtensionPolicy.getByID("net-identity@jacek4yang.github.io");
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

// Starts a message and returns without waiting for the reply. Activation resolves the
// identity through the proxy; a wrong password makes Firefox raise a proxy-auth dialog,
// which aborts a script that is still waiting for that lookup. The 407s are counted from
// the proxy log, so the reply is not needed.
const CALL_FIRE = `
  const callback = arguments[arguments.length - 1];
  const message = arguments[0];
  try {
    const page = window.wrappedJSObject || window;
    const payload = page.JSON.parse(JSON.stringify(message));
    page.browser.runtime.sendMessage(payload);
    callback({ ok: true });
  } catch (error) { callback({ error: String(error) }); }
`;

// Reports whether the options page is loaded and has the extension API. The page
// renders the profile list and the map, so a script sent too early can be torn down.
const READY = `
  const callback = arguments[arguments.length - 1];
  try {
    const page = window.wrappedJSObject || window;
    const api = page.browser && page.browser.runtime && page.browser.runtime.id;
    callback({ ok: page.document.readyState === "complete" && typeof api === "string" });
  } catch (error) { callback({ ok: false, error: String(error) }); }
`;

function count407(logText, host) {
  return logText
    .split("\n")
    .filter((line) => line.includes("407") && (host === undefined || line.includes(host))).length;
}

function sawTunnel(logText, host) {
  return logText
    .split("\n")
    .some((line) => line.includes(`CONNECT ${host}`) && !line.includes("407"));
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

  const proxyPort = await freePort();
  const marionettePort = await freePort();
  let proxyLog = "";
  const proxy = spawn(
    process.execPath,
    [
      path.join(root, "scripts", "dev-proxy.mjs"),
      "--port",
      String(proxyPort),
      "--offline",
      "--offline-target",
      "ipwho.is:443",
      "--require-auth",
      "user:pass",
    ],
    { cwd: root, stdio: ["ignore", "ignore", "pipe"] },
  );
  proxy.stderr.on("data", (chunk) => {
    proxyLog += String(chunk);
  });

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
      ...(firefoxPath === undefined ? [] : ["--firefox", firefoxPath]),
    ],
    { cwd: root, stdio: ["ignore", "ignore", "pipe"] },
  );

  const deadline = Date.now() + timeoutMs;
  let client = null;
  const failures = [];
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
    await client.send("Marionette:SetContext", { value: "content" });
    await client.send("WebDriver:Navigate", {
      url: new URL("options/options.html", location.baseURL).href,
    });

    // The options page renders the profile list and the map. Wait until it is ready so
    // a script is not torn down by a re-render before it can reply.
    let optionsReady = false;
    while (Date.now() < deadline) {
      const probe = await client.send(
        "WebDriver:ExecuteAsyncScript",
        { script: READY, args: [] },
        10000,
      );
      const value = probe?.value ?? probe;
      if (value?.ok === true) {
        optionsReady = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!optionsReady) throw new Error("the options page never became ready");

    // A modal auth dialog can interrupt an async script with {value: null}.
    // Unwrap before checking: nullish coalescing would return the wrapper itself
    // and accidentally bypass this bounded retry. Real error replies still fail.
    async function call(message, script = CALL, timeout = 20000) {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          const result = await client.send(
            "WebDriver:ExecuteAsyncScript",
            { script, args: [message] },
            timeout,
          );
          const value = Object.hasOwn(result ?? {}, "value") ? result.value : result;
          if (value !== null && value !== undefined) return value;
        } catch (error) {
          // Wrong credentials intentionally produce native proxy-auth dialogs.
          // A dialog can arrive between DismissAlert and the next command; the
          // configured handler dismisses it and reports this specific error.
          if (
            !(error instanceof Error) ||
            !error.message.includes('"error":"unexpected alert open"')
          )
            throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return null;
    }

    const profile = {
      id: "e2e-auth01",
      name: "Auth proxy",
      proxy: {
        type: "http",
        host: "127.0.0.1",
        port: proxyPort,
        proxyDNS: false,
        bypassHosts: ["localhost", "127.0.0.1", "::1"],
      },
      identity: { mode: "manual", latitude: 0, longitude: 0, accuracy: 20000, timezone: "UTC" },
      webrtcPolicy: "default",
    };

    async function saveAndActivate(password) {
      const saveResult = await call({
        type: "profiles:save",
        profile,
        credentials: { username: "user", password },
      });
      if (!saveResult?.ok || saveResult.value?.ok !== true) {
        throw new Error(`save failed: ${JSON.stringify(saveResult)}`);
      }
      // Activation resolves the identity through the proxy. A wrong password makes
      // Firefox raise a proxy-auth dialog, which would abort a script that waits for
      // the lookup, so start the activation and return immediately.
      const activateResult = await call(
        { type: "profiles:activate", profileId: profile.id },
        CALL_FIRE,
        40000,
      );
      if (!activateResult?.ok) {
        throw new Error(`activate failed: ${JSON.stringify(activateResult)}`);
      }
    }

    await saveAndActivate("wrong-pass");
    await new Promise((resolve) => setTimeout(resolve, 2500));
    // The extension offers credentials for its own GeoIP request and must never tunnel
    // the wrong password. The exact number of challenges depends on Firefox's and the
    // provider's retry policy, so the once-per-request-id bound is unit tested in
    // tests/proxy.test.ts and this smoke asserts only the deterministic parts.
    const wrong407 = count407(proxyLog, "ipwho.is");
    const wrongTunnel = sawTunnel(proxyLog, "ipwho.is");
    log(
      `${wrong407 >= 1 && !wrongTunnel ? "PASS" : "FAIL"}  wrong password was challenged ${wrong407} time(s) and never tunneled the GeoIP request`,
    );
    if (wrong407 < 1 || wrongTunnel) {
      failures.push(`wrong password: ${wrong407} challenge(s), tunneled=${String(wrongTunnel)}`);
    }
    try {
      await client.send("WebDriver:DismissAlert");
    } catch {
      // No auth dialog is fine.
    }

    const beforeCorrect = count407(proxyLog, "ipwho.is");
    try {
      await client.send("WebDriver:DismissAlert");
    } catch {
      // No auth dialog is fine. A dialog means Firefox stopped accepting our answer.
    }
    await saveAndActivate("pass");
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const correct407 = count407(proxyLog, "ipwho.is") - beforeCorrect;
    const sawTraffic = sawTunnel(proxyLog, "ipwho.is");
    const leaked = /user:pass|wrong-pass/i.test(proxyLog);
    log(`${sawTraffic ? "PASS" : "FAIL"}  proxy tunneled the GeoIP connection`);
    log(
      `${correct407 <= 1 ? "PASS" : "FAIL"}  correct password added ${correct407} further 407 response(s)`,
    );
    log(`${leaked ? "FAIL" : "PASS"}  proxy log does not contain the password`);
    if (!sawTraffic) failures.push("authenticated proxy never tunneled the GeoIP request");
    if (correct407 > 1) failures.push("correct credentials were challenged repeatedly");
    if (leaked) failures.push("proxy log contains credential material");
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  } finally {
    client?.close();
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(firefox.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      firefox.kill("SIGTERM");
    }
    proxy.kill();
  }

  if (failures.length > 0) {
    log(`FAILED: ${failures.join("; ")}`);
    log(proxyLog.split("\n").slice(-30).join("\n"));
    process.exit(1);
  }
  log("PASSED: proxy credentials were offered only to the configured proxy, once per request.");
  process.exit(0);
}

main().catch((error) => {
  log(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
