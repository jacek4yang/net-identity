import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createLiveMapProxy, isMapAuthority } from "./live-map-proxy.mjs";
import { captureFrameFits } from "./capture-frame.mjs";

test("only the exact HTTPS provider authority is eligible", () => {
  assert.equal(isMapAuthority("tiles.openfreemap.org:443"), true);
  for (const value of [
    undefined,
    "tiles.openfreemap.org",
    "tiles.openfreemap.org:80",
    "tiles.openfreemap.org:443@evil.test",
    "evil.test:443",
    "127.0.0.1:443",
    "tiles.openfreemap.org.evil.test:443",
    "https://tiles.openfreemap.org:443",
    "tiles.openfreemap.org:443/path",
  ])
    assert.equal(isMapAuthority(value), false);
});
test("loopback fixture rejects arbitrary tunnels and plain HTTP without upstream access", async () => {
  const proxy = await createLiveMapProxy();
  try {
    for (const method of ["CONNECT", "GET"]) {
      const status = await new Promise((resolve, reject) => {
        const request = http.request({
          host: "127.0.0.1",
          port: proxy.port,
          method,
          path:
            method === "CONNECT"
              ? "example.invalid:443"
              : "https://tiles.openfreemap.org/styles/liberty",
        });
        request.on("error", reject);
        request.on("connect", (response, socket) => {
          socket.destroy();
          resolve(response.statusCode);
        });
        request.on("response", (response) => {
          response.resume();
          resolve(response.statusCode);
        });
        request.end();
      });
      assert.equal(status, 403);
    }
    assert.deepEqual(proxy.counts(), { accepted: 0, rejected: 2 });
  } finally {
    await proxy.close();
  }
});

test(
  "all idle, incomplete-header and plain sockets close on fixture shutdown",
  { timeout: 5000 },
  async () => {
    const { default: net } = await import("node:net");
    const proxy = await createLiveMapProxy();
    const sockets = [];
    try {
      for (const payload of [
        "",
        "GET / HTTP/1.1\r\nHost: ",
        "GET / HTTP/1.1\r\nHost: local\r\n\r\n",
      ]) {
        const socket = net.connect({ host: "127.0.0.1", port: proxy.port });
        sockets.push(socket);
        socket.on("error", () => {});
        socket.resume();
        await new Promise((resolve) => socket.once("connect", resolve));
        if (payload) socket.write(payload);
      }
      await proxy.close();
      await proxy.close();
      assert.deepEqual(proxy.counts().accepted, 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(proxy.activeConnections(), 0);
      assert.ok(sockets.every((socket) => socket.destroyed));
    } finally {
      for (const socket of sockets) socket.destroy();
      await proxy.close();
    }
  },
);

test(
  "connection, header-size and slow-header bounds are enforced without upstream access",
  { timeout: 10_000 },
  async () => {
    const { default: net } = await import("node:net");
    const { PROXY_LIMITS } = await import("./live-map-proxy.mjs");
    const proxy = await createLiveMapProxy();
    const sockets = [];
    try {
      for (let i = 0; i < PROXY_LIMITS.connections + 3; i++) {
        const socket = net.connect({ host: "127.0.0.1", port: proxy.port });
        sockets.push(socket);
        socket.on("error", () => {});
        socket.resume();
        await new Promise((resolve) => socket.once("connect", resolve));
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(proxy.activeConnections() <= PROXY_LIMITS.connections);
      assert.ok(sockets.some((socket) => socket.destroyed));
      const oversized = sockets.find((socket) => !socket.destroyed);
      oversized.write(
        `GET / HTTP/1.1\r\nHost: local\r\nX-Oversized: ${"x".repeat(PROXY_LIMITS.maxHeaderBytes)}\r\n\r\n`,
      );
      await new Promise((resolve) => oversized.once("close", resolve));
      const deadline = Date.now() + PROXY_LIMITS.headerMs + 1000;
      while (proxy.activeConnections() && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(proxy.activeConnections(), 0);
      assert.equal(proxy.counts().accepted, 0);
    } finally {
      for (const socket of sockets) socket.destroy();
      await proxy.close();
    }
  },
);

test("failed duplicate bind leaves the original fixture intact", async () => {
  const proxy = await createLiveMapProxy();
  try {
    await assert.rejects(createLiveMapProxy(proxy.port), { code: "EADDRINUSE" });
    assert.equal(proxy.counts().accepted, 0);
  } finally {
    await proxy.close();
  }
});

test(
  "capture failure stops its process tree, removes private directories and redacts split UUIDs",
  { timeout: 15_000 },
  async () => {
    const { mkdtemp, mkdir, readFile, writeFile, copyFile, readdir, rm } =
      await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const directory = await mkdtemp(path.join(tmpdir(), "ni-capture-lifecycle-test-"));
    try {
      const root = path.join(directory, "fixture");
      for (const child of ["scripts", "dist", "node_modules/web-ext/bin", "private-temp"])
        await mkdir(path.join(root, child), { recursive: true });
      await writeFile(path.join(root, "package.json"), '{"type":"module"}');
      await writeFile(path.join(root, "dist/manifest.json"), '{"version":"0.0.0"}');
      for (const name of [
        "e2e-ui.mjs",
        "live-map-proxy.mjs",
        "capture-frame.mjs",
        "draft-probe-fixture.mjs",
        "run-draft-checks.mjs",
      ])
        await copyFile(new URL(name, import.meta.url), path.join(root, "scripts", name));
      await writeFile(
        path.join(root, "node_modules/web-ext/bin/web-ext.js"),
        `
      import {spawn} from 'node:child_process';
      import {writeFileSync} from 'node:fs';
      writeFileSync(process.env.CAPTURE_TEST_ENV, JSON.stringify({home:process.env.HOME,tmp:process.env.TMPDIR,config:process.env.XDG_CONFIG_HOME,args:process.argv}));
      const childScript = process.env.CAPTURE_TEST_STUBBORN === '1'
        ? "require('node:fs').writeFileSync(process.env.CAPTURE_TEST_MARKER + '.pid',String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"
        : "process.on('SIGTERM',()=>{require('node:fs').writeFileSync(process.env.CAPTURE_TEST_MARKER,'stopped');process.exit(0)});setInterval(()=>{},1000)";
      const child = spawn(process.execPath, ['-e', childScript], {stdio:'ignore'});
      process.on('SIGTERM',()=>process.env.CAPTURE_TEST_STUBBORN === '1' ? process.exit(0) : child.once('exit',()=>process.exit(0)));
      process.stdout.write('moz-extension://12345678-');
      setTimeout(()=>process.stdout.write('1234-1234-1234-123456789012/popup\\n'),25);
      setInterval(()=>{},1000);
    `,
      );
      const output = path.join(root, "candidate-output");
      const envFile = path.join(root, "captured-env.json"),
        marker = path.join(root, "child-stopped");
      let failure;
      try {
        await promisify(execFile)(
          process.execPath,
          [
            path.join(root, "scripts/e2e-ui.mjs"),
            "--live-map",
            "--screenshots",
            output,
            "--firefox",
            "/not-a-real-browser",
            "--timeout",
            "1",
          ],
          {
            timeout: 12_000,
            env: {
              ...process.env,
              DISPLAY: ":not-used",
              TMPDIR: path.join(root, "private-temp"),
              CAPTURE_TEST_ENV: envFile,
              CAPTURE_TEST_MARKER: marker,
            },
          },
        );
      } catch (error) {
        failure = error;
      }
      assert.equal(failure?.code, 1);
      assert.match(failure.stderr, /moz-extension:\/\/<extension>\/popup/);
      assert.ok(!failure.stderr.includes("12345678-1234-1234-1234-123456789012"));
      assert.equal(await readFile(marker, "utf8"), "stopped");
      const recorded = JSON.parse(await readFile(envFile, "utf8"));
      assert.ok(recorded.home.startsWith(path.join(root, "private-temp/ni-live-map-")));
      assert.ok(recorded.tmp.startsWith(path.dirname(recorded.home)));
      assert.ok(recorded.config.startsWith(path.dirname(recorded.home)));
      assert.ok(recorded.args.includes("--keep-profile-changes"));
      assert.deepEqual(await readdir(path.join(root, "private-temp")), []);
      assert.deepEqual(await readdir(output), []);
      const rebound = await createLiveMapProxy(9999);
      try {
        await assert.rejects(
          promisify(execFile)(
            process.execPath,
            [
              path.join(root, "scripts/e2e-ui.mjs"),
              "--live-map",
              "--screenshots",
              path.join(root, "setup-failure-output"),
              "--firefox",
              "/not-a-real-browser",
              "--timeout",
              "1",
            ],
            {
              env: {
                ...process.env,
                DISPLAY: ":not-used",
                TMPDIR: path.join(root, "private-temp"),
              },
            },
          ),
          { code: 1 },
        );
        assert.deepEqual(await readdir(path.join(root, "private-temp")), []);
        assert.deepEqual(rebound.counts(), { accepted: 0, rejected: 0 });
      } finally {
        await rebound.close();
      }
      if (process.platform === "linux") {
        const stubbornMarker = path.join(root, "stubborn-child");
        const started = Date.now();
        let stubbornFailure;
        try {
          await promisify(execFile)(
            process.execPath,
            [
              path.join(root, "scripts/e2e-ui.mjs"),
              "--live-map",
              "--screenshots",
              path.join(root, "stubborn-output"),
              "--firefox",
              "/not-a-real-browser",
              "--timeout",
              "1",
            ],
            {
              timeout: 12_000,
              env: {
                ...process.env,
                DISPLAY: ":not-used",
                TMPDIR: path.join(root, "private-temp"),
                CAPTURE_TEST_ENV: envFile,
                CAPTURE_TEST_MARKER: stubbornMarker,
                CAPTURE_TEST_STUBBORN: "1",
              },
            },
          );
        } catch (error) {
          stubbornFailure = error;
        }
        assert.equal(stubbornFailure?.code, 1);
        assert.ok(
          Date.now() - started >= 5000,
          "must supervise surviving descendant after parent exits",
        );
        assert.ok(!stubbornFailure.stderr.includes("did not disappear"));
        assert.ok(!stubbornFailure.stderr.includes("profile retained"));
        const pid = (await readFile(stubbornMarker + ".pid", "utf8")).trim();
        try {
          const stat = await readFile(`/proc/${pid}/stat`, "utf8");
          assert.ok(
            ["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]),
            "no live child may survive group shutdown",
          );
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        assert.deepEqual(await readdir(path.join(root, "private-temp")), []);
      }
      await writeFile(path.join(output, "preserve-me"), "existing");
      await assert.rejects(
        promisify(execFile)(
          process.execPath,
          [path.join(root, "scripts/e2e-ui.mjs"), "--live-map", "--screenshots", output],
          { env: { ...process.env, DISPLAY: ":not-used" } },
        ),
        { code: 1 },
      );
      assert.equal(await readFile(path.join(output, "preserve-me"), "utf8"), "existing");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "allowed CONNECT relays opaque bytes and closes upstream using only an injected loopback server",
  { timeout: 5000 },
  async (context) => {
    const { default: net } = await import("node:net");
    const echoSockets = new Set();
    const echo = net.createServer((socket) => {
      echoSockets.add(socket);
      socket.on("data", (chunk) => socket.write(chunk));
      socket.on("error", () => socket.destroy());
      socket.once("close", () => echoSockets.delete(socket));
    });
    await new Promise((resolve) => echo.listen(0, "127.0.0.1", resolve));
    const connect = net.connect.bind(net);
    const destinations = [];
    context.mock.method(net, "connect", (options, ...rest) => {
      if (options?.host === "tiles.openfreemap.org") {
        destinations.push(options);
        return connect({ host: "127.0.0.1", port: echo.address().port });
      }
      return connect(options, ...rest);
    });
    const proxy = await createLiveMapProxy();
    let tunnel;
    try {
      tunnel = await new Promise((resolve, reject) => {
        const request = http.request({
          host: "127.0.0.1",
          port: proxy.port,
          method: "CONNECT",
          path: "tiles.openfreemap.org:443",
        });
        request.on("error", reject);
        request.on("connect", (response, socket) => {
          assert.equal(response.statusCode, 200);
          resolve(socket);
        });
        request.end();
      });
      const received = new Promise((resolve) =>
        tunnel.once("data", (data) => resolve(data.toString())),
      );
      tunnel.write("opaque-fixture-payload");
      assert.equal(await received, "opaque-fixture-payload");
      assert.deepEqual(destinations, [{ host: "tiles.openfreemap.org", port: 443 }]);
      assert.deepEqual(proxy.counts(), { accepted: 1, rejected: 0 });
      await proxy.close();
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(echoSockets.size, 0);
    } finally {
      tunnel?.destroy();
      await proxy.close();
      for (const socket of echoSockets) socket.destroy();
      await new Promise((resolve) => echo.close(resolve));
    }
  },
);

test("picker native framing accepts 778/784px and rejects oversized or clipped content", () => {
  const viewport = { width: 1280, height: 800 };
  const box = (height) => ({ x: 430, y: 16, width: 692, height });
  assert.equal(captureFrameFits("picker", box(778), viewport), true);
  assert.equal((800 - 778) / 2, 11);
  assert.equal(captureFrameFits("picker", box(784), viewport), true);
  assert.equal((800 - 784) / 2, 8);
  assert.equal(captureFrameFits("picker", { ...box(785), y: 0 }, viewport), false);
  assert.equal(captureFrameFits("picker", { ...box(778), y: 23 }, viewport), false);
  assert.equal(captureFrameFits("picker", { ...box(778), y: -1 }, viewport), false);
  assert.equal(captureFrameFits("picker", { ...box(778), x: -1 }, viewport), false);
  assert.equal(captureFrameFits("picker", { ...box(778), x: 600 }, viewport), false);
  assert.equal(captureFrameFits("picker", { ...box(778), height: NaN }, viewport), false);
  assert.equal(captureFrameFits("picker", box(784), { width: 1280, height: 900 }), false);
  assert.equal(captureFrameFits("audit", box(768), viewport), true);
  assert.equal(captureFrameFits("audit", box(769), viewport), false);
});
