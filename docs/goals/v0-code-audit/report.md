# v0 code audit of Answerable ID: report and plan

20 October 2026, tree `60c98f65`. The fourth and last pass over the service before v0. Five audits ran in isolated worktrees against their own Postgres 17 ([audits/](audits/a.md): A the auth layer, B1 the admin API contract, B2 services and the database runtime, C shell, operations, pages, packages and docs, D the mechanical baseline). Every delete and simplification below was spiked and run; every number has a probe behind it (`/tmp/v0-code-audit/probes/<letter>/`, listed in each audit's section 1). The coordinator re-ran the rate-limit probe and read the break-glass, flood and wrong-secret logs; the greps that hold the smaller claims are in [progress.md](progress.md).

## The verdict in one paragraph

The code is clean at the line level: knip, unused locals, suppressions and `any` are all zero, duplication is 1.9%. What the earlier passes could not see is structure that exists because of an assumption, and six of those assumptions fail: Better Auth's default rate limits are live and refuse an office's morning sign-ins; a flood of bad bearers writes thousands of permanent audit rows a second; the documented break-glass recovery replays old receipts and restores nobody; a replica with a wrong application secret starts and reports ready; a sign-in that takes a disabled user's email leaves no audit trace on that user; a no-op writes an audit event. Beyond those, about 1,250 source lines, 1,200 test lines, 460 doc lines and two production dependencies can go without any consumer noticing, and the admin API loses one of its two authorisation layers, a scope nobody requires, three routes nobody calls and its mandatory idempotency header. The rest was challenged and holds, with a measured reason each.

## Unsafe or wrong (fix before v0)

| # | Finding | Evidence | Fix |
| --- | --- | --- | --- |
| U1 | **Rate limits refuse ordinary traffic.** `createAuth` sets no `rateLimit`, so production runs Better Auth's defaults per client address per process: `sign-in/sso` 3 per 10 s, `oauth2/authorize` 30 per minute, `oauth2/token` 20 per minute, `get-session` and `sso/callback` 100 per 10 s. An office behind one NAT address gets 18 sign-ins a minute per replica; a server-side host refreshing 300 users' tokens from one address is refused at the 21st. | A probe 08, re-run by the coordinator; `better-auth/dist/api/rate-limiter/index.mjs:302-315`, `@better-auth/oauth-provider/dist/authorize-BmTe2VYG.mjs:5235-5266` | A deliberate `rateLimit` configuration sized for shared addresses, documented as a capacity limit; `Q-ADMIN-API-RATE-LIMIT` stays open |
| U2 | **Anonymous requests write permanent audit rows.** Every missing or invalid bearer on `/api/admin` and every refused machine token or forged SSO callback inserts an audit row before the 401. One client wrote 3,922 rows a second (358 B of table and index plus 818 B of WAL each); an unsigned JWT's `client_id` is stored as sent, up to 12,224 B a row. Without the insert the same flood ran at 20,951 requests a second and wrote nothing. A legitimate read's p95 rose from 29 to 116 ms under the flood; the Toolbox poller spent 353 requests finding nothing. Nothing reads these rows. | B1 probes 02a–f, 03, 10, 11; A probe 07 | Log unauthenticated refusals (request id, address, reason); keep the row once the credential verified (`admin.denied`, `user_disabled`, `oauth.token.rejected` after client authentication) |
| U3 | **Break-glass recovery is a no-op.** `make-admin` and docs/06 step 7 reuse fixed `Idempotency-Key`s, so after the last administrator leaves, ID replays the old receipt (`201`, `applied`, no membership) and a different person gets `409 idempotency_key_reused`. Receipts cannot expire: the runtime role only inserts and reads them and audit events reference them. | B1 probe 04b | Fresh key per invocation in `make-admin` and generated keys in the docs (B1-U1); make `Idempotency-Key` optional with a server key so readers stop copying constants (B1-1) |
| U4 | **A replica with a wrong application secret starts and reports ready.** `/readyz` and `/auth/jwks` answer 200; Better Auth decrypts the newest key only when it signs, so a typo or a bad rotation rolls to every pod and every issuance then fails 500. | C probe 06; `better-auth/dist/plugins/jwt/sign.mjs:55-66` | Decrypt the newest `jwks` row before `Bun.serve`; refuse to start on failure (C probe 06b, about 15 lines). With `maxUnavailable: 0` the old pods keep serving |
| U5 | **An email takeover at sign-in is unaudited.** When a new directory identity signs in with an email a disabled user holds, `services/federation.ts:228-236` moves it to `retired_email` and writes only the new user's `auth.signin.succeeded`; no event and no `audit_event_users` row for the holder. The admin route doing the same records `user.email_retired`. | B2 probe 10; coordinator grep: no `user.email_retired` writer in federation | Record `user.email_retired` for the holder in that branch with the system actor |
| U6 | **A no-op writes an audit event.** `DELETE /users/:id/sessions` records `session.revoked_all` when nothing changed; the receipt says `noop`. A test pins it. | `services/sessions.ts:74-86` | `if (changed)` around the event; the test's second iteration expects none |

Also wrong, smaller: responses expose internal `deletedAt` and `live` fields no schema declares (B1 probe 08); docs/06 and onboard.mdx use different fixed keys for the same steps; the public docs describe a replay audit event and version-three deletion facts that do not exist (`sign-in.mdx:178`, `manage.mdx:172,780`); "eleven" RLS tables (ten), `Q-SECRET-STORE` listed as open, "topology not supplied" (docs/12 supplies it); the restore runbook runs the preflight on serving pods while `OPERATIONS.md` says stop writers; the fake ID answers `forbidden` where real ID answers `insufficient_scope`; `user-oauth.integration.test.ts:1246` compares `expires_in` across a second boundary and flakes under load; `/auth/ok` is allowlisted with no caller.

## Delete

| Id | What | Lines | Why it can go | Holds after |
| --- | --- | --- | --- | --- |
| A2 | The issuance assertions (`user-token-assertions.ts`, its bookkeeping in `user-token-boundary.ts`) and the three fault-injection tests | −206 source, −164 test | They compare Better Auth's output with inputs ID gave it in the same transaction; 1,167 of 1,170 tests pass without them, the 3 that fail inject the fault themselves; no real catch in the history | The pre-issuance policy check and the claims callback |
| A2b | `OAUTH_REFRESH_REUSE_INTERVAL_SECONDS` | −10, docs | 0 in every deployment; the only path on which the assertions had real work | Native rotation at interval 0; `Q-REFRESH-PARALLEL` changes a constant later |
| A4 | Upstream refresh-token storage, `UPSTREAM_TOKEN_SECRETS`, the preflight's account scan, the bootstrap step, the pipeline, chart and kind entries, the custody docs | −130 app, −350 test, −40 infra, docs | Nothing reads the token; it is held for `Q-AID-RECHECK`, which is Not yet; it is a live Microsoft refresh token for every Entra user in a backup. Stop requesting `offline_access` (Entra's consent screen loses "maintain access") | Federation and sign-in suites; the column stays null |
| C2 | The custody preflight (`preflight.ts`, `scripts/operations-preflight.ts`, `ops:preflight`, the runbook section) | −84 −39 −88 test | With A4 gone, its remaining job is the startup check U4 does | The startup check and its test |
| B1-3a | The `authorize` tier middleware, `tier`, `Tier`, `tierOf`, `x-tier` | −75 source, −200 test | With it off, 142 tests fail and every one is a missing denial row or 403 where 404 was expected; no 2xx, no leak: `authorizeCommand` inside the transaction refuses everything it refuses. `tier` is read by nothing in production | The 404 rule and the `admin.denied` row move into `authorizeCommand`; the route matrix and `tenant-separation` suites |
| B1-3b | `org:write` | −1, 3 fixtures | No route requires it | Five scopes |
| B1-5 | `getMemberConfiguration`, `getOperationStatus`, `revokeUserSession` | −55, −67, −60 source; ~−300 test | Docs-only or no caller; `getMember` already returns the revision; a caller holds an operation id only from a response it already has; revoke-all ends the same session | `getMember` sends the ETag; `?operationId=` on audit events |
| b2-1 | The per-lock `revalidate()` (15 call sites in 9 query modules) | −23 | A staff command re-runs its whole 19-statement authority check after every row lock; the first check already share-locks every row that could revoke authority, so only time can pass (at most 2 s per lock wait). PATCH entitlement goes from 129 to 53 statements. Machine callers skip it already | The share locks; one test goes (owner decision D6 on exact expiry) |
| b2-4 | Ten read services whose body is one query call | −57 | The branded context on the query is the authority boundary | Routes import the query, as `audit-events.ts` does |
| b2-6 | `scripts/test-migrations.ts` | −76, a CI step | Each assertion is held by `db:test:migrate` and four migration tests | CI runs `bun --filter @answerable/id test` |
| b2-7 | `scripts/regenerate-migrations.ts` | −58 | Unusable once staging holds receipts; delete at B7a, not "after production" | The receipt check |
| b2-8 | `queries/health.ts` | −7 | One `select 1` | Inlined in `app.ts` |
| C8 | `scripts/export-openapi.ts` | −37 | `UPDATE_SNAPSHOT=1` in the snapshot test writes byte-identical files; one mechanism in the repo, as the MCP manifests | The snapshot test |
| C12 | Four changelog reports (`id-initial-migration`, `id-operations`, `id-release-acceptance`, `id-soft-deletion`) | −402 | Each describes a state that no longer exists (28 tables, migration 0047, 49 mutations); their banners say superseded | Six links repointed |
| A8b | `/auth/ok` from the allowlist | −5 | No caller | The 15 other routes |

## Simplify

| Id | What | Lines | Why |
| --- | --- | --- | --- |
| B1-1 | `Idempotency-Key` optional: a command without one is journalled under a server key; receipts and `Operation-Id` stay | +5, OpenAPI | The journal's real work is a stable answer after a lost response, the one non-idempotent create and the operation anchor for audit events; it costs 557 B and 3 statements per command. Mandatory keys are what made U3 |
| A9 + U2 | Unauthenticated refusals as log lines | −55, 41 tests change | See U2 |
| A3 | Verified SSO: one `current()` check under the locks instead of three; Better Auth's `defineRequestState` instead of ID's `AsyncLocalStorage` and the `handler` override | −25, −47 test | The two later checks fail only tests that fault the second of two identical calls under held locks |
| A11 | The `organization` plugin replaced by two model declarations | −10, 22 dead routes gone | ID uses only the `organization` and `member` declarations; the plugin declares an `invitation` model with no table and a required `member.role` with no column |
| C4 | 13 environment variables become constants; the production default of `BETTER_AUTH_URL` goes (30 variables → 17) | −23 `env.ts`, −85 test, −13 `default.env` | Nothing deployed sets them; every value change is already a release. `DATABASE_POOL_MAX` stays (decision D8) |
| C6 | Serve the prebuilt stylesheet; `hono-tailwind` and `tailwindcss` out of the runtime (C30, deferred twice) | ±10, −2 dependencies | The bundle runs without `node_modules` (today's cannot and Bun auto-installs from the registry); −16 MB RSS per replica, −17.5 MB and 24 packages from the production install, two of them native. No lazy fallback |
| C11 | Bundle `migrate.ts` into `dist/scripts`; the image copies `dist` and `drizzle` only | Dockerfile −3, chart command | About 80 MB of `node_modules` and two test scripts that cannot run there leave the image |
| b2-3 | Bootstrap's four scope switches → one | −16/+1 | Only three tables it touches have RLS and `platform-write` satisfies them |
| b2-5 | Six hand-written audit projections → one `evidence(row)` | −69/+6 | Same JSON keys; payloads unchanged |
| B1-12 | `sso-test.ts` uses the pinned plugin's `discoverOIDCConfig` | ~−150 | Same checks; the probe then says what sign-in does (they differ today on a trailing-slash issuer) |
| B1-10 | The Toolbox poller reads `&outcome=success` | +1 (Toolbox) | 26 pages instead of 572 for the same 2,009 relevant events |
| B1-11 | `updateGroup` freshness flag → `false` | 1 | The patch has one field |
| b2-15 | Pass ID's `hashClientSecret` to the provider's `storeClientSecret` | 1 | The two hashers cannot drift on an upgrade |
| C10 | Fix the fake ID's drift (403 code and header, `deletedAt`/`live`, `detail`/`errors`) | ~20 | So "shapes follow `openapi.admin.json`" is true |
| C12 | Trim three reports, remove three passages repeated three or four times, fix the false statements, docs/06 points at the runbook | ~−60 | A second engineer needs the README, the runbook and four evidence reports |

## Challenged and kept

With the measurement that held each: the `native-*` wrappers (each fails behaviour tests as pass-through; the plugin would revoke a user's tokens across organisations), the exact-pair evaluator (37 round trips per refresh, 22 a second per process sequential against 11 needed at 10,000 users), the machine audit event (one per token lifetime, the client caches), the route allowlist (16 of 111 mounted, each with a consumer), the `BETTER_AUTH_SECRETS` parser (Better Auth's own echoes the secret), the platform credentials marker (the admin MCP writes it), the adapter hooks (no plugin hook before the callback's transaction), freshness; the in-transaction `authorizeCommand` as the one layer, revisions and `If-Match` (the admin MCP, the Toolbox and the ops Jobs send them), `platform:users` and `org:users` (register gives the servers `platform:write` without `platform:users`), the cookie principal (the documented staff path), the root self-lock (a leaked secret is useless once a person administers), `admin.denied` and `admin.root_request`, the three audit list routes, the roughly fifteen routes nothing calls (disable is the recovery tool under terminal deletion; decision D7); the `withDatabaseScope` savepoint (without it a caught error fails open; a test caught it), the start-time role check (2.6 ms; the owner URL is a Secret in the same namespace and no table forces RLS), bootstrap at every start (5.3 ms; refuses a changed admin resource and restores after `helm rollback`), the pool timeouts (startup parameters, no round trip), the organisation `FOR UPDATE`, the receipt check, the lock order; metrics (0.34 µs per request, the only pool-waiter signal), the sweep lock (avoids false failure logs), startup and shutdown order, the pages, `@answerable/auth`, the fake ID (real ID adds 0.8 s per file and a shared database; the acceptance covers all 23 admin tools), the two test scripts.

Measured and recorded for later, not proposed: `listTargetAccess` aggregates the whole organisation per page and reads every tenant's users (19 ms at 10,000 users), member search scans all users (7.8 ms), the action-filtered audit list sorts that action's history (20 ms); a `FOR SHARE` on a hot row writes 174 B of WAL and 969 multixacts per 1,000 concurrent transactions; refresh CPU is mostly Drizzle building SQL.

## Decisions for the owner

Recommended option first.

- **D1 Rate limits (U1).** Configure Better Auth's `rateLimit` for the deployment: per-address limits sized for an office and a server-side host (for example token 600 and authorize 300 a minute, sign-in 60 per 10 s, with the numbers written into docs/06 as capacity limits), or turn the per-address limiter off and rely on Cloudflare's rate limiting. Recommended: configure, with the numbers an owner can defend; Cloudflare rules come with `Q-ADMIN-API-RATE-LIMIT`.
- **D2 Refusal evidence (U2, A9).** Unauthenticated refusals become log lines; rows stay once the credential verified. Or keep rows for failed sign-ins only (a customer's SIEM export), capped. Recommended: log lines; nothing reads the rows and no tenant can be attributed.
- **D3 Idempotency (U3, B1-1).** Fresh keys in `make-admin` and generated keys in the docs; `Idempotency-Key` optional with a server-generated key. Or keep the header mandatory and fix only the callers. Recommended: both.
- **D4 Upstream tokens and the preflight (A4, C2, U4).** Stop requesting `offline_access`, delete the storage, the key ring and the preflight; add the startup decrypt check. Or discard the token at write and keep requesting the scope so `Q-AID-RECHECK` can choose refresh probes later without a re-consent. Recommended: stop requesting; returning later costs the 77-line plugin from git and each user's next sign-in.
- **D5 Issuance assertions (A2, A2b).** Delete them with the reuse interval. Or keep a 20-line replay-only claim check and the interval for `Q-REFRESH-PARALLEL`. Recommended: delete.
- **D6 One authorisation layer (B1-3, b2-1).** Delete the tier middleware, `x-tier` and `org:write`; delete the per-lock re-evaluation and accept that a staff command admitted just before its window ends may commit up to 2 s per lock wait after it (machine callers already do). Or keep exact expiry with one "authority valid until" comparison (about 15 lines). Recommended: delete, no horizon.
- **D7 Routes (B1-5).** Delete `getMemberConfiguration`, `getOperationStatus` and `revokeUserSession`; keep the other uncalled routes as the platform's complete surface. Or cut every route no guide or tool uses and add back on demand. Recommended: the three only.
- **D8 Environment (C4).** 13 variables become constants and the production `BETTER_AUTH_URL` default goes; `DATABASE_POOL_MAX` stays as the one sizing variable. Or make it a constant too. Recommended: keep it.
- **D9 Runtime and image (C6, C11, C8).** Prebuilt stylesheet, bundled migrate script, snapshot test writes the OpenAPI files. Recommended: all three.
- **D10 The rest of the simplifications** (A3, A11, b2-3, b2-4, b2-5, b2-8, b2-15, B1-10, B1-11, B1-12, U5, U6, the response fields, `/auth/ok`, the fake's drift). Recommended: all; each is a run with a green suite.
- **D11 Scripts (b2-6, b2-7).** Delete `test-migrations.ts` now and `regenerate-migrations.ts` at the first staging deploy. Recommended.
- **D12 Docs (C12).** Delete the four changelog reports, trim three, de-duplicate, fix the false statements, docs/06 keeps the requirements and the console steps and points at the runbook. Or move the reports under `docs/goals/` as history. Recommended: delete.
- **D13 The ops Job after the root lock (B1 Q2).** `register` needs a staff token placed by hand with `kubectl`. Give the Job its own machine client, minted at the first run like the servers' (an `infra/ops` change, a later goal). Or keep the manual step for a rare operation. Recommended: the machine client, in the civo-deploy goal, not here.

## Implementation plan (after the decisions)

Four change sets in isolated worktrees on throwaway Postgres, tests first, each ending with ID's gates (typecheck, lint, `db:test:migrate`, the suite at 100%), landed in order on one branch and pushed to main per the owner's rule:

1. **Auth (Opus):** D1 rate limits with a test per route class; D5; D4 (storage, ring, preflight, the startup check, the infra entries, the docs); A3; A11; A8b; U2's auth half (machine and sign-in refusals). Re-export `openapi.json`.
2. **Admin API (Opus):** D3 (`make-admin` keys, docs keys, optional header); D6 (tier layer out, 404 rule and `admin.denied` in `authorizeCommand`, `org:write`, per-lock re-evaluation out); D7; U2's admin half; U5; U6; the response fields; B1-10 (Toolbox), B1-11, B1-12; `openapi.admin.json`, the fake ID, the admin MCP's manifest where a shape changed.
3. **Services and runtime (Sonnet):** b2-3, b2-4, b2-5, b2-8, b2-15, b2-6; D8; D9 (stylesheet, bundle, Dockerfile, chart command, snapshot test); C10.
4. **Docs (Sonnet):** D12; docs/02 register and do-not-re-propose lines; docs/03/05/06, README, OPERATIONS; the web docs' false statements; AGENTS.md's `openapi:export` lines.

Then the full gates on the landing tree (ID suite, `mcp:test`, acceptance, web, countries, typecheck, lint, build, `infra:check`, `infra:test` for the image change), docs, push to main, the owner's checkout reset, containers and worktrees removed.

## Numbers

| | Value | Source |
| --- | --- | --- |
| Non-test source, `apps/id/src` | 22,998 lines, 162 files | D |
| Admin routes with no runtime caller / none outside ID's tests | 43 of 80 / 31 | D, B1's map |
| Environment variables set by nothing deployed | 13 of 30 | D, C probe 08 |
| Audit actions written and never read in code | 38 of 66 | D |
| Default rate limits per address per process | sign-in 3/10 s, authorize 30/min, token 20/min, session and callback 100/10 s | A probe 08, re-run |
| Anonymous audit rows per second from one client | 3,922 (idle database); 20,951 req/s with the insert removed | B1 probes 10b, 02f |
| Bytes an anonymous request can store | 12,224 | B1 probe 02e |
| Legitimate read p95 under the flood | 29 → 116 ms | B1 probe 10 |
| Journal cost per command | 557 B, 3 statements, 9.6 ms end to end | B1 probe 05 |
| Statements per PATCH entitlement, before / without per-lock re-checks | 129 / 53 | B2 probes 02, 07 |
| Refresh | 37 round trips, 1 transaction; 22.3/s per process sequential; 11.1/s needed at 10,000 users | A probe 05 |
| Startup checks | role check 2.6 ms, bootstrap verify 5.3 ms | B2 probe 03 |
| Metrics middleware | 0.34 µs per request | C probe 02 |
| Runtime without `hono-tailwind` | −16 MB RSS per replica; −17.5 MB, −24 packages in the install | C probes 03c, 04 |
| Spike failures | assertions 3; tier layer 142 (0 leaks); denial rows 127; re-evaluation 1; savepoint 1; env 5; organisation plugin 1; upstream discard 7 | A, B1, B2, C |
| Baseline suite | 1,558 pass, 100% lines and functions | every audit |
