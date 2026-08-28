import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import { createLogger } from "@gadgets/backend-utils/logger";
import { MCP_BASE_TYPES } from "@gadgets/mcp-shared/base-types";
import type { ConnectionAccount, McpConnection } from "@gadgets/mcp-shared/connection";
import { McpFacetBase } from "@gadgets/mcp-shared/facet";
import { fetchOptions } from "@gadgets/mcp-shared/fetch";
import type { McpLogFields } from "@gadgets/mcp-shared/log";
import { generateSessionTypes, sessionTypeName } from "@gadgets/mcp-shared/schema-to-ts";
import { sameEndpoint, type ToolScope } from "@gadgets/mcp-shared/scope";
import { McpSessionBase } from "@gadgets/mcp-shared/session";
import ERXES_LOGO_SVG from "./erxes-logo.svg";
import type { ClassifiedTool, ServerTrust } from "@gadgets/mcp-shared/tools";
import { hostOf } from "@gadgets/mcp-shared/util";
import {
  stripTrailingSlashes,
  type AccountDescription,
  type Gatekeeper,
  type GatekeeperConnectCallback,
  type GatekeeperConnectOptions,
  type GatekeeperUser,
  type GatekeeperUserVerifier,
  type GatekeeperVendor as GatekeeperVendorInterface,
  type ResourceConfiguratorFrame,
  type ResourceDescription,
  type SupportedResource,
  type VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";

const LOGIN_LIFETIME_MS = 10 * 60 * 1000;
const EXECUTOR_TOKEN_LIFETIME_SECONDS = 5 * 60;
const VENDOR_ID = "erxes";
const SERVER_ID = "executor";
const SERVER_NAME = "Executor";
const SCOPE: ToolScope = {};
const TRUST: ServerTrust = "byo";
const EXECUTOR_TYPES = `// Executor use in this erxes deployment.
//
// Do not inspect or enumerate this binding. Do not call listTools for an erxes request.
// Call execute directly. executeCode only shows console output, so log the Executor RPC result:
//   const result = await env.EXECUTOR.execute({ code: "return ..." });
//   console.log(JSON.stringify(result));
//
// Fetch the how-to before GraphQL work. These are MCP tools on this binding, not sandbox APIs:
//   await env.EXECUTOR.skills({ name: "execute" });
//   await env.EXECUTOR.skills({ name: "graphql" });
//
// Inside Executor code, find erxes tools with:
//   const { items } = await tools.search({ namespace: "erxes-officenext", query: "customer", limit: 12 });
// Use item.path (not item.name) with tools.describe.tool({ path }) and tools[path](input).
// Tool calls return { ok: true, data } or { ok: false, error }. They do not throw for expected
// failures; check .ok. Nested GraphQL fields still need select, e.g.
//   select: "list { _id name } totalCount"
// Outer braces on select are optional. The tools object is a lazy proxy and cannot be enumerated.

${MCP_BASE_TYPES}`;
const LOGO = {
  url: `data:image/svg+xml,${encodeURIComponent(ERXES_LOGO_SVG)}`,
};

const logger = createLogger<McpLogFields>({
  component: "gatekeeper.erxes",
  vendorId: VENDOR_ID,
});

type LoginNonce = {
  value: string;
  expiresAt: number;
  claimed: boolean;
  completed?: boolean;
};

type NonceStatus =
  | { kind: "ok"; nonce: LoginNonce }
  | { kind: "completed" }
  | { kind: "dead" };

// The link is "dead" only when it is invalid, expired, or gone. A claim (another submit in
// flight) or a completed sign-in is not dead — answering those with "expired" is how a correct
// submission used to show the error while the real login still connected the account.
function nonceStatus(stored: LoginNonce | undefined, value: string): NonceStatus {
  if (!stored || Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, value)) {
    return { kind: "dead" };
  }
  if (stored.completed) return { kind: "completed" };
  return { kind: "ok", nonce: stored };
}

type LoginResult = { ok: true } | { ok: false; error: string };

// Returned by login() when a concurrent submit already claimed the link; the fetch handler
// converts it into the self-resolving waiting page rather than surfacing it as an error.
const SIGN_IN_IN_PROGRESS_MESSAGE =
    "Sign-in is already in progress. Please wait and try again.";
type ErxesUserProps = { accountId: string };

type ErxesIdentity = {
  userId: string;
  email: string;
  tenant: string;
};

type ExecutorGatekeeperProps = {
  accountId: string;
  endpoint: string;
  serverName: string;
  scope: ToolScope;
};

type GraphQlResponse<T> = {
  data?: T;
  errors?: { message?: string }[];
};

function getBaseUrl(env: Env) {
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/erxes");
}

function secureUrl(raw: string | undefined, name: string, allowInsecure: boolean) {
  const value = raw?.trim();
  if (!value) throw new Error(`${name} is not configured.`);

  const url = new URL(value);
  if (url.protocol !== "https:" && !(allowInsecure && url.protocol === "http:")) {
    throw new Error(`${name} must use HTTPS.`);
  }
  if (url.username || url.password) throw new Error(`${name} must not contain credentials.`);
  url.hash = "";
  return url;
}

function getGraphQlUrl(env: Env) {
  return secureUrl(
    env.ERXES_GRAPHQL_URL,
    "ERXES_GRAPHQL_URL",
    env.ERXES_ALLOW_INSECURE === "true",
  ).toString();
}

function getExecutorUrl(env: Env) {
  const url = secureUrl(env.EXECUTOR_URL, "EXECUTOR_URL", fetchOptions(env).allowInsecure === true);
  return stripTrailingSlashes(url.toString());
}

function executorMcpUrl(env: Env) {
  // `model` mode lets the agent answer Executor's approval elicitations itself, so
  // execute calls don't pause for a human on every step. Browser mode remains right
  // for interactive OAuth handoffs; the data-path agent flow doesn't do those.
  return `${getExecutorUrl(env)}/os/mcp?elicitation_mode=model`;
}

function executorSecret(env: Env) {
  const secret = env.EXECUTOR_AUTH_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error("EXECUTOR_AUTH_SECRET must be at least 32 characters.");
  }
  return secret;
}

function nonce() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function constantTimeEqual(left: string, right: string) {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index++) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function encodeJson(value: object) {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function executorToken(env: Env, identity: ErxesIdentity) {
  const now = Math.floor(Date.now() / 1000);
  const header = encodeJson({ alg: "HS256", typ: "JWT" });
  const payload = encodeJson({
    iss: "cloudflare-os",
    aud: "executor",
    sub: identity.userId,
    org: identity.tenant,
    email: identity.email,
    iat: now,
    exp: now + EXECUTOR_TOKEN_LIFETIME_SECONDS,
  });
  const unsigned = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(executorSecret(env)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function loginPage(action: string, error?: string) {
  const errorHtml = error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in with erxes</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
    main { width: min(360px, calc(100vw - 32px)); }
    .logo { width: 28px; height: 40px; margin-bottom: 20px; }
    .logo svg { display: block; width: 100%; height: 100%; }
    h1 { margin: 0 0 8px; font-size: 24px; }
    p { margin: 0 0 20px; color: GrayText; }
    label { display: grid; gap: 6px; margin: 14px 0; font-weight: 600; }
    input, button { box-sizing: border-box; width: 100%; min-height: 44px; border-radius: 8px; font: inherit; }
    input { border: 1px solid GrayText; padding: 10px 12px; background: Field; color: FieldText; }
    button { margin-top: 8px; border: 0; padding: 10px 14px; background: #4f46e5; color: white; font-weight: 700; cursor: pointer; }
    .error { color: #c53030; }
  </style>
</head>
<body>
  <main>
    <div class="logo" aria-hidden="true">${ERXES_LOGO_SVG}</div>
    <h1>Sign in with erxes</h1>
    <p>Signing in also connects erxes to Executor for agent use.</p>
    ${errorHtml}
    <form method="post" action="${escapeHtml(action)}">
      <label>Email<input name="email" type="email" autocomplete="username" required autofocus></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
      <button type="submit">Continue</button>
    </form>
  </main>
</body>
</html>`;
}

const CLOSE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Signed in</title></head>
<body><p>Signed in. You can close this window.</p><script>window.close()</script></body></html>`;

// Shown while another submit is completing this sign-in (double-click, refresh re-POST, or the
// same link open in another tab). Polls the link's JSON status and reloads when the state leaves
// "claimed" — the normal GET handler then renders the form, the expired page, or the close page
// as appropriate, so the window resolves itself instead of dead-ending on a 401.
const WAITING_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Signing in</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
    main { width: min(360px, calc(100vw - 32px)); text-align: center; }
    .spinner { width: 28px; height: 28px; margin: 0 auto 16px; border-radius: 50%;
      border: 3px solid color-mix(in srgb, CanvasText 20%, transparent);
      border-top-color: #4f46e5; animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    p { margin: 0 0 8px; font-size: 16px; }
    small { color: GrayText; }
  </style>
</head>
<body>
  <main>
    <div class="spinner" aria-hidden="true"></div>
    <p>Sign-in is already in progress.</p>
    <small>This window will finish by itself once the other sign-in completes.</small>
  </main>
  <script>
    const waitUrl = location.pathname +
        (location.search ? location.search + "&" : "?") + "wait=1";
    (async () => {
      for (;;) {
        await new Promise(r => setTimeout(r, 1000));
        let status;
        try {
          status = (await (await fetch(waitUrl, { cache: "no-store" })).json()).status;
        } catch {
          continue;
        }
        if (status !== "claimed") { location.reload(); return; }
      }
    })();
  </script>
</body>
</html>`;

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function html(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
        "connect-src 'self'; form-action 'self'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function graphql<T>(url: string, body: object, cookie?: string) {
  const response = await fetch(url, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  const result = await response.json<GraphQlResponse<T>>();
  return { response, result };
}

async function authenticate(env: Env, email: string, password: string) {
  const url = getGraphQlUrl(env);
  const login = await graphql<{ login: string }>(url, {
    operationName: "erxesOsLogin",
    query:
      "mutation erxesOsLogin($email: String!, $password: String!) { login(email: $email, password: $password) }",
    variables: { email, password },
  });
  if (
    !login.response.ok ||
    login.result.errors?.length ||
    login.result.data?.login !== "loggedIn"
  ) {
    return null;
  }

  const setCookie = login.response.headers.get("set-cookie") ?? "";
  const token = /(?:^|[,;]\s*)auth-token=([^;,\s]+)/.exec(setCookie)?.[1];
  if (!token) throw new Error("erxes did not return an auth cookie.");

  const cookie = `auth-token=${token}`;
  const currentUser = await graphql<{
    currentUser: { _id?: string | null; email?: string | null } | null;
  }>(
    url,
    {
      operationName: "erxesOsCurrentUser",
      query: "query erxesOsCurrentUser { currentUser { _id email } }",
    },
    cookie,
  );
  const user = currentUser.result.data?.currentUser;
  if (!currentUser.response.ok || currentUser.result.errors?.length || !user?._id || !user.email) {
    return null;
  }

  return {
    identity: {
      userId: user._id,
      email: user.email.trim().toLowerCase(),
      tenant: new URL(url).host.toLowerCase(),
    },
    cookie,
  };
}

/**
 * Passwordless variant: redeems a single-use connect code with the erxes backend, which returns
 * a session token for the already-authenticated dashboard user. The currentUser round-trip both
 * verifies the token actually works and resolves the identity the same way password sign-in does.
 */
async function authenticateWithCode(env: Env, code: string) {
  const exchangeUrl = env.CF_OS_EXCHANGE_URL;
  const exchangeSecret = env.CF_OS_EXCHANGE_SECRET;
  if (!exchangeUrl || !exchangeSecret) throw new Error("Connect-code exchange is not configured.");

  const response = await fetch(exchangeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-cf-os-secret": exchangeSecret },
    body: JSON.stringify({ code }),
  });
  if (!response.ok) return null;
  const exchanged = (await response.json()) as { authToken?: string };
  if (!exchanged.authToken) return null;

  const cookie = `auth-token=${exchanged.authToken}`;
  const url = getGraphQlUrl(env);
  const currentUser = await graphql<{
    currentUser: { _id?: string | null; email?: string | null } | null;
  }>(
    url,
    {
      operationName: "erxesOsCurrentUser",
      query: "query erxesOsCurrentUser { currentUser { _id email } }",
    },
    cookie,
  );
  const user = currentUser.result.data?.currentUser;
  if (!currentUser.response.ok || currentUser.result.errors?.length || !user?._id || !user.email) {
    return null;
  }

  return {
    identity: {
      userId: user._id,
      email: user.email.trim().toLowerCase(),
      tenant: new URL(url).host.toLowerCase(),
    },
    cookie,
  };
}

async function provisionExecutor(env: Env, identity: ErxesIdentity, cookie: string) {
  const response = await fetch(`${getExecutorUrl(env)}/os/provision`, {
    method: "POST",
    redirect: "manual",
    headers: {
      Authorization: `Bearer ${await executorToken(env, identity)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ endpoint: getGraphQlUrl(env), cookie }),
  });
  if (!response.ok) throw new Error(`Executor provisioning failed with status ${response.status}.`);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const baseUrl = new URL(getBaseUrl(env));
    const prefix = baseUrl.pathname;
    if (!url.pathname.startsWith(`${prefix}/`)) return new Response("Not Found", { status: 404 });

    const parts = url.pathname.slice(prefix.length + 1).split("/");
    if (parts.length !== 2) return new Response("Not Found", { status: 404 });

    let account: DurableObjectStub<ErxesLoginAccount>;
    try {
      account = ctx.exports.ErxesLoginAccount.get(
        ctx.exports.ErxesLoginAccount.idFromString(parts[0]),
      );
    } catch {
      return html(loginPage(url.pathname, "This sign-in link is invalid."), 400);
    }

    if (request.method === "GET") {
      const status = await account.nonceStatus(parts[1]);
      // Poll endpoint for the waiting page: JSON status instead of HTML.
      if (url.searchParams.has("wait")) {
        return json({
          status: status.kind === "ok" && status.nonce.claimed ? "claimed" : status.kind,
        });
      }
      if (status.kind === "completed") return html(CLOSE_PAGE);
      if (status.kind === "dead") {
        return html(loginPage(url.pathname, "This sign-in link has expired."), 400);
      }
      // A sign-in is mid-flight on this link (e.g. it was opened in another tab): wait for it
      // to settle instead of showing a stale form that would just bounce back.
      if (status.kind === "ok" && status.nonce.claimed) return html(WAITING_PAGE);
      // Dashboard-embedded sign-ins arrive with a single-use connect code: skip the password
      // form. A failed redemption falls back to the normal form so the user is never stuck.
      const connectCode = url.searchParams.get("code");
      if (connectCode && status.kind === "ok") {
        const result = await account.loginWithCode(parts[1], connectCode);
        if (result.ok) return html(CLOSE_PAGE);
        return html(loginPage(url.pathname, result.error));
      }
      return html(loginPage(url.pathname));
    }
    if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    // A concurrent submit (double-click, refresh re-POST, same link elsewhere) is already
    // completing this sign-in: show the self-resolving waiting page instead of a 401.
    const postStatus = await account.nonceStatus(parts[1]);
    if (postStatus.kind === "dead") {
      return html(loginPage(url.pathname, "This sign-in link has expired."), 400);
    }
    if (postStatus.kind === "completed") return html(CLOSE_PAGE);
    if (postStatus.kind === "ok" && postStatus.nonce.claimed) return html(WAITING_PAGE);

    const form = await request.formData();
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    if (!email || !password) {
      return html(loginPage(url.pathname, "Enter your email and password."), 400);
    }

    const result = await account.login(parts[1], email, password);
    if (!result.ok) {
      // The link was claimed between our check above and login() (the form parse awaits): same
      // story, show the waiting page.
      if (result.error === SIGN_IN_IN_PROGRESS_MESSAGE) return html(WAITING_PAGE);
      return html(loginPage(url.pathname, result.error), 401);
    }
    return html(CLOSE_PAGE);
  },
};

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorInterface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "erxes",
      url: "https://officenext.erxes.io/",
      logo: LOGO,
      color: "#4f46e5",
      tagline: "Sign in and use erxes through Executor",
      description:
        "Sign in with your erxes account. The same sign-in connects your erxes data " +
        "to your private Executor account for agent use.",
      providesAuth: true,
    };
  }

  async connectAccount(
    callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ) {
    getGraphQlUrl(this.env);
    getExecutorUrl(this.env);
    executorSecret(this.env);
    const accountId = this.ctx.exports.ErxesLoginAccount.newUniqueId();
    const initiationNonce = nonce();
    const account = this.ctx.exports.ErxesLoginAccount.get(accountId);
    await account.begin(callback, initiationNonce);
    const url = `${getBaseUrl(this.env)}/${accountId}/${initiationNonce}`;
    // Dashboard SSO redeems the connect code on this RPC so the browser never
    // loads the login page in a frame. Workshop CSP is `frame-src srcdoc:` and
    // Firefox enforces it (Chrome often does not).
    if (_options?.initialCode) {
      const result = await account.loginWithCode(initiationNonce, _options.initialCode);
      if (!result.ok) throw new Error(result.error);
    }
    return { url };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  async getTypeScriptTypes() {
    return EXECUTOR_TYPES;
  }
}

export class ErxesLoginAccount extends DurableObject<Env> {
  async begin(callback: Fetcher<GatekeeperConnectCallback>, value: string) {
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<LoginNonce>("nonce", {
      value,
      expiresAt: Date.now() + LOGIN_LIFETIME_MS,
      claimed: false,
    });
    await this.ctx.storage.setAlarm(Date.now() + LOGIN_LIFETIME_MS);
  }

  async nonceStatus(value: string): Promise<NonceStatus> {
    return nonceStatus(this.ctx.storage.kv.get<LoginNonce>("nonce"), value);
  }

  async login(value: string, email: string, password: string): Promise<LoginResult> {
    const status = nonceStatus(this.ctx.storage.kv.get<LoginNonce>("nonce"), value);
    if (status.kind === "dead") return { ok: false, error: "This sign-in link has expired." };
    // The link already signed someone in (a duplicate submit landed after completion) — the
    // connection is done, so answer success instead of a misleading "expired".
    if (status.kind === "completed") return { ok: true };
    const stored = status.nonce;
    if (stored.claimed) {
      return { ok: false, error: SIGN_IN_IN_PROGRESS_MESSAGE };
    }
    this.ctx.storage.kv.put<LoginNonce>("nonce", { ...stored, claimed: true });

    let authenticated: Awaited<ReturnType<typeof authenticate>> | null = null;
    try {
      authenticated = await authenticate(this.env, email, password);
      if (!authenticated) {
        this.ctx.storage.kv.put<LoginNonce>("nonce", { ...stored, claimed: false });
        return { ok: false, error: "Email or password is incorrect." };
      }

      return await this.complete(value, stored, authenticated);
    } catch (error) {
      logger.warn("erxes sign-in failed", { event: "auth.login.failed", error });
      this.ctx.storage.kv.put<LoginNonce>("nonce", { ...stored, claimed: false });
      return { ok: false, error: "erxes sign-in is unavailable. Try again." };
    }
  }

  /**
   * Passwordless variant for dashboard-embedded sign-ins: redeems a single-use connect code
   * issued by the erxes backend (which already authenticated the user) and completes the same
   * provisioning path as a password sign-in.
   */
  async loginWithCode(value: string, code: string): Promise<LoginResult> {
    const status = nonceStatus(this.ctx.storage.kv.get<LoginNonce>("nonce"), value);
    if (status.kind !== "ok" || status.nonce.claimed) return { ok: false, error: SIGN_IN_IN_PROGRESS_MESSAGE };
    const stored = status.nonce;
    this.ctx.storage.kv.put<LoginNonce>("nonce", { ...stored, claimed: true });

    try {
      const authenticated = await authenticateWithCode(this.env, code);
      if (!authenticated) {
        this.ctx.storage.kv.put<LoginNonce>("nonce", { ...stored, claimed: false });
        return { ok: false, error: "This connect code is invalid or has expired." };
      }
      return await this.complete(value, stored, authenticated);
    } catch (error) {
      logger.warn("erxes connect-code sign-in failed", { event: "auth.login.code_failed", error });
      this.ctx.storage.kv.put<LoginNonce>("nonce", { ...stored, claimed: false });
      return { ok: false, error: "erxes sign-in is unavailable. Try again." };
    }
  }

  /** Shared tail of both sign-in paths: provision Executor, activate the account, notify OS. */
  private async complete(
    value: string,
    stored: LoginNonce,
    authenticated: NonNullable<Awaited<ReturnType<typeof authenticate>>>,
  ): Promise<LoginResult> {
    // Executor provisioning can take tens of seconds on first login (GraphQL tool
    // catalog). Do not block SSO on it — the OS shell can load while tools sync.
    this.ctx.waitUntil(
      provisionExecutor(this.env, authenticated.identity, authenticated.cookie).catch((error) => {
        logger.warn("executor provision failed", { event: "auth.provision.failed", error });
      }),
    );
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) return { ok: false, error: "This sign-in link has expired." };

    const accountId = this.ctx.exports.ErxesLoginAccount.idFromName(
      `${authenticated.identity.tenant}:${authenticated.identity.userId}`,
    );
    await this.ctx.exports.ErxesLoginAccount.get(accountId).activate(
      authenticated.identity,
      callback,
    );
    await callback.complete(
      this.ctx.exports.ErxesUser({ props: { accountId: accountId.toString() } }),
    );
    // Keep the nonce (marked completed) so a duplicate submit answers "already signed in"
    // instead of "expired"; the alarm cleans up at the end of the link's lifetime.
    this.ctx.storage.kv.put<LoginNonce>("nonce", { ...stored, claimed: false, completed: true });
    return { ok: true };
  }

  activate(identity: ErxesIdentity, callback: Fetcher<GatekeeperConnectCallback>) {
    this.ctx.storage.kv.put("identity", identity);
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put("credentialsExpired", false);
  }

  identity() {
    return this.ctx.storage.kv.get<ErxesIdentity>("identity") ?? null;
  }

  async connection(endpoint: string) {
    const identity = this.identity();
    if (!identity || this.ctx.storage.kv.get<boolean>("credentialsExpired")) {
      throw new Error("Sign in to erxes again.");
    }
    const expected = executorMcpUrl(this.env);
    if (!sameEndpoint(endpoint, expected)) {
      throw new Error("Executor configuration changed. Start a new Gadget session.");
    }
    return executorToken(this.env, identity);
  }

  async executorCredentialsExpired() {
    this.ctx.storage.kv.put("credentialsExpired", true);
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (callback) await callback.credentialsExpired();
  }

  async revoke() {
    await this.ctx.storage.deleteAll();
  }

  async alarm() {
    if (!this.identity()) await this.ctx.storage.deleteAll();
  }
}

@validateRpc()
export class ErxesUser extends WorkerEntrypoint<Env, ErxesUserProps> implements GatekeeperUser {
  #account() {
    return this.ctx.exports.ErxesLoginAccount.get(
      this.ctx.exports.ErxesLoginAccount.idFromString(this.ctx.props.accountId),
    );
  }

  async describe(): Promise<AccountDescription> {
    const identity = await this.#account().identity();
    if (!identity) throw new Error("Sign in to erxes again.");
    return {
      displayName: identity.email,
      uniqueName: `${identity.tenant}:${identity.userId}`,
      avatar: LOGO,
      singleton: { tsType: sessionTypeName(SERVER_ID, executorMcpUrl(this.env)) },
    };
  }

  async getAuthenticatedEmail() {
    return (await this.#account().identity())?.email ?? null;
  }

  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<unknown>>> {
    return this.ctx.exports.ExecutorGatekeeper({
      props: {
        accountId: this.ctx.props.accountId,
        endpoint: executorMcpUrl(this.env),
        serverName: SERVER_NAME,
        scope: SCOPE,
      },
    });
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }

  getGatekeeperClassFor(_url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<unknown>>;
    resource: SupportedResource;
  }> {
    throw new Error("Executor is an automatic agent capability, not a URL resource.");
  }

  startResourceConfigurator(_resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    throw new Error("Executor has no resource form.");
  }

  async ensureResources(_resourceUrlPatterns: string[]) {
    return {};
  }

  async revoke() {
    await this.#account().revoke();
  }

  reconnect(): Promise<{ url: string }> {
    throw new Error("Sign in to erxes again.");
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.ErxesVerifier({});
  }
}

@validateRpc()
export class ErxesVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

export class ExecutorGatekeeper
  extends McpFacetBase<Env, ExecutorGatekeeperProps, ExecutorSession>
  implements ConnectionAccount
{
  protected get log() {
    return logger.with({ serverHost: hostOf(this.ctx.props.endpoint) });
  }

  protected get trust(): ServerTrust {
    return TRUST;
  }

  protected get sessionClass() {
    return ExecutorSession;
  }

  protected get actionScopeTag() {
    return `executor:${this.ctx.props.accountId}`;
  }

  /**
   * Executor applies its per-user policy to every inner tool call. Avoid a second approval around
   * these wrapper calls.
   */
  async tools(): Promise<ClassifiedTool[]> {
    return (await super.tools()).map(entry => ({
      ...entry,
      mode: "read",
      autoApprovable: false,
      classifiedBy: "default",
    }));
  }

  protected get observerName() {
    return this.ctx.props.serverName;
  }

  protected account(): ConnectionAccount {
    return this;
  }

  get serverName() {
    return this.ctx.props.serverName;
  }

  #loginAccount() {
    return this.ctx.exports.ErxesLoginAccount.get(
      this.ctx.exports.ErxesLoginAccount.idFromString(this.ctx.props.accountId),
    );
  }

  async describe(): Promise<ResourceDescription> {
    // Install-time metadata only. MCP tool listing can take tens of seconds while Executor
    // provisions the GraphQL catalog; addGatekeeper() deletes the row if describe() throws.
    return {
      url: this.ctx.props.endpoint,
      title: this.ctx.props.serverName,
      snippet: "Executor tools for your erxes account.",
      suggestedBindingName: "EXECUTOR",
      tsType: sessionTypeName(SERVER_ID, this.ctx.props.endpoint),
    };
  }

  async getTypeScriptTypes() {
    return generateSessionTypes({
      baseTypes: EXECUTOR_TYPES,
      serverId: SERVER_ID,
      serverName: this.ctx.props.serverName,
      endpoint: this.ctx.props.endpoint,
      discriminator: this.ctx.props.endpoint,
      trust: TRUST,
      tools: await this.tools(),
    });
  }

  async getConnection(endpoint: string): Promise<McpConnection> {
    return {
      authorization: await this.#loginAccount().connection(endpoint),
      sessionId: this.ctx.storage.kv.get<string>("mcpSessionId") ?? null,
      generation: 0,
    };
  }

  async assertConnectionCurrent(endpoint: string, generation: number) {
    if (generation !== 0 || !sameEndpoint(endpoint, this.ctx.props.endpoint)) {
      throw new Error("This Executor connection changed before the request was sent. Try again.");
    }
  }

  async setMcpSessionId(
    endpoint: string,
    generation: number,
    previousSessionId: string | null,
    sessionId: string | null,
  ) {
    if (generation !== 0 || !sameEndpoint(endpoint, this.ctx.props.endpoint)) return false;
    const currentSessionId = this.ctx.storage.kv.get<string>("mcpSessionId") ?? null;
    if (currentSessionId !== previousSessionId) return currentSessionId === sessionId;
    if (sessionId) this.ctx.storage.kv.put("mcpSessionId", sessionId);
    else this.ctx.storage.kv.delete("mcpSessionId");
    return true;
  }

  async noteCredentialsExpired(endpoint: string, generation: number) {
    if (generation !== 0 || !sameEndpoint(endpoint, this.ctx.props.endpoint)) return;
    this.ctx.storage.kv.delete("mcpSessionId");
    await this.#loginAccount().executorCredentialsExpired();
    this.log.warn("Executor rejected the erxes account", {
      event: "executor.credentials.rejected",
    });
  }
}

@validateRpc()
class ExecutorSession extends McpSessionBase {}
