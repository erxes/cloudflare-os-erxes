#!/usr/bin/env node
/**
 * Deploys one Cloudflare OS instance to a real Cloudflare account with direct `wrangler deploy`s
 * — the self-host path for instances that don't run behind Cloudflare's hosted deploy service.
 *
 * Currently configured for the erxes instance at os.erxes.io. The three workers that instance
 * needs are deployed in dependency order (gatekeepers -> backend -> router); every other
 * gatekeeper in the workspace is skipped because AUTH_GATEKEEPERS only allows erxes sign-in.
 *
 * Per worker, the script reads the committed wrangler.jsonc and writes a generated sibling
 * `wrangler.instance.jsonc` (gitignored) with the instance-specific pieces patched in:
 *   - router:    the custom-domain route and GATEKEEPER_ERXES service binding
 *   - backend:   PUBLIC_BASE_URL/ADMINS/auth vars, the WORKERS_AI binding, the erxes vendor
 *                binding, and fresh KV namespace ids created in the target account
 *   - gatekeeper: BASE_URL derived from the public origin
 *
 * Committed configs stay upstream-clean so syncs from cloudflare/cloudflare-os don't conflict;
 * everything instance-shaped lives here or in the generated files.
 *
 * Secrets (ERXES_GRAPHQL_URL, EXECUTOR_URL, EXECUTOR_AUTH_SECRET, CF_OS_EXCHANGE_URL,
 * CF_OS_EXCHANGE_SECRET) are not stored anywhere in the
 * repo: pass `--secrets <file>` with a flat JSON object and they're uploaded to gatekeeper-erxes
 * via `wrangler secret bulk` after its deploy.
 *
 * Safety: refuses to run unless CLOUDFLARE_ACCOUNT_ID is pinned to the erxes account, so an
 * unpinned shell can never point this at the wrong account.
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = join(ROOT, "packages");

/** The instance this script deploys. Change these to stand up a different tenant. */
const INSTANCE = {
  slug: "erxes-os-internal",
  baseUrl: "https://os.erxes.io",
  admins: ["amaraaamka0404@gmail.com"],
  authGatekeepers: "erxes",
  disablePasswordAuth: true,
  aiGateway: {
    name: "erxes-os-internal",
    providers: "cloudflare",
    accountId: "7c8392aff8ac4518aa06dfa4b6337ef2",
  },
};

/** Only this account is allowed. Refusing without the pin protects the personal account. */
const ALLOWED_ACCOUNT_ID = "7c8392aff8ac4518aa06dfa4b6337ef2";
const ACCOUNT_NAME = "erxes Inc";

const CONFIG_NAME = "wrangler.instance.jsonc";
const DEPLOY_ORDER = ["gatekeeper-erxes", "workshop-backend", "router"];

const secretsFlag = process.argv.indexOf("--secrets");
const secretsFile = secretsFlag > -1 ? resolve(process.argv[secretsFlag + 1]) : undefined;
const backendSecretsFlag = process.argv.indexOf("--backend-secrets");
const backendSecretsFile =
    backendSecretsFlag > -1 ? resolve(process.argv[backendSecretsFlag + 1]) : undefined;
const dryRun = process.argv.includes("--dry-run");

function die(message: string): never {
  console.error(`deploy-instance: ${message}`);
  process.exit(1);
}

if (process.env.CLOUDFLARE_ACCOUNT_ID !== ALLOWED_ACCOUNT_ID) {
  die(`CLOUDFLARE_ACCOUNT_ID must be pinned to ${ACCOUNT_NAME} (${ALLOWED_ACCOUNT_ID}). ` +
      "This checkout uses direnv for that — run from a shell inside the repo.");
}

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

// --- resources ---------------------------------------------------------------

/** Find-or-create the KV namespaces the backend binds, returning ids keyed by binding name. */
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
    // Resource titles carry the instance slug so another tenant can share this CF account.
    const out = wrangler(pkgDir,
      ["kv", "namespace", "create", title, "--preview", "false"]).out;
    // Wrangler prints both a table line (`id: <hex>`) and a JSON snippet (`"id": "<hex>"`).
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

// --- config generation ---------------------------------------------------------

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
  // The instance route (if any) comes from the patch; never inherit stale ones.
  if (!patch.routes) delete config.routes;
  Object.assign(config, patch);
  const path = join(pkgDir, CONFIG_NAME);
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
  console.log(`gen  ${relative(path)}`);
  return pkgDir;
}

// --- main ----------------------------------------------------------------------

console.log(`instance: ${INSTANCE.baseUrl} -> account ${ACCOUNT_NAME}`);

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
const kvIds = ensureKvNamespaces(backendDir, backendConfig.kv_namespaces ?? []);
const blueprintBucket = `${INSTANCE.slug}-blueprint-content`;
ensureR2Bucket(backendDir, blueprintBucket);

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
          AUTH_GATEKEEPERS: INSTANCE.authGatekeepers,
          DISABLE_PASSWORD_AUTH: String(INSTANCE.disablePasswordAuth),
          CF_AI_GATEWAY: INSTANCE.aiGateway.name,
          CF_AI_GATEWAY_PROVIDERS: INSTANCE.aiGateway.providers,
          CF_AI_GATEWAY_ACCOUNT_ID: INSTANCE.aiGateway.accountId,
          // The authenticated gateway rejects the binding sentinel, so inference rides HTTPS
          // with the gateway token; the WORKERS_AI binding stays for webFetch's toMarkdown.
          CF_AI_GATEWAY_USE_BINDING: "false",
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
