import {
  createServer,
  type OutgoingHttpHeader,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { pathToFileURL } from "node:url";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import * as z from "zod/v4";
import { loadConfig, type ServerConfig } from "./config.js";
import type { CatalogEntry } from "./catalog.js";
import { authorizedCatalog, gatewayRequest, GatewayError } from "./gateway.js";

const UUID = z.uuid();
const SCAN_URL = z.url()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch {
      return false;
    }
  }, "Scan URL must be an HTTPS URL without credentials");

const TOKEN = /^hbr_[0-9a-f]{32}_[0-9a-f]{32}_[A-Za-z0-9_-]{43}$/;
const MAX_REQUEST_BODY_BYTES = 1_048_576;

const TOOL_DETAILS: Record<string, { title: string; description: string }> = {
  rank: {
    title: "Rank overview",
    description: "Read the workspace Rank overview, work queue, and policy.",
  },
  "rank-setup": {
    title: "Rank connections",
    description: "List connected websites and their Search Console connection state.",
  },
  "rank-scan": {
    title: "Scan homepage",
    description: "Scan a public HTTPS homepage and return on-page signals; no competitor comparison.",
  },
  "rank-health": {
    title: "Site health",
    description: "Read a website's Rank health: audit, scorecard, and open fixes.",
  },
  "rank-opportunities": {
    title: "Site opportunities",
    description: "Read keyword opportunities and the current plan for a website.",
  },
  "rank-visibility": {
    title: "AI visibility",
    description: "Read a website's AI visibility results.",
  },
  "rank-plan": {
    title: "Site plan",
    description: "Read a website's current Rank plan.",
  },
  "rank-reviews": {
    title: "Site reviews",
    description: "Read customer reviews tracked for a website.",
  },
  "rank-report": {
    title: "Site report",
    description: "Read a website's latest report, recent changes, and search performance.",
  },
};

function logJson(event: Record<string, unknown>): void {
  console.error(JSON.stringify({ timestamp: new Date().toISOString(), ...event }));
}

function reportError(error: unknown): void {
  const normalized = error instanceof Error ? error : new Error(String(error));
  logJson({ event: "error", name: normalized.name, message: normalized.message });
}

function toolError(error: unknown) {
  let message = "Rank gateway unavailable";
  if (error instanceof GatewayError) {
    if (error.status === 401) {
      message = "Rank API key was rejected. Replace it in Settings > API keys.";
    } else if (error.status === 403) {
      message = "Rank API key does not have read access.";
    } else if (error.status === 429) {
      message = "Rank API key rate limit exceeded. Retry later.";
    } else {
      message = `Rank gateway returned HTTP ${error.status}.`;
    }
  }
  return { isError: true as const, content: [{ type: "text" as const, text: message }] };
}

function makeMcpServer(entries: CatalogEntry[], origin: string, token: string): McpServer {
  const server = new McpServer({ name: "hubbly-ranks-mcp", version: "0.1.0" });
  for (const entry of entries) {
    const details = TOOL_DETAILS[entry.command] ?? {
      title: entry.command,
      description: "Governed Hubbly Rank read operation.",
    };
    const needsId = entry.path.includes("{id}");
    const inputSchema = entry.command === "rank-scan"
      ? z.object({ url: SCAN_URL })
      : needsId ? z.object({ id: UUID }) : z.object({});
    server.registerTool(entry.command, {
      title: details.title,
      description: details.description,
      inputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: entry.method === "GET",
        openWorldHint: entry.command === "rank-scan",
      },
    }, async (args) => {
      const id = "id" in args ? String(args.id) : "";
      const path = needsId ? entry.path.replace("{id}", id) : entry.path;
      try {
        const result = await gatewayRequest(origin, token, entry.method, path,
          entry.command === "rank-scan" ? { url: args.url } : undefined);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return toolError(error);
      }
    });
  }
  return server;
}

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Vary": "Origin",
} as const;

function commonHeaders(response: ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
  const originalWriteHead = response.writeHead.bind(response);
  response.writeHead = ((
    statusCode: number,
    statusMessageOrHeaders?: string | OutgoingHttpHeaders | OutgoingHttpHeader[],
    maybeHeaders?: OutgoingHttpHeaders | OutgoingHttpHeader[],
  ) => {
    const withSecurity = (headers?: OutgoingHttpHeaders | OutgoingHttpHeader[]) =>
      Array.isArray(headers) ? headers : { ...headers, ...SECURITY_HEADERS };
    if (typeof statusMessageOrHeaders === "string") {
      return originalWriteHead(statusCode, statusMessageOrHeaders, withSecurity(maybeHeaders));
    }
    return originalWriteHead(statusCode, withSecurity(statusMessageOrHeaders));
  }) as ServerResponse["writeHead"];
}

function respondJson(response: ServerResponse, status: number, body: unknown,
  headers: Record<string, string> = {}): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(body));
}

function originOf(value: string): string | null {
  try {
    const origin = new URL(value).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

function errorCode(status: number): string {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate_limited";
  if (status === 502) return "bad_gateway";
  return "gateway_unavailable";
}

export function startServer(config: ServerConfig = loadConfig()): Server {
  const httpServer = createServer(async (request, response) => {
    const started = Date.now();
    let logged = false;
    const logRequest = () => {
      if (logged) return;
      logged = true;
      if (!config.logRequests) return;
      logJson({
        event: "request",
        method: request.method,
        path: request.url,
        status: response.statusCode,
        duration_ms: Date.now() - started,
        aborted: !response.writableFinished,
      });
    };
    response.once("finish", logRequest);
    response.once("close", logRequest);

    commonHeaders(response);

    if ((request.method === "GET" || request.method === "HEAD") && request.url === "/healthz") {
      const body = JSON.stringify({ status: "ok" });
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
      });
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }

    const host = request.headers.host?.toLowerCase();
    if (!host || host !== config.publicHost) {
      respondJson(response, 403, { error: "forbidden" });
      return;
    }

    let origin: string | null = null;
    if (request.headers.origin) {
      origin = originOf(request.headers.origin);
      if (!origin || !config.allowedOrigins.has(origin)) {
        respondJson(response, 403, { error: "forbidden" });
        return;
      }
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, MCP-Protocol-Version");
    }

    if (request.url !== "/mcp") {
      respondJson(response, 404, { error: "not_found" });
      return;
    }

    if (request.method === "OPTIONS") {
      if (!origin) {
        response.writeHead(405, { Allow: "OPTIONS, POST, GET, DELETE" }).end();
        return;
      }
      response.writeHead(204, {
        "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, MCP-Protocol-Version, MCP-Method, MCP-Name, Mcp-Session-Id, Last-Event-ID",
        "Access-Control-Max-Age": "600",
      }).end();
      return;
    }

    const authorization = request.headers.authorization ?? "";
    const separator = authorization.indexOf(" ");
    const scheme = separator === -1 ? "" : authorization.slice(0, separator);
    const token = separator === -1 ? "" : authorization.slice(separator + 1);
    if (scheme.toLowerCase() !== "bearer" || !TOKEN.test(token)) {
      respondJson(response, 401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
      return;
    }

    try {
      const entries = await authorizedCatalog(config.origin, token);
      const handler = createMcpHandler(() => makeMcpServer(entries, config.origin, token), {
        maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
        onerror: reportError,
      });
      try {
        await toNodeHandler(handler, {
          maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
          onerror: reportError,
        })(request, response);
      } finally {
        await handler.close();
      }
    } catch (error) {
      if (!(error instanceof GatewayError && [401, 403, 429].includes(error.status))) {
        reportError(error);
      }
      if (response.headersSent) {
        response.end();
        return;
      }
      const status = error instanceof GatewayError && [401, 403, 429, 502].includes(error.status)
        ? error.status : 503;
      const headers: Record<string, string> = {};
      if (status === 401) headers["WWW-Authenticate"] = "Bearer";
      respondJson(response, status, { error: errorCode(status) }, headers);
    }
  });

  httpServer.headersTimeout = 10_000;
  httpServer.requestTimeout = 35_000;
  httpServer.keepAliveTimeout = 5_000;
  httpServer.maxHeadersCount = 100;
  httpServer.on("clientError", (_error, socket) => {
    if (socket.writable) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    } else {
      socket.destroy();
    }
  });
  httpServer.listen(config.port, config.listenHost, () => {
    if (config.logRequests) {
      logJson({
        event: "listening",
        listen_host: config.listenHost,
        port: config.port,
        public_host: config.publicHost,
        gateway_origin: config.origin,
        allowed_origins: config.allowedOrigins.size,
      });
    }
  });
  return httpServer;
}

export function installShutdown(server: Server): void {
  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    logJson({ event: "shutdown", signal });
    const timer = setTimeout(() => server.closeAllConnections(), 10_000);
    timer.unref();
    server.close(() => {
      clearTimeout(timer);
      if (process.exitCode === undefined) process.exitCode = 0;
    });
    server.closeIdleConnections();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

function main(): void {
  try {
    const server = startServer();
    server.once("error", (error) => {
      reportError(error);
      process.exitCode = 1;
    });
    installShutdown(server);
  } catch (error) {
    reportError(error);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
