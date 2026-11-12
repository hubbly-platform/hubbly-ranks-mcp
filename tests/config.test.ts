import assert from "node:assert/strict";
import test from "node:test";
import { isLoopbackHost, loadConfig, normalizePublicHost } from "../src/config.js";

test("loopback defaults are complete and safe", () => {
  const config = loadConfig({ RANK_API_URL: "https://rank.example.com" });
  assert.equal(config.origin, "https://rank.example.com");
  assert.equal(config.port, 3333);
  assert.equal(config.listenHost, "127.0.0.1");
  assert.equal(config.publicHost, "127.0.0.1:3333");
  assert.deepEqual([...config.allowedOrigins], []);
  assert.equal(config.logRequests, true);
});

test("public hosts and origins are normalized without accepting paths or credentials", () => {
  const config = loadConfig({
    RANK_API_URL: "https://rank.example.com/",
    PORT: "8443",
    MCP_PUBLIC_HOST: " MCP.Example.COM:8443 ",
    MCP_ALLOWED_ORIGINS: " https://App.Example.com , http://localhost:3000 ",
    MCP_LOG_REQUESTS: "false",
  });
  assert.equal(config.publicHost, "mcp.example.com:8443");
  assert.deepEqual([...config.allowedOrigins].sort(), [
    "http://localhost:3000",
    "https://app.example.com",
  ]);
  assert.equal(config.logRequests, false);
});

test("non-loopback binds require an explicit public host and allowed origins", () => {
  const base = { RANK_API_URL: "https://rank.example.com", MCP_LISTEN_HOST: "0.0.0.0" };
  assert.throws(() => loadConfig(base), /MCP_PUBLIC_HOST/);
  assert.throws(
    () => loadConfig({ ...base, MCP_PUBLIC_HOST: "mcp.example.com" }),
    /MCP_ALLOWED_ORIGINS/,
  );
  assert.equal(
    loadConfig({
      ...base,
      MCP_PUBLIC_HOST: "mcp.example.com",
      MCP_ALLOWED_ORIGINS: "https://app.example.com",
    }).publicHost,
    "mcp.example.com",
  );
});

test("IPv6 loopback gets a bracketed default public host", () => {
  const config = loadConfig({ RANK_API_URL: "https://rank.example.com", MCP_LISTEN_HOST: "::1" });
  assert.equal(config.publicHost, "[::1]:3333");
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("[::1]"), true);
  assert.equal(normalizePublicHost("[::1]:8443"), "[::1]:8443");
});

test("invalid ports, hosts, origins, and booleans fail closed", () => {
  const base = { RANK_API_URL: "https://rank.example.com" };
  for (const port of ["0", "65536", "3.5", "abc"]) {
    assert.throws(() => loadConfig({ ...base, PORT: port }), /PORT/);
  }
  for (const host of ["https://mcp.example.com", "mcp.example.com/path", "bad host"]) {
    assert.throws(() => loadConfig({ ...base, MCP_PUBLIC_HOST: host }), /MCP_PUBLIC_HOST/);
  }
  assert.throws(() => loadConfig({ ...base, MCP_PUBLIC_HOST: "example.com:0" }), /port/);
  for (const origin of ["http://app.example.com", "https://user:pass@app.example.com", "https://app.example.com/path"]) {
    assert.throws(() => loadConfig({ ...base, MCP_ALLOWED_ORIGINS: origin }), /MCP_ALLOWED_ORIGINS/);
  }
  assert.throws(() => loadConfig({ ...base, MCP_LOG_REQUESTS: "maybe" }), /MCP_LOG_REQUESTS/);
  assert.throws(() => loadConfig({}), /RANK_API_URL/);
  assert.throws(() => normalizePublicHost(""), /MCP_PUBLIC_HOST/);
});
