import type {
  BeginExecutorConnectInput,
  BeginExecutorConnectResult,
  ExecutorDetectCandidate,
  ExecutorIntegrationKind,
  ExecutorSecretTemplate,
  IntegrationCatalogRow,
  SubmitExecutorSecretInput,
  SubmitExecutorSecretResult,
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

export function rankDetectCandidates(json: unknown): ExecutorDetectCandidate[] {
  const out: ExecutorDetectCandidate[] = [];
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
): ResolvedConnectTarget | { error: string } {
  const row = catalog.find((e) => e.id === input.catalogId);
  if (!row) return { error: `Unknown catalog entry: ${input.catalogId}` };
  if (!row.endpoint) return { error: `${row.name} has no connect URL in the catalog.` };
  return {
    kind: row.kind,
    endpoint: row.endpoint,
    name: row.name,
    slugHint: row.domain?.replace(/\./g, "-") || row.id.split("/").pop(),
  };
}

export type EnsureMcpResult =
  | { slug: string; probe: Record<string, unknown> }
  | { error: string };

export async function ensureMcpIntegrationWithProbe(
  api: ExecutorJson,
  target: ResolvedConnectTarget,
): Promise<EnsureMcpResult> {
  const probe = await api("POST", "/api/mcp/probe", { endpoint: target.endpoint });
  if (!probe.ok) {
    return { error: `MCP probe failed (${probe.status}).` };
  }
  const probeBody = asRecord(probe.json) ?? {};
  const slug =
    text(target.slugHint) ||
    text(probeBody.slug) ||
    target.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") ||
    "mcp";

  const created = await api("POST", "/api/mcp/servers", {
    transport: "remote",
    name: target.name,
    endpoint: target.endpoint,
    slug,
    remoteTransport: "auto",
  });
  if (!created.ok && created.status !== 409) {
    return { error: `Create MCP server failed (${created.status}).` };
  }
  const createdSlug = text(asRecord(created.json)?.slug) || slug;
  return { slug: createdSlug, probe: probeBody };
}

function secretTemplateFromAuthMethod(method: Record<string, unknown>): ExecutorSecretTemplate {
  const id = text(method.id) || text(method.slug) || "apikey";
  const kindRaw = text(method.kind).toLowerCase();
  const kind = kindRaw === "header" ? "header" : kindRaw === "none" ? "none" : "apikey";
  return {
    id,
    label: text(method.label) || id,
    kind,
    fields: [{ name: "value", label: text(method.label) || "Secret", secret: true }],
  };
}

export async function startAuthForSlug(
  api: ExecutorJson,
  opts: {
    slug: string;
    probe: Record<string, unknown>;
    executorOrigin: string;
  },
): Promise<BeginExecutorConnectResult> {
  const requiresAuth = opts.probe.requiresAuthentication === true;
  const requiresOAuth = opts.probe.requiresOAuth === true;
  if (!requiresAuth) {
    const none = await api("POST", "/api/connections", {
      owner: "user",
      name: "default",
      integration: opts.slug,
      template: "none",
      value: "",
    });
    if (!none.ok && none.status !== 409) {
      // Some none-auth servers need no connection row; treat as connected.
      if (none.status === 400) return { status: "connected", slug: opts.slug };
      return { status: "error", message: `Create connection failed (${none.status}).` };
    }
    return { status: "connected", slug: opts.slug };
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
    const clientsRes = await api("GET", "/api/oauth/clients");
    const clients = asArray(clientsRes.json);
    const first = asRecord(clients[0]);
    if (!first) {
      return {
        status: "error",
        message:
          "This MCP needs OAuth. Register an OAuth app in Executor once, then Connect again.",
      };
    }
    const template = text(oauthMethod?.id) || text(oauthMethod?.slug) || "oauth";
    const start = await api("POST", "/api/oauth/start", {
      client: text(first.slug) || text(first.client),
      clientOwner: text(first.owner) || "org",
      owner: "user",
      name: "default",
      integration: opts.slug,
      template,
      newConnection: true,
      redirectUri: `${opts.executorOrigin.replace(/\/$/, "")}/api/oauth/callback`,
    });
    if (!start.ok) {
      return { status: "error", message: `OAuth start failed (${start.status}).` };
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
    return { status: "error", message: "OAuth start returned an unexpected response." };
  }

  if (secretMethod) {
    return {
      status: "needs_secret",
      slug: opts.slug,
      template: secretTemplateFromAuthMethod(secretMethod),
    };
  }

  return {
    status: "error",
    message: "Integration requires auth but no supported method was found.",
  };
}

export async function submitSecret(
  api: ExecutorJson,
  input: SubmitExecutorSecretInput,
): Promise<SubmitExecutorSecretResult> {
  const res = await api("POST", "/api/connections", {
    owner: "user",
    name: "default",
    integration: input.slug,
    template: input.template,
    value: input.value,
  });
  if (!res.ok && res.status !== 409) {
    return { status: "error", message: `Save secret failed (${res.status}).` };
  }
  return { status: "connected", slug: input.slug };
}

/** Run MCP connect after target is resolved. */
export async function connectMcpTarget(
  api: ExecutorJson,
  target: ResolvedConnectTarget,
  executorOrigin: string,
): Promise<BeginExecutorConnectResult> {
  if (target.kind !== "mcp") {
    return { status: "unsupported_kind", kind: target.kind };
  }
  const ensured = await ensureMcpIntegrationWithProbe(api, target);
  if ("error" in ensured) return { status: "error", message: ensured.error };
  return startAuthForSlug(api, {
    slug: ensured.slug,
    probe: ensured.probe,
    executorOrigin,
  });
}
