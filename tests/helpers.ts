import { createServer, type Server } from "node:http";

export const TOKEN = `hbr_${"0".repeat(32)}_${"1".repeat(32)}_${"a".repeat(43)}`;

export function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

export async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

export function waitForListening(server: Server): Promise<void> {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
}

export async function freePort(): Promise<number> {
  const probe = createServer();
  await listen(probe);
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("No probe address");
  const port = address.port;
  await close(probe);
  return port;
}
