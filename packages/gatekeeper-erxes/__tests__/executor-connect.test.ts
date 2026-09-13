import { describe, expect, test } from "bun:test";
import {
  authShorthandFromProbe,
  resolveOAuthClientForMcp,
  type ExecutorJson,
} from "../src/executor-connect.ts";

describe("authShorthandFromProbe", () => {
  test("oauth wins over bearer", () => {
    expect(
      authShorthandFromProbe({ requiresOAuth: true, requiresAuthentication: true }),
    ).toEqual({ kind: "oauth2" });
  });

  test("bearer header when auth required without oauth", () => {
    expect(authShorthandFromProbe({ requiresAuthentication: true })).toEqual({
      kind: "header",
      headerName: "Authorization",
      prefix: "Bearer ",
    });
  });

  test("none when open", () => {
    expect(authShorthandFromProbe({})).toEqual({ kind: "none" });
  });
});

describe("resolveOAuthClientForMcp", () => {
  test("reuses an existing DCR client for the integration", async () => {
    const calls: string[] = [];
    const api: ExecutorJson = async (method, path) => {
      calls.push(`${method} ${path}`);
      if (path === "/api/oauth/clients") {
        return {
          ok: true,
          status: 200,
          json: [
            {
              owner: "user",
              slug: "dcr-mcp-notion-com",
              origin: { kind: "dynamic_client_registration", integration: "notion" },
            },
          ],
        };
      }
      throw new Error(`unexpected ${method} ${path}`);
    };
    await expect(
      resolveOAuthClientForMcp(api, {
        slug: "notion",
        discoveryUrl: "https://mcp.notion.com/mcp",
        redirectUri: "https://executor.example/api/oauth/callback",
        supportsDynamicRegistration: true,
      }),
    ).resolves.toEqual({ client: "dcr-mcp-notion-com", clientOwner: "user" });
    expect(calls).toEqual(["GET /api/oauth/clients"]);
  });

  test("registers via DCR when no clients exist", async () => {
    const api: ExecutorJson = async (method, path, body) => {
      if (path === "/api/oauth/clients") return { ok: true, status: 200, json: [] };
      if (path === "/api/oauth/probe") {
        return {
          ok: true,
          status: 200,
          json: {
            authorizationUrl: "https://auth.example/authorize",
            tokenUrl: "https://auth.example/token",
            registrationEndpoint: "https://auth.example/register",
            issuer: "https://auth.example",
            scopesSupported: ["openid"],
          },
        };
      }
      if (path === "/api/oauth/clients/register-dynamic") {
        expect(body).toMatchObject({
          owner: "user",
          clientName: "Executor",
          originIntegration: "notion",
          scopes: ["openid"],
        });
        return { ok: true, status: 200, json: { client: "dcr-auth-example" } };
      }
      throw new Error(`unexpected ${method} ${path}`);
    };
    await expect(
      resolveOAuthClientForMcp(api, {
        slug: "notion",
        discoveryUrl: "https://mcp.notion.com/mcp",
        redirectUri: "https://executor.example/api/oauth/callback",
        supportsDynamicRegistration: true,
      }),
    ).resolves.toEqual({ client: "dcr-auth-example", clientOwner: "user" });
  });
});
