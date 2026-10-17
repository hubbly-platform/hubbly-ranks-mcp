import assert from "node:assert/strict";
import test from "node:test";
import { CATALOG, enabledCatalog } from "../src/catalog.js";
import { gatewayOrigin } from "../src/gateway.js";

test("catalog has exactly twelve unique Rank commands", () => {
  assert.equal(CATALOG.length, 12);
  assert.equal(new Set(CATALOG.map((entry) => entry.command)).size, 12);
});

test("only exact advertised read contracts become tools", () => {
  assert.deepEqual(enabledCatalog({ available: [] }), []);
  assert.deepEqual(enabledCatalog({ available: [
    { command: "rank", method: "GET", path: "/v1/agent/status" },
    { command: "rank-health", method: "GET", path: "/wrong" },
    { command: "rank-write", method: "POST", path: "/v1/agent/sites/{id}/drafts" },
  ] }).map((entry) => entry.command), ["rank"]);
  assert.throws(() => enabledCatalog({}), /Malformed/);
});

test("gateway URL rejects credentials and non-loopback plaintext", () => {
  assert.equal(gatewayOrigin("https://api.example.com"), "https://api.example.com");
  assert.equal(gatewayOrigin("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.throws(() => gatewayOrigin("http://api.example.com"));
  assert.throws(() => gatewayOrigin("https://user:pass@api.example.com"));
});
