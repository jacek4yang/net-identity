/** Loopback-only SOCKS/HTTP and trusted test-profile TLS fixture. No public network. */
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import https from "node:https";
import http from "node:http";
import path from "node:path";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}
export async function createDraftFixture(directory, profile) {
  const key = path.join(directory, "test-key.pem"),
    cert = path.join(directory, "test-cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=ipwho.is",
      "-addext",
      "subjectAltName=DNS:ipwho.is",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    ],
    { stdio: "ignore" },
  );
  const leafKey = path.join(directory, "server-key.pem"),
    leafCsr = path.join(directory, "server.csr"),
    leafCert = path.join(directory, "server-cert.pem"),
    ext = path.join(directory, "server.ext");
  await writeFile(
    ext,
    "subjectAltName=DNS:ipwho.is\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n",
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      leafKey,
      "-out",
      leafCsr,
      "-subj",
      "/CN=ipwho.is",
    ],
    { stdio: "ignore" },
  );
  execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      leafCsr,
      "-CA",
      cert,
      "-CAkey",
      key,
      "-CAcreateserial",
      "-out",
      leafCert,
      "-days",
      "1",
      "-extfile",
      ext,
    ],
    { stdio: "ignore" },
  );
  // Trust only in this disposable profile, never in the OS/user certificate database.
  execFileSync("certutil", ["-N", "-d", `sql:${profile}`, "--empty-password"], { stdio: "ignore" });
  execFileSync(
    "certutil",
    [
      "-A",
      "-d",
      `sql:${profile}`,
      "-n",
      "net-identity local draft fixture",
      "-t",
      "C,,",
      "-i",
      cert,
    ],
    { stdio: "ignore" },
  );
  const sockets = new Set();
  const servers = [];
  const seen = { a: [], b: [], auth: [], http: [], tls: [] };
  const track = (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    return socket;
  };
  const tls = https.createServer(
    { key: await readFile(leafKey), cert: await readFile(leafCert) },
    (request, response) => {
      seen.tls.push(request.url);
      response.writeHead(200, {
        "content-type": "application/json",
        connection: "close",
        "access-control-allow-origin": "*",
      });
      response.end(
        JSON.stringify({
          success: true,
          ip: "203.0.113.42",
          city: "Tokyo",
          country_code: "JP",
          latitude: 35.68,
          longitude: 139.76,
          timezone: { id: "Asia/Tokyo" },
        }),
      );
    },
  );
  tls.on("tlsClientError", (error) => {
    seen.tls.push({ tlsError: error.code });
  });
  tls.on("connection", track);
  servers.push(tls);
  const tlsPort = await listen(tls);
  const tunnel = (socket, ready) => {
    const upstream = track(net.connect({ host: "127.0.0.1", port: tlsPort }));
    upstream.once("connect", () => {
      ready();
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("close", () => upstream.destroy());
  };
  async function socks(label, auth) {
    const server = net.createServer((socket) => {
      track(socket);
      let buffer = Buffer.alloc(0),
        phase = 0;
      const receive = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > 4096) return socket.destroy();
        if (phase === 0) {
          if (buffer.length < 2 || buffer.length < 2 + buffer[1]) return;
          const method = auth ? 2 : 0,
            accepted = buffer.subarray(2, 2 + buffer[1]).includes(method);
          buffer = buffer.subarray(2 + buffer[1]);
          socket.write(Buffer.from([5, accepted ? method : 255]));
          if (!accepted) return socket.end();
          phase = auth ? 1 : 2;
        }
        if (phase === 1) {
          if (buffer.length < 2 || buffer.length < 3 + buffer[1]) return;
          const endUser = 2 + buffer[1],
            end = endUser + 1 + buffer[endUser];
          if (buffer.length < end) return;
          const accepted =
            buffer.subarray(2, endUser).toString() === "fixture-user" &&
            buffer.subarray(endUser + 1, end).toString() === "fixture-password";
          buffer = buffer.subarray(end);
          seen.auth.push({ accepted });
          socket.write(Buffer.from([1, accepted ? 0 : 1]));
          if (!accepted) return socket.end();
          phase = 2;
        }
        if (phase !== 2 || buffer.length < 5) return;
        const length = buffer[3] === 3 ? 1 + buffer[4] : buffer[3] === 1 ? 4 : 16;
        if (buffer.length < 6 + length) return;
        const host = buffer[3] === 3 ? buffer.subarray(5, 5 + buffer[4]).toString() : "rejected-ip";
        const port = buffer.readUInt16BE(4 + length);
        seen[label].push({ host, port });
        if (host !== "ipwho.is" || port !== 443)
          return socket.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0]));
        phase = 3;
        socket.removeListener("data", receive);
        tunnel(socket, () => socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])));
      };
      socket.on("data", receive);
    });
    servers.push(server);
    return listen(server);
  }
  const a = await socks("a", false),
    b = await socks("b", false),
    auth = await socks("auth", true);
  const httpProxy = http.createServer((_req, res) => {
    res.writeHead(403);
    res.end();
  });
  httpProxy.on("connection", track);
  httpProxy.on("connect", (request, socket) => {
    seen.http.push(request.url);
    if (request.url !== "ipwho.is:443") return socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    tunnel(socket, () => socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"));
  });
  servers.push(httpProxy);
  const httpPort = await listen(httpProxy);
  const unused = net.createServer();
  const closedPort = await listen(unused);
  await new Promise((resolve) => unused.close(resolve));
  return {
    a,
    b,
    auth,
    http: httpPort,
    closedPort,
    seen,
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    },
  };
}
