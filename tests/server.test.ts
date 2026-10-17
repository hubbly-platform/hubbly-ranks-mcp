import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { startServer } from "../src/server.js";

const TOKEN = `hbr_${"0".repeat(32)}_${"1".repeat(32)}_${"a".repeat(43)}`;

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("HTTP MCP denies anonymous callers and registers no unadvertised tools", async () => {
  let gatewayCalls = 0;
  let revoked = false;
  let available: unknown[] = [];
  const gateway = createServer((request, response) => {
    gatewayCalls += 1;
    assert.equal(request.url, "/v1/agent/capabilities");
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
    if (revoked) { response.writeHead(401).end(); return; }
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ available }));
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const address = gateway.address();
  if (!address || typeof address === "string") throw new Error("No gateway address");
  const mcpPort = address.port + 1;
  process.env.RANK_API_URL = `http://127.0.0.1:${address.port}`;
  process.env.PORT = String(mcpPort);
  process.env.MCP_PUBLIC_HOST = `127.0.0.1:${mcpPort}`;
  const mcp = startServer();
  try {
    await new Promise<void>((resolve) => mcp.once("listening", resolve));
    const endpoint = `http://127.0.0.1:${mcpPort}/mcp`;
    const anonymous = await fetch(endpoint, { method: "POST" });
    assert.equal(anonymous.status, 401);
    assert.equal(gatewayCalls, 0);
    const badOrigin = await fetch(endpoint, {
      method: "POST", headers: { Origin: "https://evil.example", Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(badOrigin.status, 403);
    assert.equal(gatewayCalls, 0);
    const initialized = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
        protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" },
      } }),
    });
    assert.equal(initialized.status, 200, await initialized.text());
    assert.equal(gatewayCalls, 1);
    const listed = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    assert.equal(listed.status, 200);
    const listBody = await listed.text();
    assert.match(listBody, /Method not found/); // SDK omits tools/list when no tools exist.
    available = [{ command: "rank", method: "GET", path: "/v1/agent/status" }];
    const advertisedList = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
    });
    assert.equal(advertisedList.status, 200);
    assert.match(await advertisedList.text(), /"name":"rank"/);
    revoked = true;
    const afterRevoke = await fetch(endpoint, {
      method: "POST", headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(afterRevoke.status, 401);
    assert.equal(gatewayCalls, 4);
  } finally {
    await close(mcp);
    await close(gateway);
  }
});
