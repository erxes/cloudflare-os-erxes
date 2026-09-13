import type {
  BeginExecutorConnectInput,
  BeginExecutorConnectResult,
  ExecutorIntegrationKind,
  ExecutorSecretTemplate,
  IntegrationCatalogRow,
  SubmitExecutorSecretInput,
} from "@gadgets/workshop-shared/api";

export type ExecutorJson = (
  method: string,
  path: string,
  body?: unknown,
) => Promise<{ ok: boolean; status: number; json: unknown }>;

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

const CONFIDENCE_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

export type DetectCandidate = {
  kind: ExecutorIntegrationKind;
  confidence: "high" | "medium" | "low";
  endpoint: string;
  name: string;
  slug: string;
};

/** Rank detect results; highest confidence first. */
export function rankDetectCandidates(json: unknown): DetectCandidate[] {
  const out: DetectCandidate[] = [];
  for (const row of asArray(json)) {
    const rec = asRecord(row);
    if (!rec) continue;
    const kind = text(rec.kind);
    if (kind !== "mcp" && kind !== "openapi" && kind !== "graphql") continue;
    const confidence = text(rec.confidence);
    if (confidence !== "high" && confidence !== "medium" && confidence !== "low") continue;
    const endpoint = text(rec.endpoint);
    if (!endpoint) continue;
    out.push({
      kind,
      confidence,
      endpoint,
      name: text(rec.name) || endpoint,
      slug: text(rec.slug) || "integration",
    });
  }
  out.sort((a, b) => (CONFIDENCE_RANK[b.confidence] ?? 0) - (CONFIDENCE_RANK[a.confidence] ?? 0));
  return out;
}

export type ResolvedConnectTarget = {
  kind: ExecutorIntegrationKind;
  endpoint: string;
  name: string;
  slugHint?: string;
};

export function resolveFromCatalog(
  input: Extract<BeginExecutorConnectInput, { source: "catalog" }>,
  catalog: readonly IntegrationCatalogRow[],
): ResolvedConnectTarget {
  const row = catalog.find((e) => e.id === input.catalogId);
  if (!row) throw new Error(`Unknown catalog entry: ${input.catalogId}`);
  return {
    kind: row.kind,
    endpoint: row.endpoint,
    name: row.name,
    slugHint: row.id.split("/").pop()?.replace(/\./g, "-"),
  };
}

export type EnsureMcpResult = { slug: string; probe: Record<string, unknown> };

const BEARER_API_KEY_TEMPLATE = {
  type: "apiKey" as const,
  label: "API key",
  headers: {
    Authorization: ["Bearer ", { type: "variable" as const, name: "token" }],
  },
};

/** Declared auth methods for addServer — open servers get none + optional bearer. */
export function authenticationTemplateFromProbe(probe: Record<string, unknown>): unknown[] {
  if (probe.requiresOAuth === true) return [{ kind: "oauth2" }];
  if (probe.requiresAuthentication === true) return [BEARER_API_KEY_TEMPLATE];
  return [{ kind: "none" }, BEARER_API_KEY_TEMPLATE];
}

/** @deprecated prefer authenticationTemplateFromProbe — kept for unit tests of shorthand mapping. */
export function authShorthandFromProbe(
  probe: Record<string, unknown>,
):
  | { kind: "none" }
  | { kind: "oauth2" }
  | { kind: "header"; headerName: string; prefix: string } {
  if (probe.requiresOAuth === true) return { kind: "oauth2" };
  if (probe.requiresAuthentication === true) {
    return { kind: "header", headerName: "Authorization", prefix: "Bearer " };
  }
  return { kind: "none" };
}

function failureDetail(json: unknown): string {
  const rec = asRecord(json);
  if (!rec) return "";
  const msg = text(rec.message) || text(rec.error) || text(asRecord(rec.error)?.message);
  return msg ? `: ${msg}` : "";
}

function slugify(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "mcp";
}

const OPTIONAL_API_KEY_TEMPLATE: ExecutorSecretTemplate = {
  id: "header",
  label: "API key",
  kind: "apikey",
  fields: [{ name: "value", label: "API key", secret: true }],
};

export async function ensureMcpIntegrationWithProbe(
  api: ExecutorJson,
  target: ResolvedConnectTarget,
): Promise<EnsureMcpResult> {
  const probe = await api("POST", "/api/mcp/probe", { endpoint: target.endpoint });
  if (!probe.ok) {
    throw new Error(`MCP probe failed (${probe.status})${failureDetail(probe.json)}`);
  }
  const probeBody = asRecord(probe.json) ?? {};
  const slug =
    text(target.slugHint) ||
    text(probeBody.slug) ||
    slugify(target.name);

  const authenticationTemplate = authenticationTemplateFromProbe(probeBody);
  const created = await api("POST", "/api/mcp/servers", {
    transport: "remote",
    name: target.name,
    endpoint: target.endpoint,
    slug,
    remoteTransport: "auto",
    authenticationTemplate,
  });
  if (created.ok) {
    return { slug: text(asRecord(created.json)?.slug) || slug, probe: probeBody };
  }
  if (created.status === 409) {
    // Idempotent: reuse existing slug; merge optional API-key method for open servers.
    const listed = await api("GET", "/api/integrations");
    const match = asArray(listed.json)
      .map(asRecord)
      .find((row) => row && text(row.displayUrl) === target.endpoint);
    const existingSlug = text(match?.slug) || slug;
    if (probeBody.requiresOAuth !== true && probeBody.requiresAuthentication !== true) {
      await api("POST", `/api/mcp/servers/${encodeURIComponent(existingSlug)}/auth`, {
        authenticationTemplate,
        mode: "merge",
      });
    }
    return { slug: existingSlug, probe: probeBody };
  }
  throw new Error(`Create MCP server failed (${created.status})${failureDetail(created.json)}`);
}

function secretTemplateFromAuthMethod(method: Record<string, unknown>): ExecutorSecretTemplate {
  const id = text(method.id) || text(method.template) || text(method.slug) || "apikey";
  const kindRaw = text(method.kind).toLowerCase();
  const kind = kindRaw === "header" ? "header" : kindRaw === "none" ? "none" : "apikey";
  return {
    id,
    label: text(method.label) || id,
    kind,
    fields: [{ name: "value", label: text(method.label) || "Secret", secret: true }],
  };
}

function oauthClientRows(json: unknown): Record<string, unknown>[] {
  const rec = asRecord(json);
  const rows = asArray(rec?.clients ?? json);
  return rows.map(asRecord).filter((row): row is Record<string, unknown> => !!row);
}

function dcrClientSlug(issuerOrEndpoint: string): string {
  try {
    const host = new URL(issuerOrEndpoint).hostname.toLowerCase();
    const base = host.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return `dcr-${base || "authorization-server"}`;
  } catch {
    return "dcr-authorization-server";
  }
}

function stringList(value: unknown): string[] {
  return asArray(value).map(text).filter(Boolean);
}

type ResolvedOAuthClient = { client: string; clientOwner: "user" | "org" };

/** Prefer an existing DCR client for this integration; otherwise register via RFC 7591. */
export async function resolveOAuthClientForMcp(
  api: ExecutorJson,
  opts: {
    slug: string;
    discoveryUrl: string;
    redirectUri: string;
    supportsDynamicRegistration: boolean;
  },
): Promise<ResolvedOAuthClient> {
  const clients = oauthClientRows((await api("GET", "/api/oauth/clients")).json);

  const existingDcr = clients.find((row) => {
    const origin = asRecord(row.origin);
    return (
      text(origin?.kind) === "dynamic_client_registration" &&
      text(origin?.integration) === opts.slug
    );
  });
  if (existingDcr) {
    return {
      client: text(existingDcr.slug),
      clientOwner: text(existingDcr.owner) === "org" ? "org" : "user",
    };
  }

  if (opts.supportsDynamicRegistration || clients.length === 0) {
    const probe = await api("POST", "/api/oauth/probe", { url: opts.discoveryUrl });
    if (probe.ok) {
      const body = asRecord(probe.json) ?? {};
      const registrationEndpoint = text(body.registrationEndpoint);
      if (registrationEndpoint && text(body.authorizationUrl) && text(body.tokenUrl)) {
        const slug = dcrClientSlug(text(body.issuer) || registrationEndpoint);
        const scopes = stringList(body.scopesSupported);
        const registered = await api("POST", "/api/oauth/clients/register-dynamic", {
          owner: "user",
          slug,
          issuer: text(body.issuer) || null,
          registrationEndpoint,
          authorizationUrl: text(body.authorizationUrl),
          tokenUrl: text(body.tokenUrl),
          resource: text(body.resource) || opts.discoveryUrl,
          scopes,
          tokenEndpointAuthMethodsSupported: stringList(body.tokenEndpointAuthMethodsSupported),
          clientName: "Executor",
          redirectUri: opts.redirectUri,
          originIntegration: opts.slug,
        });
        if (registered.ok) {
          return {
            client: text(asRecord(registered.json)?.client) || slug,
            clientOwner: "user",
          };
        }
        if (registered.status === 409) {
          return { client: slug, clientOwner: "user" };
        }
        throw new Error(
          `OAuth client registration failed (${registered.status})${failureDetail(registered.json)}`,
        );
      }
    }
  }

  const fallback = clients[0];
  if (fallback) {
    return {
      client: text(fallback.slug),
      clientOwner: text(fallback.owner) === "org" ? "org" : "user",
    };
  }

  throw new Error(
    "This MCP needs OAuth. Automatic registration failed — open Executor and add an OAuth app, then try again.",
  );
}

export async function startAuthForSlug(
  api: ExecutorJson,
  opts: {
    slug: string;
    probe: Record<string, unknown>;
    executorOrigin: string;
    discoveryUrl: string;
    displayName?: string;
  },
): Promise<BeginExecutorConnectResult> {
  const requiresAuth = opts.probe.requiresAuthentication === true;
  const requiresOAuth = opts.probe.requiresOAuth === true;
  const displayName = opts.displayName || opts.slug;

  // Executor: register first, connect account second. Open servers (Firecrawl
  // keyless, etc.) must NOT auto-create a none connection and claim "connected".
  if (!requiresAuth && !requiresOAuth) {
    return {
      status: "needs_secret",
      slug: opts.slug,
      template: OPTIONAL_API_KEY_TEMPLATE,
      optional: true,
      displayName,
    };
  }

  const detail = await api("GET", `/api/integrations/${encodeURIComponent(opts.slug)}`);
  const methods = asArray(asRecord(detail.json)?.authMethods);
  const oauthMethod = methods
    .map(asRecord)
    .find((m) => m && text(m.kind).toLowerCase() === "oauth");
  const secretMethod = methods
    .map(asRecord)
    .find((m) => {
      if (!m) return false;
      const k = text(m.kind).toLowerCase();
      return k === "apikey" || k === "header";
    });

  if (requiresOAuth || oauthMethod) {
    const redirectUri = `${opts.executorOrigin.replace(/\/$/, "")}/api/oauth/callback`;
    const discoveryUrl =
      text(asRecord(oauthMethod?.oauth)?.discoveryUrl) || opts.discoveryUrl;
    const resolved = await resolveOAuthClientForMcp(api, {
      slug: opts.slug,
      discoveryUrl,
      redirectUri,
      supportsDynamicRegistration:
        opts.probe.supportsDynamicRegistration === true ||
        asRecord(oauthMethod?.oauth)?.supportsDynamicRegistration === true,
    });
    const template =
      text(oauthMethod?.template) || text(oauthMethod?.id) || text(oauthMethod?.slug) || "oauth2";
    const start = await api("POST", "/api/oauth/start", {
      client: resolved.client,
      clientOwner: resolved.clientOwner,
      owner: "user",
      name: "default",
      integration: opts.slug,
      template,
      newConnection: true,
      redirectUri,
    });
    if (!start.ok) {
      throw new Error(`OAuth start failed (${start.status})${failureDetail(start.json)}`);
    }
    const body = asRecord(start.json) ?? {};
    if (text(body.status) === "connected") {
      return { status: "connected", slug: opts.slug };
    }
    if (text(body.status) === "redirect" && text(body.authorizationUrl)) {
      return {
        status: "needs_oauth",
        slug: opts.slug,
        authorizationUrl: text(body.authorizationUrl),
        state: text(body.state),
      };
    }
    throw new Error("OAuth start returned an unexpected response.");
  }

  if (secretMethod) {
    return {
      status: "needs_secret",
      slug: opts.slug,
      template: secretTemplateFromAuthMethod(secretMethod),
      displayName,
    };
  }

  throw new Error("Integration requires auth but no supported method was found.");
}

export async function submitSecret(
  api: ExecutorJson,
  input: SubmitExecutorSecretInput,
): Promise<{ slug: string }> {
  const res = await api("POST", "/api/connections", {
    owner: "user",
    name: "default",
    integration: input.slug,
    template: input.template,
    value: input.value,
  });
  if (!res.ok && res.status !== 409) {
    throw new Error(`Save secret failed (${res.status})${failureDetail(res.json)}`);
  }
  return { slug: input.slug };
}

function connectionRows(json: unknown): Record<string, unknown>[] {
  const rec = asRecord(json);
  return asArray(rec?.connections ?? json)
    .map(asRecord)
    .filter((row): row is Record<string, unknown> => !!row);
}

/** Drop this user's connections for the slug, then remove the integration. */
export async function disconnectExecutorIntegration(
  api: ExecutorJson,
  slug: string,
): Promise<void> {
  const listed = await api(
    "GET",
    `/api/connections?integration=${encodeURIComponent(slug)}`,
  );
  if (listed.ok) {
    for (const row of connectionRows(listed.json)) {
      if (text(row.integration) && text(row.integration) !== slug) continue;
      const owner = text(row.owner) === "org" ? "org" : "user";
      // CF OS only creates owner:user connections.
      if (owner !== "user") continue;
      const name = text(row.name) || "default";
      const del = await api(
        "DELETE",
        `/api/connections/${owner}/${encodeURIComponent(slug)}/${encodeURIComponent(name)}`,
      );
      if (!del.ok && del.status !== 404) {
        throw new Error(`Remove connection failed (${del.status})${failureDetail(del.json)}`);
      }
    }
  }
  const rem = await api("DELETE", `/api/integrations/${encodeURIComponent(slug)}`);
  if (!rem.ok && rem.status !== 404) {
    throw new Error(`Remove integration failed (${rem.status})${failureDetail(rem.json)}`);
  }
}

/** Re-run auth for an existing MCP integration (update key / OAuth). */
export async function reconnectExecutorIntegration(
  api: ExecutorJson,
  slug: string,
  executorOrigin: string,
): Promise<BeginExecutorConnectResult> {
  const detail = await api("GET", `/api/mcp/servers/${encodeURIComponent(slug)}`);
  if (!detail.ok) {
    throw new Error(`Integration not found (${detail.status}).`);
  }
  const body = asRecord(detail.json) ?? {};
  const config = asRecord(body.config) ?? {};
  const endpoint = text(config.endpoint);
  if (!endpoint) {
    throw new Error("This integration has no endpoint to reconnect.");
  }
  const name = text(body.description) || text(body.name) || slug;
  return connectMcpTarget(
    api,
    { kind: "mcp", endpoint, name, slugHint: slug },
    executorOrigin,
  );
}

/** Run MCP connect after target is resolved. OpenAPI/GraphQL throw. */
export async function connectMcpTarget(
  api: ExecutorJson,
  target: ResolvedConnectTarget,
  executorOrigin: string,
): Promise<BeginExecutorConnectResult> {
  if (target.kind !== "mcp") {
    throw new Error(`${target.kind.toUpperCase()} connect is not supported yet. Try an MCP server.`);
  }
  const ensured = await ensureMcpIntegrationWithProbe(api, target);
  return startAuthForSlug(api, {
    slug: ensured.slug,
    probe: ensured.probe,
    executorOrigin,
    discoveryUrl: target.endpoint,
    displayName: target.name,
  });
}
