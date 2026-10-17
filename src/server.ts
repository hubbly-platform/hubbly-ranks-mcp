import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import * as z from "zod/v4";
import type { CatalogEntry } from "./catalog.js";
import { authorizedCatalog, gatewayOrigin, gatewayRequest, GatewayError } from "./gateway.js";

const UUID = z.uuid();

function makeMcpServer(entries: CatalogEntry[], origin: string, token: string): McpServer {
  const server = new McpServer({ name: "hubbly-ranks-mcp", version: "0.1.0" });
  for (const entry of entries) {
    const needsId = entry.path.includes("{id}");
    const inputSchema = entry.command === "rank-scan"
      ? z.object({ url: z.url().startsWith("https://") })
      : needsId ? z.object({ id: UUID }) : z.object({});
    server.registerTool(entry.command, {
      description: `Governed Hubbly Rank ${entry.command} operation. Only registered when the gateway advertises its exact contract.`,
      inputSchema,
    }, async (args) => {
      const id = "id" in args ? String(args.id) : "";
      const path = needsId ? entry.path.replace("{id}", id) : entry.path;
      try {
        const result = await gatewayRequest(origin, token, entry.method, path,
          entry.command === "rank-scan" ? { url: args.url } : undefined);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (error) {
        const message = error instanceof GatewayError
          ? `Rank gateway returned HTTP ${error.status}` : "Rank gateway unavailable";
        return { isError: true, content: [{ type: "text" as const, text: message }] };
      }
    });
  }
  return server;
}

export function startServer(): ReturnType<typeof createServer> {
  const origin = gatewayOrigin(process.env.RANK_API_URL ?? "");
  const port = Number(process.env.PORT ?? "3333");
  const listenHost = process.env.MCP_LISTEN_HOST ?? "127.0.0.1";
  const publicHost = process.env.MCP_PUBLIC_HOST ?? `${listenHost}:${port}`;
  const allowedOrigins = new Set((process.env.MCP_ALLOWED_ORIGINS ?? "").split(",").filter(Boolean));
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !publicHost ||
      (listenHost !== "127.0.0.1" && allowedOrigins.size === 0)) {
    throw new Error("Invalid MCP host, port, or Origin configuration");
  }

  const httpServer = createServer(async (request, response) => {
    if (request.headers.host !== publicHost ||
        (request.headers.origin && !allowedOrigins.has(request.headers.origin))) {
      response.writeHead(403).end(); return;
    }
    if (request.url !== "/mcp") { response.writeHead(404).end(); return; }
    const authorization = request.headers.authorization ?? "";
    const match = /^Bearer (hbr_[0-9a-f]{32}_[0-9a-f]{32}_[A-Za-z0-9_-]{43})$/.exec(authorization);
    if (!match) { response.writeHead(401, { "WWW-Authenticate": "Bearer" }).end(); return; }
    const token = match[1]!;
    try {
      const entries = await authorizedCatalog(origin, token);
      const handler = createMcpHandler(() => makeMcpServer(entries, origin, token));
      try { await toNodeHandler(handler)(request, response); }
      finally { await handler.close(); }
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      const status = error instanceof GatewayError && [401, 403, 429].includes(error.status)
        ? error.status : 503;
      response.writeHead(status, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: status === 503 ? "gateway_unavailable" : "unauthorized" }));
    }
  });
  httpServer.listen(port, listenHost);
  return httpServer;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
