# Erxes ↔ CF OS ↔ Executor integration: problem statement

**Date:** 2026-08-28  
**Scope:** Passwordless SSO from OfficeNext (`officenext.erxes.io/cf-os`) into Cloudflare OS (`os.erxes.io`), with per-user Executor provisioning (`executor.os.erxes.io`) and agent access to erxes GraphQL tools via the `EXECUTOR` binding.

**Purpose:** Describe observed failures, architectural tensions, and invariants we keep violating. This document intentionally does **not** propose fixes.

---

## 1. What we are trying to make true

A user signed into OfficeNext opens Command (`/cf-os`). An iframe loads CF OS with a fresh single-use connect code. CF OS completes SSO without a password form. The user lands in a workspace and can ask the agent questions that call live erxes data through Executor GraphQL tools.

The user should not manually connect resources, log out and back in, or wait on opaque spinners. The erxes gatekeeper connection and EXECUTOR ambient binding should exist because they signed in through the embed path.

---

## 2. System map (as implemented today)

| Layer | Role |
|-------|------|
| **cf_os_ui** (erxes-private) | Embeds `os.erxes.io?cfOsCode=…` in an iframe; mints connect code via `POST /pl:erxes-agent/cf-os/connect-code` |
| **CF OS client** (`workshop-frontend`) | Dashboard SSO handoff: stash code, redeem before React render, clear stale `localStorage.authToken` when code present |
| **gatekeeper-erxes** | `connectAccount` + `loginWithCode` → `ErxesLoginAccount.complete()` → activates account, notifies workshop backend |
| **Executor host** | `POST /os/provision` creates/backfills erxes GraphQL connection and tool catalog (~1,500 tools, D1 writes) |
| **workshop-backend overseer** | `ensureAmbientCapsules()` wires singleton erxes account → `ExecutorGatekeeper` as ambient capsule; `prepareChatBindings()` folds ambient gatekeepers into chat `env` as `EXECUTOR` |
| **Agent runtime** | Expects `env.EXECUTOR` MCP bridge to personal Executor workspace with live erxes session cookie |

Two Cloudflare accounts are involved in deployment (personal vs erxes Inc). `.envrc` pins `CLOUDFLARE_ACCOUNT_ID` to erxes Inc for this checkout.

---

## 3. Incident timeline (2026-08-28)

### 3.1 Original bug (fixed, merged)

After logout from OfficeNext and login as another user, CF OS showed the previous user's workspace. Root cause: CF OS reused `localStorage.authToken` on `os.erxes.io` instead of honoring fresh `cfOsCode` handoff. Fixed in PR #17 (cloudflare-os-erxes) and PR #428 (erxes-private iframe `key={userId}`).

### 3.2 Passwordless spinner (fixed, deployed)

Post-fix regression: "Continue with erxes" spinner stuck forever. Server login succeeded but client dropped token / blocked on synchronous provisioning. Multiple client bugs fixed in PR #18; deployed to `os.erxes.io`.

### 3.3 Login blocked on provisioning (patched live, not committed)

Gatekeeper logs showed `GatekeeperVendor.connectAccount` killed by Workers runtime: synchronous `await provisionExecutor()` in `complete()` blocked until timeout. **Live patch:** `provisionExecutor()` moved to `ctx.waitUntil()` so SSO returns immediately. Deployed gatekeeper version `908a113b-57dc-458c-98c6-d04d4717112d`. Change not yet committed to git.

### 3.4 Executor slowness (partially addressed)

First login provision took ~90s: 301 redirect loops (missing `global_fetch_strictly_public`), sequential D1 inserts (~1,585 tools), synchronous `produceConnectionTools`. Executor PR #3 added D1 batching, returning-user fast path, offline introspection snapshot. Deployed to `executor.os.erxes.io`.

### 3.5 Current regression: EXECUTOR binding missing after SSO

After gatekeeper `waitUntil` deploy, SSO completes in seconds (verified via gatekeeper tail + Helium CDP on `/cf-os`). User reaches CF OS home/workspace. Agent prompt ("list 3 erxes contacts using graphql tools") fails:

- `describeBinding("EXECUTOR")` → `There is no binding named "EXECUTOR" in your env`
- `Object.keys(env)` → `[]`
- `listConnectableResources("executor")` → no vendors

Observed via:
- Direct `os.erxes.io` tab (same browser session)
- `officenext.erxes.io/cf-os` iframe (agent-browser nested refs + CDP on iframe's `os.erxes.io` target)

Agent correctly refuses to hallucinate contact data. User expectation: resource is automatic; no logout, no manual "Add resource."

---

## 4. Problem catalog

### P1. Login latency vs login completeness are coupled on one critical path

`ErxesLoginAccount.complete()` historically did:

1. `await provisionExecutor()` (tens of seconds, can exceed Worker subrequest limits)
2. `activate()` + `callback.complete()` (creates connected account, finishes SSO)

These steps are sequential. Blocking on (1) breaks SSO. Deferring (1) with `waitUntil` unblocks SSO but allows (2) and all downstream wiring to proceed before Executor exists.

**Symptom:** User is "signed in" while their Executor workspace may not exist, may be mid-provision, or may have failed silently (logged as `auth.provision.failed` only).

### P2. Ambient EXECUTOR wiring assumes Executor MCP is live at workspace-open time

`ensureAmbientCapsules()` (on workspace `open()`):

1. Reads owner's singleton connected accounts (`ErxesUser` from erxes gatekeeper)
2. Gets `ExecutorGatekeeper` class via `getSingletonGatekeeperClass()`
3. `addGatekeeper()` with `creationSpec: { type: "ambient", vendorId: "erxes", accountId }`

`ExecutorGatekeeper.describe()` calls `this.tools()`, which reaches Executor MCP over the network. If Executor is not provisioned or MCP session cannot start, capsule install fails. Failure is **best-effort per account** (`ambient.capsule.provision.failed` logged); workspace open continues.

**Symptom:** User has erxes connected account but no ambient EXECUTOR gatekeeper record on the workspace.

### P3. Chat binding freeze can permanently omit EXECUTOR for a chat

`prepareChatBindings()` on first agent turn:

- Freezes `alwaysAvailableCapsuleIds` from current ambient gatekeepers in workspace storage
- Folds ambient gatekeepers into seed binding map as `EXECUTOR` (via `suggestedBindingName`)

If ambient set is empty at first turn (because P2 failed), chat seeds with empty EXECUTOR. Comment in code: new singletons only appear in chats started afterwards; frozen list includes disconnected gatekeepers as inert entries.

**Symptom:** Even if EXECUTOR capsule is added later, existing chats may never see it depending on freeze timing and chat lifecycle.

### P4. No user-visible signal that Executor provisioning is in progress or failed

Background `waitUntil` provisioning:

- Success/failure only in gatekeeper logs (`auth.provision.failed`)
- No UI state on CF OS home ("tools syncing…")
- No retry of `ensureAmbientCapsules()` triggered by provision completion
- Agent system prompt/documentation tells agent EXECUTOR exists for every signed-in user, which is false during the gap

**Symptom:** Agent confidently attempts EXECUTOR, gets empty env, tells user to sign out and back in (wrong advice for this failure mode).

### P5. Three separate "ready" states with no shared readiness model

Independent readiness predicates:

| Component | "Ready" means |
|-----------|---------------|
| CF OS auth | Valid token / completed SSO callback |
| Erxes connected account | `ErxesUser` exists on user DO, identity in login account DO |
| Executor workspace | `/os/provision` succeeded, GraphQL connection + tools in D1 |
| EXECUTOR ambient capsule | Gatekeeper record on workspace DO, MCP reachable |
| Chat env | `prepareChatBindings` seeded `EXECUTOR` into binding map |

Nothing coordinates these. Each layer assumes the others are done because the user "signed in."

### P6. First-time provision is inherently expensive

Even with perf work, first login still implies:

- HTTP provision call from gatekeeper → executor
- GraphQL introspection / tool catalog materialization
- Large D1 batch writes

This work cannot complete in the same wall-clock window as a responsive SSO redirect unless radically redesigned. Current architecture treats it as part of login or immediately after login with no backpressure on the UI.

### P7. Embed path adds constraints not exercised in direct navigation testing

`/cf-os` iframe:

- Cross-origin (parent `officenext.erxes.io`, child `os.erxes.io`)
- Connect code single-use (opening same code in second tab invalidates)
- `localStorage.authToken` is CF-OS-only, separate from erxes cookies
- Browser automation: iframe refs work via agent-browser snapshot inlining; CDP target for OOPIF is not always obvious

Testing only on a direct `os.erxes.io` tab misses embed-specific timing (parent loads iframe while SSO in flight) and session isolation assumptions.

### P8. Operational fragility across two Cloudflare accounts

Deploy requires erxes Inc account pin via direnv. Wrangler OAuth tokens expire independently. Failed deploys and partial deploys (gatekeeper live, executor live, client live) create version skew. No single "integration health" check validates end-to-end: SSO → provision → ambient capsule → agent tool call.

### P9. Regression pattern: each fix optimizes one edge and breaks the contract

Observed cycle:

1. Fix session isolation → expose login spinner
2. Fix login spinner → expose synchronous provision hang
3. Defer provision with `waitUntil` → fix hang → expose missing EXECUTOR
4. Executor perf reduces duration but does not change readiness semantics

Each patch addresses the loudest symptom without a documented integration contract or readiness gate.

---

## 5. Observable failure modes (acceptance criteria we miss)

| # | Scenario | Expected | Actual (2026-08-28) |
|---|----------|----------|---------------------|
| F1 | User opens `/cf-os` while signed into OfficeNext | iframe SSO → workspace in few seconds | SSO OK after gatekeeper deploy |
| F2 | User sends agent prompt using erxes data | EXECUTOR tools called, real data returned | `env` empty, no EXECUTOR binding |
| F3 | First-time user, first login | Tools available without manual connect | Provisioning async; ambient wiring often fails |
| F4 | Returning user | Fast path, tools immediately available | Untested end-to-end post-`waitUntil` deploy; fast path exists in executor but ambient may still be missing if P2 failed once |
| F5 | Provision failure | User sees actionable error | Silent log only |
| F6 | User switches erxes account in OfficeNext | CF OS session matches iframe user | Fixed via PR #17/#428 (separate from EXECUTOR issue) |

---

## 6. Code locations (for reviewers)

| Concern | Path |
|---------|------|
| Login + deferred provision | `packages/gatekeeper-erxes/src/erxes.ts` → `complete()`, `provisionExecutor()` |
| Singleton account + Executor gatekeeper | same file → `ErxesUser`, `ExecutorGatekeeper` |
| Ambient capsule wiring | `packages/workshop-backend/src/overseer.ts` → `ensureAmbientCapsules()`, `open()` |
| Chat EXECUTOR binding | same file → `prepareChatBindings()` |
| Dashboard SSO client | `packages/workshop-frontend/src/dashboardSso.ts`, `main.tsx` |
| Embed + connect code | `erxes-private/frontend/plugins/cf_os_ui/` |
| Executor provision endpoint | `executor/apps/host-cloudflare/src/worker.ts` |
| Provision perf | `executor/packages/core/sdk/src/executor.ts`, D1 batch adapter, introspection snapshot |

---

## 7. Invariants we intended (but do not enforce)

1. **Embed sign-in implies EXECUTOR.** Signing in through erxes gatekeeper connects erxes data to Executor; agent env should expose `EXECUTOR` without user action.
2. **SSO must not hang.** User must not wait on tool catalog generation to see the shell.
3. **No cross-user session bleed.** CF OS token must follow erxes identity (addressed separately).
4. **Agent must not guess erxes data.** Empty env should not produce fabricated contacts (agent behavior is correct; platform is wrong).

These invariants conflict under load: (1) and (2) cannot both hold if provisioning remains on the critical path with no readiness coordination.

---

## 8. Open questions (problem framing, not solutions)

- What is the **unit of readiness** for "user can call erxes tools"? Is it login completion, provision completion, ambient capsule presence, or first successful MCP `tools/list`?
- Should the embed path have a **different contract** than direct `os.erxes.io` navigation?
- When ambient capsule install fails transiently, what is the **expected recovery** without user intervention?
- Is Executor provisioning **part of auth** or **part of workspace initialization** or **part of first agent turn**? Code currently spans all three with no owner.
- How do we **test** the full chain in CI without Helium/manual CDP?

---

## 9. What we explicitly do not want (constraints for future design)

- Telling users to log out and back in as the primary recovery path
- Manual "Add resource" for EXECUTOR after erxes SSO
- Retry loops that paper over races without a defined readiness state
- Further one-line deferrals (`waitUntil`, timeouts, fire-and-forget) without reconciling downstream consumers

---

*End of problem statement. No solutions prescribed.*
