#!/usr/bin/env node
/**
 * Deploys one Cloudflare OS instance to a real Cloudflare account with direct `wrangler deploy`s
 * — the self-host path for instances that don't run behind Cloudflare's hosted deploy service.
 *
 * Instance config lives in `instances/<slug>.json`. Secrets live in gitignored sibling files:
 *   instances/<slug>.secrets.gatekeeper.json
 *   instances/<slug>.secrets.backend.json
 *
 * The three workers deploy in dependency order (gatekeepers -> backend -> router). Every other
 * gatekeeper in the workspace is skipped because AUTH_GATEKEEPERS only allows erxes sign-in.
 *
 * Per worker, the script reads the committed wrangler.jsonc and writes a generated sibling
 * `wrangler.instance.jsonc` (gitignored) with the instance-specific pieces patched in.
 *
 * Safety: refuses to run unless CLOUDFLARE_ACCOUNT_ID is pinned to the erxes account.
 *
 * Usage:
 *   bun scripts/deploy-instance.ts --instance erxes-os-internal [--dry-run] [--skip-build]
 *   bun scripts/deploy-instance.ts --instance erxes-os-priuscenter --secrets path --backend-secrets path
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readWranglerConfig,
  type BindingDecl,
  type WranglerConfig,
} from "./release/manifest-lib.ts";
import { ERXES_INSTANCE_INSTRUCTIONS } from "../packages/workshop-shared/src/erxes-executor-guidance.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = join(ROOT, "packages");
const INSTANCES_DIR = join(ROOT, "instances");

/** Only this account is allowed. Refusing without the pin protects the personal account. */
const ALLOWED_ACCOUNT_ID = "7c8392aff8ac4518aa06dfa4b6337ef2";
const ACCOUNT_NAME = "erxes Inc";

const CONFIG_NAME = "wrangler.instance.jsonc";
const DEPLOY_ORDER = ["gatekeeper-erxes", "workshop-backend", "router"];

const AUTH_GATEKEEPERS = "erxes";
const DISABLE_PASSWORD_AUTH = true;
const AI_GATEWAY_PROVIDERS = "cloudflare";

interface InstanceFile {
  slug: string;
  baseUrl: string;
  admins: string[];
}

interface ResolvedInstance {
  slug: string;
  baseUrl: string;
  admins: string[];
  aiGatewayName: string;
}

function die(message: string): never {
  console.error(`deploy-instance: ${message}`);
  process.exit(1);
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index > -1 ? process.argv[index + 1] : undefined;
}

const instanceSlug = argValue("--instance");
if (!instanceSlug) die("--instance <slug> is required (e.g. erxes-os-internal)");

const secretsFileOverride = argValue("--secrets");
const backendSecretsFileOverride = argValue("--backend-secrets");
const dryRun = process.argv.includes("--dry-run");

if (process.env.CLOUDFLARE_ACCOUNT_ID !== ALLOWED_ACCOUNT_ID) {
  die(`CLOUDFLARE_ACCOUNT_ID must be pinned to ${ACCOUNT_NAME} (${ALLOWED_ACCOUNT_ID}). ` +
      "This checkout uses direnv for that — run from a shell inside the repo.");
}

function loadInstance(slug: string): ResolvedInstance {
  const configPath = join(INSTANCES_DIR, `${slug}.json`);
  if (!existsSync(configPath)) die(`missing instance config: ${relative(configPath)}`);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    die(`invalid JSON in ${relative(configPath)}`);
  }

  const file = raw as Partial<InstanceFile>;
  if (file.slug !== slug) {
    die(`instance config slug "${file.slug}" does not match --instance "${slug}"`);
  }
  if (!file.baseUrl || !file.baseUrl.startsWith("https://")) {
    die(`instance ${slug}: baseUrl must be an https URL`);
  }
  if (!Array.isArray(file.admins) || file.admins.length === 0 ||
      !file.admins.every(admin => typeof admin === "string" && admin.includes("@"))) {
    die(`instance ${slug}: admins must be a non-empty email list`);
  }

  return {
    slug,
    baseUrl: file.baseUrl.replace(/\/+$/, ""),
    admins: file.admins,
    aiGatewayName: slug,
  };
}

function defaultSecretsPath(slug: string, kind: "gatekeeper" | "backend") {
  return join(INSTANCES_DIR, `${slug}.secrets.${kind}.json`);
}

function resolveSecretsPath(slug: string, kind: "gatekeeper" | "backend", override?: string) {
  if (override) return resolve(override);
  const path = defaultSecretsPath(slug, kind);
  return existsSync(path) ? path : undefined;
}

const INSTANCE = loadInstance(instanceSlug);
const secretsFile = resolveSecretsPath(instanceSlug, "gatekeeper", secretsFileOverride);
const backendSecretsFile = resolveSecretsPath(instanceSlug, "backend", backendSecretsFileOverride);

function wrangler(pkgDir: string, args: string[], stdin?: string): { ok: boolean; out: string } {
  const result = spawnSync("npx", ["wrangler", ...args], {
    cwd: pkgDir,
    encoding: "utf8",
    input: stdin,
  });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0 || result.error) {
    console.error(out);
    die(`wrangler ${args.join(" ")} failed in ${relative(pkgDir)}`);
  }
  return { ok: true, out };
}

function relative(path: string): string {
  return path.startsWith(ROOT) ? path.slice(ROOT.length + 1) : path;
}

function ensureKvNamespaces(pkgDir: string, wanted: BindingDecl[]) {
  const listed = JSON.parse(wrangler(pkgDir, ["kv", "namespace", "list"]).out) as
    { id: string; title: string }[];
  const ids: Record<string, string> = {};
  for (const ns of wanted) {
    const title = `${INSTANCE.slug}-${ns.binding.toLowerCase()}`;
    const existing = listed.find(entry => entry.title === title);
    if (existing) {
      ids[ns.binding] = existing.id;
      console.log(`kv   ${ns.binding}: ${existing.id} (${existing.title})`);
      continue;
    }
    const out = wrangler(pkgDir,
      ["kv", "namespace", "create", title, "--preview", "false"]).out;
    const id = out.match(/"?id"?:\s+"?([0-9a-f]{32})"?/)?.[1];
    if (!id) die(`could not parse created KV namespace id for ${ns.binding}:\n${out}`);
    ids[ns.binding] = id;
    console.log(`kv   ${ns.binding}: created ${id}`);
  }
  return ids;
}

function ensureR2Bucket(pkgDir: string, bucket: string) {
  const listed = wrangler(pkgDir, ["r2", "bucket", "list"]).out;
  if (listed.includes(bucket)) {
    console.log(`r2   ${bucket}: exists`);
    return;
  }
  wrangler(pkgDir, ["r2", "bucket", "create", bucket]);
  console.log(`r2   ${bucket}: created`);
}

interface InstanceConfigPatch {
  name?: string;
  routes?: unknown[];
  services?: unknown[];
  ai?: unknown;
  kv_namespaces?: { binding: string; id: string }[];
  r2_buckets?: { binding: string; bucket_name: string }[];
  vars?: Record<string, unknown>;
}

type InstanceWranglerConfig = WranglerConfig & {
  routes?: unknown[];
  r2_buckets?: (BindingDecl & { bucket_name: string })[];
};

function generateConfig(pkgName: string, patch: InstanceConfigPatch) {
  const pkgDir = join(PACKAGES, pkgName);
  const config = readWranglerConfig(pkgDir) as InstanceWranglerConfig;
  if (!patch.routes) delete config.routes;
  Object.assign(config, patch);
  const path = join(pkgDir, CONFIG_NAME);
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
  console.log(`gen  ${relative(path)}`);
  return pkgDir;
}

console.log(`instance: ${INSTANCE.slug} ${INSTANCE.baseUrl} -> account ${ACCOUNT_NAME}`);

const frontendDist = join(PACKAGES, "workshop-frontend", "dist", "index.html");
if (existsSync(frontendDist) && process.argv.includes("--skip-build")) {
  console.log("skip frontend build (--skip-build)");
} else {
  console.log("building frontend...");
  const build = spawnSync("npx", ["vite", "build"], {
    cwd: join(PACKAGES, "workshop-frontend"),
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "production" },
  });
  if (build.status !== 0) {
    console.error(build.stdout);
    console.error(build.stderr);
    die("frontend build failed");
  }
}

const backendDir = join(PACKAGES, "workshop-backend");
const backendConfig = readWranglerConfig(backendDir) as InstanceWranglerConfig;
const kvIds = dryRun ? {} : ensureKvNamespaces(backendDir, backendConfig.kv_namespaces ?? []);
const blueprintBucket = `${INSTANCE.slug}-blueprint-content`;
if (!dryRun) ensureR2Bucket(backendDir, blueprintBucket);

for (const pkgName of DEPLOY_ORDER) {
  let patch: InstanceConfigPatch;
  switch (pkgName) {
    case "gatekeeper-erxes":
      patch = {
        name: `${INSTANCE.slug}-gatekeeper-erxes`,
        vars: { BASE_URL: `${INSTANCE.baseUrl}/gatekeeper/erxes` },
      };
      break;
    case "workshop-backend":
      patch = {
        name: `${INSTANCE.slug}-workshop-backend`,
        services: [{
          binding: "GATEKEEPER_ERXES",
          service: `${INSTANCE.slug}-gatekeeper-erxes`,
          entrypoint: "GatekeeperVendor",
        }],
        ai: { binding: "WORKERS_AI" },
        kv_namespaces: Object.entries(kvIds).map(([binding, id]) => ({ binding, id })),
        r2_buckets: [{ binding: "BLUEPRINT_CONTENT", bucket_name: blueprintBucket }],
        vars: {
          ADMINS: INSTANCE.admins,
          PUBLIC_BASE_URL: INSTANCE.baseUrl,
          AUTH_GATEKEEPERS,
          DISABLE_PASSWORD_AUTH: String(DISABLE_PASSWORD_AUTH),
          CF_AI_GATEWAY: INSTANCE.aiGatewayName,
          CF_AI_GATEWAY_PROVIDERS: AI_GATEWAY_PROVIDERS,
          CF_AI_GATEWAY_ACCOUNT_ID: ALLOWED_ACCOUNT_ID,
          CF_AI_GATEWAY_USE_BINDING: "false",
          INSTANCE_INSTRUCTIONS: ERXES_INSTANCE_INSTRUCTIONS,
        },
      };
      break;
    case "router":
      patch = {
        name: `${INSTANCE.slug}-router`,
        routes: [{ pattern: new URL(INSTANCE.baseUrl).host, custom_domain: true }],
        services: [
          {
            binding: "WORKSHOP_BACKEND",
            service: `${INSTANCE.slug}-workshop-backend`,
          },
          {
            binding: "GATEKEEPER_ERXES",
            service: `${INSTANCE.slug}-gatekeeper-erxes`,
          },
        ],
      };
      break;
    default:
      die(`no config patch defined for ${pkgName}`);
  }

  const pkgDir = generateConfig(pkgName, patch);

  console.log(`deploying ${pkgName}...`);
  if (dryRun) {
    console.log(`dry-run: skipped deploy of ${pkgName}`);
    continue;
  }
  wrangler(pkgDir, ["deploy", "-c", CONFIG_NAME]);
  const secretsForWorker =
      pkgName === "gatekeeper-erxes" ? secretsFile :
      pkgName === "workshop-backend" ? backendSecretsFile : undefined;
  if (secretsForWorker) {
    const secrets = JSON.parse(readFileSync(secretsForWorker, "utf8"));
    wrangler(pkgDir, ["secret", "bulk", "-c", CONFIG_NAME], JSON.stringify(secrets));
    console.log(`sec  ${pkgName}: uploaded ${Object.keys(secrets).length} secret(s)`);
  }
  console.log(`done ${pkgName}`);
}

console.log(dryRun ? "\ndry-run complete" : `\ninstance live at ${INSTANCE.baseUrl}`);
