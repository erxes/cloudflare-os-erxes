import type {
  ExecutorIntegrationInfo,
  ExecutorIntegrationKind,
  IntegrationCatalogRow,
} from "@gadgets/workshop-shared/api";

export type IntegrationCatalogQuery = {
  q?: string;
  kind?: ExecutorIntegrationKind;
  limit?: number;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const KIND_SET = new Set<string>(["mcp", "openapi", "graphql"]);

function asKind(value: unknown): ExecutorIntegrationKind | undefined {
  const k = text(value);
  return KIND_SET.has(k) ? (k as ExecutorIntegrationKind) : undefined;
}

/** Merge Executor integrations + connections into browse rows. */
export function mergeExecutorCatalog(
  integrationsJson: unknown,
  connectionsJson: unknown,
): ExecutorIntegrationInfo[] {
  const connectedSlugs = new Set<string>();
  for (const row of asArray(connectionsJson)) {
    const rec = asRecord(row);
    const slug = text(rec?.integration);
    if (slug) connectedSlugs.add(slug);
  }

  const out: ExecutorIntegrationInfo[] = [];
  for (const row of asArray(integrationsJson)) {
    const rec = asRecord(row);
    if (!rec) continue;
    const slug = text(rec.slug);
    const kind = asKind(rec.kind);
    if (!slug || !kind) continue;
    const displayUrl = text(rec.displayUrl);
    out.push({
      slug,
      name: text(rec.name) || slug,
      description: text(rec.description),
      kind,
      ...(displayUrl ? { displayUrl } : {}),
      connected: connectedSlugs.has(slug),
    });
  }
  return out;
}

/** Normalize integrations.sh api.json into catalog rows. Drops cli / unknown / no-endpoint. */
export function normalizeIntegrationsShCatalog(envelope: unknown): IntegrationCatalogRow[] {
  const root = asRecord(envelope);
  const data = asArray(root?.data ?? envelope);
  const out: IntegrationCatalogRow[] = [];
  for (const row of data) {
    const rec = asRecord(row);
    if (!rec) continue;
    const kind = asKind(rec.kind);
    if (!kind) continue;
    const id = text(rec.id) || text(rec.slug);
    if (!id) continue;
    const endpoint = text(rec.connectUrl) || text(rec.endpoint) || text(rec.url);
    if (!endpoint) continue;
    // Stdio MCP is disabled on Cloudflare host.
    if (text(rec.transport).toLowerCase() === "stdio") continue;
    const domain = text(rec.domain);
    const iconUrl = domain
      ? `https://integrations.sh/logo/${domain}`
      : text(rec.icon) || undefined;
    out.push({
      id,
      name: text(rec.name) || id,
      description: text(rec.description),
      kind,
      endpoint,
      ...(iconUrl ? { iconUrl } : {}),
      ...(rec.featured === true ? { featured: true } : {}),
    });
  }
  return out;
}

export function filterCatalog(
  entries: readonly IntegrationCatalogRow[],
  query: IntegrationCatalogQuery | undefined,
): IntegrationCatalogRow[] {
  const q = text(query?.q).trim().toLowerCase();
  const kind = query?.kind;
  const limit = Math.min(Math.max(query?.limit ?? 80, 1), 200);
  const filtered = entries.filter((e) => {
    if (kind && e.kind !== kind) return false;
    if (!q) return true;
    return (
      e.name.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      e.id.toLowerCase().includes(q) ||
      e.endpoint.toLowerCase().includes(q)
    );
  });
  // Keep integrations.sh api.json order (curated block, then their ranking).
  return filtered.slice(0, limit);
}

export const CATALOG_CACHE_TTL_MS = 60 * 60 * 1000;
export const INTEGRATIONS_SH_URL = "https://integrations.sh/api.json";
