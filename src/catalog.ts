export type Method = "GET" | "POST" | "PUT";
export type CatalogEntry = { command: string; method: Method; path: string };

// Only these original clean-room Rank contracts can become MCP tools.
export const CATALOG: readonly CatalogEntry[] = [
  { command: "rank", method: "GET", path: "/v1/agent/status" },
  { command: "rank-setup", method: "GET", path: "/v1/agent/connections" },
  { command: "rank-scan", method: "POST", path: "/v1/agent/scan" },
  { command: "rank-health", method: "GET", path: "/v1/agent/sites/{id}/health" },
  { command: "rank-opportunities", method: "GET", path: "/v1/agent/sites/{id}/opportunities" },
  { command: "rank-visibility", method: "GET", path: "/v1/agent/sites/{id}/ai-visibility" },
  { command: "rank-questions", method: "PUT", path: "/v1/agent/sites/{id}/questions" },
  { command: "rank-plan", method: "GET", path: "/v1/agent/sites/{id}/plan" },
  { command: "rank-write", method: "POST", path: "/v1/agent/sites/{id}/drafts" },
  { command: "rank-publish", method: "POST", path: "/v1/agent/drafts/{id}/publish" },
  { command: "rank-reviews", method: "GET", path: "/v1/agent/sites/{id}/reviews" },
  { command: "rank-report", method: "GET", path: "/v1/agent/sites/{id}/report" },
];

// Writes remain unregistered until payload-bound preview/confirm and server policy are proven.
const DISABLED_WRITES = new Set(["rank-questions", "rank-write", "rank-publish"]);

export function enabledCatalog(raw: unknown): CatalogEntry[] {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { available?: unknown }).available)) {
    throw new Error("Malformed Rank capability response");
  }
  const advertised = (raw as { available: unknown[] }).available;
  const result: CatalogEntry[] = [];
  for (const entry of CATALOG) {
    if (DISABLED_WRITES.has(entry.command)) continue;
    if (advertised.some((item) => item && typeof item === "object" &&
      (item as CatalogEntry).command === entry.command &&
      (item as CatalogEntry).method === entry.method &&
      (item as CatalogEntry).path === entry.path)) result.push(entry);
  }
  return result;
}
