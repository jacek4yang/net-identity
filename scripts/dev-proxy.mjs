/**
 * Local test proxy for manual verification.
 *
 * This is a development tool, not part of the extension. It implements the two
 * behaviours needed to check net-identity's proxy engine end to end:
 *
 *   - plain HTTP proxying (absolute-form requests and CONNECT tunnels)
 *   - optional, required Basic authentication, so the challenge path
 *     (`webRequest.onAuthRequired`) and the preemptive path
 *     (`proxyAuthorizationHeader`) can both be exercised
 *
 * Usage:
 *   node scripts/dev-proxy.mjs [--port 8080] [--host 127.0.0.1] [--require-auth user:pass]
 *
 * Then create a profile in net-identity pointing at 127.0.0.1:8080 and activate it.
 * Every request is logged to stderr without credentials.
 */
import http from "node:http";
import net from "node:net";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8080" },
    host: { type: "string", default: "127.0.0.1" },
    "require-auth": { type: "string" },
    offline: { type: "boolean", default: false },
    "offline-target": { type: "string" },
  },
});

const port = Number(values.port);
const host = values.host;
const credentials =
  typeof values["require-auth"] === "string" ? values["require-auth"].split(":") : null;
const expectedAuthorization =
  credentials === null
    ? null
    : `Basic ${Buffer.from(`${credentials[0]}:${credentials[1]}`).toString("base64")}`;

function log(message) {
  console.error(`[dev-proxy] ${message}`);
}

function authorized(request) {
  if (expectedAuthorization === null) return true;
  return request.headers["proxy-authorization"] === expectedAuthorization;
}

function requireAuthentication(response) {
  response.writeHead(407, {
    "proxy-authenticate": 'Basic realm="net-identity dev proxy"',
    "content-length": "0",
  });
  response.end();
}

function forward(request, response) {
  if (!authorized(request)) {
    log(`${request.method} ${request.url} -> 407 (authentication required)`);
    requireAuthentication(response);
    return;
  }

  const target = new URL(request.url ?? "");
  const upstream = http.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: request.method,
      headers: { ...request.headers, host: target.host },
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );

  upstream.on("error", (error) => {
    log(`error forwarding ${request.url}: ${error.message}`);
    response.writeHead(502, { "content-type": "text/plain" });
    response.end("proxy upstream error");
  });

  request.pipe(upstream);
}

const server = http.createServer((request, response) => {
  if (values.offline) {
    response.writeHead(502);
    response.end("offline CONNECT fixture");
    return;
  }
  if (request.url?.startsWith("http://") !== true) {
    response.writeHead(400, { "content-type": "text/plain" });
    response.end("this proxy expects absolute-form requests or CONNECT");
    return;
  }
  log(`${request.method} ${request.url}`);
  forward(request, response);
});

server.on("connect", (request, clientSocket, head) => {
  // In the offline auth fixture only the specified connection is challenged.
  // Firefox background services also use the active proxy; reject those locally
  // without creating unrelated native auth dialogs or any upstream connection.
  if (
    values.offline &&
    values["offline-target"] !== undefined &&
    request.url !== values["offline-target"]
  ) {
    clientSocket.end("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n");
    return;
  }
  if (!authorized(request)) {
    log(`CONNECT ${request.url} -> 407 (authentication required)`);
    clientSocket.end(
      'HTTP/1.1 407 Proxy Authentication Required\r\nproxy-authenticate: Basic realm="net-identity dev proxy"\r\ncontent-length: 0\r\n\r\n',
    );
    return;
  }

  const [targetHost, targetPort] = (request.url ?? "").split(":");
  if (targetHost === undefined || targetPort === undefined) {
    clientSocket.end("HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\n\r\n");
    return;
  }

  log(`CONNECT ${request.url}`);
  if (values.offline) {
    // Test-only CONNECT acceptance: authenticate locally, then end TLS without upstream traffic.
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    clientSocket.once("data", () => clientSocket.destroy());
    clientSocket.on("error", () => clientSocket.destroy());
    return;
  }
  const upstream = net.connect(Number(targetPort), targetHost, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  const destroy = () => {
    upstream.destroy();
    clientSocket.destroy();
  };
  upstream.on("error", destroy);
  clientSocket.on("error", destroy);
  upstream.setTimeout(120000, destroy);
});

server.listen(port, host, () => {
  log(
    `listening on ${host}:${port}${credentials === null ? " (no authentication)" : ` (requires ${credentials[0]}:****)`}`,
  );
});
