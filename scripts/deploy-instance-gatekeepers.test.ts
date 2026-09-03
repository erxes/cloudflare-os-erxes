import { describe, expect, test } from "bun:test";
import {
  INSTANCE_GATEKEEPERS,
  applyInstancePatch,
  backendGatekeeperServices,
  buildInstancePatches,
  deployOrder,
  routerGatekeeperServices,
} from "./deploy-instance-gatekeepers.ts";

const instance = {
  slug: "erxes-os-priuscenter",
  baseUrl: "https://os.priuscenter.com",
  admins: ["admin@example.com"],
  aiGatewayName: "erxes-os-priuscenter",
};

const emptyResources = {
  backendKv: {},
  contextKv: {},
  blueprintBucket: "erxes-os-priuscenter-blueprint-content",
};

describe("deploy-instance-gatekeepers", () => {
  test("backend bindings for all five in table order", () => {
    const services = backendGatekeeperServices(instance, INSTANCE_GATEKEEPERS);
    expect(services.map((s) => s.binding)).toEqual([
      "GATEKEEPER_ERXES",
      "GATEKEEPER_CONTEXT",
      "GATEKEEPER_HOMEASSISTANT",
      "GATEKEEPER_MCP",
      "GATEKEEPER_SCHEDULER",
    ]);
    expect(services.every((s) => s.entrypoint === "GatekeeperVendor")).toBe(true);
  });

  test("context props sharingDomain", () => {
    const services = backendGatekeeperServices(instance, INSTANCE_GATEKEEPERS);
    const context = services.find((s) => s.binding === "GATEKEEPER_CONTEXT");
    expect(context?.service).toBe("erxes-os-priuscenter-gatekeeper-context");
    expect(context?.props).toEqual({ sharingDomain: instance.baseUrl });
  });

  test("router has no entrypoint", () => {
    const services = routerGatekeeperServices(instance, INSTANCE_GATEKEEPERS);
    expect(services.every((s) => s.entrypoint === undefined)).toBe(true);
    expect(services.map((s) => s.binding)).toEqual([
      "GATEKEEPER_ERXES",
      "GATEKEEPER_CONTEXT",
      "GATEKEEPER_HOMEASSISTANT",
      "GATEKEEPER_MCP",
      "GATEKEEPER_SCHEDULER",
    ]);
  });

  test("mcp vars merge keeps MCP_ALLOW_INSECURE", () => {
    const patches = buildInstancePatches({
      instance,
      table: INSTANCE_GATEKEEPERS,
      accountId: "acct",
      authGatekeepers: "erxes",
      disablePasswordAuth: true,
      aiGatewayProviders: "cloudflare",
      baseVarsByPackage: {
        "gatekeeper-mcp": { MCP_ALLOW_INSECURE: "false" },
      },
      resources: emptyResources,
    });
    expect(patches["gatekeeper-mcp"].vars).toEqual({
      MCP_ALLOW_INSECURE: "false",
      BASE_URL: "https://os.priuscenter.com/gatekeeper/mcp",
    });

    const merged = applyInstancePatch(
      { name: "gatekeeper-mcp", vars: { MCP_ALLOW_INSECURE: "false" } },
      { vars: { BASE_URL: "https://os.priuscenter.com/gatekeeper/mcp" } },
    );
    expect(merged.vars?.MCP_ALLOW_INSECURE).toBe("false");
    expect(merged.vars?.BASE_URL).toBe("https://os.priuscenter.com/gatekeeper/mcp");
  });

  test("deployOrder ends with workshop-backend, router", () => {
    const order = deployOrder(INSTANCE_GATEKEEPERS);
    expect(order.slice(-2)).toEqual(["workshop-backend", "router"]);
    expect(order).toEqual([
      "gatekeeper-erxes",
      "gatekeeper-context",
      "gatekeeper-homeassistant",
      "gatekeeper-mcp",
      "gatekeeper-scheduler",
      "workshop-backend",
      "router",
    ]);
  });

  test("backend patch AUTH_GATEKEEPERS is erxes", () => {
    const patches = buildInstancePatches({
      instance,
      table: INSTANCE_GATEKEEPERS,
      accountId: "acct",
      authGatekeepers: "erxes",
      disablePasswordAuth: true,
      aiGatewayProviders: "cloudflare",
      baseVarsByPackage: {},
      resources: emptyResources,
    });
    expect(patches["workshop-backend"].vars?.AUTH_GATEKEEPERS).toBe("erxes");
  });

  test("dry-run omits context kv when ids are empty", () => {
    const patches = buildInstancePatches({
      instance,
      table: INSTANCE_GATEKEEPERS,
      accountId: "acct",
      authGatekeepers: "erxes",
      disablePasswordAuth: true,
      aiGatewayProviders: "cloudflare",
      baseVarsByPackage: {},
      resources: emptyResources,
    });
    expect(patches["gatekeeper-context"].kv_namespaces).toBeUndefined();
  });

  test("context kv ids land when provisioned", () => {
    const patches = buildInstancePatches({
      instance,
      table: INSTANCE_GATEKEEPERS,
      accountId: "acct",
      authGatekeepers: "erxes",
      disablePasswordAuth: true,
      aiGatewayProviders: "cloudflare",
      baseVarsByPackage: {},
      resources: {
        ...emptyResources,
        contextKv: { CONTEXT_COLLECTIONS: "abc123" },
      },
    });
    expect(patches["gatekeeper-context"].kv_namespaces).toEqual([
      { binding: "CONTEXT_COLLECTIONS", id: "abc123" },
    ]);
  });
});
