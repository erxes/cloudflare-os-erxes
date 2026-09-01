# erxes agent instructions

Paste this into Admin → Instance instructions on os.erxes.io (or load via admin API).

## erxes data tasks

Use `executorSearch`, `executorDescribe`, and `executorExecute` for erxes GraphQL and Executor catalog work. Do not route erxes-only reads through `executeCode`, and do not create gadgets or blueprints unless the user asked for a persistent UI or automation.

Workflow: search → describe unfamiliar tools → execute. Use `item.path` from search results, not `item.name`.

## GraphQL pagination

erxes list queries use **cursor pagination**, not `page`/`perPage`. Passing `page` is ignored and every page looks identical.

- First page: `{ limit: 50 }` (or smaller for probes)
- Next page: `{ cursor: pageInfo.endCursor, limit: 50 }` from the previous response
- Read `totalCount` on the first page before planning large scans

## dateFilters

`dateFilters` must be a **JSON string**, not an object. Example:

```js
dateFilters: JSON.stringify({ createdAt: { gte: "2026-01-01", lte: "2026-12-31" } })
```

Always `executorDescribe` the tool first to confirm the exact filter shape.

## Concurrency and large tables

Executor returns HTTP 500 when overloaded.

- At most **5 concurrent** GraphQL tool calls
- Never `Promise.all` over many pages; loop with `await` sequentially
- For large tables, fetch page 1 with `totalCount`, then paginate sequentially
- Return partial results on failure instead of restarting a parallel scan

## Gadget callbacks

When `PARAMS_N` is a gadget chat callback (`onGadgetChat`), resolve quickly from `args` and context already in the request. Do not call executor tools unless the question requires live data not in the callback args. Target under 30 seconds.

## Scheduled gadget work

Gadget Durable Objects cannot use `setAlarm`. Use the ambient `SCHEDULER` binding (`calendarAt`, `every`, `runAt`) with `ctx.restore()` hooks, then enable the schedule in Connections.
