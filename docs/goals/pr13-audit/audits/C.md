# Pull request 13 audit, C: the SDK and the servers

Auditor C. Tree `7ffd16b4` on `claude/typed-config-b1`, diff `62b6b1b3..7ffd16b4`, read in the worktree `/Users/anthonyriera/code/answerable/.claude/worktrees/typed-config-b1`. Scope: `packages/mcp` (the context, `withDatabase`, profiles, `example`, the request path), `packages/id-admin` (`createIdProfiles`, the fake ID), `packages/mcp-platform`, `mcps/toolbox`, `mcps/standalone`, the PR's changes to `mcps/admin`, `mcps/e2e`, `mcps/example`; the MCP CLI's D2, D6, D14, D15, D17 and D18.

**Headline.** The SDK changes are mostly sound: a typed `db` in every tool, one per process, isolated by organisation, is a good shape. The weight is in two places:

1. **A second serving process and a third place to run that nothing real uses.** No MCP declares `standalone`. The only `both` MCP is `e2e`, the test fixture (`mcps/e2e/mcp.json:4`). In staging and production, the standalone server, its database, its machine client and its hostname would serve the fixture alone.
2. **An ID read before every call that only the docs example uses.** `profiles` is required and read eagerly. It costs:
   - a machine client for each serving process;
   - an audit-log poller in the admin MCP;
   - an ID round trip on a cold call;
   - an outage coupling.

   Only `mcps/example`'s status tool and its preview read `person.name` or `organisation.name`.

I also found:
- **a defect, verified by probe:** the readiness probe now waits on the shared MCP pool, so a busy or slow MCP can take every Toolbox pod out of service;
- **a smaller defect:** on a cold call, the profile read waits for the grants read, against D18's own text.

## What each server reads from ID on a call (read, and probes C1 and C2)

| Server | Per request (any method that decides tools) | Per handler run (`tools/call`, prompts, resources) | Background |
| --- | --- | --- | --- |
| Toolbox | Grants: the member access view, cached 60 s per organisation, member and authorisation version. It has no stale fallback past the TTL (`mcps/toolbox/src/grants.ts:63-68`). Catalogue and host client: from its own database, every request | Member and organisation (`createIdProfiles`): cached 60 s, then served stale for up to an hour when ID fails | Audit-log poller every 15 s per replica |
| Standalone server | Nothing: a scope check on the token | Member and organisation, as above | Poller every 15 s per replica: added for profiles only |
| Admin MCP | Role: the platform organisation's member access view, uncached, read once per request (`mcps/admin/src/roles.ts:29`) | Member and organisation, as above | Poller every 15 s per replica: new in this PR, for profiles only (`mcps/admin/src/server.ts:21`) |

All three verify the token offline against ID's keys.

**Estimate, from the charts' `minReplicas` and the 15 s interval:** ID's audit log is read 24 times a minute at minimum replicas (2 replicas each of the Toolbox, the standalone server and the admin MCP), up from 8 (the Toolbox's 2) before the PR.

## Findings

### C1. The standalone server serves only the test fixture: delete it, and the `serve` choice with it
- **Verdict:** delete
- **Cost today:** high
- **Where:**
  - **The declarations:** `mcps/e2e/mcp.json:4` (`"serve": "both"`) and `mcps/example/mcp.json:4` (`"toolbox"`). No `mcp.json` says `standalone`.
  - **The server:** `mcps/standalone/**`.
  - **The chart and infrastructure:**
    - `charts/answerable/templates/standalone.yaml:1-41`;
    - `charts/answerable/values.yaml:117-128`;
    - `charts/answerable/values-civo-production.yaml:31-32`;
    - `infra/postgres/init/007-create-standalone-databases.sql`;
    - `infra/ops/src/bootstrap.ts:31,35`;
    - `infra/ops/src/register.ts:153-156`;
    - `infra/ops/src/registrar.ts:131-141`;
    - `infra/pipeline/src/smoke.ts:161`;
    - `infra/civo/envs/staging.tfvars:15` and `infra/civo/envs/production.tfvars:19`;
    - `infra/civo/modules/edge/variables.tf:42`.
  - **The admin MCP:**
    - `mcps/admin/src/standalone.ts:19-84`;
    - `mcps/admin/src/enablement.ts:1-71`;
    - `mcps/admin/src/access.ts:12-19,148-149`;
    - `mcps/admin/src/environment.ts:22-27`;
    - `mcps/admin/src/provider.ts:233`.
  - **Tests and the acceptance:**
    - `infra/k8s/local/standalone-sign-in.ts`;
    - `packages/acceptance/src/standalone.ts`.
  - **Configuration:** `default.env:103,119-143,153`.
  - **Docs:**
    - `apps/web/content/docs/mcp/index.mdx:20-30`;
    - `sign-in.mdx:26-61`;
    - `servers.mdx:83-98`;
    - the standalone parts of `claude-code.mdx`, `local-testing.mdx` and `admin/index.mdx`.
- **What it is:**
  - **One process, with its own resources.** `mcps/standalone` is one process serving each `standalone` or `both` MCP at `https://mcp.<zone>/<name>/mcp`. It has:
    - its own database `answerable_standalone` (intents and evidence);
    - its own serving login on `answerable_mcps`;
    - its own machine client `standalone-hub`;
    - its own Deployment (2 to 4 replicas in production);
    - its own hostname.
  - **It needs a second sign-in model.**
    - **Scopes:** `<name>:read` and `<name>:write` in the token, in place of the Toolbox's grant strings.
    - **One host client per MCP:** `claude-code-<name>`.
    - **A second staff flow:**
      - `standalone_enable`;
      - `access_grant`, which must name the client (`access.ts:12-19`).
  - **It needs a third value of `serve`.** `both` splits one MCP's intents and evidence across two databases and two hash chains.
  - **Who uses it today:** only e2e, the fixture, is served this way. The chart renders the Deployment because e2e is `both` (`values.yaml:117`: "rendered only while mcps.json has a standalone or both MCP").
- **The assumption:**
  - D2 decides *how* to host standalone MCPs: one process, not a Deployment each. It never weighs *whether* any is needed now.
  - The owner's request asked it as a question ("Is it part of the toolbox? Just standalone MCP? Standalone MCP available in Toolbox?", `docs/goals/mcp-cli/task_plan.md:7`). The owner's first stated need was "can we make one MCP we own available through the toolbox fairly easily?"
  - The docs give the reason as "when an MCP needs a sign-in of its own" (`index.mdx:30`). No MCP needs one. No number backs it.
  - Before this PR, staging and production ran no standalone MCP: e2e was mounted in the Toolbox and served alone only on a laptop (`git show 62b6b1b3:charts/answerable/templates/`).
- **Proposal:**
  - **Serve every MCP in the Toolbox.** Delete:
    - `mcps/standalone`;
    - `serve` and `--serve`;
    - `standalone_enable` and the `clientId` rule;
    - `standalone-hub`;
    - the `mcp` hostname;
    - the standalone parts of the chart, ops, pipeline, kind stack, acceptance and docs.
  - **Keep the acceptance's real-ID proof of a single-resource server.** Serve e2e with `createMcpServer` in process, as before this PR (`git show 62b6b1b3:packages/acceptance/src/journeys/e2e.journeys.test.ts`). The admin MCP stays a single-resource server in production.
  - **Add a register row.** Something like `Q-MCP-STANDALONE`, triggered by the first MCP whose users must sign in to it alone. When it fires, use the shape of C2.
  - **The smallest step, if the owner wants to defer rather than delete:**
    - make e2e `toolbox`;
    - then no standalone Deployment renders, and nothing ships to `mcp.<zone>`;
    - the code stays.
- **Removes (measured, whole files and blocks):**
  - **`mcps/standalone`:** 1,967 tracked lines, 860 of them TypeScript (419 source, 441 tests) and 853 drizzle snapshots. About 230 of those lines (the MCP migration Job, C11) move rather than go.
  - **Other whole files and blocks:**
    - `standalone.yaml`: 41 lines;
    - `007-create-standalone-databases.sql`: 20 lines;
    - admin `standalone.ts`: 84 lines;
    - admin `enablement.ts`: 71 lines;
    - the `standalone_enable` tests: +161 lines in `writes.test.ts`;
    - the `access.ts` rule: 16 added lines;
    - `standalone-sign-in.ts`: 71 lines;
    - acceptance `standalone.ts`: 52 lines.
  - **Total: about 2,250 lines,** plus parts of about 40 more files: 39 mentions in `charts.test.ts`, 19 in `stack.test.ts`, 16 in `register.ts`, 18 in `register.test.ts`, and 137 lines of `scripts/mcp`.
  - **Runtime pieces:**
    - 15 variables;
    - 1 machine client and its Secret;
    - 1 Deployment;
    - 1 database with its owner and runtime logins;
    - 1 serving login;
    - 1 network policy;
    - 1 hostname.
  - **Concepts a developer no longer learns:**
    - the `serve` field;
    - the second sign-in model (MCP scopes, one client per MCP, the `clientId` rule);
    - the second staff flow;
    - one MCP split across two evidence chains.
- **Risk:**
  - Nobody outside the team uses it, and the PR isn't merged, so nothing user-visible changes.
  - The kind stack's and the acceptance's standalone proofs go. The single-resource path stays proved by the admin MCP's journeys.
  - Bringing it back later costs about what it cost now. C2's shape is cheaper.
- **Confidence:** verified by reading (`rg` of every `mcp.json`; the chart gate; the line counts with `wc -l` and `git ls-files`; the pre-PR chart via `git show`).

### C2. If the standalone mode stays, serve it from the Toolbox's process
- **Verdict:** simplify (the alternative to C1)
- **Cost today:** high
- **Where:**
  - `mcps/standalone/src/server.ts:1-36` against `mcps/toolbox/src/server.ts:1-36`;
  - `mcps/standalone/src/environment.ts:11-36` against `mcps/toolbox/src/environment.ts:11-36`;
  - `infra/ops/src/register.ts:130,154`;
  - `mcps/standalone/src/environment.ts:32`;
  - decision D2.
- **What it is:**
  - **The two entry points are the same file.** `diff` of the two `server.ts` files differs only in names and the log line. The two `environment.ts` files differ in 45 lines once each server's name is replaced by a placeholder, out of 54 and 52.
  - **The machine client exists only for profiles.** The standalone server's client, `standalone-hub`, has `platform:read` only to read who is calling (`environment.ts:32`).
  - **The separation buys no least privilege for MCP code.** A `both` MCP's code also runs in the Toolbox, whose `toolbox-hub` holds `platform:read platform:write` (`register.ts:130`). Every MCP's code is trusted first-party code anyway (D1's lint rule).
- **The assumption:** that standalone MCPs need a process apart from the Toolbox's. D2 compared only "one shared process" against "a Deployment per MCP".
- **Proposal:**
  - Let the Toolbox also route `/<name>/mcp` and `/.well-known/oauth-protected-resource/<name>/mcp` to one `createMcpServer` per standalone MCP. That is the roughly 6 routing lines of `standalone.ts:51-55`.
  - Use the Toolbox's database for intents and evidence, its pool to `answerable_mcps` and its machine client.
  - Keep `standalone_enable` and the per-MCP resource and client.
- **Removes (estimate):** about 1,500 lines of `mcps/standalone`, plus:
  - its database and logins;
  - `standalone-hub`;
  - its Deployment;
  - its network policy;
  - its migration Job for its own database;
  - about 12 variables.
- **Risk:** the Toolbox and standalone MCPs share a failure domain. Today they share one when an MCP is `both`.
- **Confidence:** verified by reading and `diff`.

### C3. Readiness now waits on the shared MCP pool, so a busy or slow MCP takes every Toolbox pod out of service
- **Verdict:** defect
- **Cost today:** medium
- **Where:**
  - `packages/mcp-platform/src/health.ts:8-13`;
  - `mcps/toolbox/src/toolbox.ts:87,92`;
  - `mcps/standalone/src/standalone.ts:49,53`;
  - `packages/mcp-platform/src/databases.ts:21,26`: pg defaults, max 10 and no connection timeout;
  - `charts/answerable/templates/toolbox.yaml:29` and `standalone.yaml:38`: readiness is `/health`;
  - `charts/answerable/templates/_server.tpl:94-98`: no `timeoutSeconds`, so Kubernetes' default of 1 s applies.
- **What it is:**
  - `/health` runs `select 1` on the server's own pool, the shared MCP pool and each own MCP's pool. It answers only once each answers.
  - pg's pool queues waiters in order, so the check waits behind every queued tool query.
  - Before the PR, the Toolbox's `/health` checked only its own database (`git show 62b6b1b3:mcps/toolbox/src/toolbox.ts:134-141`).
- **Probe C3 results** (`probe-health.ts` and `probe-health-burst.ts`, database `audit_c_health`):

  | Load on the shared pool | `/health` answer | Time |
  | --- | --- | --- |
  | Idle | 200 | 15 ms |
  | 10 slow MCP queries holding the pool | 200, but not within 1 s | 2,815 ms |
  | 1,000 queued 10 ms queries, M9's burst size | 200 | 1,525 ms |
  | 2,000 queued 10 ms queries | 200 | 3,029 ms |

  At three failed probes, 15 s, Kubernetes takes the pod out of the Service: every MCP and the Toolbox's own tools with it.
- **The assumption:** that "every database answers" is the right readiness signal. Readiness should be about whether this pod can serve, and a saturated shared pool is load, not breakage.
- **Proposal:** readiness checks only the process and its own database, as before. If the smoke test still needs the mounted providers, it can read them from a `/health` that doesn't touch the MCP pools (or see C16). No new code.
- **Removes:** a cascading outage path. About 5 lines change.
- **Risk:** a down MCP database is no longer a readiness failure. Its tools then answer errors, as any upstream outage does.
- **Confidence:** verified by probe C3 (timings above). Kubernetes' behaviour is read only: the default `timeoutSeconds` and `failureThreshold: 3`.

### C4. Every call waits on ID for a profile only the docs example uses: read it when a tool asks
- **Verdict:** simplify
- **Cost today:** medium
- **Where:**
  - `packages/mcp/src/server.ts:53-59`: `profiles` is required;
  - `packages/mcp/src/server.ts:201-210,278-292`: `context()` awaits the profile before every handler;
  - `packages/mcp/src/definitions.ts:9-14,21-30`;
  - `packages/id-admin/src/profiles.ts:45-96`;
  - `mcps/admin/src/admin.ts:39,47,59-60` and `mcps/admin/src/server.ts:2,21-22,29`;
  - `mcps/standalone/src/standalone.ts:34-37` and `mcps/standalone/src/server.ts:21`;
  - `mcps/toolbox/src/toolbox.ts:36,71`;
  - `infra/ops/src/register.ts:153-154`.
- **What it is:**
  - Every `tools/call`, prompt and resource read first reads the member and the organisation from ID's admin API, cached 60 s.
  - The only readers of `person.name|email|groups` or `organisation.name|slug` in served code are in `mcps/example`:
    - `src/tools/example-status.ts:30-31`;
    - `src/tools/notes-add.ts:34-37`, a preview string.

    They are copies of `scripts/mcp/templates/tool.ts:59-60,112-115`. e2e reads only token ids (`records-create.ts:17-18`). The admin MCP's and the Toolbox's own tools read none (`rg`).
- **The costs:**
  - **Availability.** Probe C2 (`probe-outage.ts`): with ID's admin API down and a cold cache, a valid token calling a tool that reads nothing of the profile is refused `UPSTREAM_UNAVAILABLE`. It runs once ID is back.
  - **Latency.** The evidence report (26 October) measured 4.4 ms cached against 28.9 ms when the profile is read from ID.
  - **A new poller.** The admin MCP gained `createIdProfiles` and a 15-second audit-log poller in this PR, for data none of its tools read.
  - **A credential in every serving process.** Each one needs a `platform:read` client that can read every organisation's members. `standalone-hub` exists only for this.
  - **An awkward SDK example.** The SDK's own README example can no longer serve a provider without an ID admin credential.
- **The assumption:**
  - D17 and D18: the owner asked that tools *can* know who is calling ("so we can address who they are"), and that is met either way.
  - "Read before every call" is an implementation choice that no number backs.
- **Proposal:**
  - Keep `person.id`, `person.membershipId` and `organisation.id` from the token.
  - Move `name`, `email`, `groups`, and the organisation's `name` and `slug`, behind `await context.profile()`, read through the same cached `createIdProfiles` on first use in a request.
  - Make `profiles` optional on `createMcpServer`. A server that passes none makes `profile()` answer `INTERNAL` naming the missing option.
  - The admin MCP drops `createIdProfiles` and its poller.
  - The template's status tool calls `profile()`.
- **Removes:**
  - the admin MCP's profiles wiring and poller (about 6 lines, and 8 ID reads a minute at minimum replicas, an estimate);
  - the ID round trip on calls that don't ask;
  - the outage coupling for those calls;
  - the need for a `platform:read` client in any server whose MCPs never ask.

  It adds about 5 lines.
- **Risk:**
  - The PR also makes the profile read a liveness check: a member not in force, or one ID no longer knows, is refused `PERMISSION_DENIED` within 60 s (probe C2 confirms it). With on-demand reads that check runs only when a tool asks.
  - The Toolbox's grants read and the admin MCP's role read still refuse such a member: read only, and not probed for `effective: false`.
  - The standalone server would rely on the token's 900 s.
  - It changes D17's approved shape, so it is the owner's call.
- **Confidence:** verified (`rg` for readers; probe C2; the evidence report's numbers).

### C5. On a cold call, the profile read waits for the grants read, against D18's own text
- **Verdict:** defect
- **Cost today:** low
- **Where:**
  - `packages/mcp/src/server.ts:296`: `usable` is awaited;
  - `packages/mcp/src/server.ts:319`: `context()`, which then reads the profile;
  - `mcps/toolbox/src/toolbox.ts:43-44`: `authority` reads grants, catalogue and host client, not profiles;
  - `docs/goals/mcp-cli/decisions.md` D18: "The read runs alongside the Toolbox's existing grants read".
- **What it is:** two ID round trips in sequence on every call by a person whose cache is more than 60 s old.
- **Probe C1** (`probe-order.ts`: the Toolbox's real `createGrantsReader` and `createIdProfiles` over the fake ID at 100 ms per request):
  - the access-view read ran 1 to 104 ms;
  - the member and organisation reads ran 104 to 207 ms;
  - the cold call took 208 ms;
  - the same call cached took 2 ms.
- **The assumption:** D18 says "alongside"; the code runs them in sequence.
- **Proposal:** if C4 isn't taken, start the profile read at the start of a `tools/call` request, beside `usable`, or put it in the Toolbox's `authority` `Promise.all`. If C4 is taken, this applies only to the tools that ask.
- **Removes:** one ID round trip of latency on cold calls; about 3 lines change.
- **Risk:** a refused call may read a profile it didn't need.
- **Confidence:** verified by probe C1.

### C6. The one-hour stale window helps only the standalone server: delete it
- **Verdict:** delete
- **Cost today:** low
- **Where:**
  - `packages/id-admin/src/profiles.ts:33,45,63-70`;
  - its test, `profiles.test.ts:106`;
  - `packages/id-admin/README.md` ("served for up to an hour");
  - `apps/web/content/docs/mcp/sign-in.mdx`.
- **What it is:** when ID fails, a profile expired less than an hour ago is served. But the other two servers fail first:
  - **The Toolbox** refuses at `allow` once its grants are past their 60-second TTL. Grants have no stale fallback (`grants.ts:63-68`), so the window adds at most about 60 s there.
  - **The admin MCP** reads the role on every request with no cache (`roles.ts:29-38`), so the window never helps it.

  Only the standalone server, whose only MCP is the fixture, gets the hour. There it also serves a person's groups up to an hour old.
- **The assumption:** that a profile cache can ride out an ID outage. The caches in front of it don't.
- **Proposal:** fresh or fail, as grants are. Drop the `staleMs` option (only a test passes it, `profiles.test.ts:106`) and the stale branch.
- **Removes:** about 8 lines of code, one test, one option, and a sentence each in the README and docs.
- **Risk:** under C1's or C2's alternative, the standalone server, if kept, refuses during an ID outage once the cache expires, as the Toolbox already does.
- **Confidence:** verified by reading the three servers' read paths.

### C7. `createIdProfiles` makes the ID admin client depend on the MCP SDK: move it to `@answerable/mcp-platform`
- **Verdict:** simplify
- **Cost today:** low
- **Where:**
  - `packages/id-admin/src/profiles.ts:1`;
  - `packages/id-admin/src/index.ts:192`;
  - `packages/id-admin/package.json:16`;
  - the callers: `mcps/toolbox/src/toolbox.ts:1`, `mcps/standalone/src/standalone.ts:1`, `mcps/admin/src/admin.ts:1`.
- **What it is:**
  - Before the PR, `@answerable/id-admin` depended only on zod (`git show 62b6b1b3:packages/id-admin/package.json`). It now depends on `@answerable/mcp` for `ToolError` and `Profile`.
  - Through that, `scripts` and `packages/acceptance` now also depend on the SDK.
  - All three callers already import `@answerable/mcp-platform`, which holds the poller that invalidates the cache.
- **The assumption:** that a profile cache belongs with the HTTP client of ID's admin API.
- **Proposal:** move `profiles.ts` and its test to `packages/mcp-platform`. Export `createIdProfiles` from there.
- **Removes:** one dependency edge, ID client to SDK. The 212 lines move rather than go.
- **Risk:** none visible; the imports change.
- **Confidence:** verified by reading `package.json` before and after.

### C8. `client` in every tool's context has no reader: delete it
- **Verdict:** delete
- **Cost today:** low
- **Where:**
  - `packages/mcp/src/definitions.ts:29-30` and `server.ts:290`;
  - docs: `tools.mdx:54`, `sign-in.mdx:69`, `add-a-tool.mdx:73`;
  - tests: `server.test.ts:237-238`, `context.test.ts:64`.
- **What it is:** `client: { id }` copies `principal.clientId`. `rg` finds no reader in any MCP, template or server.
- **Every id now has two spellings and two paths.**
  - `person.id` / `principal.userId`;
  - `organisation.id` / `principal.organizationId`;
  - a test connects with `connect({ organizationId, organisation })` and seeds with `asOrganisation`.
- **The assumption:** that an object with one field will grow. That is a future with no date (D17 lists it).
- **Proposal:** drop `client`. Keep `principal` for the rest.
- **Removes:** 3 code lines, 3 doc rows and 3 test lines; one field to learn.
- **Risk:** none; nothing reads it.
- **Confidence:** verified by `rg`.

### C9. Two plans for enabling an MCP for an organisation, and the Toolbox holds `platform:write` only for the older one
- **Verdict:** simplify
- **Cost today:** medium
- **Where:**
  - `mcps/toolbox/src/admin-enable.ts:22-110`: its ID writes are at `:56,64,73,82`;
  - `mcps/admin/src/enablement.ts:24-71`, new in the PR, also used by `scripts/mcp/local-access.ts:4,37`;
  - `infra/ops/src/register.ts:130`: `toolbox-hub` holds `platform:read platform:write`;
  - `mcps/toolbox/src/environment.ts:32`;
  - decision D15.
- **What it is:**
  - **Two plans for the same rows.** The rows are a link, login and resource capabilities for both grant kinds, and a login and resource entitlement.
    - **`toolbox_enable`** asks the Toolbox's admin API, which plans them (`exists`, a 409 `Problem`).
    - **`standalone_enable`** plans them in the admin MCP (`held`, `RowConflict`) and writes ID itself.
  - **`platform:write` in the Toolbox exists for that older plan alone.** `admin-enable.ts` holds the Toolbox's only `id.manage` writes.
  - **D15's reason is contradicted.** D15 keeps the admin MCP apart because it holds `platform:write`, "which no shared process should carry". The Toolbox is that shared process, and it carries it.
- **The assumption:** that `platform:write` stays out of shared processes. It doesn't today.
- **Proposal:**
  - `toolbox_enable` writes ID's rows from the admin MCP with the one `enablementSteps` plan, the Toolbox's resource being one more resource, and patches the Toolbox resource's `allowedScopes` itself.
  - The Toolbox's admin API writes only its catalogue.
  - `toolbox-hub` drops to `platform:read`.
- **Removes:** about 70 lines of the Toolbox's plan (estimate), one of two plans, and `platform:write` from the process that runs every Toolbox MCP's code.
- **Risk:** it touches `toolbox_enable` and the Toolbox's admin API (pre-PR code) and their tests. It overlaps auditor E's machine-client review.
- **Confidence:** read only.

### C10. The `own` database mode's footprint in the servers and `mcp-platform`, for no MCP
- **Verdict:** delete (with auditor B's D1 finding)
- **Cost today:** medium
- **Where:**
  - `packages/mcp-platform/src/configuration.ts:1-25` and its test (14 lines);
  - `packages/mcp-platform/src/databases.ts:10,22-27,36,40`;
  - `packages/mcp-platform/src/testing.ts:62-89` (`testOwnMcp`);
  - `mcps/toolbox/src/environment.ts:8,12,44` and `mcps/standalone/src/environment.ts:8,12,47`;
  - `mcps/toolbox/src/test/mcps.ts:8,12-15,20,24`;
  - `mcps/toolbox/src/toolbox.test.ts:263-275`;
  - `mcps/standalone/src/server.test.ts:11-18,33,45`;
  - `mcps/standalone/src/db/migrate-mcps.ts:14,39,52-56`.
- **What it is:**
  - For each `own` MCP, every server opens its own pool, reads a variable named by the generated list (`ownDatabases`) and asserts its login.
  - The tests branch on it.
  - No `mcp.json` declares `own`.
- **The assumption:** D1's "leave the door open" (owner). No MCP walks through it, and no trigger is dated.
- **Proposal:** delete the mode here, with B's deletion in `mcp-postgres`. `Declared` becomes a provider.
- **Removes:** about 110 lines in this area (counted per file above), and the `Declared` union.
- **Risk:** none until an MCP needs isolation; the register row `Q-MCP-MOVE` already names the trigger.
- **Confidence:** verified by reading every `mcp.json`.

### C11. The migration Job for every MCP lives in the standalone server's workspace
- **Verdict:** simplify
- **Cost today:** low
- **Where:**
  - `mcps/standalone/src/db/migrate-mcps.ts:27-61`;
  - `mcps/standalone/scripts/migrate-mcps.ts:1-20`;
  - `mcps/standalone/scripts/env.ts`;
  - `charts/answerable/templates/migrations.yaml:96,110`;
  - `mcps/Dockerfile:5`.
- **What it is:** `mcps-migrate` migrates every declared MCP, Toolbox-only ones included, from code in `mcps/standalone`.
- **The assumption:** none stated. It couples C1 and C2 to an unrelated job.
- **Proposal:** move `migrateDeclared` beside `migrateMcps` in `@answerable/mcp-postgres`, or into `infra/ops`.
- **Removes:** the coupling. About 230 lines (with the test) move.
- **Risk:** none; the chart's command path changes.
- **Confidence:** verified by reading.

### C12. Two in-memory fakes of ID's admin API, both grown in this PR for the same routes
- **Verdict:** simplify
- **Cost today:** low
- **Where:**
  - `infra/ops/src/testing.ts:47-264` (`fakeIdAdmin`, +96/−22 in this PR);
  - `packages/id-admin/src/testing.ts`: `createFakeId` grew `POST /resources`, `POST /clients`, `rotate-secret`, the root secret, `lockRoot`, `staffToken` and capability `PATCH` (CHANGELOG 0.7.0);
  - `infra/ops/src/registrar.test.ts:4,7`;
  - `scripts/mcp/test/id.ts:3,10`.
- **What it is:**
  - The registrar (`infra/ops/src/registrar.ts`) is tested against infra/ops's fake.
  - `bun mcp setup` and `dev`, which use the same registrar, are tested against id-admin's.
  - Only id-admin's fake is checked against `apps/id/openapi.admin.json` (its README).
- **The assumption:** none stated.
- **Proposal:** one fake, id-admin's. Add the make-admin behaviour it lacks (joining `platform-admins` locks root, break-glass) and move the ops tests onto it.
- **Removes:** up to about 218 lines of `fakeIdAdmin`, less the routes that move (estimate: net 120 to 160), and one of two models of ID to keep in step.
- **Risk:** the ops tests change; their behaviour should not.
- **Confidence:** read only.

### C13. The docs example MCP ships to staging and production
- **Verdict:** simplify
- **Cost today:** low
- **Where:**
  - `mcps/example/mcp.json:4`;
  - `charts/answerable/mcps.json:24-38`;
  - `mcps/toolbox/src/mounted.generated.ts:4,9`;
  - `mcps/toolbox/package.json` (`@answerable/mcp-example`).
- **What it is:** `example`, "the finished example of the MCP docs", is mounted in every environment's Toolbox, with:
  - its schema and roles in `answerable_mcps`;
  - its migration on every deploy;
  - its catalogue rows.
- **The assumption:**
  - D14 justifies shipping e2e as the proof. Nothing justifies shipping the docs example.
  - The PR has no per-environment switch (`Q-MCP-ENV-SWITCH`).
- **Proposal:** either keep `example` out of the shipped lists (a docs fixture, as `mcps/example/src/docs/` already is), or fold its role into e2e.
- **Removes:** one production schema, two roles, a migration per deploy and a mounted provider.
- **Risk:** the acceptance journey "a person's name reaches a tool" (`packages/acceptance/src/journeys/mcps.journeys.test.ts:71-99`) uses `example` in its own stack, not in production.
- **Confidence:** read only.
- **Note:** the scaffold's default first tool `<name>.status` gives the stuttering wire name `example_example_status`. That is auditor D's area.

### C14. The Toolbox's ingest was rewritten in raw SQL for 200 MCPs that don't exist
- **Verdict:** simplify
- **Cost today:** low
- **Where:** `mcps/toolbox/src/catalogue.ts:19-61`.
- **What it is:**
  - A drizzle loop (two queries per tool) became one `jsonb_to_recordset` read and one CTE write per provider.
  - The evidence report's "1.6 s, probe" and "0.35 to 0.53 s, M9" ran on different Postgres instances and code, so the gain isn't measured like for like.
  - At the 2 MCPs mounted today it saves nothing visible.
- **The assumption:** that boot ingest at 200 MCPs needed to be faster. No target was set, and 1.6 s per boot meets any.
- **Proposal:** return to the drizzle loop, which reads as the rule it enforces. Or keep it, since it is tested and done. Simplicity, not correctness, is the only gain.
- **Removes:** about 10 lines and the raw-SQL idiom.
- **Risk:** none behavioural.
- **Confidence:** read only.

### C15. `bench/scale.ts` keeps compiling in the Toolbox's gates for a run nobody repeats
- **Verdict:** delete
- **Cost today:** low
- **Where:**
  - `mcps/toolbox/bench/scale.ts:1-174`;
  - `mcps/toolbox/package.json` (the `lint` script);
  - `mcps/toolbox/tsconfig.json` (`include`).
- **What it is:** a hand-run benchmark of 200 synthetic MCPs. It is typechecked and linted with every gate, and is the fourth caller of `testSharedMcps`.
- **The assumption:** that the 200-MCP numbers will be rerun. They are recorded in the evidence report.
- **Proposal:** delete it. Git history keeps it.
- **Removes:** 174 lines, and two config entries.
- **Risk:** rerunning needs `git show`.
- **Confidence:** verified by `wc -l`.

### C16. The Toolbox's public `/health` lists every mounted MCP by name
- **Verdict:** simplify
- **Cost today:** low
- **Where:**
  - `packages/mcp-platform/src/health.ts:12`;
  - `mcps/toolbox/src/toolbox.ts:87`;
  - the Ingress on `/` (`_server.tpl:159-161`);
  - `infra/pipeline/src/smoke.ts:95-106,158`.
- **What it is:**
  - Unauthenticated, on the public hostname, `/health` answers `providers: [...]`. Before the PR it answered `{ status }` alone.
  - An MCP named for a customer would be public.
  - The smoke test is the only reader.
- **The assumption:** that the smoke test must see mounts through a public, unauthenticated path.
- **Proposal:** drop `providers` from `/health`, or answer it only inside the cluster. The smoke test can check each MCP's catalogue through the Toolbox's protected admin API, or not at all. The pod's start already asserts the mounts.
- **Removes:** one field.
- **Risk:** the smoke test checks less.
- **Confidence:** verified by reading.

### C17. The SDK carries server wiring no MCP calls, and a dependency for it
- **Verdict:** simplify
- **Cost today:** low
- **Where:**
  - `packages/mcp/src/environment.ts:1-38` and `packages/mcp/src/index.ts:12`;
  - `packages/mcp/package.json` (`@answerable/config`);
  - the callers: `mcps/toolbox/src/environment.ts:40`, `mcps/standalone/src/environment.ts:41`, `mcps/admin/src/environment.ts`.
- **What it is:**
  - `parseEnvironment` is called by the three hubs alone. No MCP has a server or an environment any more (`rg` of `scripts/mcp/templates`, e2e and example).
  - The SDK depends on `@answerable/config` only for it.
- **The assumption:** that MCP authors write their own entry points. They no longer do.
- **Proposal:** move it to `@answerable/mcp-platform`.
- **Removes:** one dependency of the SDK, and one export from its public surface and reference page.
- **Risk:** none.
- **Confidence:** verified by `rg`.

## The decisions in my area

| Decision | Verdict | Why |
| --- | --- | --- |
| D2, one shared standalone server | Challenge: C1, else C2 | It decides how to host standalone MCPs, never whether any is needed. Today it serves the test fixture alone |
| D6, three places to run | Challenge: C1 | `standalone` has no user. `both` exists so that e2e can prove both paths. Without them, `--serve` and `serve` go, and agents lose a required flag |
| D14, e2e on Postgres, served `both` | Keep the Postgres part | It ends staging's per-replica data split and proves the database path. `both` falls with C1 |
| D15, the admin MCP keeps its Deployment and database | Keep the separation. Its stated reason is contradicted (C9) | The admin MCP's own tools write ID as staff. That is a reason to keep it apart. "No shared process should carry `platform:write`" is false of the Toolbox today |
| D17, the ready context | Keep `db`, `withDatabase` and the `person` and `organisation` ids. Challenge the eager profile (C4) and `client` (C8) | The typed `db`, one per process, is the right shape |
| D18, profiles from ID's admin API, cached | Challenge: eager read (C4), order (C5), stale hour (C6), placement (C7) | The data source is right; when and where it's read are not |

## What a tool author must learn today

An author meets:
- `mcp.json` (`serve` in three values, `database` in two);
- `src/mcp.ts`, whose `defineTool` differs from `@answerable/mcp`'s;
- `src/provider.ts` with `database`;
- `src/db/schema.ts` with `pgSchema`, `organisationIsolation` and `.enableRLS()`;
- drizzle migrations;
- a tool's eleven fields;
- the context's seven fields, with two spellings of every id;
- a mutation's prepare and commit;
- two sign-in models and two staff flows;
- tests from `@answerable/mcp-postgres/testing`, whose `createTestMcp` and `assertProviderConformance` have the names of the SDK's own;
- the manifest.

C1 removes `serve`, a sign-in model and a staff flow. C4 makes the profile visible where it is read. C8 removes a field. C10 removes `database`'s second value. The two same-named test helpers are auditors B and F's.

## Kept

- **`withDatabase`, `src/mcp.ts` and `schemaOf`** (`packages/mcp/src/database.ts`, 50 lines). It is the only way to give `execute` a typed `db` without per-tool generics or factories. `defineProvider` refuses a tool typed by a schema it doesn't declare, at load.
- **`callerOrganisation` and `inCall`** (`scope.ts`, 21 lines). One `db` per process with row-level security per call needs the caller's organisation reachable from the pool. A `db` per call would rebuild drizzle's relational config on every call.
- **`@answerable/mcp-platform`'s `createCalls`, `health`, `perRequest`, `startAuditPoller` and spans.** Each has 2 or 3 production callers. The admin MCP lost its own evidence wiring (`admin.ts`: +27 −39). If C1 is taken, `mcpDatabases` and `testSharedMcps` keep only the Toolbox as their server caller; moving them isn't worth it.
- **`Mount` with a `db` per provider, and `scoped()`.** A hub with several databases needs each definition to receive its own.
- **e2e on Postgres** (D14).
- **`example` on definitions, and the fixture's `examples`.** Three fixtures need inputs that depend on state (e2e, admin, `mcp-postgres`'s test). The rest read the definition.
- **`TOOLBOX_MCPS_ROLE_PREFIX` and `STANDALONE_MCPS_ROLE_PREFIX`.** Only tests set them. Roles are cluster-wide and suites run at once, and `infra/k8s/charts.test.ts:121` pins them unset in the chart. Role prefixes are B's area.
- **`ProviderDatabase.migrations`.** The deploy and the CLI use `mcps/<name>/drizzle`, but test fixtures outside `mcps/` need the provider to say where theirs are.
- **The servers' `process.exit(0)` on close.** It fixes a measured `bun --hot` hang (evidence report, M9).
- **The Toolbox's per-request server build,** which M9 measured at 10.7 to 12.3 ms at 1,000 tools a caller. This PR didn't change it, so it isn't a finding here.

## Cleanup

- **Databases:** `audit_c_health` was created and dropped twice, once per health probe run. No roles were created. After the probes, `pg_database` and `pg_roles` held nothing named `audit_c%`.
- **Copies and processes:** no copy of the tree and no `bun mcp` run. No process was left running, and no port was opened: nothing listened on 47300, 47400, 47510 or 47520 at the end.
- **Worktree:** no tracked file changed. `git status` shows only `docs/goals/pr13-audit/progress.md`, which another session modified.

  Running `bun test` in `packages/mcp` and `packages/id-admin` rewrote their git-ignored `coverage/lcov.info`. Bun ignored `--coverage-dir`, since `bunfig.toml`'s `coverageDir` wins. Every test run regenerates these files.
- **Scratch:** `probe-order.ts`, `probe-outage.ts`, `probe-health.ts`, `probe-health-burst.ts` and this report, in `/private/tmp/claude-501/-Users-anthonyriera--claude-spares-spare-qQNK1r/787e1118-e76c-4109-a85a-7962b23a9563/scratchpad/pr13-audit/C/`.
- **Suites run:**
  - `packages/mcp`: 125 pass, 2 skip, 3.1 s, no Postgres;
  - `packages/id-admin`: 28 pass, 0.28 s, no Postgres.

## Every finding, one line each

- C1, delete, high, `mcps/e2e/mcp.json:4`: the standalone server, its database, client, Deployment, hostname and second sign-in model serve only the e2e fixture; no MCP is `standalone`. Removes about 2,250 lines in whole files, 15 variables, 1 client, 1 Deployment, the `serve` choice and a staff flow.
- C2, simplify, high, `mcps/standalone/src/server.ts:1-36`: if standalone stays, serve it from the Toolbox's process; the two entry points are the same file, and the separation isolates nothing (`both` MCPs run beside `platform:write`). Removes about 1,500 lines (estimate), a database, a client and a Deployment.
- C3, defect, medium, `packages/mcp-platform/src/health.ts:8-13`: readiness `/health` waits on the shared MCP pool; a probe measured 1,525 ms behind 1,000 queued 10 ms queries and 2,815 ms behind 10 slow ones, past Kubernetes' default 1 s, so load or one slow MCP unreadies every Toolbox pod. Removes a cascading outage path (about 5 lines change).
- C4, simplify, medium, `packages/mcp/src/server.ts:278-292`: every call reads the profile from ID before running, though only `mcps/example` reads it. A probe showed a profile-free tool refused `UPSTREAM_UNAVAILABLE` when ID is down; read it on demand with `context.profile()`. Removes the admin MCP's poller and profiles, a cold round trip, and the outage coupling.
- C5, defect, low, `packages/mcp/src/server.ts:296,319`: the profile read waits for the grants read (probe: 208 ms cold at 100 ms per ID request, against D18's "alongside"). Removes one round trip; about 3 lines change.
- C6, delete, low, `packages/id-admin/src/profiles.ts:63-70`: the one-hour stale window can help only the standalone server, since the Toolbox's grants and the admin MCP's role fail first. Removes about 8 lines, an option, a test and two doc sentences.
- C7, simplify, low, `packages/id-admin/package.json:16`: `createIdProfiles` made the ID admin client depend on the MCP SDK; move it to `mcp-platform`, where all three callers already import from. Removes one dependency edge (212 lines move).
- C8, delete, low, `packages/mcp/src/definitions.ts:29-30`: `context.client` has no reader and copies `principal.clientId`. Removes 3 code lines, 3 doc rows and 3 test lines.
- C9, simplify, medium, `mcps/toolbox/src/admin-enable.ts:22-110`: two plans enable an MCP for an organisation, and the Toolbox holds `platform:write` only for the older one, contradicting D15's reason. Removes about 70 lines (estimate) and `platform:write` from the shared process.
- C10, delete, medium, `packages/mcp-platform/src/configuration.ts:1-25`: the `own` mode's pools, variables, assertions and test branches in the servers serve no MCP. Removes about 110 lines here, plus B's share.
- C11, simplify, low, `mcps/standalone/src/db/migrate-mcps.ts:27`: the Job that migrates every MCP lives in the standalone server's workspace. Removes the coupling (about 230 lines move).
- C12, simplify, low, `infra/ops/src/testing.ts:47-264`: two fakes of ID's admin API grew the same routes in this PR. Removes about 120 to 160 lines net (estimate).
- C13, simplify, low, `mcps/example/mcp.json:4`: the docs example ships to staging and production. Removes a production schema, two roles and a mounted provider.
- C14, simplify, low, `mcps/toolbox/src/catalogue.ts:19-61`: the ingest became raw SQL for 200 MCPs that don't exist, with no like-for-like measurement. Removes about 10 lines and the raw-SQL idiom.
- C15, delete, low, `mcps/toolbox/bench/scale.ts:1-174`: a hand-run benchmark compiled in every gate. Removes 174 lines.
- C16, simplify, low, `packages/mcp-platform/src/health.ts:12`: the Toolbox's public, unauthenticated `/health` now lists every mounted MCP. Removes one field.
- C17, simplify, low, `packages/mcp/src/environment.ts:1-38`: `parseEnvironment` serves only the three hubs, yet ties the SDK to `@answerable/config`. Removes one SDK dependency and one export.
