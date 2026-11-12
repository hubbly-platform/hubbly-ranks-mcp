import { gatewayOrigin } from "./gateway.js";

export type ServerConfig = {
  origin: string;
  port: number;
  listenHost: string;
  publicHost: string;
  allowedOrigins: ReadonlySet<string>;
  logRequests: boolean;
};

const PUBLIC_HOST = /^(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)(?::(\d{1,5}))?$/;

function normalizedHost(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, "");
}

export function isLoopbackHost(value: string): boolean {
  const host = normalizedHost(value);
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function parsePort(value: string): number {
  if (!/^[0-9]+$/.test(value)) throw new Error("PORT must be an integer from 1 to 65535");
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer from 1 to 65535");
  }
  return port;
}

export function normalizePublicHost(value: string): string {
  const host = value.trim().toLowerCase();
  const match = PUBLIC_HOST.exec(host);
  if (!match) throw new Error("MCP_PUBLIC_HOST must be a hostname with an optional port");
  const port = match[1];
  if (port && (Number(port) < 1 || Number(port) > 65535)) {
    throw new Error("MCP_PUBLIC_HOST contains an invalid port");
  }
  return host;
}

function parseOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("MCP_ALLOWED_ORIGINS contains an invalid origin");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && isLoopbackHost(url.hostname)))) {
    throw new Error("MCP_ALLOWED_ORIGINS must contain HTTPS origins or loopback HTTP origins");
  }
  return url.origin;
}

function parseAllowedOrigins(value: string): ReadonlySet<string> {
  const origins = new Set<string>();
  for (const part of value.split(",")) {
    const candidate = part.trim();
    if (candidate) origins.add(parseOrigin(candidate));
  }
  return origins;
}

function parseBoolean(value: string, name: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off", ""].includes(normalized)) return false;
  throw new Error(`${name} must be true or false`);
}

function defaultPublicHost(listenHost: string, port: number): string {
  const host = listenHost.includes(":") ? `[${normalizedHost(listenHost)}]` : listenHost;
  return normalizePublicHost(`${host}:${port}`);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): ServerConfig {
  const rawOrigin = env.RANK_API_URL?.trim();
  if (!rawOrigin) throw new Error("RANK_API_URL is required");

  const port = parsePort((env.PORT ?? "3333").trim());
  const listenHost = normalizedHost(env.MCP_LISTEN_HOST ?? "127.0.0.1");
  if (!listenHost || /[\s/?#@]/.test(listenHost)) {
    throw new Error("MCP_LISTEN_HOST must be a valid bind address");
  }

  const configuredPublicHost = env.MCP_PUBLIC_HOST?.trim();
  if (!configuredPublicHost && !isLoopbackHost(listenHost)) {
    throw new Error("MCP_PUBLIC_HOST is required for a non-loopback MCP_LISTEN_HOST");
  }
  const publicHost = configuredPublicHost
    ? normalizePublicHost(configuredPublicHost)
    : defaultPublicHost(listenHost, port);

  const allowedOrigins = parseAllowedOrigins(env.MCP_ALLOWED_ORIGINS ?? "");
  if (!isLoopbackHost(listenHost) && allowedOrigins.size === 0) {
    throw new Error("MCP_ALLOWED_ORIGINS is required for a non-loopback MCP_LISTEN_HOST");
  }

  return {
    origin: gatewayOrigin(rawOrigin),
    port,
    listenHost,
    publicHost,
    allowedOrigins,
    logRequests: parseBoolean(env.MCP_LOG_REQUESTS ?? "true", "MCP_LOG_REQUESTS"),
  };
}
