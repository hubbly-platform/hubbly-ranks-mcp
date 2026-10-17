# Hubbly Ranks MCP

Clean-room, MIT-licensed Streamable HTTP adapter for Hubbly Rank. It is a thin client of the private `/v1/agent/*` gateway, not an alternative authorization or execution path. A per-request capability check determines which read tools exist. The three write commands stay disabled until the gateway and client implement tested payload-bound preview/confirm and approval handling. When the gateway advertises no catalog routes, no tools are registered.

## Run locally

Use Node 20+ and run `npm ci && npm run build && npm start`. Configure:

| Variable | Purpose |
| --- | --- |
| `RANK_API_URL` | Official HTTPS API origin; loopback HTTP only for tests |
| `PORT` | Listener port, default `3333` |
| `MCP_LISTEN_HOST` | Bind address, default `127.0.0.1` |
| `MCP_PUBLIC_HOST` | Exact expected HTTP Host header, including port |
| `MCP_ALLOWED_ORIGINS` | Comma-separated browser origins; required for non-loopback bind |

Mount `/mcp` behind an HTTPS reverse proxy for remote use and set `MCP_PUBLIC_HOST` to the public Host header it forwards. The service accepts a workspace-scoped `Authorization: Bearer <Rank API key>` header. It never returns or logs the key, and it asks the gateway to reauthenticate on every MCP request, so server-side revocation is effective on the next request. Origin and Host are checked before key use. Limit deployment access and TLS termination appropriately; this repository does not provide OAuth token issuance, hosting, or a dashboard Settings screen.

## Current scope

The adapter contains the twelve-command contract but registers only exact advertised read operations. It cannot make missing gateway routes work. It does not implement CMS publishing, approvals, client write confirmations, or `/rank-update`; it never reaches Rank jobs directly. Goldworth is read-only. A successful local test does not certify Claude Desktop or Cursor compatibility or a production deployment; those remain release gates.

Run `npm run build && npm test` before changes. The tests cover catalog parity, fail-closed advertisement, basic Streamable HTTP handshake, Origin rejection, and revocation on the next request. No real workspace key is needed.
