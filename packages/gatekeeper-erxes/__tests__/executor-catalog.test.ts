import { describe, expect, test } from "bun:test";
import {
  filterCatalog,
  mergeExecutorCatalog,
  normalizeIntegrationsShCatalog,
} from "../src/executor-catalog.ts";
import { rankDetectCandidates, resolveFromCatalog } from "../src/executor-connect.ts";

describe("mergeExecutorCatalog", () => {
  test("marks connected slugs", () => {
    expect(
      mergeExecutorCatalog(
        [{ slug: "slack", name: "Slack", description: "x", kind: "mcp" }],
        [{ integration: "slack", name: "default" }],
      ),
    ).toEqual([
      {
        slug: "slack",
        name: "Slack",
        description: "x",
        kind: "mcp",
        connected: true,
      },
    ]);
  });

  test("drops unknown kinds", () => {
    expect(mergeExecutorCatalog([{ slug: "x", kind: "cli" }], [])).toEqual([]);
  });
});

describe("normalizeIntegrationsShCatalog", () => {
  test("keeps mcp and drops cli", () => {
    const rows = normalizeIntegrationsShCatalog({
      data: [
        {
          id: "curated/deepwiki-com-mcp",
          kind: "mcp",
          name: "DeepWiki",
          description: "docs",
          domain: "deepwiki.com",
          connectUrl: "https://mcp.deepwiki.com/mcp",
          featured: true,
        },
        { id: "cli/foo", kind: "cli", name: "foo", description: "" },
      ],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.endpoint).toBe("https://mcp.deepwiki.com/mcp");
    expect(rows[0]?.iconUrl).toBe("https://integrations.sh/logo/deepwiki.com");
  });
});

describe("filterCatalog", () => {
  test("filters by kind and query", () => {
    const entries = normalizeIntegrationsShCatalog({
      data: [
        {
          id: "a",
          kind: "mcp",
          name: "Slack",
          description: "chat",
          connectUrl: "https://mcp.slack.com/mcp",
          featured: true,
        },
        {
          id: "b",
          kind: "openapi",
          name: "Stripe",
          description: "payments",
          connectUrl: "https://api.stripe.com",
        },
      ],
    });
    expect(filterCatalog(entries, { kind: "mcp", q: "sla", limit: 10 })).toHaveLength(1);
  });
});

describe("rankDetectCandidates", () => {
  test("orders high before low", () => {
    const ranked = rankDetectCandidates([
      { kind: "mcp", confidence: "low", endpoint: "https://a", name: "A", slug: "a" },
      { kind: "mcp", confidence: "high", endpoint: "https://b", name: "B", slug: "b" },
    ]);
    expect(ranked[0]?.slug).toBe("b");
  });
});

describe("resolveFromCatalog", () => {
  test("resolves mcp rows", () => {
    expect(
      resolveFromCatalog(
        { source: "catalog", catalogId: "slack" },
        [
          {
            id: "slack",
            name: "Slack",
            description: "",
            kind: "mcp",
            endpoint: "https://mcp.slack.com/mcp",
            domain: "slack.com",
          },
        ],
      ),
    ).toMatchObject({
      kind: "mcp",
      endpoint: "https://mcp.slack.com/mcp",
      name: "Slack",
    });
  });
});
