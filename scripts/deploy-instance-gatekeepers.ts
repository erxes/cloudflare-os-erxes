import { gatekeeperShortName } from "./release/manifest-lib.ts";

export interface DeployInstance {
  slug: string;
  baseUrl: string;
  admins: string[];
  aiGatewayName: string;
}

export interface GatekeeperRow {
  package: `gatekeeper-${string}`;
  secrets?: "gatekeeper";
  kvBindings?: readonly string[];
  backendProps?: (instance: DeployInstance) => Record<string, unknown>;
}

export const INSTANCE_GATEKEEPERS: readonly GatekeeperRow[] = [
  { package: "gatekeeper-erxes", secrets: "gatekeeper" },
  {
    package: "gatekeeper-context",
    kvBindings: ["CONTEXT_COLLECTIONS"],
    backendProps: (instance) => ({ sharingDomain: instance.baseUrl }),
  },
  { package: "gatekeeper-homeassistant" },
  { package: "gatekeeper-mcp" },
  { package: "gatekeeper-scheduler" },
] as const;

export interface ResourceIds {
  backendKv: Record<string, string>;
  contextKv: Record<string, string>;
  blueprintBucket: string;
}

export interface InstanceConfigPatch {
  name?: string;
  routes?: unknown[];
  services?: ServiceBinding[];
  ai?: unknown;
  kv_namespaces?: { binding: string; id: string }[];
  r2_buckets?: { binding: string; bucket_name: string }[];
  vars?: Record<string, unknown>;
}

export interface ServiceBinding {
  binding: string;
  service: string;
  entrypoint?: string;
  props?: Record<string, unknown>;
}

export type InstanceWranglerConfig = {
  name?: string;
  routes?: unknown[];
  services?: unknown[];
  ai?: unknown;
  kv_namespaces?: unknown[];
  r2_buckets?: unknown[];
  vars?: Record<string, unknown>;
  [key: string]: unknown;
};

export interface BuildPatchesInput {
  instance: DeployInstance;
  table: readonly GatekeeperRow[];
  accountId: string;
  authGatekeepers: string;
  disablePasswordAuth: boolean;
  aiGatewayProviders: string;
  baseVarsByPackage: Readonly<Record<string, Record<string, unknown>>>;
  resources: ResourceIds;
}

/** Preview's binding scheme, inlined so self-host deploy does not import preview. */
export function gatekeeperBindingName(pkgName: string): string {
  return pkgName.toUpperCase().replaceAll("-", "_");
}

export function instanceWorkerName(slug: string, pkgName: string): string {
  return `${slug}-${pkgName}`;
}

export function deployOrder(table: readonly GatekeeperRow[]): string[] {
  return [...table.map((r) => r.package), "workshop-backend", "router"];
}

export function secretsKindForPackage(
  pkgName: string,
  table: readonly GatekeeperRow[],
): "gatekeeper" | "backend" | undefined {
  if (pkgName === "workshop-backend") return "backend";
  return table.find((r) => r.package === pkgName)?.secrets;
}

export function mergeVars(
  base: Record<string, unknown> | undefined,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  return { ...(base ?? {}), ...overlay };
}

export function backendGatekeeperServices(
  instance: DeployInstance,
  table: readonly GatekeeperRow[],
): ServiceBinding[] {
  return table.map((row) => ({
    binding: gatekeeperBindingName(row.package),
    service: instanceWorkerName(instance.slug, row.package),
    entrypoint: "GatekeeperVendor",
    ...(row.backendProps ? { props: row.backendProps(instance) } : {}),
  }));
}

export function routerGatekeeperServices(
  instance: DeployInstance,
  table: readonly GatekeeperRow[],
): ServiceBinding[] {
  return table.map((row) => ({
    binding: gatekeeperBindingName(row.package),
    service: instanceWorkerName(instance.slug, row.package),
  }));
}

function gatekeeperKvIds(
  row: GatekeeperRow,
  resources: ResourceIds,
): Record<string, string> | undefined {
  if (!row.kvBindings?.length) return undefined;
  if (row.package === "gatekeeper-context") return resources.contextKv;
  throw new Error(`${row.package}: kvBindings with no ResourceIds field`);
}

function gatekeeperPatch(
  instance: DeployInstance,
  row: GatekeeperRow,
  baseVars: Record<string, unknown> | undefined,
  resources: ResourceIds,
): InstanceConfigPatch {
  const patch: InstanceConfigPatch = {
    name: instanceWorkerName(instance.slug, row.package),
    vars: mergeVars(baseVars, {
      BASE_URL: `${instance.baseUrl}/gatekeeper/${gatekeeperShortName(row.package)}`,
    }),
  };
  const kvIds = gatekeeperKvIds(row, resources);
  if (row.kvBindings?.length && kvIds &&
      row.kvBindings.every((binding) => Boolean(kvIds[binding]))) {
    patch.kv_namespaces = row.kvBindings.map((binding) => ({
      binding,
      id: kvIds[binding],
    }));
  }
  return patch;
}

function backendPatch(input: BuildPatchesInput): InstanceConfigPatch {
  const { instance, table, resources } = input;
  return {
    name: instanceWorkerName(instance.slug, "workshop-backend"),
    services: backendGatekeeperServices(instance, table),
    ai: { binding: "WORKERS_AI" },
    kv_namespaces: Object.entries(resources.backendKv).map(([binding, id]) => ({
      binding,
      id,
    })),
    r2_buckets: [{ binding: "BLUEPRINT_CONTENT", bucket_name: resources.blueprintBucket }],
    vars: {
      ADMINS: instance.admins,
      PUBLIC_BASE_URL: instance.baseUrl,
      AUTH_GATEKEEPERS: input.authGatekeepers,
      DISABLE_PASSWORD_AUTH: String(input.disablePasswordAuth),
      CF_AI_GATEWAY: instance.aiGatewayName,
      CF_AI_GATEWAY_PROVIDERS: input.aiGatewayProviders,
      CF_AI_GATEWAY_ACCOUNT_ID: input.accountId,
      CF_AI_GATEWAY_USE_BINDING: "false",
    },
  };
}

function routerPatch(input: BuildPatchesInput): InstanceConfigPatch {
  const { instance, table } = input;
  return {
    name: instanceWorkerName(instance.slug, "router"),
    routes: [{ pattern: new URL(instance.baseUrl).host, custom_domain: true }],
    services: [
      {
        binding: "WORKSHOP_BACKEND",
        service: instanceWorkerName(instance.slug, "workshop-backend"),
      },
      ...routerGatekeeperServices(instance, table),
    ],
  };
}

export function buildInstancePatches(
  input: BuildPatchesInput,
): Record<string, InstanceConfigPatch> {
  const out: Record<string, InstanceConfigPatch> = {};
  for (const row of input.table) {
    out[row.package] = gatekeeperPatch(
      input.instance,
      row,
      input.baseVarsByPackage[row.package],
      input.resources,
    );
  }
  out["workshop-backend"] = backendPatch(input);
  out["router"] = routerPatch(input);
  return out;
}

/** Object.assign would replace vars wholesale; merge so committed keys survive. */
export function applyInstancePatch(
  committed: InstanceWranglerConfig,
  patch: InstanceConfigPatch,
): InstanceWranglerConfig {
  const next: InstanceWranglerConfig = {
    ...committed,
    ...patch,
    vars: patch.vars ? mergeVars(committed.vars, patch.vars) : committed.vars,
  };
  if (!patch.routes) delete next.routes;
  return next;
}
