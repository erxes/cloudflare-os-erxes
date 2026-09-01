import type { WorkpieceId } from "@gadgets/workshop-shared/api";

export const ERXES_EXECUTOR_VENDOR_ID = "erxes";
export const ERXES_DEFAULT_TOOL_NAMESPACE = "erxes-officenext";

type ExecutorMcpResult =
  | { status: "ok"; text: string; structuredContent?: unknown; isError?: boolean }
  | { status: "pending"; message: string }
  | { status: "rejected"; message: string }
  | { status: "failed"; message: string };

export type ChatBindingEntryLike =
  | { type: "workpiece"; id: WorkpieceId }
  | { type: "value"; messageSequence: number };

export type GatekeeperRecordLike = {
  creationSpec?: { type?: string; vendorId?: string };
};

export function isExecutorGatekeeper(record: GatekeeperRecordLike): boolean {
  let spec = record.creationSpec;
  return spec?.type === "ambient" && spec.vendorId?.toLowerCase() === ERXES_EXECUTOR_VENDOR_ID;
}

export function findExecutorGatekeeperId(
  bindings: Record<string, ChatBindingEntryLike>,
  gatekeeperOf: (id: WorkpieceId) => GatekeeperRecordLike | undefined,
): WorkpieceId | undefined {
  for (let entry of Object.values(bindings)) {
    if (entry.type !== "workpiece") continue;
    let record = gatekeeperOf(entry.id);
    if (record && isExecutorGatekeeper(record)) return entry.id;
  }
  return undefined;
}

export function executorSearchCode(input: {
  query: string;
  namespace?: string;
  limit?: number;
}): string {
  return `return tools.search(${JSON.stringify({
    query: input.query,
    namespace: input.namespace ?? ERXES_DEFAULT_TOOL_NAMESPACE,
    limit: input.limit ?? 12,
  })})`;
}

export function executorDescribeCode(path: string): string {
  return `return tools.describe.tool(${JSON.stringify({ path })})`;
}

export function formatExecutorMcpResult(result: ExecutorMcpResult): string {
  switch (result.status) {
    case "ok": {
      let text = result.text;
      if (result.structuredContent !== undefined) {
        text += `\n\n${JSON.stringify(result.structuredContent, null, 2)}`;
      }
      if (result.isError) {
        throw new Error(text || "Executor tool reported an error.");
      }
      return text;
    }
    case "pending":
      throw new Error(result.message);
    case "rejected":
    case "failed":
      throw new Error(result.message);
    default:
      result satisfies never;
      throw new Error("Unexpected Executor MCP result.");
  }
}
