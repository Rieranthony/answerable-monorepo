# Test audit, area B: Answerable ID admin API, database and services

Audit of `apps/id` at commit `491c9e9` (2026-10-03): `src/http/admin/**`, `src/db/**`, `src/operations/**`, the admin services, `scripts/test-migrations.ts` and `src/__tests__/`. Every number below comes from a run on the audit's own Postgres (port 47434) unless it says otherwise.

## Summary

- **Verdict:** the area proves its documented contracts well, but about a third of its tests repeat a fact another test already holds, while a few facts have no test at all. 88 files, 30,919 lines, 1,318 tests (87 files: 236 s and 241 s in one process); full ID suite 2,040 pass, 0 fail, 100% coverage (630 s under load).
- **Counts (401 call sites):** INV 168, CON 61, BEH 53, DUP 90, IMPL 19, FILL 10. The route matrix adds 813 generated tests (62% of the area), 337 of them repeating a route-independent or identical fact.
- **Finding 1, duplication:** one broken journal fingerprint failed 27 tests in 15 files, a cursor off-by-one 30 in 22, a replay status change 66 in 26; 20 call sites assert "a failed audit rolls back". Measured: deleting 13 query, service and migration files keeps the rest of the suite green apart from one unrelated timing flake (one test-only error class must go with them); collapsing the matrix removes 337 tests and about 7 s.
- **Finding 2, gaps:** an erased group still appears in its group list and no test in the ID suite notices (the probe run against all 142 files: 2,040 pass); cross-tenant child ids on writes are checked only by service tests; the suite connects as a Postgres superuser, so 73 of 88 files cannot see RLS or missing grants; `runtime-role.integration.test.ts` fails when run alone.
- **Finding 3, unmeasured authorisation:** the 14 security probes (scope, organisation, root lock, token binding, `sid`, freshness, RLS) were not run: the permission classifier refused the first edit that weakened an authorisation check, and the rest were not attempted; authorisation is checked twice (middleware, then inside the transaction), and whether each layer is tested on its own remains unknown.

## Inventory

Environment: worktree at commit `491c9e9`, Postgres on 47434, `NODE_ENV=test`, Bun 1.3.1. Other audits ran on the same machine throughout (load average 7.8–9.4), so every time is measured twice and both runs are quoted. "Alone" means `bun test --timeout 15000 <file>` in its own process with coverage on, as `bunfig.toml` sets it. Tests are those reported by Bun (loops and the route matrix expand one `test()` call into many); the area has 401 `test()` call sites and 1,318 tests.

`db/runtime-role.integration.test.ts` fails when run alone (see Q2), so its row comes from the JUnit report of full runs 2 and 3 (its time inside the suite; JUnit `time` excludes `beforeAll`).

| File | Lines | Tests | Alone (s), run 1 / run 2 | Layer | What it proves |
| --- | ---: | ---: | --- | --- | --- |
| `db/audit-history.integration.test.ts` | 139 | 3 | 0.4 / 0.4 | schema (SQL triggers) | Person/tenant audit history and subject capture survive erasure; subject failure rolls back the fact |
| `db/capabilities.integration.test.ts` | 161 | 1 | 0.5 / 0.5 | schema (SQL triggers) | Capability rows keep immutable exact targets, kinds, scopes and windows |
| `db/grant-subjects.integration.test.ts` | 546 | 12 | 0.9 / 0.7 | schema (SQL triggers) | The audit-subject trigger indexes users only from exact versioned event envelopes |
| `db/identity.integration.test.ts` | 486 | 12 | 3.3 / 2.5 | schema (SQL triggers) | Client/resource identity is immutable, versions only advance, identifiers stay reserved |
| `db/migrate-script.integration.test.ts` | 51 | 1 | 0.2 / 0.3 | script (subprocess) | scripts/migrate.ts provisions a runtime role with protected audit permissions |
| `db/migrate.integration.test.ts` | 73 | 2 | 0.1 / 0.1 | schema | Installed custom objects equal the catalogue; re-running migrations is a no-op |
| `db/migrations.test.ts` | 48 | 1 | 0.2 / 0.2 | schema (no DB) | The TypeScript schema generates no diff against the committed migration |
| `db/operation-audit.integration.test.ts` | 95 | 2 | 0.2 / 0.2 | schema | Audit may precede its receipt in a transaction; a dangling operation link cannot commit |
| `db/queries/access.integration.test.ts` | 904 | 8 | 2.7 / 2.3 | query | Member/target access explanations through the shared permission evaluator |
| `db/queries/audit.integration.test.ts` | 466 | 9 | 1.6 / 1.6 | query | Audit insert/list/filter/cursor and some subject-capture rules |
| `db/queries/effective.integration.test.ts` | 140 | 1 | 0.3 / 0.3 | query | The shared effective-window predicate |
| `db/queries/entitlements.integration.test.ts` | 176 | 1 | 0.4 / 0.4 | query | Entitlement CRUD, filters, cursor, organisation predicate |
| `db/queries/grants.integration.test.ts` | 555 | 19 | 4.3 / 4.3 | query | Admin authority evaluation (effectiveGrants, hasPlatformWriter) and root lockout |
| `db/queries/groups.integration.test.ts` | 280 | 3 | 0.8 / 1.1 | query | Group CRUD, assignment upsert, revisions and immutable assignment columns |
| `db/queries/management.integration.test.ts` | 305 | 5 | 1.2 / 1.3 | query | Client erasure cascades, domain deletion scope, exact-email and cross-org lists |
| `db/queries/members.integration.test.ts` | 205 | 2 | 0.6 / 0.6 | query | Member projections and the assignment lookup context guard |
| `db/queries/oauth-clients.integration.test.ts` | 218 | 4 | 0.8 / 1.0 | query | Client principal lookup and client administration queries |
| `db/queries/oauth-resources.integration.test.ts` | 94 | 1 | 0.3 / 0.4 | query | Resource CRUD, filters, cursors, locks, references |
| `db/queries/oauth-tokens.integration.test.ts` | 188 | 2 | 0.5 / 0.6 | query | Token revocation by user, client and session with exact counts |
| `db/queries/organization-domains.integration.test.ts` | 150 | 2 | 0.5 / 0.5 | query | Domain CRUD and routing eligibility |
| `db/queries/organizations.integration.test.ts` | 98 | 1 | 0.4 / 0.3 | query | Organisation CRUD, filters, cursor, soft-deleted rows |
| `db/queries/policy-context.integration.test.ts` | 116 | 1 | 2.2 / 1.3 | query | Group/entitlement queries refuse forged, copied or expired contexts |
| `db/queries/sessions.integration.test.ts` | 96 | 2 | 0.5 / 0.4 | query | Session deletion and listing without tokens |
| `db/queries/sso-providers.integration.test.ts` | 271 | 6 | 1.2 / 1.2 | query | Provider CRUD, redaction, platform credential serialisation, DB clock |
| `db/queries/users.integration.test.ts` | 196 | 4 | 1.0 / 0.8 | query | User email retirement, lists, status changes |
| `db/runtime-role.integration.test.ts` | 2394 | 23 | 2.5 / 2.4 (in suite, see note) | schema + query under the restricted role | Least-privilege runtime role, RLS isolation on 11 tables, startup role assertion |
| `db/schema.integration.test.ts` | 1137 | 22 | 5.4 / 4.5 | schema | Column constraints, uniqueness, FKs and Better Auth adapter compatibility |
| `db/statement-timeout.integration.test.ts` | 187 | 3 | 2.8 / 2.8 | HTTP + pool settings (restricted role) | Statement and lock timeouts roll back commands and answer 503 |
| `http/admin/access.integration.test.ts` | 515 | 23 | 3.8 / 3.6 | HTTP | Access views; tenant isolation of private targets; matrix |
| `http/admin/audit-events.integration.test.ts` | 307 | 30 | 3.0 / 2.5 | HTTP | Audit lists, tenant audit isolation, history after erasure; matrix |
| `http/admin/capabilities.integration.test.ts` | 638 | 62 | 6.7 / 6.3 | HTTP | Capability ceilings: escalation guards, replay, revisions; matrix |
| `http/admin/client-erasure-audit.integration.test.ts` | 400 | 2 | 2.5 / 2.5 | HTTP (restricted role) | Client erasure manifests and cross-client effect visibility |
| `http/admin/client-lifecycle.integration.test.ts` | 237 | 3 | 2.6 / 2.6 | HTTP | Client lifecycle replay, noops, audit-failure rollback |
| `http/admin/client-replay.integration.test.ts` | 353 | 5 | 2.6 / 2.3 | HTTP | Client create/rotate receipts; transactional authority recheck |
| `http/admin/client-resource-audit.integration.test.ts` | 281 | 7 | 7.6 / 6.5 | HTTP (restricted role) | Client-resource link evidence visibility per tier |
| `http/admin/client-revision.integration.test.ts` | 185 | 5 | 2.5 / 2.1 | HTTP | Client If-Match/ETag contract |
| `http/admin/clients.integration.test.ts` | 431 | 122 | 6.3 / 5.9 | HTTP | Client administration with real token minting; matrix |
| `http/admin/command-replay.integration.test.ts` | 263 | 23 | 4.5 / 4.2 | HTTP | The idempotency promise across 8 command families |
| `http/admin/denial-audit.integration.test.ts` | 196 | 5 | 4.9 / 4.6 | HTTP (restricted role) | Denials survive an audit outage; root admission is audited |
| `http/admin/diagnostics.integration.test.ts` | 118 | 14 | 1.9 / 2.0 | HTTP | Sign-in diagnosis and its tenant isolation; matrix |
| `http/admin/directory-context.integration.test.ts` | 80 | 1 | 1.7 / 1.6 | HTTP | Nine tenant read paths (titled "all ten") recheck authority inside their transaction |
| `http/admin/domains.integration.test.ts` | 384 | 61 | 3.9 / 3.7 | HTTP | Domain lifecycle, replay, routing effect on sign-in; matrix |
| `http/admin/entitlement-audit.integration.test.ts` | 623 | 12 | 11.4 / 10.2 | HTTP (restricted role) | Entitlement audience history and subject capture vs user erasure |
| `http/admin/entitlement-replay.integration.test.ts` | 172 | 3 | 2.7 / 2.2 | HTTP | Entitlement receipts and noops |
| `http/admin/entitlements.integration.test.ts` | 362 | 83 | 6.2 / 5.8 | HTTP | Entitlement lifecycle, validation, tenant isolation; matrix |
| `http/admin/group-erasure-audit.integration.test.ts` | 786 | 8 | 7.9 / 7.5 | HTTP (restricted role) | Group erasure/status manifests and subject capture vs user erasure |
| `http/admin/groups.integration.test.ts` | 583 | 121 | 7.9 / 7.7 | HTTP | Group lifecycle, directory groups, receipts; matrix |
| `http/admin/management.integration.test.ts` | 460 | 5 | 6.6 / 8.3 | HTTP | Client erasure, domain deletion, review reads (human and machine) |
| `http/admin/me.integration.test.ts` | 158 | 11 | 1.6 / 1.8 | HTTP | /me shapes; platform authority follows the binding; matrix |
| `http/admin/member-audit.integration.test.ts` | 406 | 5 | 5.4 / 6.9 | HTTP (restricted role) | Member access observations and reinstatement evidence |
| `http/admin/members.integration.test.ts` | 710 | 77 | 6.8 / 8.2 | HTTP | Member windows/removal/reinstatement, tenant command recheck; matrix |
| `http/admin/operation-crash.integration.test.ts` | 368 | 6 | 15.9 / 19.9 | HTTP (subprocess, restricted role) | SIGKILL before/after commit leaves nothing or a receipt |
| `http/admin/operations.integration.test.ts` | 210 | 13 | 3.8 / 3.7 | HTTP | Operation status reads; blocked write answers 503; matrix |
| `http/admin/organization-erasure-audit.integration.test.ts` | 442 | 5 | 4.8 / 4.7 | HTTP (restricted role) | Organisation erasure manifest, rollback, ordering vs user erasure |
| `http/admin/organizations.integration.test.ts` | 458 | 76 | 4.5 / 4.4 | HTTP | Organisation lifecycle, isolation, replay; matrix |
| `http/admin/platform-directory-context.integration.test.ts` | 104 | 3 | 1.6 / 1.6 | HTTP | Platform reads recheck authority; no-store; SSO probe outside transaction |
| `http/admin/request-security.integration.test.ts` | 77 | 6 | 1.7 / 2.0 | HTTP | Hostile Origin denied and audited; erase needs query confirmation |
| `http/admin/resource-replay.integration.test.ts` | 249 | 6 | 2.9 / 2.8 | HTTP | Resource receipts, preconditions, ETag coverage, normalised input |
| `http/admin/resources.integration.test.ts` | 285 | 76 | 4.1 / 3.9 | HTTP | Resource lifecycle and immutable ownership; matrix |
| `http/admin/revisions.integration.test.ts` | 703 | 6 | 9.8 / 9.6 | HTTP | If-Match/If-None-Match for six entity kinds |
| `http/admin/route-table.test.ts` | 215 | 8 | 0.1 / 0.1 | unit (stub DB) | registerRoute wiring, tierOf, /me serialisation, window schema |
| `http/admin/routes.test.ts` | 287 | 2 | 0.3 / 0.3 | unit (stub DB) | Route metadata equals the OpenAPI document; every mutation declares the command contract |
| `http/admin/session-replay.integration.test.ts` | 196 | 3 | 1.7 / 1.6 | HTTP | Session revocation receipts and later-effect safety |
| `http/admin/sessions.integration.test.ts` | 251 | 33 | 2.4 / 2.6 | HTTP | Global session revocation; tenants cannot reach global sessions; matrix |
| `http/admin/soft-deletion.integration.test.ts` | 683 | 11 | 8.6 / 8.2 | HTTP + schema (restricted role) | Terminal deletion, identifier reservation, parent guards, startup privilege check |
| `http/admin/sso-providers.integration.test.ts` | 782 | 58 | 5.1 / 5.0 | HTTP | SSO provider PUT/DELETE, redaction, SSO test, replay; matrix |
| `http/admin/token-revocation-audit.integration.test.ts` | 235 | 5 | 5.4 / 5.7 | HTTP (restricted role) | Token revocation manifests for five modes, rollback, replay |
| `http/admin/user-erasure-audit.integration.test.ts` | 645 | 6 | 6.1 / 5.4 | HTTP (restricted role) | Global user erasure manifests and rollback |
| `http/admin/user-erasure-race.integration.test.ts` | 263 | 4 | 4.4 / 3.8 | HTTP (restricted role) | User erasure captures children created while it waits |
| `http/admin/user-replay.integration.test.ts` | 452 | 7 | 5.0 / 4.6 | HTTP (restricted role in one test) | User command receipts, reconciliation, pool exhaustion, last-writer guard |
| `http/admin/users.integration.test.ts` | 448 | 62 | 4.1 / 3.5 | HTTP | Global user lifecycle; matrix |
| `operations/metrics.test.ts` | 83 | 2 | 0.3 / 0.3 | unit (stub DB) | Process summaries carry no identifiers and finite dimensions |
| `operations/preflight.integration.test.ts` | 73 | 1 | 1.3 / 1.1 | service | Custody preflight is read-only and detects missing keys |
| `services/access.integration.test.ts` | 179 | 2 | 0.6 / 0.5 | service | Access service tenant reads and existence checks |
| `services/audit.integration.test.ts` | 162 | 2 | 0.3 / 0.3 | service | Audit service binds the tenant from its context |
| `services/client-grants.integration.test.ts` | 411 | 10 | 2.6 / 1.7 | service | Client disable/erase/rotate revoke grant contexts with complete effects |
| `services/clients.integration.test.ts` | 489 | 7 | 1.8 / 1.2 | service | Client service lifecycle, validation, audit allowlist |
| `services/command-policy-lock.integration.test.ts` | 403 | 6 | 7.7 / 6.6 | service (concurrency) | Policy revocation and a user command serialise; expiry after lock wait denies |
| `services/domains.integration.test.ts` | 227 | 3 | 0.8 / 0.5 | service | Domain service lifecycle and foreign-row rejection |
| `services/entitlements.integration.test.ts` | 409 | 3 | 0.9 / 0.7 | service | Entitlement service validation and foreign-organisation writes |
| `services/groups.integration.test.ts` | 295 | 2 | 0.7 / 0.5 | service | Group service lifecycle and foreign-row rejection |
| `services/machine-command-policy.integration.test.ts` | 321 | 7 | 5.9 / 5.2 | service (concurrency) | Policy revocation and a machine command serialise; token expiry after wait |
| `services/members.integration.test.ts` | 529 | 6 | 1.4 / 1.1 | service | Member revocation, A/B isolation, grant-context revocation |
| `services/operations.integration.test.ts` | 315 | 8 | 4.6 / 4.5 | service | The operation journal: canonical input, key isolation, rollback, lock timeout |
| `services/organizations.integration.test.ts` | 506 | 7 | 1.5 / 1.1 | service | Organisation disable/erase effects on tokens, sessions and grant contexts |
| `services/resource-grants.integration.test.ts` | 236 | 5 | 1.1 / 0.8 | service | Resource disable/erase revoke grant contexts across tenants |
| `services/resources.integration.test.ts` | 227 | 4 | 0.9 / 0.7 | service | Resource service lifecycle and erasure guards |
| `services/root-policy-lock.integration.test.ts` | 278 | 6 | 5.3 / 4.3 | service (concurrency) | Root admission and first platform writer activation serialise |
| **Total (88 files)** | **30919** | **1318** | **277 / 267** | | |



### Measurements

| What | Run 1 | Run 2 | Note |
| --- | --- | --- | --- |
| The 87 area files in one Bun process (all but `runtime-role`) | 236 s, 1,295 pass | 241 s, 1,295 pass | unmodified source |
| Sum of the 87 files run alone | 274.5 s | 264.6 s | coverage on, as configured |
| `runtime-role` inside the full suite (JUnit) | 2.5 s, 23 pass (JUnit time, which excludes `beforeAll`) | 2.4 s, 23 pass | full runs 2 and 3 |
| Full ID suite, `bun run test:coverage` (142 files) | 2,040 pass, 0 fail, 630.2 s, 100% lines and functions | not repeated unmodified; runs 2 and 3 below are variants | other audits loaded the machine |
| Full ID suite without the 13 deletion candidates (run 2) | 2,012 pass, 1 fail, 535 s; lines 100%, functions 99.96% (`UserNotRetirableError`, `src/db/queries/users.ts` lines 41–42, loses its only caller). The failure is `auth/user-oauth` "cached native refresh responses recheck policy and record replay separately": `expires_in` 300 against 299, a one-second boundary crossed under load, outside this area and unrelated to the deletions | | |
| Full ID suite with probe 8 applied (run 3) | 2,040 pass, 0 fail, 494 s, 100% lines and functions: no test in the whole ID suite notices erased groups in the group list | | |
| `bun run test:migrations` (CI's migration proof) | 2.4 s, pass | 2.4 s, pass | targets `answerable_id_test` on 47434 |
| The 16 matrix files: all their tests / the matrix / "no credentials" plus the five repeated kinds / "no credentials" alone | 57.2 / 22.5 / 17.1 / 10.0 s | 61.4 / 23.5 / 17.6 / 10.9 s | 922 / 813 / 423 / 81 tests |

**Ten slowest files** (mean of the two alone runs, seconds): `operation-crash` 17.9 (15.9, 19.9); `entitlement-audit` 10.8 (11.4, 10.2); `revisions` 9.7 (9.8, 9.6); `soft-deletion` 8.4 (8.6, 8.2); `groups` 7.8 (7.9, 7.7); `group-erasure-audit` 7.7 (7.9, 7.5); `members` 7.5 (6.9, 8.2); `management` 7.4 (6.6, 8.3); `command-policy-lock` 7.2 (7.7, 6.6); `client-resource-audit` 7.1 (7.6, 6.5).

**Test count per class:** see Classification (401 call sites: INV 168, CON 61, BEH 53, DUP 90, IMPL 19, FILL 10; matrix 813: INV 397, DUP 288, CON 67, BEH 61).

## Classification

Every `test()` call site in the area (401) is classified once; a call inside a loop or `test.each` stands for all its expansions. The route matrix in `__tests__/admin-routes.ts` is classified separately by entry kind, because one `entry()` produces 813 of the area's 1,318 tests.

**Counts by class (401 call sites):** INV 168 · CON 61 · BEH 53 · DUP 90 · IMPL 19 · FILL 10.

| Layer | INV | CON | BEH | DUP | IMPL | FILL |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `db` (schema, role, triggers; 11 files) | 48 | 9 | 3 | 8 | 8 | 1 |
| `db/queries` (17 files) | 22 | 2 | 7 | 28 | 3 | 5 |
| `http/admin` (43 files) | 71 | 49 | 40 | 28 | 7 | 2 |
| `services` (15 files) | 26 | 1 | 1 | 26 | 1 | 2 |
| `operations` (2 files) | 1 | 0 | 2 | 0 | 0 | 0 |

**Route matrix (813 generated tests):** INV 397 · DUP 288 (route-independent repeats of foreign bearer, missing origin, untrusted origin and disabled user) · CON 67 (of which 50 are the machine-token repeat of the platform-reader fact) · BEH 61. Detail below.

How DUP was decided: the same fact must be asserted by a named test at a layer closer to the consumer, and, where a probe was run, the probe must have failed the named test too. IMPL marks tests that pin how the audit-subject trigger parses JSON or which lock wins a race, where the consumer-visible effect is held elsewhere. FILL marks tests whose only effect is reaching a branch production cannot reach (forged contexts, executor variants, a fixture self-check).

### The route matrix, `__tests__/admin-routes.ts` (14 entry kinds, 813 generated tests)

`describeAdminRoutes` is called by 16 HTTP files and generates one test per entry kind per route, over the 81 admin routes (32 read, 44 write, 5 erase). Counts are computed from the route tables with the generator's own conditions (scripted) and confirmed by a run: filtering the 16 files to the 14 entry names runs exactly 813 tests.

| Entry | Tests | Class | Basis |
| --- | ---: | --- | --- |
| root is admitted by authorisation (one `admin.root_request` row) | 81 | INV | every root request is audited (`src/http/authorize.ts` `admitRoot`) |
| no credentials → 401 `unauthenticated` with `WWW-Authenticate` | 81 | INV | proves every route sits behind the principal middleware |
| foreign bearer → 401 `invalid_token` | 81 | INV once, DUP 80 | the principal middleware rejects before routing; the route does not change the path |
| missing origin on a write → 403 `origin_required` | 49 | INV once, DUP 48 | same middleware, route-independent |
| untrusted origin → 403 `untrusted_origin` | 81 | INV once, DUP 80 | same middleware, route-independent |
| insufficient scope (tenant principal on a platform route, or the wrong `org:*` scope) → 403 and one `admin.denied` row | 80 | INV | route-dependent: each route declares its scopes |
| platform reader on a non-read platform route → 403 | 50 | INV | `platform:read` cannot write |
| machine `platform:read` token on a non-read platform route → 403 with `WWW-Authenticate: Bearer error="insufficient_scope"` | 50 | CON | same scope fact as the line above; the header is the only difference |
| outsider organisation → 404 and an unattributed denial | 21 | INV | tenant isolation per org-scoped route |
| disabled user → 403 `user_disabled` | 81 | INV once, DUP 80 | principal middleware, route-independent |
| expired member → 404 or 403 | 80 | INV | route-dependent (org-scoped routes hide the organisation) |
| unknown ids → 404 `not_found` | 60 | BEH | route-dependent |
| invalid body → 400 `validation_failed` with `errors` | 17 | CON | error envelope |
| open route admits a principal with no grants | 1 | BEH | `getAdminMe` |

288 of the 813 (foreign bearer, missing origin, untrusted origin and disabled user beyond their first instance) exercise the same middleware with the same principal on a different path; the request never reaches route-specific code.

### Q1. One entity across the layers: organisations, groups, entitlements

Method: every test in the area that drives the entity was read and mapped; the "only below HTTP" column was then checked against the HTTP files by name and, where possible, by a probe.

**Organisations** (query: `db/queries/organizations` 1 test; service: `services/organizations` 7; HTTP: `organizations` 8 plus 68 matrix tests, `organization-erasure-audit` 4, the organisation rows of `command-replay` (3), `revisions` (1 case), `request-security`, `soft-deletion`, `audit-events`, `operations`; schema: `db/identity` "organisation authorization version", `db/schema` slug and lifecycle constraints).

| Fact | Held at |
| --- | --- |
| Route authorisation, root admission, CSRF, validation 400, unknown id 404 | HTTP only (matrix, `organizations` "paths validate UUIDs") |
| If-Match on PATCH; replay receipts; noops record `noop` | HTTP only (`revisions`, `organizations` 370, `command-replay`); probe p-org-revision caught by one HTTP test |
| Audit attribution with `x-request-id`, IP and user agent | HTTP only (`organizations` 115) |
| Disable keeps the global browser session | HTTP (`organizations` 222, via `/me`) and service (`services/organizations` 157, 308) |
| Erasure manifest (v3 effects, cleared selections, other tenant intact, rollback on subject failure) | HTTP only (`organization-erasure-audit`) |
| Create/update audit before/after | service and HTTP |
| Erase confirmation and the owned-client 409 | service and HTTP (probes p-org-erase-confirm, p-org-erase-clients below) |
| Disable revokes only that tenant's machine access tokens and leaves refresh, user-bound and other-tenant tokens | **service only** (`services/organizations` 157, 308) |
| Disable revokes that tenant's grant contexts; enable does not restore them | **service only** (`services/organizations` 436) |
| `authorizationVersion` advances on disable and never rolls back | service (157) and schema (`db/identity` 302) |
| Case-insensitive search over name and slug | query and HTTP (probe p-org-search-case below) |

**Groups** (query: `db/queries/groups` 3 and `db/queries/policy-context`; service: `services/groups` 2; HTTP: `groups` 6 plus 115 matrix tests, `group-erasure-audit` 8, `revisions` (2 cases), `command-replay` (3), `soft-deletion` 211, `directory-context`).

| Fact | Held at |
| --- | --- |
| Authorisation per route; If-Match and If-None-Match; receipts; noops; audit attribution per actor kind | HTTP only (probe p-group-ifnonematch caught by one HTTP test) |
| Erasure and status-change manifests, ordering against user erasure | HTTP only (`group-erasure-audit`) |
| Directory-managed groups refuse manual membership edits | service and HTTP (probe p-directory-managed below) |
| Reader isolation for another organisation's groups | HTTP (`groups` 108) |
| A group id of organisation B used under organisation A's path, for every write | **service only** (`services/groups` 226); HTTP tests only use random ids or the right organisation |
| Assignment columns (`id`, `revision`, `member_id`, `organization_id`, `group_id`) are immutable; revision bumps on raw SQL changes | **query/schema only** (`db/queries/groups` 224) |
| Composite foreign key refuses a member of another organisation | schema (`db/schema` 767) and query (`db/queries/groups` 111); HTTP returns 404 earlier, from the service check |
| `effective: false` for a future or expired assignment in the member list | query only (probe p-group-member-effective below) |
| An erased group disappears from the group list | **nothing** (probe p-list-groups-deleted: 0 failures) |

**Entitlements** (query: `db/queries/entitlements` 1, `db/queries/grants` 19, `db/queries/effective` 1; service: `services/entitlements` 3; HTTP: `entitlements` 2 plus 81 matrix tests, `entitlement-replay` 3, `entitlement-audit` 12, `revisions` (1 case), `command-replay` (3), `access`).

| Fact | Held at |
| --- | --- |
| Authorisation, receipts, noops, If-Match | HTTP only (probe p-entitlement-revision caught by one HTTP test) |
| Audience history and person history after erasure | HTTP only (`entitlement-audit`) |
| Principal/target/scope validation, 409 on duplicates, foreign member/group references 404 | service and HTTP |
| GET of another organisation's entitlement id under this organisation's path | HTTP (`entitlements` 262) |
| PATCH, disable, enable and DELETE of another organisation's entitlement id under this path | **service and query only** (`services/entitlements` 252, `db/queries/entitlements` 84) |
| Scopes refused after the resource's `allowedScopes` becomes null | **service only** (252) |
| How an entitlement becomes authority (membership, group, window, status, disabled organisation, capability ceiling, resource vocabulary) | **query only** (`db/queries/grants`, 19 tests); the HTTP matrix covers only the expired member and the disabled user |

**What deleting the query and service tests would lose, keeping HTTP.** Three kinds of fact, none of them CRUD:

1. Cross-tenant identifiers on writes (a valid child id of organisation B under organisation A's path). For groups, domains and entitlements this is held only by service tests (`services/groups` 226, `services/domains` 80 and 193, `services/entitlements` 252). Every HTTP test runs as a Postgres superuser (measured: `rolsuper = true` for `answerable`), so row-level security does not back these predicates up in the suite, and the HTTP matrix never sends a foreign child id. This is the one fact worth moving up before any deletion: one matrix entry ("foreign child id → 404") in `__tests__/admin-routes.ts` would hold it for all 26 organisation routes with a child id (18 of them writes).
2. Side effects of organisation disable on tokens, sessions and grant contexts (`services/organizations` 157, 308, 436), and the grant-context revocation of member removal and client/resource lifecycle (`services/members` 226, 476; `services/client-grants`; `services/resource-grants`). No HTTP test asserts them.
3. The policy evaluation behind admin authority (`db/queries/grants`, 19 tests) and behind access explanations (`db/queries/access`, 8). These are not CRUD duplicates; they are the only tests of most admission rules for human administrators.

The plain CRUD query tests (`organizations`, `entitlements`, `oauth-resources`, `organization-domains`, `sessions`, `management`, `users`, `members`, `oauth-tokens`) hold nothing the HTTP layer does not, apart from the cross-tenant write predicate already held by the service tests. Measured (run 2): the rest of the suite passes without them and four more duplicate files; function coverage drops to 99.96% only because of one test-only error class (Recommendations 1).

### Q4. `db/schema.integration.test.ts` and the migration catalogue

- `__tests__/migration-catalog.json` (1,131 lines) pins the objects Drizzle's snapshot does not describe: 23 functions (definition hash, `SECURITY DEFINER`, `search_path`, PUBLIC execute), 57 triggers, 24 policies, the RLS and FORCE flags of all 26 tables (11 enabled) and the deferral of 45 foreign keys. Measured on the installed test database: 26 tables, 11 with RLS, 23 functions, 57 triggers, 24 policies. `docs/04-answerable-id-schema.md` line 7 says "28 tables, 27 custom functions, 61 triggers"; the catalogue and the database say 26, 23 and 57. The doc is stale.
- `db/migrate.integration.test.ts` compares the live catalogue with the JSON, re-runs the migrator and lists the 26 tables. `scripts/test-migrations.ts` (CI step "Prove fresh migration and interrupted installation") already asserts `migrationCatalog(db)` equals the JSON twice from a fresh install, re-runs the migrator and compares receipts. Both tests in `migrate.integration` are therefore duplicates of a CI step that runs before the suite; the table list is implied by the catalogue's `rls` list. The script is not part of `bun --filter @answerable/id test`, so a developer who runs only `test` loses the catalogue check locally; CI keeps it. Measured run of the script: see Measurements.
- `db/migrations.test.ts` is not duplicated anywhere: it is the only check that the TypeScript schema and the committed SQL agree (drizzle-kit diff empty).
- `db/schema.integration.test.ts` (22 tests) pins something different from the catalogue: column-level behaviour (CHECK, unique, foreign keys, cascades) proven by inserts that must fail, plus Better Auth adapter compatibility (UUIDv7 ids, verification and assertion ids, relations). The fresh-install script does not exercise any of this. Two tests have little value: "resolves every table configuration and foreign key reference" (static, covered by typecheck and `migrations.test`) and "cascades organisation data while keeping clients and resources" (physical deletes the runtime role cannot perform).

### Q5. Erasure and audit tests: contract or internal shape

Contractual (a consumer or a published document depends on it):

- The audit envelope: `id` (UUIDv7, newest first), `action`, `organizationId`, `outcome`, `actorType`, `actorId`, `operationId`, `requestId`, cursor pagination. The Toolbox's grant poller (`mcps/toolbox/src/poller.ts`) depends on action prefixes, `organizationId` and newest-first order; the admin MCP's audit tool parses the outcome and actor enums. Held by `audit-events` 37, the per-write `request()` helpers in `groups`, `entitlements` and `members` (one success event with `organizationId`, action and `requestId`), and `db/queries/audit` 255 (vocabulary).
- Tenant visibility of audit history (`audit-events` 128 and 268, `client-resource-audit`): a tenant reads only its own events. Invariant, docs/05 §5.
- Atomicity: a failed audit or subject write rolls back the effect and the receipt (docs/05 §5). One test per mechanism is enough; the area has 20 call sites asserting it (see Simplifications 3).
- Person history survives erasure (docs/04 "Durable audit subjects"): `/users/{id}/audit-events` still returns the events after the user row is gone. Held at HTTP by `organization-erasure-audit` 156, `entitlement-audit` 79, `audit-events` 188.

Internal shape (no consumer reads it; `data` is typed `object | null` in `openapi.admin.json` and described only in prose):

- The exact keys and arrays inside `data.effects` (`softDeletedMembers`, `revokedGrantContexts`, `clearedSessionSelections`, ...) and `schemaVersion` per action. Documented in `reports/id-soft-deletion.md` and the OpenAPI `schemaVersion` description, read by nothing in the repository.
- The subject-capture trigger's envelope rules (`db/grant-subjects` 7 tests, `db/queries/audit` 273/327/400, `soft-deletion` 617): which JSON shapes produce `audit_event_subjects` rows.
- Which subject rows exist after a race between two erasures (`entitlement-audit` 212, `group-erasure-audit` 336 and 612, `organization-erasure-audit` 304, `user-erasure-audit` 554: 14 tests). They assert the subject index per lock order, using triggers and advisory locks to force each order.


### Per-file tables

#### `db/audit-history` (INV 2, DUP 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 21 | person and tenant audit history survive membership and identity erasure | INV | docs/04 Durable audit subjects; docs/05 §5 |
| 66 | subject-write failure rolls back the audit fact | DUP | held at HTTP by organization-erasure-audit "rolls back configuration and receipt when subject capture fails" and entitlement-audit "subject failure rolls back" |
| 94 | recorded subjects do not invent a removed membership's user | INV | person history must not attribute events to unaffected people (id-initial-migration report regression) |

#### `db/capabilities` (INV 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 64 | capability constraints enforce immutable exact targets, ownership, kinds, scope shape and windows | INV | docs/04 Ownership: capability exact targets; DB backstop |

#### `db/grant-subjects` (IMPL 7)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 64 | contract indexes recorded users once and rejects incompatible envelopes (loop) | IMPL | pins the subject trigger's JSON parsing; user-visible effect held by *-erasure-audit person-history reads |
| 139 | global erasure subject capture rejects unrelated versions/outcomes/malformed effects | IMPL | trigger parsing rules |
| 189 | organisation erasure subjects accept only explicit versioned tenant effect arrays | IMPL | trigger parsing rules |
| 258 | group erasure user indexing accepts only its versioned contract | IMPL | trigger parsing rules |
| 324 | group status subjects accept only matching source records | IMPL | trigger parsing rules |
| 382 | entitlement subject capture validates tenant-bound event contract | IMPL | trigger parsing rules |
| 456 | entitlement audience subjects validate version/target/tenant/group | IMPL | trigger parsing rules |

#### `db/identity` (INV 10, BEH 1, DUP 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 34 | database rejects client identity changes and version rollback | INV | docs/05 §3 immutable identifiers; F1 |
| 78 | credential and disable writes advance version at the database boundary | INV | tokens bind authorisation versions (docs/05 §3) |
| 105 | database rejects resource identity changes | INV | docs/04 Client/resource immutable identity |
| 126 | deleted client and resource identifiers remain permanently reserved | INV | docs/04 tombstone reservations |
| 160 | rolled back creation does not reserve an identifier | BEH | Postgres transaction semantics; low value |
| 177 | concurrent creation commits one identity | INV | uniqueness under concurrency |
| 194 | configuration revisions cover SQL changes, reject forged revisions, leave no-ops | INV | docs/04 Client configuration revisions (ETag integrity) |
| 217 | resource link changes advance affected client revisions | DUP | client-revision "linked resource changes invalidate the client ETag" |
| 267 | resource configuration revisions reject manual writes and include link movement | INV | docs/04 Resource configuration revisions |
| 302 | organisation authorization version advances on disable and cannot roll back | INV | docs/04 Organisation authorization version |
| 336 | resource classification and immutable owner survive configuration changes | INV | docs/04 Resource revisions |
| 421 | private resource assignments cannot cross tenants through raw writes | INV | tenant isolation DB backstop |

#### `db/migrate-script` (CON 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 10 | ordinary migration provisions the configured runtime role | CON | docs/06 migrate provisions DATABASE_RUNTIME_ROLE |

#### `db/migrate` (DUP 2)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 22 | custom database objects match the reviewed catalogue | DUP | scripts/test-migrations.ts asserts the same catalogue after a fresh install (CI step before the suite) |
| 26 | migrations are idempotent (and lists 26 tables) | DUP | test-migrations.ts re-runs runMigrations and compares receipts; catalogue rls list pins the 26 tables |

#### `db/migrations` (CON 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 7 | the schema matches the committed migrations | CON | TS schema = SQL migration (drizzle-kit diff empty) |

#### `db/operation-audit` (DUP 1, INV 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 23 | audit event can precede its operation and be queried by operation | DUP | client-replay traces /audit-events?operationId= |
| 72 | a dangling operation link rejects commit | INV | docs/04 deferred FK: no dangling reference can commit |

#### `db/queries/access` (INV 5, BEH 3)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 107 | assignment sources do not grant unrelated rows administrator authority | INV | docs/05 §3 unrelated assignments cannot combine |
| 288 | exact pairs never union with client-only, resource-only, other pairs or tenant | INV | docs/05 §3 truth table (shared evaluator auth/member-permission.ts) |
| 416 | inactive global users disappear from every effective target projection | INV | docs/05 §2 admission requires live user |
| 446 | pair access distinguishes assigned scopes from current permission | BEH | explanation shape |
| 475 | pair diagnostics use live ceilings, endpoint state, tenant-local sources | BEH | explanation content |
| 619 | single-target explanations deny registrations without approved admission | BEH | explanation content |
| 641 | client login explanations intersect only effective client-only sources | INV | docs/05 §3 login requires client-only approval |
| 779 | direct administrator explanations agree with actual grants and root writer detection | INV | explanation = effectiveGrants |

#### `db/queries/audit` (DUP 5, CON 1, IMPL 3)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 55 | round-trips JSON data and optional fields inside a transaction | DUP | every HTTP audit assertion reads events back |
| 129 | rolls back the administrative change and its audit event together | DUP | services/operations "failed mutation or journal insertion rolls back"; command-replay failure tests |
| 147 | lists newest first and walks five rows without gaps | DUP | audit-events "staff filter all audit events and walk pages without gaps" |
| 175 | narrows each filter and combines filters | DUP | audit-events "staff filter all audit events" |
| 242 | keeps the event and erased target id when an organisation is erased | DUP | audit-events "staff read retained tenant history after erasure" |
| 255 | rejects unknown actor and outcome vocabularies | CON | mcps/admin audit tool parses outcome/actorType enums |
| 273 | grant effect subjects accept only the global erasure contract | IMPL | trigger parsing rules |
| 327 | client erasure subjects accept only the v2 cascade contract | IMPL | trigger parsing rules |
| 400 | UUID audit lookups retain session subjects, ignore non-UUID member targets | IMPL | trigger parsing rules |

#### `db/queries/effective` (INV 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 32 | filters rows by status and effective window | INV | docs/04 Conventions: windows start inclusive, end exclusive (shared isEffective) |

#### `db/queries/entitlements` (DUP 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 84 | entitlement CRUD filters, pagination and organisation isolation | DUP | http entitlements (filters, cursor, GET isolation) + services/entitlements (foreign-org writes) |

#### `db/queries/grants` (INV 14, BEH 1, FILL 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 147 | organisation-wide grants require effective membership | INV | admin authority (effectiveGrants) |
| 174 | group grants require effective group membership and an active group | INV | admin authority |
| 224 | member grants apply only to that member | INV | admin authority |
| 244 | unions and sorts distinct scopes across principals | BEH | /me shape |
| 274 | ignores an inactive entitlement on its own (loop) | INV | admin authority |
| 291 | ignores disabled organisations | INV | admin authority |
| 301 | ignores other resources and client targets | INV | admin authority (audience) |
| 315 | isolates scope unions by organisation | INV | tenant isolation of grants |
| 339 | no grants without membership or entitlements | INV | admin authority |
| 353 | accepts a transaction handle | FILL | executor type only |
| 371 | root lockout follows effective group grants | INV | README root locks after a platform writer exists |
| 433 | root lockout recognises organisation and member entitlements (each) | INV | root lock |
| 452 | grants and writer detection require an active global user | INV | admin authority |
| 470 | direct administrator assignments cannot exceed their platform capability | INV | docs/04 capability ceilings |
| 488 | direct-session policy rechecks capability windows and resource vocabulary | INV | docs/04 capability ceilings |
| 535 | removing a tenant admin ceiling removes authority | INV | docs/04 capability ceilings |

#### `db/queries/groups` (DUP 1, BEH 1, INV 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 41 | group CRUD is scoped, filtered and paginated | DUP | http groups (filters, cursors, isolation) + services/groups (foreign rows) |
| 111 | membership upserts preserve windows, effectiveness, composite foreign keys | BEH | only test of effective=false in the member list (probe p-group-member-effective); composite FK also in db/schema 767 |
| 224 | assignment instances and revisions survive updates but not recreation | INV | docs/04 Group assignment identities (column immutability only here) |

#### `db/queries/management` (DUP 5)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 67 | client erasure respects references and cascades links, tokens, consents | DUP | http management "erases a client, its cascades"; client-erasure-audit |
| 124 | domain deletion is scoped to its organisation | DUP | services/domains "deletion rejects missing and foreign targets" |
| 143 | exact email combines with q | DUP | http management "reviews exact emails" |
| 166 | all entitlements joins organisations, filters, cursors | DUP | http management "cross-organisation entitlements" |
| 233 | user audit subject matches stay inside filters | DUP | http management "personal audit trails" |

#### `db/queries/members` (FILL 1, DUP 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 78 | platform assignment lookup requires live write authority | FILL | asserts the "Invalid or expired" programmer-error throw |
| 99 | members expose summaries, filter windows, isolate organisations | DUP | http members reads/filters |

#### `db/queries/oauth-clients` (DUP 2, BEH 1, FILL 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 23 | finds the client ceiling and owning organisation | DUP | every machine-token HTTP test |
| 70 | preserves an unowned client through the left join | BEH | unowned client must reach client_unowned, not invalid_token |
| 105 | returns null for an unknown client, including inside a transaction | FILL | executor variant |
| 115 | client administration queries: writes, filters, pagination, links | DUP | http clients |

#### `db/queries/oauth-resources` (DUP 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 20 | resource queries: CRUD, filters, cursors, locks, references | DUP | http resources + resource-replay |

#### `db/queries/oauth-tokens` (DUP 2)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 32 | revokes only live tokens by user or client, exact counts | DUP | token-revocation-audit (user/client/rotate modes) |
| 131 | revokes only live tokens of selected sessions | DUP | token-revocation-audit (session/all modes) |

#### `db/queries/organization-domains` (DUP 2)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 23 | domain queries scope, paginate, filter, enforce ownership | DUP | http domains |
| 109 | routing requires an active, undeleted domain and organisation | DUP | http domains "disabling a domain refuses the next upstream sign-in"; soft-deletion "domain and provider deletion remove native discovery" |

#### `db/queries/organizations` (DUP 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 23 | organisation queries: CRUD, filters, cursor, missing rows | DUP | http organizations list/filters; services/organizations |

#### `db/queries/policy-context` (FILL 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 22 | policy queries reject raw, copied, expired, wrong-purpose contexts | FILL | drives the "Invalid or expired" throws only programmer error reaches |

#### `db/queries/sessions` (DUP 2)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 23 | deletes one user's sessions with exact IDs | DUP | http sessions + session-replay |
| 60 | session queries paginate, hide tokens, enforce ownership | DUP | http sessions "single-session revocation ... pagination" |

#### `db/queries/sso-providers` (DUP 2, BEH 1, INV 1, CON 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 28 | provider queries create, find, update, redact, delete | DUP | http sso-providers |
| 92 | update timestamps use the database clock despite application clock skew | BEH | clock skew |
| 122 | SSO read projections expose only intended configuration | DUP | http sso-providers "tenantReader reads the redacted provider" |
| 184 | platform application serialisation never persists credentials (each) | INV | README: platform secrets stay in the environment, never in rows |
| 255 | explicit own credentials retain the previous byte representation | CON | stored-row compatibility |

#### `db/queries/users` (DUP 3, FILL 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 40 | retires a disabled user's email | DUP | http users "administer a fresh user through ... retirement" |
| 61 | refuses to retire active, inert or retired users | DUP | http users "lifecycle conflicts" |
| 102 | lists users by filters; details expose only account identity | DUP | http users pagination; management exact email |
| 174 | locks, changes status with CHECK, deletes, null for missing | FILL | query plumbing |

#### `db/runtime-role` (INV 21, DUP 2)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 56 | real runtime login can bootstrap, audit and issue a machine token | INV | docs/06: app never runs as owner |
| 190 | runtime cannot mutate evidence, forge subjects, truncate, alter schema, assume owner | INV | docs/04 Runtime database permissions |
| 210 | provisioning rejects invalid names, privileged roles and owners | INV | apps/id/README Database roles |
| 239 | RLS denies missing/read-only context and isolates concurrent tenants | INV | docs/04 RLS (11 tables), docs/05 F4 |
| 494 | installed auth adapter and read contexts work under the runtime role | INV | docs/06 restricted runtime login |
| 545 | access queries use issued tenant contexts on a restricted connection | INV | F4 |
| 710 | group and entitlement queries preserve tenant scope under the runtime login | INV | F4 |
| 845 | restricted audit readers retain isolation and person history after erasure | INV | docs/04 audit RLS |
| 924 | runtime startup rejects disabled tenant RLS | INV | docs/06 startup check |
| 936 | capability RLS permits tenant inspection, denies tenant ceiling writes | INV | docs/04 only platform writers approve ceilings |
| 1037 | runtime erasure audit creates indirect subject references through its trigger | INV | docs/04 subjects are trigger-owned |
| 1056 | runtime lifecycle audit indexes users without subject write privileges | DUP | same mechanism as line 1037 |
| 1095 | restricted runtime evaluates exact user pairs through scoped policy reads | INV | F4/F5 |
| 1401 | restricted domain readers never load another tenant's routing identity | INV | F4 |
| 1482 | restricted SSO queries keep tenant projections separate from secrets | INV | F4 |
| 1535 | restricted organisation readers keep detail, diagnosis, history existence distinct | INV | F4 |
| 1593 | restricted global user/session queries preserve scope, exclude credentials | INV | F4 |
| 1691 | restricted resource queries hide foreign private targets | INV | F4 |
| 1769 | restricted client queries exclude digests | INV | F4 |
| 1842 | restricted revocation queries preserve tenant/user/client/session boundaries | INV | F4 |
| 2141 | runtime startup refuses disabled grant-context RLS | DUP | same assertRuntimeRole count check as line 924 |
| 2157 | administrative RLS isolates rows, keeps routing and append-only broker access | INV | docs/04 RLS + audit insert policy |
| 2353 | policy-user access tables require an effective membership | INV | isolation inventory: policy-user scope |

#### `db/schema` (FILL 1, CON 6, INV 11, BEH 2, DUP 1, IMPL 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 170 | resolves every table configuration and foreign key reference | FILL | drizzle config sanity; migrations.test and typecheck cover |
| 182 | Better Auth creates core records with UUIDv7 and the inert default | CON | adapter ↔ schema |
| 230 | joins accounts onto users through the Drizzle relations | CON | adapter ↔ schema |
| 254 | accepts the verification ids Better Auth computes | CON | adapter ↔ schema |
| 267 | stores OAuth clients, resources, links, signing keys with UUIDv7 | CON | adapter ↔ schema |
| 297 | keeps a machine client inside its owning organisation | INV | ownership FK |
| 327 | accepts the client assertion ids Better Auth computes | CON | adapter ↔ schema |
| 351 | advances updated_at on Better Auth and Drizzle updates | BEH | timestamps |
| 401 | the real Better Auth health route is mounted at /auth | DUP | app.test (other area) mounts /auth |
| 410 | reuses the single bounded pool for readiness checks | BEH | readiness |
| 420 | enforces user identity and lifecycle invariants | INV | docs/04 user identity |
| 449 | ties the email tombstone to retirement | INV | docs/04 user deletion retires email |
| 505 | keys external accounts by issuer and account id | INV | docs/04 unique upstream binding |
| 529 | keys accounts by directory user id per issuer | INV | docs/04 unique upstream binding |
| 572 | binds one SSO provider per organisation | INV | docs/04 |
| 638 | organisation slug, uniqueness and lifecycle invariants | INV | docs/04 |
| 666 | constrains invitation status to Better Auth's vocabulary | CON | adapter vocabulary |
| 691 | routes a domain to exactly one active organisation | INV | routing integrity |
| 767 | keeps groups inside their organisation | INV | docs/04 composite foreign keys |
| 836 | orders effective windows | INV | docs/04 windows |
| 929 | enforces entitlement principals, targets, uniqueness, organisation binding | INV | docs/04 NULLS NOT DISTINCT uniqueness |
| 1068 | cascades organisation data while keeping clients and resources | IMPL | physical ON DELETE behaviour; runtime cannot delete organisations |

#### `db/statement-timeout` (INV 2, CON 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 52 | runtime connection applies a server-side statement deadline | INV | README pool timeouts |
| 75 | timed-out command rolls back and retries the same key | INV | docs/05 §4 before commit no effect |
| 139 | pool lock timeout returns 55P03 and a retryable machine response | CON | id-admin consumers retry 5xx |

#### `http/admin/access` (BEH 2, DUP 1, INV 2)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 44 | tenant users review three sources; readers and machines read | BEH | access view |
| 234 | access reads recheck tenant authority after middleware | DUP | directory-context (same withTenantRead mechanism) |
| 284 | pair creation and reads preserve both targets without direct admin access | INV | docs/05 §3 exact pairs |
| 350 | target access hides foreign private resource existence | INV | tenant isolation |
| 386 | pair explanations expose only approved scopes and sources | BEH | explanation content |

#### `http/admin/audit-events` (CON 1, INV 3, DUP 2)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 37 | staff filter all events and walk pages without gaps | CON | Toolbox poller and mcps/admin page /audit-events |
| 128 | tenant readers see their sign-ins and denied attempts only | INV | tenant audit isolation |
| 158 | tenant audit reads recheck membership after middleware | DUP | directory-context |
| 188 | staff read retained tenant history after erasure | INV | docs/05 §5 UUID audit survives |
| 235 | platform audit reads reject authority revoked after middleware | DUP | platform-directory-context |
| 268 | indirect erasure history visible to staff, not tenant history | INV | tenant audit isolation |

#### `http/admin/capabilities` (CON 1, INV 6, BEH 2, DUP 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 71 | capability commands recover outcomes, revisions on noops, audit, tenant reads | CON | replay/If-Match contract |
| 187 | validation cannot change identity or approve foreign/unknown scopes | INV | docs/04 capability exact targets |
| 264 | removal replays after deletion; blocks resource erasure until references removed | INV | docs/04 resource deletion rejects live references |
| 299 | writers can suspend and remove legacy user capabilities | BEH | operator recovery |
| 320 | a machine cannot recover a command after its approval is revoked | DUP | client-replay "transactional authority rejects stale ... machine credentials" |
| 367 | direct-session ceilings narrow assignments; removal/recreation does not restore | INV | docs/04 ceilings |
| 429 | direct-session approval rejects foreign resources and platform scopes for tenants | INV | escalation guard |
| 452 | user approvals distinguish login, exact pair and renewal | INV | docs/04 one approval does not approve another |
| 556 | user approvals reject unsupported registration and foreign private resources | INV | escalation guard |
| 616 | bound platform ceiling can be removed even when it supplies the last writer | BEH | docs/05 §2 allowed; break-glass recovery |

#### `http/admin/client-erasure-audit` (INV 2)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 72 | client erasure records exact cascades; cross-client effects platform-only | INV | docs/05 §5 tenant client history counts and link |
| 308 | erasure captures a token committed while waiting for its refresh parent | INV | no token survives erasure under concurrency |

#### `http/admin/client-lifecycle` (CON 1, INV 1, DUP 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 32 | lifecycle commands recover results and record noops | CON | replay + noop receipts |
| 101 | links, owner verification, erasure replay without recreating erased state | INV | docs/05 §4 matching key never repeats later effects |
| 197 | failed lifecycle audit rolls back state and reservation | DUP | command-replay "client: failed commands leave no receipt" |

#### `http/admin/client-replay` (CON 2, INV 2, DUP 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 33 | creation and rotation return receipts without repeating effects | CON | docs/05 §4 lost secret needs a new rotation |
| 129 | key errors cannot repeat a rotation | CON | 400 invalid key; 409 reuse |
| 152 | transactional authority rejects stale users, root and machine credentials | INV | docs/05 §4 current authority |
| 218 | deletion replay uses retained operation; revoked session cannot recover | DUP | command-replay "current authority is required" |
| 245 | rotation replay does not revoke grants established afterwards | INV | docs/05 §4 never repeats later effects |

#### `http/admin/client-resource-audit` (INV 4, DUP 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 103 | private foreign link evidence is platform-only | INV | tenant audit isolation |
| 141 | resource link evidence stays visible after unlink and erasure (each kind) | INV | docs/05 §5 |
| 172 | legacy link events cannot leak through tenant filters or pagination | INV | tenant audit isolation |
| 227 | unlink of an unclassified missing target stays platform-only | INV | tenant audit isolation |
| 247 | link audit failure rolls back before same-key recovery (each method) | DUP | command-replay failure tests |

#### `http/admin/client-revision` (CON 4, INV 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 46 | patches reject stale revisions but replay a committed patch first | CON | If-Match contract (mcps/admin INTENT_STALE) |
| 90 | weak, wildcard, malformed and unrelated tags do not update | CON | If-Match contract |
| 119 | concurrent different operations cannot overwrite the same revision | INV | lost-update prevention |
| 135 | linked resource changes invalidate the client ETag | CON | ETag contract |
| 176 | a client patch accepts a missing If-Match | CON | docs/05 §4 without If-Match use current row |

#### `http/admin/clients` (BEH 2, CON 1, INV 2)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 66 | machine and human manage a client through real token minting and revocation (each) | BEH | end-to-end client lifecycle |
| 251 | private key and public clients work through both admin credentials | BEH | client kinds |
| 307 | cross-field failures include errors; create example reaches 404 | CON | error envelope; OpenAPI example |
| 382 | cursor pages have no gaps and do not expose digests | INV | no secret digests in reads |
| 410 | a soft-deleted client's public identifier still conflicts | INV | docs/04 reservations |

#### `http/admin/command-replay` (CON 3)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 156 | matching retries return a receipt, changed input conflicts, current authority required (8 families) | CON | release plan idempotency promise |
| 203 | overlapping same-key commands commit once and return one 409 (7 families) | CON | docs/05 §4 |
| 244 | failed commands leave no receipt and the key remains usable (8 families) | CON | docs/05 §4 before commit |

#### `http/admin/denial-audit` (INV 2)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 52 | audit outage preserves the refusal and never runs the handler (each kind) | INV | docs/05 §5 rejection-audit failure preserves denial |
| 151 | root admission requires its audit; same-key recovery commits once | INV | root requests audited |

#### `http/admin/diagnostics` (BEH 3, INV 1, DUP 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 29 | tenantUsersOnly diagnoses members, unknown emails, disabled users | BEH | sign-in diagnosis |
| 44 | platform readers, admins, machines diagnose tenant users | BEH | sign-in diagnosis |
| 57 | validates required email and organisation id | BEH | validation |
| 68 | tenant diagnosis does not expose foreign users or routing identities | INV | tenant isolation |
| 86 | diagnosis rechecks tenant authority after middleware | DUP | directory-context |

#### `http/admin/directory-context` (INV 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 37 | ten tenant configuration routes recheck membership in their read transaction | INV | docs/05 §4 current authority (canonical); its path list has 9 entries |

#### `http/admin/domains` (CON 2, DUP 1, INV 2, BEH 3)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 24 | creation and deletion recover their result without adopting another target | CON | replay contract |
| 69 | lifecycle replay preserves state; new keys record noops | CON | replay/noop |
| 105 | a failed domain audit rolls back assignment and reservation | DUP | command-replay failure mechanism (same executeOperation transaction) |
| 161 | tenantReader lists only its domains | INV | tenant isolation |
| 195 | create, disable, enable; conflicts and validation | BEH | domain lifecycle |
| 265 | pagination has no gaps and filters disabled rows | BEH | list |
| 304 | disabling a domain refuses the next upstream sign-in | INV | routing state drives admission |
| 356 | machine token performs every domain write | BEH | machine path |

#### `http/admin/entitlement-audit` (INV 1, DUP 2, IMPL 1, CON 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 79 | member entitlement history survives removal and global erasure | INV | docs/05 §5 |
| 163 | subject failure rolls back entitlement and receipt | DUP | organization-erasure-audit subject-failure rollback |
| 212 | entitlement removal and global user erasure are ordered (3 principals x 2 orders) | IMPL | asserts subject rows per lock order |
| 401 | entitlement changes retain their historical audience (3 principals) | CON | documented entitlement v2 audience payload |
| 559 | audience failure rolls back creation, permits same-key recovery (3) | DUP | command-replay failure mechanism |

#### `http/admin/entitlement-replay` (CON 2, DUP 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 64 | all entitlement commands return receipts and one audit fact | CON | replay contract |
| 121 | new-key noops preserve state, record noop outcomes | CON | noop receipts |
| 142 | replay requires current platform authority after middleware | DUP | command-replay "entitlement: ... current authority is required" |

#### `http/admin/entitlements` (BEH 1, INV 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 90 | administrator and machine manage every principal with attributed audits | BEH | lifecycle |
| 262 | client filter, foreign references, tenant isolation, validation | INV | tenant isolation (GET only for foreign ids) |

#### `http/admin/group-erasure-audit` (INV 1, DUP 2, IMPL 2, CON 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 159 | group erasure records removed policy rows, preserves another tenant | INV | docs/04 group deletion captures UUIDs |
| 305 | erasure audit failure restores assignments, entitlements and receipt | DUP | command-replay failure mechanism |
| 336 | assignment removal history and user erasure are ordered (2) | IMPL | subject rows per lock order |
| 488 | group status changes retain policy sources and affected users | CON | documented group v2 policySources |
| 612 | group status history and user erasure are ordered (2) | IMPL | subject rows per lock order |
| 757 | status subject failure rolls back status and receipt | DUP | organization-erasure-audit subject-failure rollback |

#### `http/admin/groups` (INV 2, BEH 3, CON 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 108 | readers read groups and memberships with organisation isolation | INV | tenant isolation |
| 141 | administrator and machine perform the complete group lifecycle | BEH | lifecycle + audit attribution |
| 315 | directory groups reject membership edits; external IDs unique | BEH | product rule |
| 381 | validation, filters and membership cursors | BEH | list/validation |
| 485 | group commands return receipts without repeating effects | CON | replay contract |
| 540 | noops preserve state; old removal replay does not remove a new assignment | INV | docs/05 §4 never repeats later effects |

#### `http/admin/management` (BEH 2, CON 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 68 | erases a client, its cascades and former owner, deletes domains (each) | BEH | lifecycle |
| 269 | reviews exact emails, cross-organisation entitlements, personal trails (each) | BEH | review reads |
| 441 | review filters reject invalid values | CON | validation envelope |

#### `http/admin/me` (CON 3, FILL 1, INV 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 20 | getAdminMe: platform admin cookie | CON | /me shape |
| 43 | getAdminMe: tenant reader cookie | CON | /me shape |
| 66 | getAdminMe: machine token | CON | mcps/admin readPlatform parses principal and grants |
| 88 | every fixture cookie resolves | FILL | fixture sanity |
| 97 | platform authority and root lockout follow the binding after slugs change | INV | docs/04 platform identity from system_bindings |

#### `http/admin/member-audit` (CON 1, INV 1, DUP 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 108 | window audit observes lost and restored access, preserves other tenant | CON | documented member v2 access observations |
| 228 | reinstatement does not recreate removed direct grants | INV | docs/04 Membership revocation |
| 330 | evidence subject failure rolls back member and receipt (each kind) | DUP | organization-erasure-audit subject-failure rollback |

#### `http/admin/members` (INV 3, BEH 2, DUP 3, CON 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 139 | readers read members with organisation isolation | INV | tenant isolation |
| 179 | tenant admin, users-only, platform admin and machine change windows and remove | BEH | lifecycle |
| 317 | member filters, pagination and validation | BEH | list |
| 375 | member PATCH/DELETE/POST recheck authority after middleware (3) | INV | only tenant-command recheck (authorizeTenantMemberCommand) |
| 451 | an owned machine with org:users changes only its tenant's members | INV | tenant-tier machine cannot write another organisation |
| 525 | member commands recover the same result | DUP | command-replay member family |
| 591 | member replay requires current authority | DUP | command-replay member family |
| 631 | member reads recheck membership; projections private | DUP | directory-context |
| 684 | simultaneous member retries commit only one removal | CON | the overlap case command-replay excludes |

#### `http/admin/operation-crash` (INV 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 103 | create/rotate/erase recover after SIGKILL before/after commit (6) | INV | docs/05 F3 crash proof |

#### `http/admin/operations` (CON 3, DUP 1, BEH 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 51 | operation status exposes the receipt to platform audit authority | CON | getOperationStatus shape |
| 81 | unknown operations 404; invalid UUIDs 400 | CON | error envelope |
| 94 | operation reads require authority current at transaction entry | DUP | platform-directory-context |
| 119 | platform operation auditing survives tenant erasure | BEH | receipts outlive tenants |
| 148 | a blocked write returns retryable 503 without retaining an operation | CON | consumers retry 5xx with the same key |

#### `http/admin/organization-erasure-audit` (INV 2, IMPL 1, CON 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 156 | erasure records removed configuration and member history; preserves people | INV | docs/04 Organisation command receipts |
| 277 | rollback on subject capture failure, then same-key recovery | INV | docs/05 §5 (canonical subject-failure case) |
| 304 | organisation and user erasure retain membership effects per order (2) | IMPL | subject rows per lock order |
| 407 | erasure records each deleted grant with its tenant identity | CON | documented revoked grant contexts |

#### `http/admin/organizations` (CON 4, INV 2, BEH 2)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 77 | pagination has no gaps; filters name, slug, status | CON | list contract |
| 115 | cookie and machine writes return 201 and attributed audit with request ID | CON | mcps/admin x-request-id evidence link |
| 164 | own tenant reader succeeds, outsider hidden | INV | tenant isolation |
| 197 | nullable fields and audit changes | BEH | update |
| 222 | global browser session survives organisation disable | INV | docs/04 Global session boundary |
| 301 | erase confirmation, owned client conflict, erasure retains audit | BEH | erase |
| 342 | paths validate UUIDs; writes 404 for missing rows | CON | error envelope |
| 370 | commands recover results across lifecycle changes and erasure | CON | replay contract |

#### `http/admin/platform-directory-context` (INV 2, CON 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 23 | fleet reads reject platform authority revoked after middleware | INV | current authority (canonical platform case) |
| 51 | fleet responses prohibit caching | CON | Cache-Control no-store |
| 61 | SSO probe receives only endpoints, runs after the read transaction | INV | no secrets or open transaction during network I/O |

#### `http/admin/request-security` (DUP 1, CON 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 15 | hostile cookie Origin cannot POST/DELETE an organisation (2) | DUP | matrix "untrusted origin" + principal.test denial audit |
| 44 | erase requires query confirmation, existence before mismatch (4 entities) | CON | erase contract |

#### `http/admin/resource-replay` (CON 5, INV 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 41 | creation and revision-aware edits replay before stale checks | CON | replay ordering |
| 83 | preconditions and concurrent edits reject lost updates | INV | lost-update prevention |
| 113 | resource tags cover linked clients | CON | ETag contract |
| 148 | noops and historical erasure recovery preserve later state | CON | replay contract |
| 189 | linked resource erasure fails without reserving its key | CON | failure leaves key usable |
| 219 | creation normalises omitted and explicit shared defaults | CON | canonical input |

#### `http/admin/resources` (BEH 3, INV 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 58 | machine and human perform the complete resource lifecycle (each) | BEH | lifecycle |
| 151 | conflicts, protection, confirmation, validation | BEH | errors |
| 200 | cursor pages have no gaps | BEH | list |
| 231 | creation records immutable ownership, rejects conflicting classification | INV | docs/04 Resource revisions |

#### `http/admin/revisions` (CON 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 701 | If-Match/If-None-Match per entity: assignment, entitlement, group, member, organisation, SSO (6) | CON | revision contract (mcps/admin INTENT_STALE) |

#### `http/admin/route-table` (FILL 1, IMPL 1, DUP 3, BEH 2)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 13 | tierOf distinguishes platform, organisation and me | FILL | one-line helper |
| 18 | registerRoute describes, authorises and handles a route | IMPL | wiring with a stub database |
| 99 | me serialises a user/client principal separately from grants (2) | DUP | me.integration getAdminMe user/machine |
| 134 | me serialises root scopes without phantom grants | BEH | root /me |
| 156 | open routes still audit a root request | DUP | matrix "getAdminMe: root is admitted by authorisation" |
| 184 | open routes skip authorisation for zero grants | DUP | matrix "getAdminMe: no grant is admitted" |
| 201 | validity windows preserve omitted and cleared boundaries | BEH | null vs omitted |

#### `http/admin/routes` (CON 2)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 16 | command contract gaps cannot grow unnoticed | CON | every mutation declares Idempotency-Key, receipt headers, If-Match |
| 91 | admin route tables equal the OpenAPI operation union | CON | openapi.admin.json |

#### `http/admin/session-replay` (INV 2, DUP 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 55 | single session revocation replays after removal; secret-free effects | INV | docs/04 Global session command recovery |
| 90 | revoke-all replay preserves later sessions; new empty commands are noops | INV | never repeats later effects |
| 148 | users-only authority suffices; revoked authority denies recovery | DUP | command-replay session family |

#### `http/admin/sessions` (BEH 1, INV 2)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 134 | administrator and machine revoke global user sessions | BEH | revocation |
| 161 | single-session revocation preserves another user's session | INV | revocation precision |
| 216 | tenant session aliases cannot expose or revoke a shared person's login | INV | docs/04 Global session boundary |

#### `http/admin/soft-deletion` (INV 8, IMPL 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 75 | user deletion retains identity, hides reads, cannot be enabled | INV | docs/04 Soft deletion |
| 175 | membership removal reversible; organisation deletion terminal | INV | docs/04 Lifecycle values |
| 211 | group deletion retires only new assignment effects, denies reuse | INV | docs/04 Soft deletion |
| 303 | unlink and relink allocate a new relationship; client deletion clears credentials | INV | docs/04 Resource link deletion boundary |
| 416 | domain and provider deletion remove native discovery, keep identifiers | INV | docs/04 Soft deletion |
| 479 | live uniqueness permits replacements at one timestamp; rejects duplicate null principals | INV | docs/04 Conventions |
| 534 | parent deletion committed first denies a waiting relationship creation | INV | docs/04 parent guards under locks |
| 600 | startup refuses domain DELETE privileges | INV | docs/04 runtime cannot DELETE product rows |
| 617 | soft-deletion subjects require the complete new event envelope (3) | IMPL | trigger parsing rules |

#### `http/admin/sso-providers` (INV 4, BEH 9, CON 2, DUP 2)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 64 | tenantReader reads the redacted provider only for its organisation | INV | secrets redacted; isolation |
| 101 | create and update without replacing the secret, then delete | BEH | lifecycle |
| 157 | provider validation and missing organisation writes | BEH | validation |
| 185 | machine token creates, updates and deletes the provider | BEH | machine path |
| 225 | admins, readers and machine test the in-process SSO issuer | BEH | SSO test |
| 249 | SSO test reports a missing provider and unreachable issuer | BEH | SSO test |
| 309 | retries recover historical redacted results without replacing later credentials | INV | never repeats later effects |
| 370 | noops preserve timestamps and credentials | CON | noop receipts |
| 429 | SSO audit failure rolls back credentials and reservation | DUP | command-replay failure mechanism |
| 467 | concurrent SSO creation has one mutation and a recoverable result | CON | overlap contract |
| 496 | SSO replay rechecks current platform authority | DUP | command-replay current authority |
| 536 | provider rejects supplied pkce (existing x pkce) | BEH | validation |
| 555 | omitted Google oidc uses platform defaults; retries replay or noop | BEH | platform defaults |
| 599 | platform validation rejects row credentials and unconfigured directories | INV | README platform secrets never in rows |
| 642 | tenantReader sees the platform client id without credentials | INV | redaction |
| 722 | SSO diagnosis reports each endpoint on an origin removed from trustedOrigins | BEH | diagnosis |
| 750 | own credentials receive directory scopes (each issuer) | BEH | defaults |

#### `http/admin/token-revocation-audit` (INV 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 67 | restricted revocation retains exact safe token effects, rolls back, replays (5 modes) | INV | docs/04 Global session command recovery; docs/05 §5 |

#### `http/admin/user-erasure-audit` (INV 2, DUP 1, IMPL 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 267 | global user erasure records cross-tenant and owned-client effects without credentials | INV | docs/04 Global user command recovery |
| 487 | erasure rolls back all effects when subject capture fails | DUP | organization-erasure-audit subject-failure rollback |
| 514 | erasure preserves external restrictions and rolls back earlier effects (each) | INV | parent references block erasure |
| 554 | erasure orders owned-client effects with client erasure (2) | IMPL | subject rows per lock order |

#### `http/admin/user-erasure-race` (INV 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 70 | user erasure records children committed while waiting for a parent (4) | INV | no child survives erasure under concurrency |

#### `http/admin/user-replay` (CON 3, INV 3)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 60 | user commands return receipts after erasure | CON | replay contract |
| 111 | new-key lifecycle noops preserve state and timestamps | CON | noop receipts |
| 134 | disable reconciliation distinguishes replay from a new command | INV | docs/04 Global user command recovery |
| 291 | lifecycle and erasure retain distinct scopes and recheck before recovery | INV | platform:users vs platform:write |
| 354 | pool exhaustion returns 503 and permits same-key recovery (2) | CON | consumers retry 5xx; docs/05 §4 |
| 436 | global user offboarding retains the last-writer safeguard | INV | docs/05 §2 |

#### `http/admin/users` (BEH 2, DUP 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 144 | administrator and machine administer a fresh user through erasure | BEH | lifecycle |
| 324 | pagination, platform reader access, validation, lifecycle conflicts | BEH | list/errors |
| 415 | global identity reads reject authority revoked after middleware | DUP | platform-directory-context |

#### `operations/metrics` (INV 1, BEH 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 10 | summaries retain in-flight work without request identifiers or payloads | INV | docs/05 §7 fixed-cardinality summaries; no identifiers |
| 54 | dimensions are finite; pool values instantaneous | BEH | operator metrics |

#### `operations/preflight` (BEH 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 8 | custody preflight reads retained material without changing it | BEH | OPERATIONS.md preflight |

#### `services/access` (DUP 2)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 101 | member command authority reads only its tenant's access | DUP | http access "target access hides foreign ..." + matrix outsider |
| 116 | access service checks existence without auditing reads | DUP | http access read() asserts no audit row |

#### `services/audit` (IMPL 1, DUP 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 40 | audit queries bind authority and reject caller-supplied tenant substitution | IMPL | service signature; HTTP cannot supply a different tenant |
| 84 | audit reads filter, paginate, force the organisation, reject missing | DUP | http audit-events |

#### `services/client-grants` (INV 4, DUP 2)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 110 | client disable/erase records complete effects without exposing foreign grants to owner (each) | INV | docs/05 §5 owner sees counts and link |
| 213 | client rolls back context and lifecycle effects when audit fails (each) | DUP | command-replay failure mechanism |
| 237 | already-disabled client reconciles remaining contexts before a no-op | INV | reconciliation |
| 256 | platform effect event rolls back when the owner event fails (each) | DUP | same transaction mechanism |
| 300 | secret rotation revokes existing client contexts atomically (2) | INV | docs/04 security changes revoke stored grants |
| 358 | client creation waits for organisation erasure and returns not_found | INV | parent guard under lock |

#### `services/clients` (DUP 5, BEH 1, INV 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 92 | lifecycle hides digests, returns secrets once, revokes tokens, audits | DUP | http clients + client-replay |
| 227 | public and private key clients have no secret | DUP | http clients "private key and public clients" |
| 268 | every cross-field rule rejects creation with field errors | DUP | http clients "cross-field failures include errors" |
| 305 | updates recheck the stored configuration, including legacy invalid rows | BEH | legacy rows |
| 365 | unknown clients, organisations, resources return 404 without audit | DUP | matrix "unknown ids" |
| 400 | erasure checks existence, confirmation and entitlements in order | DUP | request-security erase; management client erasure |
| 445 | client audit allowlists security settings, omits raw JWK | INV | no secrets in audit |

#### `services/command-policy-lock` (INV 3)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 33 | capability/resource revocation and user command are ordered (4) | INV | docs/05 §4 revocation-first denies |
| 202 | session expiry during a policy lock wait denies before mutation | INV | docs/05 §4 post-lock checks |
| 302 | concurrent policy lock upgrades roll back one command; same-key recovery | INV | deadlock handling |

#### `services/domains` (INV 2, DUP 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 80 | domain writes audit once, record noops, reject foreign rows | INV | cross-tenant domain ids only checked here |
| 158 | ownership conflicts and audit failures roll back | DUP | http domains conflicts + audit failure |
| 193 | deletion rejects missing and foreign targets, rolls back with audit | INV | cross-tenant delete only checked here |

#### `services/entitlements` (DUP 2, INV 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 131 | writes audit once, keep immutable fields, preserve omitted windows | DUP | http entitlements lifecycle |
| 252 | validates principal, target, references; foreign-organisation writes 404 | INV | cross-tenant PATCH/disable/enable/remove only checked here |
| 372 | every write rolls back when its audit cannot be stored | DUP | command-replay failure mechanism |

#### `services/groups` (DUP 1, INV 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 129 | lifecycle and membership writes emit one audit each; erasure cascades | DUP | http groups lifecycle + group-erasure-audit |
| 226 | group writes reject missing or foreign rows, managed memberships, constraints | INV | cross-tenant group ids only checked here |

#### `services/machine-command-policy` (INV 2)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 35 | machine revocation and command are ordered (each source x order) | INV | docs/05 §4 |
| 210 | machine token expiry during a policy wait is checked before admission | INV | expiry after lock wait |

#### `services/members` (DUP 3, INV 2, FILL 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 135 | windows and removal audit, cascade grants, retain users | DUP | http members + member-audit |
| 194 | missing rows and CHECK failures leave no writes | DUP | http members constraint_violation + matrix unknown ids |
| 226 | revocation retains identity, denies tenant A, preserves tenant B, explicit reinstatement | INV | docs/04 Membership revocation |
| 339 | member configuration omits identity, rejects missing organisations | DUP | http members reads + matrix |
| 353 | tenant actor is immutable; the command runner cannot be reused | FILL | programmer-error throws |
| 476 | removal irreversibly revokes grant contexts, audits only new IDs | INV | docs/04 Membership revocation |

#### `services/operations` (CON 1, INV 2, DUP 1, FILL 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 41 | committed commands replay by canonical input, current authorisation, isolated keys (200/201/204) | CON | key isolation by actor/scope/name held only here |
| 120 | failed mutation or journal insertion rolls back audit and releases the key | INV | docs/05 §4 |
| 166 | concurrent duplicates get a retryable response, then recover | DUP | command-replay overlap |
| 211 | invalid keys and non-JSON numbers cannot reserve an operation | FILL | NaN unreachable from JSON; key length also checked in command.ts |
| 232 | lock timeout during authority/mutation rolls back and clears pooled settings (2) | INV | pooled connections retain no state (docs/04) |

#### `services/organizations` (DUP 4, INV 3)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 106 | creates, lists, gets, updates with one audit per write | DUP | http organizations create/update |
| 140 | missing organisation paths return 404 and write no audit | DUP | matrix "unknown ids" |
| 157 | tenant kill switch revokes only machine rows, preserves sessions and user grants | INV | docs/04 Global session boundary (only here) |
| 256 | erase rejects confirmation and clients, cascades members and domains | DUP | http organizations erase + organization-erasure-audit |
| 308 | disabling tenant A preserves a shared person's session and tenant B tokens | INV | F4 A/B isolation (only here) |
| 436 | disable irreversibly revokes only its tenant contexts | INV | docs/04 Organisation authorization version (only here) |
| 478 | erasure records deleted contexts without touching the other tenant | DUP | organization-erasure-audit "records each deleted grant" |

#### `services/resource-grants` (INV 3, DUP 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 102 | resource disable revokes contexts across tenants, never revives authority | INV | docs/04 Resource revisions |
| 148 | already-disabled resource reconciles remaining contexts | INV | reconciliation |
| 166 | resource deletion records every revoked context | INV | docs/05 §5 |
| 211 | resource rolls back context effects when audit fails (each) | DUP | command-replay failure mechanism |

#### `services/resources` (DUP 3, INV 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 64 | lifecycle attributes one audit per write | DUP | http resources lifecycle |
| 122 | missing resources, confirmation mismatch, references fail without audit | DUP | http resources errors + request-security |
| 163 | audit failures roll back every resource write | DUP | command-replay resource family |
| 197 | erasure requires explicit unlinking in service and database | INV | docs/04 deletion rejects live references (DB guard) |

#### `services/root-policy-lock` (INV 1)

| Line | Test | Class | Basis |
| ---: | --- | --- | --- |
| 36 | root admission and first writer activation are ordered (3 sources x 2 orders) | INV | root locks once a writer exists, under concurrency |


## Mutation probes

**What could not be run.** The first planned probe, making `src/http/authorize.ts` line 81 admit any platform grant regardless of scope, was refused by the session's permission classifier ("Security Weaken"), with the instruction not to pursue the same outcome another way. No edit that weakens an authorisation, isolation, credential or audit check was attempted after that. The fourteen security probes below are therefore **not run**; they are listed so that the coordinator can have them run with the owner's permission. Everything in the "run" table was edited in the audit worktree, run against the 87 area files in one process (the 88th, `runtime-role`, cannot run in that set; see Q2), and restored with `git checkout -- <file>`; `git status --short` was empty after each.

### Run (data-integrity and contract checks)

Baseline for the same 87 files: 1,295 pass, 0 fail, 236 s.

| # | What was broken | Where | What failed | Verdict |
| --- | --- | --- | --- | --- |
| 1 | `If-Match` ignored on organisation PATCH | `src/services/organizations.ts` line 94 (`expected &&` → `false &&`) | 1: `revisions` "organisation revision rejects stale edits while replay preserves its original result" | Caught once, at HTTP (CON). No service test passes `expected` |
| 2 | `If-None-Match: *` ignored on group assignment PUT | `src/services/groups.ts` line 277 | 1: `revisions` "assignment creation and replacement preconditions protect recreated pairs and historical replay" | Caught once, at HTTP. The admin MCP depends on this 412 (`mcps/admin/src/staff.ts` line 68) |
| 3 | `If-Match` ignored on client PATCH | `src/services/clients.ts` line 315 | 4: all in `client-revision` | Caught at HTTP |
| 4 | `If-Match` ignored on entitlement PATCH | `src/services/entitlements.ts` line 156 | 1: `revisions` "entitlement revisions reject stale and recreated targets without breaking replay" | Caught once, at HTTP |
| 5 | Journal accepts a reused key with different input (fingerprint not compared) | `src/services/operations.ts` line 96 | 29 failures, 27 distinct tests in 15 files, including all 8 `command-replay` "matching retries" rows and `services/operations` "status %s" ×3 | Caught everywhere: one fact, 27 tests |
| 6 | A replay answers 200 instead of the original status (and a body for 204) | `src/http/admin/command.ts` lines 125 and 128 | 66 tests in 26 files (most through the shared `expectReceipt` helper) | Caught everywhere; neither consumer would notice (Q3) |
| 7 | Every receipt records `applied` (noops lost) | `src/http/admin/command.ts` line 112 | 15 tests in 11 files: about one noop test per command family | Caught per family; no consumer reads `outcome` |
| 8 | Group list includes soft-deleted groups | `src/db/queries/groups.ts` line 73 (drop `deletedAt is null`) | **none** | **Gap**: docs/04 line 188 says ordinary reads exclude deleted rows |
| 9 | Group member list reports every assignment as effective | `src/db/queries/groups.ts` line 292 | 1: `db/queries/groups` "group membership upserts preserve omitted windows, compute effectiveness and enforce composite foreign keys" | Caught only below HTTP: the HTTP tests check `effective: true` only |
| 10 | Cursor pages repeat the cursor row (`lt` → `lte`) | `src/http/pagination.ts` line 27 | 30 tests in 22 files, query and HTTP alike | Caught everywhere |
| 11 | Directory-managed groups accept manual membership edits | `src/services/groups.ts` line 234 | 2: `groups` "directory groups reject both membership edits and external IDs are unique", `services/groups` "group writes reject missing or foreign rows, managed memberships and database constraints" | Caught at HTTP and service (the service one is a duplicate for this fact) |
| 12 | Organisation erasure ignores owned clients | `src/services/organizations.ts` line 202 | 2: `services/organizations` "erase rejects confirmation and clients, cascades members and domains and retains audit", `organizations` "eraseOrganization: confirmation, owned client conflict and successful erasure retains audit" | Caught at service and HTTP |
| 13 | Organisation erasure ignores its `confirm` value | `src/services/organizations.ts` line 196 | The same 2 tests | Caught at service and HTTP. `request-security` "erase requires query confirmation" does not catch it: it only uses unknown ids, where 404 comes first |
| 14 | Organisation search becomes case-sensitive (`ilike` → `like`) | `src/db/queries/organizations.ts` lines 62–63 | 2: `organizations` "listOrganizations: platform admin pagination has no gaps and filters name, slug and status", `db/queries/organizations` | Caught at HTTP and query |

Names used elsewhere in this report: 1 p-org-revision, 2 p-group-ifnonematch, 3 p-client-revision, 4 p-entitlement-revision, 5 p-journal-fingerprint, 6 p-replay-status, 7 p-noop-outcome, 8 p-list-groups-deleted, 9 p-group-member-effective, 10 p-cursor-lte, 11 p-directory-managed, 12 p-org-erase-clients, 13 p-org-erase-confirm, 14 p-org-search-case.

Fourteen probes, one uncaught (8). Full run 3 (see Measurements) applied probe 8 to the whole ID suite of 142 files: 2,040 pass, 0 fail, 100% lines and functions. Nothing in the ID suite notices.

Reading the run table: every contract a consumer depends on (preconditions, fingerprint, status, cursor) is caught at the HTTP layer. Probes 1, 2 and 4 are caught by exactly one test each, all in the `revisions` table, which makes it the most valuable file per line in the area; probes 5, 6 and 10 are caught by 27 to 66 tests each, which is the duplication measured. Probe 9 is caught only below HTTP.

### Not run (blocked)

| # | Planned break | Where | Tests expected to hold it (by name, unverified) |
| --- | --- | --- | --- |
| S1 | A platform grant admits regardless of the route's scope | `src/http/authorize.ts` line 81 | matrix "platform reader insufficient scope", "machine insufficient scope"; but `authorizeCommand` re-checks writes inside the transaction, so this may be masked |
| S2 | Any scope in the caller's own organisation admits | `src/http/authorize.ts` line 90 | matrix "insufficient scope" (tenant principals); `withTenantRead` re-checks |
| S3 | The organisation of the path is not compared | `src/http/authorize.ts` line 88 | matrix "outsider organisation" (expects 404, would get 403 from the re-check) |
| S4 | The user's grant organisation is not compared in the transaction | `src/services/command-authority.ts` line 104 | none expected: the middleware refuses first |
| S5 | A tenant machine's organisation is not compared in the transaction | `src/services/command-authority.ts` line 141 | none expected: the middleware refuses first |
| S6 | A user-delegated token (`sid`) is accepted | `src/http/principal.ts` line 295 | only `src/http/principal.test.ts` (other area) |
| S7 | Root is admitted after a platform writer exists | `src/http/principal.ts` lines 220–224; `src/services/command-authority.ts` lines 38–45 | `me` 97, `client-replay` 152, `root-policy-lock`; `src/http/root.integration.test.ts` |
| S8 | A machine token's authorisation versions are not compared | `src/http/principal.ts` lines 288–292 and `src/services/command-authority.ts` lines 123–127 | `client-replay` 152 ("stale ... machine credentials"), `principal.test.ts` |
| S9 | The journal ignores the actor (or scope) when looking up a key | `src/services/operations.ts` lines 88–92 | `services/operations` "status %s ... isolated keys" only; no HTTP test sends one key from two actors |
| S10 | Replay is returned before current authority is checked | `src/services/operations.ts` line 74 | `command-replay` "current authority is required" (8 families) |
| S11 | Freshness is not checked for human commands | `src/http/admin/command.ts` lines 98–102 | `auth/verified-sso.integration.test.ts` only; nothing in this area |
| S12 | Organisation predicate dropped from group and entitlement lookups | `src/db/queries/groups.ts` line 51, `src/db/queries/entitlements.ts` line 58 | `services/groups` 226, `services/entitlements` 252, `db/queries/*`; HTTP only for entitlement GET |
| S13 | Tenant audit history not filtered by organisation | `src/db/queries/audit.ts` line 105 | `audit-events` 128 (superuser connection, so RLS would not mask it), `runtime-role` 845 |
| S14 | RLS disabled, or a permissive policy added, on one table; product-row DELETE not revoked | database; `src/db/runtime-role.ts` line 53 | see Q2; `soft-deletion` 600, `runtime-role` 190 and 924 |

### Q2. `db/runtime-role.integration.test.ts`

- **Production invariant: yes.** `docs/06-deploying-answerable-id.md` line 27 ("The application's `DATABASE_URL` is an unprivileged login, never the owner ... Eleven tables rely on it for tenant isolation"), `apps/id/README.md` "Database roles", and `src/runtime.ts` calls `assertRuntimeRole` before listening in every environment but test.
- **It is the main place RLS is tested at all.** The suite's own connection is the role `answerable`, a superuser (measured with `psql`: `rolsuper = 1`), and superusers bypass RLS. Only 15 files in this area (and 6 elsewhere) create a restricted role with `configureRuntimeRole`; the other 73 files, including every matrix test and every query and service test, cannot observe RLS.
- **The file cannot run alone.** `bun test src/db/runtime-role.integration.test.ts` fails at load with "Unhandled error between tests" while Bun parses `src/http/pages/fonts/PublicSans-Variable.woff2` as JavaScript: 0 pass, 1 fail, in four separate runs. `bun test src/db/` fails the same way and then hangs on the next file (killed after 4.5 minutes). Copies behave erratically: its first 2,352 lines passed (22 tests) under one file name and failed at load under another (twice); its header plus the last test passed (twice). The file passes only inside the full suite, where another file loads the pages module first. Its inventory time therefore comes from the JUnit report of full runs 2 and 3.
- **Which tests fail if RLS is disabled on one table: not run.** The probe (`ALTER TABLE ... DISABLE ROW LEVEL SECURITY`, or an extra permissive policy) was not attempted after the permission classifier refused the first security-weakening edit (see Mutation probes). From reading only, unverified: `assertRuntimeRole` counts the 11 RLS flags, so tests that call it on the runtime connection (56, 924, 2141, and `soft-deletion` 600) and the catalogue comparison would fail; a permissive extra policy keeps the count at 11 and would be caught only by the behavioural tests that read that table under the restricted role (239, 545, 710, 845, 1095–1842, 2157, 2353) and by the catalogue's policy list.
- **Is it a matrix?** Partly. Lines 1,401–2,141 hold seven tests of one shape (seed two tenants as owner, read through the runtime role in several scopes, compare visible rows), 740 lines in all; 545–845 add three more of the same shape (300 lines). A table of (query, scope, expected tenant ids) over one shared seed would replace roughly 1,040 lines with an estimated 350. Tests 924 and 2141 check the same `assertRuntimeRole` count with a different table; one is enough.

### Q3. Operation journal, idempotency and replay

**The public promise** (`reports/answerable-id-release-decision-plan.md` line 17): the same actor, tenant, key and normalised command, with current authority, recovers the committed result without repeating effects; reservations are permanent; fresh authentication applies to replay. `docs/05` §4 adds: before commit nothing remains; after commit the original status code returns (204 stays empty); mismatched input conflicts; a stale revision fails; a matching key never repeats later effects.

**Held at the HTTP layer with `Idempotency-Key`:** `command-replay` (23 tests over 8 families: receipt with headers and original status, 409 `idempotency_key_reused`, 403 when authority was revoked between admission and the transaction, 409 `operation_in_progress` for an overlapping send, no receipt after a failure and the key still usable); per-family replay tests in `organizations`, `groups`, `domains`, `entitlement-replay`, `client-replay`, `client-lifecycle`, `resource-replay`, `session-replay`, `user-replay`, `sso-providers`, `capabilities`, `members`; `revisions` (replay is checked before the stale revision); `operations` 148, `statement-timeout` 75 and `user-replay` 354 (a 503 leaves no operation and the same key then commits). Freshness on replay is not tested in this area; only `auth/verified-sso.integration.test.ts` asserts `reauthentication_required`.

**Internal, not observable by a consumer:** `operation-crash` (SIGKILL of a worker process before and after commit: Postgres transaction atomicity seen from outside); `command-policy-lock`, `machine-command-policy` and `root-policy-lock` (which transaction blocks on which, observed with `pg_blocking_pids`; the consumer sees only the outcome); `services/operations` 232 (lock timeout clears pooled `SET` state); key isolation by actor, scope and command name (`services/operations` 41, the only test of it).

**What the consumers rely on** (read from `packages/id-admin/src/index.ts` and `mcps/admin/src/calls.ts`): a caller-chosen key reused after a 401 token renewal and once after a 5xx or no answer; `Idempotency-Replayed: true` with the receipt's `resultReference.id` standing in for the row id; `Operation-Id`; `409 idempotency_key_reused`; `412` on a stale `If-Match` or `If-None-Match: *` (mapped to `INTENT_STALE`); `GET /me` shape. Nothing beyond "same key, same result; different input, 409; stale precondition, 412; a 5xx left nothing behind". They do not read `outcome` (`noop`), do not compare the replayed status code (`manage` treats any 2xx alike and handles a 204 or a JSON body), never call `GET /operations/{id}`, and use random UUID keys so cross-actor key isolation never arises. Probe p-replay-status (replays answer 200) broke 66 tests but, by reading their code, would break neither consumer.

### Q6. The admin API's authorisation boundary at HTTP

Tests that hold each boundary (named; probes not run, see Mutation probes):

| Boundary | Tests |
| --- | --- |
| A tenant-tier principal cannot read or write another organisation | matrix "outsider organisation" (21 org-scoped routes, a cookie user with `org:*` in its own organisation gets 404 and one `admin.denied` row); `members` 451 "an owned machine with org:users changes only its tenant's members" (tenant machine token, 404 for the other organisation, PATCH only); reader isolation tests in `groups` 108, `members` 139, `domains` 161, `entitlements` 262, `organizations` 164, `audit-events` 128 |
| `platform:read` cannot write | matrix "platform reader insufficient scope" and "machine insufficient scope" (50 non-read platform routes each; the machine case also checks `WWW-Authenticate: Bearer error="insufficient_scope"`); matrix "insufficient scope" (80 routes: a tenant principal on a platform route, or the wrong `org:*` scope on an organisation route) |
| A user-delegated token is refused at `/api/admin` | none in this area. Only `src/http/principal.test.ts` "rejects delegated credentials including an empty sid" (unit test with a stubbed verifier, other area). No test sends a real user-delegated token for the admin resource |
| Root locks once a platform administrator exists | `me` 97 (root gets 403 after a writer exists, binding not slug); `client-replay` 152 (root refused inside the transaction); `services/root-policy-lock` (6 orderings); `db/queries/grants` 371/433 (writer detection); `src/http/root.integration.test.ts` (other area). The fixture sets `ROOT_ADMIN_BREAK_GLASS=true` by default, so every other root request in the area runs unlocked |

Defence in depth matters for reading these: the route middleware (`src/http/authorize.ts`) and the in-transaction check (`src/services/command-authority.ts`, through `withTenantRead`, `withPlatformRead` and the command wrappers) test the same scopes twice. A test that sends a request cannot tell which of the two refused it, so breaking either one alone may leave every HTTP test green. That is exactly what the blocked probes were meant to measure.

## Gaps

### Invariants and contracts the docs claim, and what holds each

| Claim (source) | Held by | Note |
| --- | --- | --- |
| Runtime is a non-owner role; startup refuses an unsafe role (docs/06 line 27, README "Database roles") | `runtime-role` 56, 190, 210, 924, 2141; `soft-deletion` 600; `migrate-script` | file cannot run alone (see Q2) |
| RLS isolates 11 tables (docs/04 line 72, F4) | `runtime-role` 239, 545, 710, 845, 936, 1095–1842, 2157, 2353; restricted-role audit files | the other 73 files run as a superuser |
| All 49 mutations require `Idempotency-Key` and expose `Operation-Id` / `Idempotency-Replayed` (docs/05 §4) | `routes` 16 (metadata), `command-replay` (runtime, 8 of the 11 command families) | domain, SSO provider and capability commands rely on their own files |
| Replay rechecks current authority (release plan line 17) | `command-replay` 156, `client-replay` 152, `members` 375, `capabilities` 320 | |
| Replay rechecks five-minute freshness (release plan line 17, mutation inventory) | none in this area | only `auth/verified-sso.integration.test.ts` |
| Before commit nothing remains; after commit a receipt with the original status (docs/05 §4) | `command-replay` 244, `statement-timeout` 75, `operations` 148, `user-replay` 354, `operation-crash` | |
| Mismatched input conflicts; stale revision fails without overwrite (docs/05 §4) | `command-replay` 156, `revisions`, `client-revision`, `resource-replay` 83 | probes: 29 and 1–4 failures |
| A matching key never repeats later effects (docs/05 §4) | `groups` 540, `client-replay` 245, `session-replay` 90, `sso-providers` 309, `client-lifecycle` 101 | |
| Reservations are permanent; runtime cannot alter them (docs/04 line 78, README) | `services/operations` 41, `runtime-role` 190 | |
| Effects, audit, subjects and receipt commit together (docs/04 line 52) | `command-replay` 244, `organization-erasure-audit` 277 and 18 copies | |
| Rejection-audit failure keeps the denial (docs/05 §5) | `denial-audit` 52 | |
| Root locks once a platform writer exists; break-glass reopens it (README first run) | `me` 97, `client-replay` 152, `root-policy-lock`, `db/queries/grants` 371, 433 | |
| A tenant cannot reach global sessions (docs/04 "Global session boundary") | `sessions` 216, `organizations` 222, `services/organizations` 157, 308 | |
| Capability ceilings are platform-only and exact (docs/04 line 170) | matrix on capability routes, `runtime-role` 936, `capabilities` 187, 429, 556 | |
| Ordinary reads exclude deleted rows (docs/04 line 188) | `soft-deletion` 75 (users), single-row GETs after erase in each lifecycle test | **group list does not**: probe p-list-groups-deleted, 0 failures |
| Platform identity from `system_bindings`, not slugs (docs/04 line 48) | `me` 97 | |
| Process summaries carry no identifiers (docs/05 §7) | `metrics` 10 | |

### What an operator would need proven that nothing in this area proves

| Gap | Worth a test? | What it would assert |
| --- | --- | --- |
| An erased group still appears in `GET /organizations/{id}/groups` if the list loses its `deletedAt` filter (probe: 0 failures) | Yes, one assertion | After `DELETE .../groups/{id}`, the list no longer contains it. Same check for every list route that has an erase or remove (clients, resources, domains, entitlements, members) |
| Cross-tenant child ids on writes are checked only by service tests on a superuser connection | Yes, one matrix entry | For every route with `:organizationId` and a child id, a platform administrator using a child id from the other organisation gets 404 and no audit success row |
| The HTTP suite never runs as the restricted runtime role | Yes, as a fixture change rather than new tests | `createAdminFixture` serves the app on a role made by `configureRuntimeRole` (seeding stays on the owner). Every HTTP test then also proves grants and RLS for the path it drives; today the other 73 files (69 of which use the database) cannot see a missing `GRANT` or RLS scope |
| A real user-delegated token at `/api/admin` | Yes, one integration test | A token from the real user OAuth flow, presented as a bearer to `/api/admin/v1/me`, gets 401 `invalid_token` (today only a unit test with a stubbed verifier) |
| Which layer refuses an out-of-scope request (middleware or transaction) | Not as a test; as the blocked probes | Run the 14 security probes listed under Mutation probes with the owner's permission |
| Rate limits on `/api/admin` | No test; there is no limiter to test | Only Better Auth's limiter exists, on `/auth`. A runaway machine client can issue writes as fast as the pool allows. Product decision (release checklist E6) |
| Growth of `admin_operations` and `audit_events` (permanent rows, no retention) | No test; an operations note | Size and index growth per million commands; cursor queries stay index-only |
| `q` search passes `%` and `_` to `ILIKE` unescaped (`db/queries/organizations.ts` line 62 and the other list queries) | No | Authorised readers only; a `%` matches everything in their own scope |
| The Toolbox invalidates grants on `entitlement.`, `group_member.`, `group.`, `member.`, `organization.` events only (`mcps/toolbox/src/poller.ts`) | Yes, but in the Toolbox | `capability.*` changes (a ceiling narrows access) and `user.disabled` / `user.erased` (organisation id null) are not in its list; nothing pins the action list ID emits against the list the Toolbox reads |
| Pool exhaustion across tenants, latency budgets (E6) | Not locally | `user-replay` 354 covers one request on an exhausted pool; fairness is an external input |
| `docs/04` line 7 counts (28 tables, 27 functions, 61 triggers) | No test; fix the doc | The database and the catalogue have 26, 23 and 57 |

## Dead and test-only code

Proven with `grep` over `apps/id/src` and `apps/id/scripts`, excluding `*.test.ts` and `src/__tests__/`.

| Code | Evidence | What to do |
| --- | --- | --- |
| Ten "Invalid or expired ... context" throws in `src/services/platform-context.ts` (lines 54, 105, 141, 146) and `src/services/tenant-context.ts` (86, 113, 170, 181, 189, 197) | Reachable only by passing a forged, copied or finished context: a programmer error. Exercised by `db/queries/policy-context` (whole file), `db/queries/members` 78, `services/members` 353, `runtime-role` and `services/platform-users-context` (other area) | Keep the guard if it is wanted as a design aid, but one table-driven test is enough for coverage; today four files carry it |
| `executeOperation`'s own key-length check, `src/services/operations.ts` lines 56–61 | Its only caller is `src/http/admin/command.ts` line 86, which rejects the same keys at lines 70–76 first. Only `services/operations` 211 reaches it | Delete the check and that half of the test |
| The non-finite number check in `canonical`, `src/services/operations.ts` lines 25–26 | Command input is validated JSON from the request; JSON cannot carry `NaN` or `Infinity`. Only `services/operations` 211 reaches it | Delete with the test, or keep as an assertion without a test if the gate allows |
| `pendingReplay` and `pendingRevision`, `src/http/admin/routes.test.ts` lines 13–14 | Both are empty arrays labelled "Temporary F3 backlog"; F3 is complete | Delete the two constants and compare with `[]` |
| `ssoTest.allowPrivateHosts` option of `createApp` (`src/app.ts` line 35, `src/http/context.ts` line 11, `src/services/sso-test.ts`) | Set only by the test fixture `src/__tests__/admin.ts` line 90; `src/runtime.ts` never passes it | A test-only knob in production code; acceptable for the in-process OIDC issuer, but it should be named as such |
| `export` on route schemas no other module imports: `organizationSchema`, `domainSchema`, `resourceSchema`, `ssoProviderSchema`, `ssoTestSchema`, `signInDiagnosisSchema`, `meSchema`, `adminRouteTables`, `UserNotRetirableError` (tests only); `operationReceiptSchema`, `capabilitySchema`, `entitlementSchema`, `groupSchema`, `memberSchema` (nothing outside their file) | Scripted scan of every `export` in the area's source against non-test importers | Drop the `export` keyword where only tests import, or let tests read the OpenAPI document instead |
| The optional `releaseAuthority` of `executeOperation` | `command.ts` always passes it; only `services/operations` calls without it | Make it required |
| Test support for calling context-guarded queries: `__tests__/bind-query.ts` and ten `*-queries.ts` wrappers (322 lines) | Importers per wrapper: 1 (`session-queries`) to 24 (`organization-queries`); most HTTP tests use them as seeders | Keep as seeders. If the query CRUD files go, `session-queries.ts` loses its only importer (`db/queries/sessions`) and can go too; `user-queries.ts` keeps two of four |
| `UserNotRetirableError` and its throw, `src/db/queries/users.ts` lines 40–45 and 72 | `services/users.ts` `retireUserEmail` locks the user and refuses one that is not disabled or already retired before calling the query, so by reading the query's `where` cannot miss in production. Run 2 (suite without `db/queries/users`) leaves exactly this function uncovered | Delete with the query test file |
| `me` "every fixture cookie resolves" | Asserts the fixture, not the product | Delete |

## Simplifications

Ordered roughly by size: tests removed first, then lines.

1. **The route matrix repeats route-independent checks 288 times.** Foreign bearer, missing origin, untrusted origin and disabled user are refused by `createPrincipalMiddleware` before any route code runs (`src/http/admin/index.ts` line 65 applies it to `*`). Keep "no credentials" per route (it proves no route escapes the middleware) and run the other four once each. The 50 "machine insufficient scope" tests repeat the 50 "platform reader" tests with a different principal; keep one machine case for the `WWW-Authenticate` header. Saving: 337 of 1,318 tests in the area (26%), measured on the 16 matrix files: the 342 tests of those five kinds beyond "no credentials" take 7.1 s and 6.7 s per run (two runs: 17.1 s and 17.6 s with them, 10.0 s and 10.9 s with "no credentials" alone, most of which is fixture set-up). The whole matrix of 813 takes 22.5 s and 23.5 s of those files' 57.2 s and 61.4 s.
2. **One idempotency table instead of a dozen per-family copies.** Probe p-journal-fingerprint broke 27 distinct tests in 15 files, p-replay-status 66, p-noop-outcome 15, p-cursor-lte 30: the same fact is asserted in many places. `command-replay` already runs the promise as a table over 8 families; adding the three families it lacks (domain, SSO provider, capability) and one PATCH and one DELETE per family would let the receipt/409/noop parts of `organizations` 370, `groups` 485, `domains` 24 and 69, `entitlement-replay` (whole file), `client-lifecycle` 32 and 197, `client-replay` 33, 129 and 218, `resource-replay` 41, 148, 189 and 219, `session-replay` 148, `user-replay` 60 and 111, `sso-providers` 370 and 496, `capabilities` 320, `members` 525 and 591 go. Estimate from line counts of those blocks: about 1,300 lines become about 300 lines of table rows.
3. **Eighteen copies of "a failed audit or subject write rolls back the command".** One mechanism: `executeOperation` runs the effect, the audit, the subjects and the receipt in one transaction. `command-replay` 244 holds it for 8 families and `organization-erasure-audit` 277 for subject capture. The other 18 call sites (`db/audit-history` 66, `db/queries/audit` 129, `client-lifecycle` 197, `client-resource-audit` 247, `domains` 105, `entitlement-audit` 163 and 559, `group-erasure-audit` 305 and 757, `member-audit` 330, `sso-providers` 429, `user-erasure-audit` 487, `services/client-grants` 213 and 256, `services/domains` 158, `services/entitlements` 372, `services/resource-grants` 211, `services/resources` 163) repeat it with a different command; several build a trigger or a constraint for the purpose.
4. **Seven copies of "reads recheck authority after the middleware".** `directory-context` (9 tenant read paths, although its title says ten) and `platform-directory-context` (7 platform read paths) are already tables over one mechanism (`withTenantRead` and `withPlatformRead` call `authorizeCommand` inside the read transaction). Add the remaining read paths to those two tables and delete `access` 234, `audit-events` 158 and 235, `diagnostics` 86, `members` 631, `operations` 94 and `users` 415.
5. **Fourteen race-ordering tests assert subject rows per lock order** (`entitlement-audit` 212 ×6, `group-erasure-audit` 336 and 612 ×4, `organization-erasure-audit` 304 ×2, `user-erasure-audit` 554 ×2). Each builds a trigger and an advisory-lock gate to force an order, then checks which subject rows exist. Keep `organization-erasure-audit` 304 (two orders) as the proof that a concurrent erasure cannot leave an event unattributed; the other twelve pin the same mechanism. These two files are the second and sixth slowest in the area (`entitlement-audit` 11.4 s and 10.2 s alone, `group-erasure-audit` 7.9 s and 7.5 s).
6. **`operation-crash`: six SIGKILL tests become two.** The action (create, rotate, erase) does not change the mechanism under test (the whole command is one transaction); the phase (before or after commit) does. It is the slowest file in the area (15.9 s and 19.9 s alone); two tests keep both proofs.
7. **`runtime-role` as a table.** See Q2: about 1,040 lines of seven-plus-three same-shape isolation tests could become one seed and a table, estimated 350 lines; 924 and 2141 merge. Splitting the file would also fix the "cannot run alone" failure.
8. **Query-layer CRUD files.** Deleting `db/queries/{organizations,entitlements,oauth-resources,organization-domains,sessions,management,users,members,oauth-tokens,policy-context}`, `db/migrate.integration` and `services/{access,audit}` (13 files, 2,038 lines, 27 tests, 8.5 s when run alone) loses no fact the HTTP or service layer does not hold, except the cross-tenant write predicate, which the service tests keep. Measured in run 2: 2,012 of the 2,013 remaining tests pass (the one failure is the unrelated timing flake in `auth/user-oauth`), lines stay at 100% and functions drop to 99.96%, because `UserNotRetirableError` (`src/db/queries/users.ts` lines 40–45) is thrown only when `db/queries/users` calls the query directly: `services/users.ts` locks the user and refuses a user who is not disabled or already retired before it calls the query. Delete the class and its throw with the file.

## Recommendations

Effects are measured where a run is cited; the rest are counts from the inventory.

### Delete

1. **Thirteen query, service and migration test files that hold nothing the HTTP or service layer does not:** `db/queries/{organizations,entitlements,oauth-resources,organization-domains,sessions,management,users,members,oauth-tokens,policy-context}.integration.test.ts`, `db/migrate.integration.test.ts`, `services/{access,audit}.integration.test.ts`. 2,038 lines, 27 tests, 8.5 s alone (run 1). Measured (run 2): the rest of the suite passes, lines stay at 100%, functions drop to 99.96% only because `UserNotRetirableError` (`src/db/queries/users.ts` lines 40–45) loses its only caller; it is unreachable in production (the service checks the same conditions under a row lock first), so delete it in the same change. The gate with that deletion was not re-run.
2. **288 route-independent matrix tests and 49 machine duplicates** in `__tests__/admin-routes.ts` (keep "no credentials" per route; run foreign bearer, missing origin, untrusted origin and disabled user once; one machine-scope case). 337 tests. Measured: about 7 s per run (7.1 s and 6.7 s), 26% of the area's test count, no fact lost.
3. **The 18 audit-failure rollback copies, the 7 read-recheck copies and 12 of the 14 race-ordering tests** listed under Simplifications 3–5. 37 call sites in `entitlement-audit`, `group-erasure-audit`, `member-audit`, `user-erasure-audit`, `client-resource-audit`, `client-lifecycle`, `domains`, `sso-providers`, `access`, `audit-events`, `diagnostics`, `members`, `operations`, `users`, `db/audit-history`, `db/queries/audit` and six service files. The two files holding ten of the race tests (`entitlement-audit`, `group-erasure-audit`) take 19.3 s and 17.7 s together when run alone (two runs).
4. **Four of six `operation-crash` tests** (keep one create before commit and one after). The file is the slowest in the area (15.9 and 19.9 s alone).
5. **Small items:** `route-table.test.ts` 13, 99, 156, 184 (FILL/DUP); `me` 88; `db/schema` 170, 401 and 1068; `db/grant-subjects` (7 IMPL tests pinning trigger JSON parsing; the person-history reads in the erasure files hold what a consumer sees); `pendingReplay`/`pendingRevision`; the duplicate key-length and non-finite checks in `src/services/operations.ts` with the half of `services/operations` 211 that drives them.

Together, deletions 1–5 remove at least 420 of the area's 1,318 tests (32%), counting each looped call site once: 27 + 337 + 37 + 4 + 15.

### Simplify

6. **Extend `command-replay` to the three families it lacks** (domain, SSO provider, capability) and to one PATCH and one DELETE per family, then delete the per-family receipt/409/noop tests listed in Simplifications 2. About 1,300 lines to about 300.
7. **Run the admin fixture's app on a restricted role** (`configureRuntimeRole` once per fixture, owner connection kept for seeding). Every HTTP test then proves grants and RLS for the path it drives, which today only 15 of 88 files do. The restricted-role duplicates of ordinary HTTP tests could then go.
8. **Turn `runtime-role` into a seed plus a table** and split it, which also fixes the file failing when run alone (about 1,040 lines to about 350; merge 924 and 2141).

### Add

9. **An erased or removed row disappears from its list** (groups first: probe p-list-groups-deleted broke nothing; then clients, resources, domains, entitlements, members). One assertion per lifecycle test.
10. **A matrix entry for foreign child ids**: for the 26 organisation routes with a child id (18 writes), a child id from the other organisation gives 404 and no success audit. Once it exists, the service-level cross-tenant tests (`services/groups` 226, `services/domains` 80 and 193, `services/entitlements` 252) become duplicates and can go.
11. **A real user-delegated token at `/api/admin`** gives 401 `invalid_token` (today only a unit test with a stubbed verifier, outside this area).
12. **Run the 14 blocked security probes** (authorisation scope and organisation checks in `src/http/authorize.ts` and `src/services/command-authority.ts`, the `sid` refusal, both root-lock checks, token version binding, journal key isolation and authority-before-replay, the freshness guard, the organisation predicates in `db/queries/groups.ts`, `db/queries/entitlements.ts` and `db/queries/audit.ts`, and RLS disabled or made permissive on one table) once the owner allows source edits that weaken a check in a throwaway worktree. They answer the one question this audit could not: whether each layer of the doubled authorisation is tested on its own.
13. **Fix `docs/04-answerable-id-schema.md` line 7** to the measured 26 tables, 23 functions and 57 triggers.
