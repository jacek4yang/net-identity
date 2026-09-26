/**
 * Real-Firefox check that WebSocket traffic follows the active proxy.
 *
 * Unit tests pin `decideProxy()`. This harness checks the Firefox-specific part:
 * `proxy.onRequest` actually sees `ws:`/`wss:` URLs and the returned ProxyInfo is
 * what the browser uses.
 *
 *   - a local HTTP proxy records every request and can complete a cleartext
 *     WebSocket (upgrade or CONNECT-then-upgrade)
 *   - Marionette opens the extension options page and saves an HTTP proxy profile
 *     pointing at that proxy, then activates it
 *   - a page opens `ws://` and `wss://` to names that do not resolve on their own
 *   - the proxy must observe both, and a loopback WebSocket must stay bypassed
 *
 * Exit codes match `e2e-smoke.mjs`: 0 pass, 1 failed check, 2 inconclusive because
 * Firefox or Marionette is unavailable. A pass is never reported for a check that
 * did not run.
 *
 * Usage:
 *   node scripts/e2e-websocket.mjs [--firefox <path>] [--timeout <seconds>]
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXTENSION_ID = "net-identity@jacek4yang.github.io";
const WS_HOST = "net-identity-ws-probe.invalid";
const WSS_HOST = "net-identity-wss-probe.invalid";
const PROFILE_ID = "wsprobe01";
const WINDOWS_DEVELOPER_EDITION = "C:\\Program Files\\Firefox Developer Edition\\firefox.exe";

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
  console.error(`[e2e:ws] ${message}`);
}

function listen(server, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("server did not bind a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function websocketAccept(key) {
  return createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
}

function writeTextFrame(socket, text) {
  const payload = Buffer.from(text);
  const header = Buffer.from([0x81, payload.length]);
  socket.write(Buffer.concat([header, payload]));
}

function completeUpgrade(socket, key, marker) {
  const accept = websocketAccept(key);
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  writeTextFrame(socket, marker);
}

/**
 * Reads one HTTP head from a raw socket. Used after `CONNECT 200`, when Firefox
 * sends the WebSocket handshake through the tunnel.
 */
function readHttpHead(socket, timeout) {
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => finish(null), timeout);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end !== -1) finish(buffer.subarray(0, end).toString("utf8"));
    };
    const finish = (value) => {
      clearTimeout(timer);
      socket.off("data", onData);
      resolve(value);
    };
    socket.on("data", onData);
  });
}

function headerValue(head, name) {
  const line = head
    .split("\r\n")
    .slice(1)
    .find((entry) => entry.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line === undefined ? "" : line.slice(line.indexOf(":") + 1).trim();
}

function createRecordingProxy() {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push({
      method: request.method ?? "",
      url: request.url ?? "",
      host: request.headers.host ?? "",
      upgrade: request.headers.upgrade ?? "",
    });
    response.writeHead(502, { "content-type": "text/plain" });
    response.end("net-identity websocket probe does not forward ordinary HTTP");
  });

  server.on("upgrade", (request, socket) => {
    seen.push({
      method: "UPGRADE",
      url: request.url ?? "",
      host: request.headers.host ?? "",
      upgrade: request.headers.upgrade ?? "",
    });
    const key = request.headers["sec-websocket-key"];
    if (typeof key === "string" && key !== "") {
      completeUpgrade(socket, key, "proxied");
      return;
    }
    socket.end();
  });

  server.on("connect", (request, socket) => {
    const target = request.url ?? "";
    seen.push({ method: "CONNECT", url: target, host: target, upgrade: "" });
    const host = target.split(":")[0]?.toLowerCase() ?? "";
    if (host !== WS_HOST) {
      socket.write("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
      socket.end();
      return;
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    void readHttpHead(socket, 3000).then((head) => {
      if (head === null) {
        socket.end();
        return;
      }
      seen.push({
        method: "TUNNEL",
        url: head.split("\r\n")[0] ?? "",
        host: headerValue(head, "host"),
        upgrade: headerValue(head, "upgrade"),
      });
      const key = headerValue(head, "sec-websocket-key");
      if (key !== "") completeUpgrade(socket, key, "proxied");
      else socket.end();
    });
  });

  return { server, seen };
}

function createDirectWebSocketServer() {
  const hits = [];
  const server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  server.on("upgrade", (request, socket) => {
    hits.push(request.url ?? "");
    const key = request.headers["sec-websocket-key"];
    if (typeof key === "string" && key !== "") completeUpgrade(socket, key, "direct");
    else socket.end();
  });
  return { server, hits };
}

function createMarionette(port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let buffer = Buffer.alloc(0);
    let handshake = null;
    const pending = new Map();
    let nextId = 1;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const takeMessage = () => {
      const colon = buffer.indexOf(0x3a);
      if (colon < 1) return null;
      const length = Number(buffer.subarray(0, colon).toString("utf8"));
      if (!Number.isInteger(length) || length < 0) {
        throw new Error("Marionette sent a packet with a bad length");
      }
      const start = colon + 1;
      if (buffer.length < start + length) return null;
      const payload = buffer.subarray(start, start + length).toString("utf8");
      buffer = buffer.subarray(start + length);
      return JSON.parse(payload);
    };

    const pump = () => {
      for (;;) {
        const message = takeMessage();
        if (message === null) return;
        if (handshake === null && !Array.isArray(message)) {
          handshake = message;
          if (!settled) {
            settled = true;
            resolve(api);
          }
          continue;
        }
        if (Array.isArray(message) && message[0] === 1) {
          const waiter = pending.get(message[1]);
          pending.delete(message[1]);
          if (waiter === undefined) continue;
          if (message[2] !== null && message[2] !== undefined) {
            waiter.reject(new Error(JSON.stringify(message[2])));
          } else {
            waiter.resolve(message[3]);
          }
        }
      }
    };

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        pump();
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("error", fail);
    socket.on("close", () => {
      for (const waiter of pending.values())
        waiter.reject(new Error("Marionette connection closed"));
      pending.clear();
    });

    const api = {
      send(command, params = {}, commandTimeoutMs = 20000) {
        const id = nextId;
        nextId += 1;
        const body = JSON.stringify([0, id, command, params]);
        const packet = `${Buffer.byteLength(body)}:${body}`;
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
          socket.write(packet);
        });
      },
      close() {
        socket.end();
      },
    };
  });
}

async function connectMarionette(port, deadline) {
  let lastError = "connection refused";
  while (Date.now() < deadline) {
    try {
      return await createMarionette(port);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(lastError);
}

const LOCATE_EXTENSION = `
  const callback = arguments[arguments.length - 1];
  try {
    const policy = WebExtensionPolicy.getByID(${JSON.stringify(EXTENSION_ID)});
    if (!policy) {
      callback({ error: "extension policy is not installed yet" });
      return;
    }
    const host = policy.mozExtensionHostname;
    if (typeof host !== "string" || host === "") {
      callback({ error: "extension has no moz-extension host", baseURL: String(policy.baseURL) });
      return;
    }
    callback({ ok: true, baseURL: "moz-extension://" + host + "/" });
  } catch (error) {
    callback({ error: String(error) });
  }
`;

// The options page is an extension page, so it has the real browser.* API.
// A JSON round-trip crosses the Marionette sandbox boundary without cloneInto.
const OPTIONS_CALL = `
  const callback = arguments[arguments.length - 1];
  const message = arguments[0];
  try {
    const page = window.wrappedJSObject || window;
    if (!page.browser || !page.browser.runtime) {
      callback({ error: "options page has no browser.runtime", href: String(location.href) });
      return;
    }
    const payload = page.JSON.parse(JSON.stringify(message));
    page.browser.runtime.sendMessage(payload).then(
      (value) => callback({ ok: true, value: page.JSON.parse(page.JSON.stringify(value)) }),
      (error) => callback({ error: String(error) }),
    );
  } catch (error) {
    callback({ error: String(error), stack: String(error && error.stack) });
  }
`;

const PAGE_PROBE = `
  const callback = arguments[arguments.length - 1];
  const wsUrl = arguments[0];
  const wssUrl = arguments[1];
  const directUrl = arguments[2];

  function openSocket(url) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      let socket;
      try {
        socket = new WebSocket(url);
      } catch (error) {
        finish({ error: String(error) });
        return;
      }
      const timer = setTimeout(() => {
        try { socket.close(); } catch (error) { /* already closed */ }
        finish({ error: "timeout" });
      }, 5000);
      socket.addEventListener("message", (event) => {
        clearTimeout(timer);
        finish({ data: String(event.data) });
        socket.close();
      });
      socket.addEventListener("error", () => {
        /* close carries the outcome when the handshake fails */
      });
      socket.addEventListener("close", (event) => {
        clearTimeout(timer);
        finish({ error: "closed", code: event.code });
      });
    });
  }

  Promise.all([openSocket(wsUrl), openSocket(wssUrl), openSocket(directUrl)]).then(
    ([ws, wss, direct]) => callback({ ws, wss, direct }),
    (error) => callback({ error: String(error) }),
  );
`;

function mentions(entries, host) {
  const needle = host.toLowerCase();
  return entries.some((entry) =>
    `${entry.method} ${entry.url} ${entry.host}`.toLowerCase().includes(needle),
  );
}

function startFirefox(marionettePort, pageUrl, onOutput) {
  const cli = path.join(root, "node_modules", "web-ext", "bin", "web-ext.js");
  const args = [
    cli,
    "run",
    "--source-dir",
    path.join(root, "dist"),
    "--url",
    pageUrl,
    "--no-input",
    "--no-reload",
    `--pref=marionette.port=${marionettePort}`,
    "--arg=--marionette",
    "--arg=-remote-allow-system-access",
    "--arg=-headless",
  ];
  if (firefoxPath !== undefined) args.push("--firefox", firefoxPath);
  const child = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => onOutput(String(chunk)));
  child.stderr.on("data", (chunk) => onOutput(String(chunk)));
  return child;
}

function stopFirefox(child) {
  if (child === null || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

async function main() {
  if (!existsSync(path.join(root, "dist", "manifest.json"))) {
    log("FAIL: dist/ is missing. Run `npm run build` first.");
    process.exit(1);
  }
  if (firefoxPath === undefined) {
    log("INCONCLUSIVE: no Firefox binary was found. Pass --firefox <path>.");
    process.exit(2);
  }

  const proxy = createRecordingProxy();
  const direct = createDirectWebSocketServer();
  const page = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>ws probe</title>");
  });

  const proxyPort = await listen(proxy.server);
  const directPort = await listen(direct.server);
  const pagePort = await listen(page);
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

  const pageUrl = `http://127.0.0.1:${pagePort}/`;
  log(`proxy 127.0.0.1:${proxyPort}, direct ws 127.0.0.1:${directPort}, page ${pageUrl}`);

  let firefoxOutput = "";
  const firefox = startFirefox(marionettePort, pageUrl, (chunk) => {
    firefoxOutput += chunk;
  });

  const deadline = Date.now() + timeoutMs;
  let marionette = null;
  const failures = [];
  let exitCode = 0;

  try {
    try {
      marionette = await connectMarionette(marionettePort, deadline);
    } catch (error) {
      log(
        `INCONCLUSIVE: Marionette did not accept a connection (${error instanceof Error ? error.message : String(error)}).`,
      );
      log(firefoxOutput.split("\n").slice(-30).join("\n"));
      exitCode = 2;
    }

    if (exitCode === 0) {
      await marionette.send("WebDriver:NewSession", {
        capabilities: { alwaysMatch: { browserName: "firefox", acceptInsecureCerts: true } },
      });
      await marionette.send("WebDriver:SetTimeouts", {
        script: 30000,
        pageLoad: 30000,
        implicit: 0,
      });
      await marionette.send("Marionette:SetContext", { value: "chrome" });

      const profile = {
        id: PROFILE_ID,
        name: "WebSocket probe",
        proxy: {
          type: "http",
          host: "127.0.0.1",
          port: proxyPort,
          proxyDNS: false,
          bypassHosts: ["localhost", "127.0.0.1", "::1"],
        },
        identity: {
          mode: "manual",
          latitude: 0,
          longitude: 0,
          accuracy: 20000,
          timezone: "UTC",
        },
        webrtcPolicy: "default",
      };

      let located = null;
      while (Date.now() < deadline) {
        located = await marionette.send("WebDriver:ExecuteAsyncScript", {
          script: LOCATE_EXTENSION,
          args: [],
        });
        const value = located?.value ?? located;
        if (value && value.error === "extension policy is not installed yet") {
          await new Promise((resolve) => setTimeout(resolve, 300));
          continue;
        }
        break;
      }

      const location = located?.value ?? located;
      log(`extension -> ${JSON.stringify(location)}`);
      if (!location || location.ok !== true || typeof location.baseURL !== "string") {
        failures.push(`could not locate the extension: ${JSON.stringify(location)}`);
      } else {
        await marionette.send("Marionette:SetContext", { value: "content" });
        await marionette.send("WebDriver:Navigate", {
          url: new URL("options/options.html", location.baseURL).href,
        });
        const saved = await marionette.send("WebDriver:ExecuteAsyncScript", {
          script: OPTIONS_CALL,
          args: [{ type: "profiles:save", profile }],
        });
        const saveResult = saved?.value ?? saved;
        log(`profiles:save -> ${JSON.stringify(saveResult)}`);
        if (!saveResult || saveResult.ok !== true || saveResult.value?.ok !== true) {
          failures.push(`could not save the proxy profile: ${JSON.stringify(saveResult)}`);
        } else {
          const activated = await marionette.send(
            "WebDriver:ExecuteAsyncScript",
            {
              script: OPTIONS_CALL,
              args: [{ type: "profiles:activate", profileId: PROFILE_ID }],
            },
            40000,
          );
          const activateResult = activated?.value ?? activated;
          log(`profiles:activate -> ${JSON.stringify(activateResult)}`);
          if (!activateResult || activateResult.ok !== true || activateResult.value?.ok !== true) {
            failures.push(
              `could not activate the proxy profile: ${JSON.stringify(activateResult)}`,
            );
          } else if (activateResult.value.state?.proxy?.type !== "http") {
            failures.push(
              `active proxy type is ${String(activateResult.value.state?.proxy?.type)}`,
            );
          }
        }
      }

      if (failures.length === 0) {
        await marionette.send("Marionette:SetContext", { value: "content" });
        await marionette.send("WebDriver:Navigate", { url: pageUrl });
        const probed = await marionette.send(
          "WebDriver:ExecuteAsyncScript",
          {
            script: PAGE_PROBE,
            args: [
              `ws://${WS_HOST}/ni-ws`,
              `wss://${WSS_HOST}/ni-wss`,
              `ws://127.0.0.1:${directPort}/ni-direct`,
            ],
          },
          25000,
        );
        const report = probed?.value ?? probed;
        log(`page sockets -> ${JSON.stringify(report)}`);
        log(`proxy saw ${proxy.seen.length} request(s): ${JSON.stringify(proxy.seen)}`);
        log(`direct server saw ${direct.hits.length} upgrade(s)`);

        const wsOk = report?.ws?.data === "proxied";
        const wssSeen = mentions(proxy.seen, WSS_HOST);
        const wsSeen = mentions(proxy.seen, WS_HOST);
        const directOk = report?.direct?.data === "direct" && direct.hits.length > 0;
        const directNotProxied = !mentions(proxy.seen, "127.0.0.1");

        log(`${wsOk && wsSeen ? "PASS" : "FAIL"}  ws://${WS_HOST} reached the proxy`);
        log(`${wssSeen ? "PASS" : "FAIL"}  wss://${WSS_HOST} reached the proxy`);
        log(`${directOk && directNotProxied ? "PASS" : "FAIL"}  loopback WebSocket stayed direct`);

        if (!wsSeen || !wsOk)
          failures.push("cleartext WebSocket did not travel through the active proxy");
        if (!wssSeen) failures.push("secure WebSocket did not travel through the active proxy");
        if (!directOk || !directNotProxied) {
          failures.push("loopback WebSocket was not kept on the bypass path");
        }
      }
    }
  } finally {
    if (marionette !== null) {
      try {
        await marionette.send("WebDriver:DeleteSession", {});
      } catch {
        // The browser may already be gone.
      }
      marionette.close();
    }
    stopFirefox(firefox);
    proxy.server.close();
    direct.server.close();
    page.close();
  }

  if (exitCode !== 0) process.exit(exitCode);
  if (failures.length > 0) {
    log(`FAILED: ${failures.join("; ")}`);
    log(firefoxOutput.split("\n").slice(-40).join("\n"));
    process.exit(1);
  }
  log("PASSED: WebSocket traffic followed the active proxy and loopback stayed bypassed.");
  process.exit(0);
}

main().catch((error) => {
  log(`harness error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
