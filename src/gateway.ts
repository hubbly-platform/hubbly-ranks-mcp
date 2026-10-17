import { enabledCatalog, type CatalogEntry, type Method } from "./catalog.js";

export class GatewayError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export function gatewayOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) {
    throw new Error("RANK_API_URL must be an HTTPS origin or loopback test origin");
  }
  return url.origin;
}

export async function gatewayRequest(origin: string, token: string, method: Method, path: string, payload?: unknown): Promise<unknown> {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(payload === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new GatewayError(response.status, `Rank gateway returned HTTP ${response.status}`);
  try { return await response.json(); }
  catch { throw new GatewayError(502, "Malformed Rank gateway response"); }
}

export async function authorizedCatalog(origin: string, token: string): Promise<CatalogEntry[]> {
  const body = await gatewayRequest(origin, token, "GET", "/v1/agent/capabilities");
  return enabledCatalog(body);
}
