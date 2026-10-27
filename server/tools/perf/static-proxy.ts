import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import * as fs from "node:fs/promises";
import path from "node:path";

/** Local test fixture only: real HTTP preserves Chromium's loopback address
 * space. CDP synthetic documents are blocked by Local Network Access checks.
 * WebSocket bytes, negotiation, and backpressure pass through unchanged.
 */
export async function staticProxy(root: string, port = 19090, upstreamPort = 8080) {
  const sockets = new Set<Socket>();
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
      const file = path.resolve(root, pathname === "/" ? "index.html" : "." + pathname);
      if (!file.startsWith(path.resolve(root) + path.sep)) throw Error("invalid_static_path");
      const bytes = await fs.readFile(file);
      response.setHeader("Content-Type", file.endsWith(".html") ? "text/html" :
        file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "text/javascript" : "application/octet-stream");
      response.setHeader("Cache-Control", "no-store");
      response.end(bytes);
    } catch { response.statusCode = 404; response.end("not_found"); }
  });
  server.on("connection", socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket, head) => {
    if (request.url?.split("?")[0] !== "/api/ws") { socket.destroy(); return; }
    socket.pause();
    const upstream = connect(upstreamPort, "127.0.0.1");
    sockets.add(upstream);
    upstream.on("close", () => { sockets.delete(upstream); socket.destroy(); });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("connect", () => {
      let headers = `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`;
      for (let i = 0; i < request.rawHeaders.length; i += 2) headers += `${request.rawHeaders[i]}: ${request.rawHeaders[i+1]}\r\n`;
      upstream.write(headers + "\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket); socket.resume();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject); server.listen(port, "127.0.0.1", resolve);
  });
  return {
    async close() {
      await Promise.all([...sockets].map(socket => socket.closed ? Promise.resolve() : new Promise<void>(resolve => {
        socket.once("close", () => resolve()); socket.destroy();
      })));
      await new Promise<void>(resolve => server.close(() => resolve()));
      return { port, closed: true, remainingSockets: sockets.size };
    },
  };
}
