import { enabledCatalog, type CatalogEntry, type Method } from "./catalog.js";

const LOOPBACK_HTTP_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class GatewayError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "GatewayError";
  }
}

export function gatewayOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("RANK_API_URL must be an HTTPS origin or loopback test origin");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && LOOPBACK_HTTP_HOSTS.has(url.hostname)))) {
    throw new Error("RANK_API_URL must be an HTTPS origin or loopback test origin");
  }
  return url.origin;
}

export async function gatewayRequest(origin: string, token: string, method: Method, path: string, payload?: unknown): Promise<unknown> {
  const response = await fetch(`${origin}${path}`, {
    method,
    cache: "no-store",
    redirect: "error",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "hubbly-ranks-mcp/0.1.0",
      ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new GatewayError(response.status, `Rank gateway returned HTTP ${response.status}`);
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new GatewayError(502, "Rank gateway returned a non-JSON response");
  }
  try { return await response.json(); }
  catch { throw new GatewayError(502, "Malformed Rank gateway response"); }
}

export async function authorizedCatalog(origin: string, token: string): Promise<CatalogEntry[]> {
  const body = await gatewayRequest(origin, token, "GET", "/v1/agent/capabilities");
  return enabledCatalog(body);
}
