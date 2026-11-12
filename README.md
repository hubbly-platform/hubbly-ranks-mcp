# Hubbly Ranks MCP

Clean-room, MIT-licensed Streamable HTTP adapter for Hubbly Rank. It is a thin client of the private `/v1/agent/*` gateway, not an alternative authorization or execution path. A per-request capability check determines which read tools exist. The three write commands stay disabled until the gateway and client implement tested payload-bound preview/confirm and approval handling. When the gateway advertises no catalog routes, no tools are registered.

## Run locally

Use Node 20+ and run `npm ci && npm run build && npm start`. Configure:

| Variable | Purpose |
| --- | --- |
| `RANK_API_URL` | Official HTTPS API origin; loopback HTTP only for tests |
| `PORT` | Listener port, default `3333` |
| `MCP_LISTEN_HOST` | Bind address, default `127.0.0.1` |
| `MCP_PUBLIC_HOST` | Exact expected HTTP Host header, including any port; required for non-loopback binds |
| `MCP_ALLOWED_ORIGINS` | Comma-separated exact browser origins; required for non-loopback binds |
| `MCP_LOG_REQUESTS` | JSON request logs to stderr, default `true`; set `false` to disable |

Mount `/mcp` behind an HTTPS reverse proxy for remote use and set `MCP_PUBLIC_HOST` to the public Host header it forwards. The default loopback bind expects the Host header `127.0.0.1:3333`; set `MCP_PUBLIC_HOST` if you connect through another local name. The service accepts a workspace-scoped `Authorization: Bearer <Rank API key>` header. It never returns or logs the key, and it asks the gateway to reauthenticate on every MCP request, so server-side revocation is effective on the next request. Origin and Host are checked before key use. Limit deployment access and TLS termination appropriately; this repository does not provide OAuth token issuance or hosting.

The adapter rejects non-loopback startup unless both `MCP_PUBLIC_HOST` and at least one `MCP_ALLOWED_ORIGINS` value are set. Allowed browser origins get a CORS preflight response for `/mcp`; native clients that send no `Origin` continue to work. `/healthz` is an unauthenticated liveness endpoint for the load balancer and returns only `{"status":"ok"}`. It is intentionally exempt from Host/Origin checks.

Operational behavior:

- Only `/mcp` serves MCP traffic; other paths return `404`.
- Requests are limited to 1 MiB and oversized POST bodies receive `413`.
- Authentication failures return `401` with `WWW-Authenticate: Bearer`; gateway auth and rate-limit failures return `401`, `403`, or `429`; gateway or parsing failures return `502`/`503`.
- Responses carry `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`.
- Outbound gateway requests reject redirects, require JSON responses, and time out after 30 seconds.
- `SIGTERM` and `SIGINT` drain idle connections, then force-close remaining connections after 10 seconds.
- Request logs contain method, path, status, duration, and abort state. Bearer tokens and request bodies are never logged.

## Connect a client

Create a key in Rank under Settings → API keys, copy it once, and configure the
client's Streamable HTTP MCP transport:

- URL: `https://<your-mcp-host>/mcp`
- Header: `Authorization: Bearer hbr_...`

Codex, Claude, and Cursor can all attach custom headers to an HTTP MCP server;
keep the key in the client's secret store rather than in a URL or checked-in
config. The server re-reads capabilities and re-authenticates on every request,
so a revoked key fails on the next call and newly enabled read tools appear
without a restart. If the client sends an `Origin`, add that exact origin to
`MCP_ALLOWED_ORIGINS`; the server handles the corresponding CORS preflight. The
MCP server deliberately exposes no OAuth flow.

Capability validation and each tool call both authenticate with the gateway, so
an MCP tool call can consume two of the key's per-minute rate-limit units. Size
key limits and reverse-proxy limits for expected agent bursts.

The `rank-scan` tool accepts only an `https://` homepage URL and rejects
embedded credentials; the Rank gateway enforces public-address scanning.
Competitor comparison remains unavailable in this phase.

## Current scope

The adapter contains the twelve-command contract but registers only exact advertised read operations. It cannot make missing gateway routes work. It does not implement CMS publishing, approvals, client write confirmations, or `/rank-update`; it never reaches Rank jobs directly. This adapter is read-only.

Run `npm run build && npm test` before changes. The tests cover catalog parity, fail-closed advertisement, Streamable HTTP `2025-11-25` and `2025-06-18` handshakes, authentication, exact Host enforcement, read-tool registration and annotations, CORS preflight and successful responses, health, oversized-body rejection, revoked-key behavior, gateway redirects, and rate-limit/malformed-response mapping. No real workspace key is needed.

The CI workflow template is in `docs/ci-workflow-template.yml`. It is not active because the publishing credential lacks GitHub's `workflow` scope; a maintainer must move it to `.github/workflows/ci.yml` with an authorized credential.

## Production release gates

A successful local test does not certify Claude Desktop or Cursor compatibility or a production deployment. Before release:

1. Run real Codex, Claude, and Cursor smoke tests against an HTTPS deployment.
2. Terminate TLS at a reverse proxy, forward the public Host header, and keep the MCP listener on a private interface.
3. Set `RANK_API_URL`, `MCP_PUBLIC_HOST`, and `MCP_ALLOWED_ORIGINS`; verify a revoked key fails on the next call.
4. Confirm `/healthz` probes, log collection, graceful shutdown, and proxy request/rate limits.
5. Activate the CI workflow with a credential that has GitHub's `workflow` scope.
