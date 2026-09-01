/** Shared erxes Executor guidance for agent prompts, gatekeeper types, and deploy. */

export const ERXES_EXECUTOR_MAX_CONCURRENT = 5;
export const ERXES_EXECUTOR_MAX_DESCRIBE_PER_TURN = 3;

export const ERXES_EXECUTOR_TOOL_NAMES =
    "`executorExecute`, `executorSearch`, and `executorDescribe`";

export const ERXES_EXECUTOR_TYPES_COMMENTS = `
// Use item.path (not item.name) with tools.describe.tool({ path }) and tools[path](input).
// Tool calls return { ok: true, data } or { ok: false, error }. Check .ok; they do not throw for
// expected failures. Nested GraphQL fields still need select, e.g. select: "list { _id name } totalCount".
// Outer braces on select are optional. The tools object is a lazy proxy and cannot be enumerated.
//
// erxes GraphQL pagination uses cursor + limit, not page/perPage. dateFilters is a JSON string.
// Example: { cursor: undefined, limit: 50, dateFilters: JSON.stringify({ createdAt: { gte: "2026-01-01" } }) }
//
// GraphQL paging guardrails (Executor returns HTTP 500 when overloaded):
// - At most ${ERXES_EXECUTOR_MAX_CONCURRENT} concurrent GraphQL tool calls; prefer sequential page fetches.
// - Never Promise.all over many pages; loop with await and a small concurrency cap.
// - For large tables, fetch page 1 with totalCount first, then page sequentially.
// - Return partial results on failure instead of retrying the whole scan in parallel.
// - Describe only tools you will call this turn; max ${ERXES_EXECUTOR_MAX_DESCRIBE_PER_TURN} executorDescribe calls before the first executorExecute.`.trim();

export const ERXES_EXECUTOR_EXECUTE_GUIDANCE =
    `erxes list queries use cursor + limit, not page/perPage. \`dateFilters\` must be a JSON string. ` +
    `At most ${ERXES_EXECUTOR_MAX_CONCURRENT} concurrent GraphQL calls; page sequentially, never ` +
    `Promise.all over many pages. Describe only tools you will call this turn (max ` +
    `${ERXES_EXECUTOR_MAX_DESCRIBE_PER_TURN} executorDescribe before first executorExecute).`;

export const ERXES_EXECUTOR_SEARCH_GUIDANCE =
    `Use \`item.path\` (not \`item.name\`) when calling or describing tools.`;

export const ERXES_EXECUTOR_DESCRIBE_GUIDANCE =
    `Describe only tools you will call this turn. Max ${ERXES_EXECUTOR_MAX_DESCRIBE_PER_TURN} ` +
    `executorDescribe calls before the first executorExecute.`;

export const ERXES_INSTANCE_INSTRUCTIONS = `# erxes agent instructions

## erxes data tasks

Use ${ERXES_EXECUTOR_TOOL_NAMES} for erxes GraphQL and Executor catalog work. Do not route erxes-only reads through \`executeCode\`, and do not create gadgets or blueprints unless the user asked for a persistent UI or automation.

Workflow: search → describe unfamiliar tools → execute. Use \`item.path\` from search results, not \`item.name\`.

## GraphQL pagination

erxes list queries use **cursor pagination**, not \`page\`/\`perPage\`. Passing \`page\` is ignored and every page looks identical.

- First page: \`{ limit: 50 }\` (or smaller for probes)
- Next page: \`{ cursor: pageInfo.endCursor, limit: 50 }\` from the previous response
- Read \`totalCount\` on the first page before planning large scans

## dateFilters

\`dateFilters\` must be a **JSON string**, not an object. Example:

\`\`\`js
dateFilters: JSON.stringify({ createdAt: { gte: "2026-01-01", lte: "2026-12-31" } })
\`\`\`

Always \`executorDescribe\` the tool first to confirm the exact filter shape.

## Concurrency and large tables

Executor returns HTTP 500 when overloaded.

- At most **${ERXES_EXECUTOR_MAX_CONCURRENT} concurrent** GraphQL tool calls
- Never \`Promise.all\` over many pages; loop with \`await\` sequentially
- For large tables, fetch page 1 with \`totalCount\`, then paginate sequentially
- Return partial results on failure instead of restarting a parallel scan
- Max **${ERXES_EXECUTOR_MAX_DESCRIBE_PER_TURN}** \`executorDescribe\` calls before the first \`executorExecute\`

## Gadget callbacks

When \`PARAMS_N\` is a gadget chat callback (\`onGadgetChat\`), resolve quickly from \`args\` and context already in the request. Do not call ${ERXES_EXECUTOR_TOOL_NAMES} unless the question requires live data not in the callback args. Target under 30 seconds.

## Scheduled gadget work

Gadget Durable Objects cannot use \`setAlarm\`. Use the ambient \`SCHEDULER\` gatekeeper binding (\`calendarAt\`, \`every\`, \`runAt\`) with \`ctx.restore()\` hooks, then enable the schedule in Connections.
`.trim();
