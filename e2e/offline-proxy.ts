import { createServer, request } from "node:http";
import { connect, type Socket } from "node:net";

// WebKit's native offline emulation rejects even cached SW navigations on Linux.
// Cut the browser's actual upstream connections instead, including worker fetches.
export async function offlineProxy() {
  let offline = false;
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    if (sockets.has(socket)) return socket;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };
  const server = createServer((incoming, outgoing) => {
    if (offline) { incoming.socket.destroy(); return; }
    const url = new URL(incoming.url!);
    const upstream = request(url, { method: incoming.method, headers: incoming.headers }, response => {
      outgoing.writeHead(response.statusCode!, response.headers);
      response.pipe(outgoing);
    });
    upstream.on("socket", track);
    upstream.on("error", () => outgoing.destroy());
    outgoing.on("close", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  server.on("connection", track);
  server.on("connect", (incoming, client, head) => {
    if (offline) { client.destroy(); return; }
    const url = new URL(`http://${incoming.url}`);
    const upstream = track(connect(Number(url.port) || 443, url.hostname));
    upstream.on("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Offline proxy did not bind");
  return {
    server: `http://127.0.0.1:${address.port}`,
    setOffline(value: boolean) {
      offline = value;
      if (value) for (const socket of sockets) socket.destroy();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  };
}
