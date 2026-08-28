#!/usr/bin/env bun
/**
 * Dump workspace chats/files via AdminApi (ADMINS-gated). No UI.
 *
 *   bun packages/workshop-backend/scripts/dump-workspace.ts list <email>
 *   bun packages/workshop-backend/scripts/dump-workspace.ts dump <workspaceId> [--out file.json]
 *
 * Token: OS_AUTH_TOKEN, or ~/.config/erxes/os-auth.token (or OS_AUTH_TOKEN_FILE).
 * Host: OS_BASE_URL (default https://os.erxes.io).
 *
 * The token's identity must be in the deployment ADMINS list.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import type { AdminApi, AuthenticatedApi, PublicApi } from "@gadgets/workshop-shared/api";

const baseUrl = process.env.OS_BASE_URL ?? "https://os.erxes.io";

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

function loadToken() {
  if (process.env.OS_AUTH_TOKEN) return process.env.OS_AUTH_TOKEN.trim();
  let path = process.env.OS_AUTH_TOKEN_FILE ?? `${homedir()}/.config/erxes/os-auth.token`;
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    die(`No auth token. Set OS_AUTH_TOKEN or write one to ${path}`);
  }
}

function parseArgs(argv: string[]) {
  let out: string | undefined;
  let rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") {
      out = argv[++i];
      if (!out) die("--out needs a path");
    } else {
      rest.push(argv[i]!);
    }
  }
  return { out, rest };
}

async function withAdmin<T>(fn: (admin: RpcStub<AdminApi>) => Promise<T>) {
  let token = loadToken();
  let wsUrl = new URL("/api", baseUrl);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  let api = newWebSocketRpcSession<PublicApi>(wsUrl.toString());
  let auth = await api.authenticate(token) as unknown as RpcStub<AuthenticatedApi>;
  let admin = await auth.getAdminApi();
  if (!admin) die("getAdminApi() returned null. This login is not in ADMINS.");
  return await fn(admin);
}

function writeDump(value: unknown, out?: string) {
  let json = JSON.stringify(value, (_key, v) => {
    if (v instanceof Date) return v.toISOString();
    if (v instanceof Map) return [...v.entries()];
    if (v instanceof Uint8Array) return { bytes: v.length };
    return v;
  }, 2);
  if (out) {
    let path = resolve(out);
    writeFileSync(path, json);
    console.error(`wrote ${path} (${json.length} bytes)`);
  } else {
    console.log(json);
  }
}

let { out, rest } = parseArgs(process.argv.slice(2));
let [cmd, arg] = rest;

if (cmd === "list") {
  if (!arg) die("usage: dump-workspace.ts list <email>");
  writeDump(await withAdmin(admin => admin.listUserWorkspaces(arg)), out);
} else if (cmd === "dump") {
  if (!arg) die("usage: dump-workspace.ts dump <workspaceId> [--out file.json]");
  writeDump(await withAdmin(admin => admin.dumpWorkspace(arg)), out);
} else {
  die("usage: dump-workspace.ts list <email> | dump <workspaceId> [--out file.json]");
}
