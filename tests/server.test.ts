import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";
import { CATALOG } from "../src/catalog.js";
import { loadConfig } from "../src/config.js";
import { startServer } from "../src/server.js";
import { close, freePort, listen, TOKEN, waitForListening } from "./helpers.js";

const WRITE_COMMANDS = ["rank-questions", "rank-write", "rank-publish"];
const READ_ENTRIES = CATALOG.filter((entry) => !WRITE_COMMANDS.includes(entry.command));

function configFor(gatewayPort: number, mcpPort: number, extra: Record<string, string> = {}) {
  return loadConfig({
    RANK_API_URL: `http://127.0.0.1:${gatewayPort}`,
    PORT: String(mcpPort),
    MCP_PUBLIC_HOST: `127.0.0.1:${mcpPort}`,
    MCP_LOG_REQUESTS: "false",
    ...extra,
  });
}

function rpcHeaders(scheme = "Bearer") {
  return {
    Authorization: `${scheme} ${TOKEN}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
}

function rawStatus(port: number, path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = httpRequest({
      host: "127.0.0.1", port, path, method: "GET", agent: false, headers: { Host: host },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    probe.once("error", reject);
    probe.end();
  });
}

test("HTTP MCP enforces auth, exact tools, revocation, and hidden writes", async () => {
  let gatewayCalls = 0;
  let scanCalls = 0;
  let revoked = false;
  let available: unknown[] = [];
  const gateway = createServer((request, response) => {
    gatewayCalls += 1;
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
    if (revoked) { response.writeHead(401).end(); return; }
    if (request.url === "/v1/agent/status") {
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ status: "ready" }));
      return;
    }
    if (request.url === "/v1/agent/scan") {
      scanCalls += 1;
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ accepted: true }));
      return;
    }
    assert.equal(request.url, "/v1/agent/capabilities");
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ available }));
  });
  await listen(gateway);
  const gatewayAddress = gateway.address();
  if (!gatewayAddress || typeof gatewayAddress === "string") throw new Error("No gateway address");

  const mcpPort = await freePort();
  const mcp = startServer(configFor(gatewayAddress.port, mcpPort, {
    MCP_ALLOWED_ORIGINS: "https://app.example.com",
  }));
  try {
    await waitForListening(mcp);
    const endpoint = `http://127.0.0.1:${mcpPort}/mcp`;
    const request = (id: number, method: string, params: unknown, scheme = "Bearer", origin?: string) => fetch(endpoint, {
      method: "POST",
      headers: {
        ...rpcHeaders(scheme),
        ...(origin ? { Origin: origin } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });

    const anonymous = await fetch(endpoint, { method: "POST" });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers.get("www-authenticate"), "Bearer");
    assert.equal(anonymous.headers.get("cache-control"), "no-store");
    assert.equal(anonymous.headers.get("x-content-type-options"), "nosniff");
    assert.equal(gatewayCalls, 0);

    const badOrigin = await fetch(endpoint, {
      method: "POST", headers: { ...rpcHeaders(), Origin: "https://evil.example" },
    });
    assert.equal(badOrigin.status, 403);
    assert.equal(gatewayCalls, 0);

    const initialized = await request(1, "initialize", {
      protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" },
    }, "bearer", "https://app.example.com");
    assert.equal(initialized.status, 200);
    assert.match(await initialized.text(), /2025-11-25/);
    assert.equal(initialized.headers.get("cache-control"), "no-store");
    assert.equal(initialized.headers.get("referrer-policy"), "no-referrer");
    assert.equal(initialized.headers.get("access-control-allow-origin"), "https://app.example.com");
    assert.equal(gatewayCalls, 1);

    const olderInitialize = await request(2, "initialize", {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" },
    });
    assert.equal(olderInitialize.status, 200);
    assert.match(await olderInitialize.text(), /2025-06-18/);

    const emptyList = await request(3, "tools/list", {});
    assert.equal(emptyList.status, 200);
    assert.match(await emptyList.text(), /Method not found/);

    available = [{ command: "rank", method: "GET", path: "/v1/agent/status" }];
    const advertisedList = await request(4, "tools/list", {});
    assert.equal(advertisedList.status, 200);
    assert.match(await advertisedList.text(), /"name":"rank"/);

    const called = await request(5, "tools/call", { name: "rank", arguments: {} });
    assert.equal(called.status, 200);
    assert.match(await called.text(), /ready/);

    available = READ_ENTRIES;
    const readList = await request(6, "tools/list", {});
    assert.equal(readList.status, 200);
    const readBody = await readList.text();
    for (const entry of READ_ENTRIES) assert.match(readBody, new RegExp(`"name":"${entry.command}"`));
    assert.match(readBody, /"readOnlyHint":true/);
    assert.match(readBody, /"destructiveHint":false/);
    assert.match(readBody, /"openWorldHint":true/);
    for (const command of WRITE_COMMANDS) assert.doesNotMatch(readBody, new RegExp(`"name":"${command}"`));

    available = [{ command: "rank-scan", method: "POST", path: "/v1/agent/scan" }];
    const credentialScan = await request(7, "tools/call", {
      name: "rank-scan", arguments: { url: "https://user:pass@example.com" },
    });
    assert.equal(credentialScan.status, 200);
    assert.match(await credentialScan.text(), /Invalid arguments|invalid|credentials/);
    assert.equal(scanCalls, 0);

    const validScan = await request(8, "tools/call", {
      name: "rank-scan", arguments: { url: "https://example.com" },
    });
    assert.equal(validScan.status, 200);
    assert.match(await validScan.text(), /accepted/);
    assert.equal(scanCalls, 1);

    revoked = true;
    const afterRevoke = await fetch(endpoint, {
      method: "POST", headers: { Authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(afterRevoke.status, 401);
    assert.equal(afterRevoke.headers.get("www-authenticate"), "Bearer");
    assert.equal(afterRevoke.headers.get("cache-control"), "no-store");
    assert.equal(gatewayCalls, 11);
  } finally {
    await close(mcp);
    await close(gateway);
  }
});

test("gateway rate limits and malformed responses return safe HTTP errors", async () => {
  let status = 429;
  let contentType = "application/json";
  const gateway = createServer((_request, response) => {
    response.writeHead(status, { "Content-Type": contentType })
      .end(status === 200 ? "{}" : "");
  });
  await listen(gateway);
  const gatewayAddress = gateway.address();
  if (!gatewayAddress || typeof gatewayAddress === "string") throw new Error("No gateway address");

  const mcpPort = await freePort();
  const mcp = startServer(configFor(gatewayAddress.port, mcpPort));
  try {
    await waitForListening(mcp);
    const initialize = () => fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
      method: "POST",
      headers: rpcHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
      }),
    });

    const limited = await initialize();
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: "rate_limited" });
    assert.equal(limited.headers.get("www-authenticate"), null);
    assert.equal(limited.headers.get("cache-control"), "no-store");

    status = 200;
    contentType = "text/html";
    const malformed = await initialize();
    assert.equal(malformed.status, 502);
    assert.deepEqual(await malformed.json(), { error: "bad_gateway" });
  } finally {
    await close(mcp);
    await close(gateway);
  }
});

test("health, CORS preflight, and auth errors do not reach the gateway", async () => {
  let gatewayCalls = 0;
  const gateway = createServer((_request, response) => {
    gatewayCalls += 1;
    response.writeHead(500).end();
  });
  await listen(gateway);
  const gatewayAddress = gateway.address();
  if (!gatewayAddress || typeof gatewayAddress === "string") throw new Error("No gateway address");

  const mcpPort = await freePort();
  const mcp = startServer(configFor(gatewayAddress.port, mcpPort, {
    MCP_ALLOWED_ORIGINS: "https://app.example.com",
  }));
  try {
    await waitForListening(mcp);
    const base = `http://127.0.0.1:${mcpPort}`;

    const health = await fetch(`${base}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });
    assert.equal(health.headers.get("cache-control"), "no-store");
    assert.equal(health.headers.get("x-content-type-options"), "nosniff");

    const head = await fetch(`${base}/healthz`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");

    assert.equal(await rawStatus(mcpPort, "/healthz", "probe.internal"), 200);
    assert.equal(await rawStatus(mcpPort, "/mcp", "evil.example"), 403);

    const preflight = await fetch(`${base}/mcp`, {
      method: "OPTIONS", headers: { Origin: "https://app.example.com" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "https://app.example.com");
    assert.match(preflight.headers.get("access-control-allow-methods") ?? "", /POST/);
    const allowedHeaders = preflight.headers.get("access-control-allow-headers") ?? "";
    assert.match(allowedHeaders, /Authorization/);
    assert.match(allowedHeaders, /MCP-Protocol-Version/);
    assert.match(allowedHeaders, /MCP-Method/);
    assert.equal(preflight.headers.get("access-control-max-age"), "600");

    const disallowed = await fetch(`${base}/mcp`, {
      method: "OPTIONS", headers: { Origin: "https://evil.example" },
    });
    assert.equal(disallowed.status, 403);

    const unauthorized = await fetch(`${base}/mcp`, {
      method: "POST", headers: { Origin: "https://app.example.com" },
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.headers.get("access-control-allow-origin"), "https://app.example.com");

    const noOrigin = await fetch(`${base}/mcp`, { method: "OPTIONS" });
    assert.equal(noOrigin.status, 405);
    assert.equal(gatewayCalls, 0);
  } finally {
    await close(mcp);
    await close(gateway);
  }
});

test("oversized MCP request bodies are rejected before tool dispatch", async () => {
  let gatewayCalls = 0;
  const gateway = createServer((_request, response) => {
    gatewayCalls += 1;
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ available: [] }));
  });
  await listen(gateway);
  const gatewayAddress = gateway.address();
  if (!gatewayAddress || typeof gatewayAddress === "string") throw new Error("No gateway address");

  const mcpPort = await freePort();
  const mcp = startServer(configFor(gatewayAddress.port, mcpPort));
  try {
    await waitForListening(mcp);
    const response = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
      method: "POST",
      headers: rpcHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {}, pad: "x".repeat(1_048_577) }),
    });
    assert.equal(response.status, 413);
    assert.equal(gatewayCalls, 1);
  } finally {
    await close(mcp);
    await close(gateway);
  }
});
