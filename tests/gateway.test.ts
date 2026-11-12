import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { GatewayError, gatewayRequest } from "../src/gateway.js";
import { close, TOKEN } from "./helpers.js";

test("gateway requests reject redirects without forwarding the bearer token", async () => {
  let redirectedCalls = 0;
  const redirected = createServer((_request, response) => {
    redirectedCalls += 1;
    response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
  });
  await new Promise<void>((resolve) => redirected.listen(0, "127.0.0.1", resolve));
  const redirectedAddress = redirected.address();
  if (!redirectedAddress || typeof redirectedAddress === "string") throw new Error("No address");

  const redirecting = createServer((_request, response) => {
    response.writeHead(302, { Location: `http://127.0.0.1:${redirectedAddress.port}/steal` }).end();
  });
  await new Promise<void>((resolve) => redirecting.listen(0, "127.0.0.1", resolve));
  const address = redirecting.address();
  if (!address || typeof address === "string") throw new Error("No address");

  try {
    await assert.rejects(
      gatewayRequest(`http://127.0.0.1:${address.port}`, TOKEN, "GET", "/redirect"),
      /fetch failed|redirect/i,
    );
    assert.equal(redirectedCalls, 0);
  } finally {
    await close(redirecting);
    await close(redirected);
  }
});

test("gateway requests reject non-JSON success responses", async () => {
  let authorization = "";
  let accept = "";
  let userAgent = "";
  const gateway = createServer((request, response) => {
    authorization = request.headers.authorization ?? "";
    accept = request.headers.accept ?? "";
    userAgent = request.headers["user-agent"] ?? "";
    response.writeHead(200, { "Content-Type": "text/html" }).end("<html>not json</html>");
  });
  await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const address = gateway.address();
  if (!address || typeof address === "string") throw new Error("No address");

  try {
    await assert.rejects(
      gatewayRequest(`http://127.0.0.1:${address.port}`, TOKEN, "GET", "/v1/agent/status"),
      (error: unknown) => error instanceof GatewayError && error.status === 502,
    );
    assert.equal(authorization, `Bearer ${TOKEN}`);
    assert.equal(accept, "application/json");
    assert.match(userAgent, /^hubbly-ranks-mcp\//);
  } finally {
    await close(gateway);
  }
});
