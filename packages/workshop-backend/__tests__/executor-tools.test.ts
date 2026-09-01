import { describe, expect, it } from "vitest";
import {
  ERXES_DEFAULT_TOOL_NAMESPACE,
  executorDescribeCode,
  executorSearchCode,
  findExecutorGatekeeperId,
  formatExecutorMcpResult,
  isExecutorGatekeeper,
} from "../src/executor-tools.js";

describe("isExecutorGatekeeper", () => {
  it("matches erxes ambient gatekeepers", () => {
    expect(isExecutorGatekeeper({
      creationSpec: { type: "ambient", vendorId: "erxes" },
    })).toBe(true);
  });

  it("rejects other vendors", () => {
    expect(isExecutorGatekeeper({
      creationSpec: { type: "ambient", vendorId: "github" },
    })).toBe(false);
  });
});

describe("findExecutorGatekeeperId", () => {
  it("returns the executor gatekeeper workpiece id", () => {
    expect(findExecutorGatekeeperId(
      { EXECUTOR: { type: "workpiece", id: 42 }, GADGET: { type: "workpiece", id: 1 } },
      id => id === 42
        ? { creationSpec: { type: "ambient", vendorId: "erxes" } }
        : { creationSpec: { type: "gatekeeper", vendorId: "github" } },
    )).toBe(42);
  });
});

describe("executorSearchCode", () => {
  it("pins namespace and uses JSON encoding", () => {
    expect(executorSearchCode({ query: "customer" })).toBe(
      `return tools.search(${JSON.stringify({
        query: "customer",
        namespace: ERXES_DEFAULT_TOOL_NAMESPACE,
        limit: 12,
      })})`,
    );
  });
});

describe("executorDescribeCode", () => {
  it("calls tools.describe.tool with the path", () => {
    expect(executorDescribeCode("erxes-officenext.main.listCustomers")).toBe(
      `return tools.describe.tool(${JSON.stringify({
        path: "erxes-officenext.main.listCustomers",
      })})`,
    );
  });
});

describe("formatExecutorMcpResult", () => {
  it("returns text for ok results", () => {
    expect(formatExecutorMcpResult({
      status: "ok",
      content: [{ type: "text", text: "hello" }],
      text: "hello",
    })).toBe("hello");
  });

  it("appends structured content", () => {
    expect(formatExecutorMcpResult({
      status: "ok",
      content: [{ type: "text", text: "ok" }],
      text: "ok",
      structuredContent: { items: [1] },
    })).toContain('"items"');
  });

  it("throws on pending", () => {
    expect(() => formatExecutorMcpResult({
      status: "pending",
      actionId: 1,
      message: "needs approval",
    })).toThrow("needs approval");
  });
});
