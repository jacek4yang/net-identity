/** Optional store capture only: a bounded loopback CONNECT tunnel to one map
 * origin. TLS stays end-to-end. No credentials or arbitrary proxy destinations.
 */
import http from "node:http";
import net from "node:net";

export const isMapAuthority = (authority) => authority === "tiles.openfreemap.org:443";
export const PROXY_LIMITS = Object.freeze({
  connections: 32,
  idleMs: 30_000,
  headerMs: 5000,
  requestMs: 10_000,
  maxHeaderBytes: 8192,
});

export async function createLiveMapProxy(port = 0) {
  const inbound = new Set();
  const upstreams = new Set();
  let accepted = 0,
    rejected = 0,
    closing = false;
  let closePromise;
  const server = http.createServer(
    {
      maxHeaderSize: PROXY_LIMITS.maxHeaderBytes,
      headersTimeout: PROXY_LIMITS.headerMs,
      requestTimeout: PROXY_LIMITS.requestMs,
      connectionsCheckingInterval: 1000,
      keepAliveTimeout: 1000,
    },
    (_request, response) => {
      rejected++;
      response.writeHead(403, { Connection: "close" }).end();
    },
  );
  server.maxConnections = PROXY_LIMITS.connections;
  server.on("connection", (socket) => {
    if (closing || inbound.size >= PROXY_LIMITS.connections) {
      socket.destroy();
      return;
    }
    inbound.add(socket);
    const headerDeadline = setTimeout(() => socket.destroy(), PROXY_LIMITS.headerMs);
    socket.captureHeaderDeadline = headerDeadline;
    socket.setTimeout(PROXY_LIMITS.idleMs, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      clearTimeout(headerDeadline);
      inbound.delete(socket);
    });
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("connect", (request, client, head) => {
    clearTimeout(client.captureHeaderDeadline);
    if (closing || !isMapAuthority(request.url)) {
      rejected++;
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      // Do not depend on an untrusted client acknowledging a half-close.
      client.setTimeout(1000, () => client.destroy());
      return;
    }
    accepted++;
    const upstream = net.connect({ host: "tiles.openfreemap.org", port: 443 });
    upstreams.add(upstream);
    const stop = () => {
      client.destroy();
      upstream.destroy();
      upstreams.delete(upstream);
    };
    upstream.setTimeout(PROXY_LIMITS.idleMs, stop);
    client.on("error", stop);
    upstream.on("error", stop);
    client.on("close", stop);
    upstream.on("close", stop);
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  } catch (error) {
    for (const socket of inbound) socket.destroy();
    for (const socket of upstreams) socket.destroy();
    server.close();
    throw error;
  }
  const address = server.address();
  return {
    port: address.port,
    counts: () => ({ accepted, rejected }),
    activeConnections: () => inbound.size,
    close: () => {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = new Promise((resolve) => server.close(resolve));
      for (const socket of inbound) socket.destroy();
      for (const socket of upstreams) socket.destroy();
      server.closeAllConnections();
      return closePromise;
    },
  };
}
