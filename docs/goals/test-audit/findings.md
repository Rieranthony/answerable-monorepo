# Findings

## Inventory (2026-10-03, main 491c9e9)

| Workspace | Test files | Test lines | Source lines | Ratio |
| --- | --- | --- | --- | --- |
| apps/id | 142 | 52,327 | 27,158 | 1.93 |
| apps/web | 12 | 1,443 | 4,372 | 0.33 |
| packages/auth | 1 | 207 | 242 | 0.86 |
| packages/id-admin | 1 | 248 | 630 | 0.39 |
| packages/mcp | 16 | 2,362 | 1,921 | 1.23 |
| packages/mcp-postgres | 5 | 382 | 273 | 1.40 |
| packages/acceptance | 9 | 1,537 | 833 | 1.85 |
| mcps/e2e | 5 | 320 | 321 | 1.00 |
| mcps/example | 3 | 130 | 155 | 0.84 |
| mcps/toolbox | 14 | 1,463 | 1,044 | 1.40 |
| mcps/admin | 9 | 1,273 | 1,468 | 0.87 |
| scripts | 1 | 187 | 122 | 1.53 |

Every workspace with tests enforces 100% line and function coverage through bunfig (`coverageThreshold = { lines = 1, functions = 1 }`), except apps/web.

CI (`.github/workflows/ci.yml`, 15 min timeout): migrations proof, typecheck, lint, build, web, countries, Playwright install, `mcp:test`, `mcp:test:e2e`, ID coverage.

ID test helpers: `apps/id/src/__tests__/` (27 files, 1,720 lines; `admin.ts` 379, `admin-routes.ts` 243, `support.ts` 185, `oidc-issuer.ts` 136).

Largest ID test files: `auth/user-grant-boundary.integration.test.ts` 4,007; `db/runtime-role.integration.test.ts` 2,394; `auth/user-oauth.integration.test.ts` 2,149; `auth/verified-sso.integration.test.ts` 1,326; `services/federation.integration.test.ts` 1,304; `db/schema.integration.test.ts` 1,137.

## CI budget (measured from the last run on main, 491c9e9, 2026-10-02)

| Step | Seconds |
| --- | --- |
| Whole job | 888 (timeout 900) |
| ID `test:coverage` | 582 |
| Acceptance `mcp:test:e2e` | 87 |
| Build | 48 |
| Typecheck | 41 |
| Playwright install | 26 |
| `mcp:test` | 22 |
| Lint | 17 |

The last four runs on main took 11 to 15 minutes; 491c9e9 finished 12 seconds under the timeout. Adding tests without removing any makes main red.

Known fragility (reports/mcp-foundation-evidence.md, 25 Sep): under load the ID suite failed 5 to 55 admin and query tests on statement timeouts and deadlocks; three tests in `user-oauth.integration.test.ts` flaked locally and in CI (a cached refresh replay crossing a second boundary, two company sign-ins through the test issuer).

`docs/02-plan.md` line 13 is the standing rule: "ID requires 100% application line/function coverage"; every MCP workspace copied the gate through `bunfig.toml`.

Three stand-ins for ID exist: `packages/auth/src/testing.ts` (token issuer, 90 lines), `packages/id-admin/src/testing.ts` (fake admin API, 464 lines, excluded from coverage, used by `mcps/admin` and `mcps/toolbox` tests), and the acceptance's real ID (`packages/acceptance/src/id.ts` + `apps/id/scripts/mcp-e2e-fixture.ts`, 337 lines). `apps/id/src/__tests__/oidc-issuer.ts` (136 lines) is a fourth, an upstream IdP for ID's own federation tests.

## ID baseline on main 491c9e9 (2026-10-03, run by the coordinator)

`bun --env-file=.env run --filter @answerable/id test`: 2,037 pass, 3 fail, 2,040 tests across 142 files in 527.75 s (530 s wall), coverage 100% lines and functions.

The three failures (`auth/application-secrets` "application secret rotation retains signing custody...", `operations/preflight` "custody preflight reads retained provider...", `auth/user-oauth` "cached output and returned refresh rows are checked again...") are caused by the root `.env` reaching the test process: with `.env` minus `BETTER_AUTH_SECRETS` both re-run files pass (2 pass), with `.env` minus `UPSTREAM_TOKEN_SECRETS` they still fail (2 fail), and without any env file they pass. CI passes because it sets only four variables. So the suite is not hermetic: an owner's local `.env` changes its result, and nothing in the suite asserts the process environment is clean.

`src/auth/user-oauth.integration.test.ts` cannot run alone: `bun test src/auth/user-oauth.integration.test.ts` fails before the first test with "Unhandled error between tests" parsing `src/http/pages/fonts/PublicSans-Variable.woff2` as JavaScript (exit 1, 0 pass, 1 fail, 1 error). In the full suite it passes, so another file registers the loader first. ID test files have a hidden ordering dependency.

Passing tests print six error stack traces to stderr ("signing unavailable", "simulated signing or audit failure"), so a reader cannot tell noise from failure without the summary line.

## Audit C, the MCP kit (audits/mcp-kit.md, landed 2026-10-03 ~22:30)

360 run + 12 todo across 32 files, 10.6 to 10.8 s. INV 84 · CON 101 · BEH 50 · DUP 99 · FILL 20 · IMPL 6. 54 probes: 44 caught, 10 caught by nothing (JWT algorithm allow-list A3, discovery redirects A7, clock tolerance A9, commit token stored hashed M21, redundant signal join S1, keep-alive S2, evidence `prev_hash` link P3, migrator lock P4, both id-admin 5 s timeouts I5/I6), 1 caught only by a spy test (M8 lost-claim).

Biggest findings: 11 of the kit's 20 conformance checks cannot fail for an SDK-built provider (66 DUP tests here, 81 more in the admin MCP, 6 per scaffolded server); two checks pass vacuously for mutations without targets; the memory intent store never evicts and is the default of every standalone server; R19's policy recheck is not implemented; R24, R29, R32 and parts of R33/R35 are marked [SDK] in docs/09 with no code; a JSON-RPC batch reaches `allow` with `called=false`; the fake ID diverges from real ID in seven ways (timeouts ignored, no `operation_in_progress`, no `Retry-After`, plural `resultReference.type`, DELETE/PATCH on four routes answer as other methods, 39 of 81 operations modelled).

Recommended: delete about 105 tests (+81 in the admin MCP) with coverage held, add about 12 short tests for the gaps, fix the fake ID, correct docs/09.

## Audit D, admin MCP + Toolbox + acceptance (audits/admin-toolbox-acceptance.md, landed 2026-10-03 ~22:50)

407 tests (admin 235 incl. 17 todo; Toolbox 94 incl. 2 todo; acceptance 78). INV 87 · CON 77 · BEH 91 · DUP 103 · FILL 22 · IMPL 8 · todo 19. Admin suite 4.8 to 5.0 s, Toolbox 3.0 s, acceptance 78 pass in 89.6 s. 37 probes: 33 caught; 2 no-ops; 2 gaps: P9c (escalation guard tested on only 2 of the 11 tools that write to a chosen organisation; dropping it from `access_grant` lets an admin prepare `answerable-owner` for themselves on the platform organisation with no test failing) and P11b (`staff_revoke` without freshness fails nothing).

docs/11's claim that admin.test/writes.test and the journeys hold all ten invariants is false for four: audience held only by packages/auth and packages/mcp; "no tool takes a secret" only by the manifest snapshot (regenerable with UPDATE_MANIFEST=1); invariant 10 by nothing; guard and freshness partial. `staff_grant`/`staff_revoke` never run against real ID (journeys use root join/leave); 7 of 25 tools never called against real ID, 4 more never succeed there. The fake ID's access view is static, so nothing proves `staff_grant` makes a role.

Without `Bun.gc(true)` the acceptance fails (Toolbox `beforeAll` timed out at 120 s; 20 tests not run; 186 s): the workaround stays. Lanes: no test, no CI; `admin-lane --check` 11 s, `host-lane --check` 9 s and it caught the Toolbox `allow` probe against real ID. `kit.journeys.test.ts` (3 tests, 6.3 s, one ID boot) duplicates the admin journeys. 12 of the kit's 21 unit tests exist for the acceptance package's own 100% gate.

Recommended: delete about 40 tests and 600 lines (plus 70 conformance repeats once the kit changes), add the guard table (11 tools), the freshness table (4 tools), staff_grant/revoke journey steps, a 401 for a Toolbox token at the admin MCP; correct docs/11 and Q-ACCEPTANCE-GC; drop the acceptance kit's coverage gate.

## Audit A, ID authentication and federation (audits/id-auth.md, landed 2026-10-03 ~23:40)

54 files, 21,408 test lines, 722 tests; 292.0 and 260.6 s of the suite's 503.9 and 456.6 s of case time (full suite 527.4 and 477.1 s wall). INV 401 · CON 58 · BEH 72 · DUP 115 · FILL 53 · IMPL 23. 24 probes: 19 caught (15 on a production path), 5 not: 3 real gaps (P5 `resource` at token exchange, P7 flow-to-signed-query binding, P13 an upstream token WITHOUT `email_verified`), 2 redundant guards behind triggers (P3, P15). The five uncaught together: 2,040 pass.

Biggest findings: `user-grant-boundary.integration.test.ts` (4,007 lines, 122 cases, 106 to 118 s, 22% of the whole suite) builds its own Better Auth with a test-written token endpoint and never calls `createAuth`/`createApp`; 13 of its 48 call sites repeat `user-oauth`. The suite runs with Better Auth's origin and CSRF checks OFF because `NODE_ENV=test` sets `skipOriginCheck` (measured: cross-site `POST /auth/sign-out` 200 vs 403 with checks on; off-origin `callbackURL` 200 vs 403); the same flag would disable them and the runtime-role check in a deployment started with `NODE_ENV=test`. `createAdminFixture()` costs a median 619 ms before each of 265 cases (about 160 s). Two tests wait out the 5 s body deadline (10 s for one fact). Hermeticity: `BETTER_AUTH_SECRETS` leaks through Better Auth's `parseSecretsEnv` fallback because `testEnvironment()` passes `undefined`; files of 50 KB and over fail alone because Bun's runtime transpiler cache then parses the woff2 import as JavaScript (fix: `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` in the test scripts, measured, or `with { type: "file" }` on the import). Test-only code on production paths: `AppServices.ssoTest.allowPrivateHosts` disables the SSO probe's SSRF and HTTPS rules; six `startRuntime` injection points; unreachable federation branches (about 80 lines, 5 unit tests); `tier` context variable; `"sso_provider_changed"`.

Untested OAuth surface: unregistered/mismatched `redirect_uri`, expired code, unknown `resource` at authorize, confidential client without PKCE, `client_secret_post` on the user flow, `aud` as an array, `sid`, no `nonce` on refresh, upstream tokens with wrong `aud`/expired/unknown `kid` (the fake issuer checks nothing), signing-key rotation through `/auth/jwks`, rate limiting in production mode, `organization_disabled` end to end.

Recommended: delete UGB's 15 DUP/FILL sites (−14 s, −600 lines), `app.test.ts:650` (−5 s), 23 service-layer DUP sites (−780 lines, −3 s), zod-only env cases, `authorize.test.ts`, `audit-hooks.test.ts`, the dead source; retire the UGB harness by porting its 20 facts onto `user-oauth`'s production fixture (−106 to 118 s); table-drive the four big files (−4,000 lines estimated); make the suite hermetic; add the origin/CSRF-on refusal table, the three gap rows, the OAuth contract table, fake issuer defects, JWKS rotation, one rate-limit test.

## Audit B, ID admin API, database and services (audits/id-admin.md, landed 2026-10-04)

88 files, 30,919 lines, 1,318 tests (401 call sites + 813 generated by the route matrix); 87 files in one process 236 and 241 s. INV 168 · CON 61 · BEH 53 · DUP 90 · IMPL 19 · FILL 10 (call sites); matrix INV 397 · DUP 288 · CON 67 · BEH 61. Full suite under load 630 s.

Biggest findings: 337 of the 813 matrix tests repeat a route-independent middleware fact (foreign bearer, missing/untrusted origin, disabled user: 288) or a machine duplicate of the platform-reader fact (49), measured at about 7 s. One journal fingerprint probe failed 27 tests in 15 files; a replay-status probe 66 in 26; a cursor probe 30 in 22; 20 call sites assert "a failed audit rolls back". 13 query/service/migration files (2,038 lines, 27 tests, 8.5 s) hold nothing the HTTP or service layer does not, measured: the suite stays green without them (one test-only error class must go too). The suite's own connection is a Postgres superuser, so 73 of 88 files cannot observe RLS or missing grants; `runtime-role` (2,394 lines) is the main RLS proof and cannot run alone. Probe 8: an erased group still appears in `GET .../groups` and no test in all 142 files notices (2,040 pass). Cross-tenant child ids on writes are held only by service tests. The 14 authorisation probes (scope, organisation, root lock, `sid`, token versions, journal isolation, freshness, RLS) were NOT run: the permission classifier refused the first security-weakening edit; authorisation is checked twice (middleware, then in-transaction) so HTTP tests cannot tell which layer refused. Consumers (`id-admin`, admin MCP) rely only on "same key, same result; different input 409; stale precondition 412; a 5xx left nothing". docs/04 line 7's counts (28 tables, 27 functions, 61 triggers) are stale: the database and the catalogue have 26, 23, 57.

Recommended: delete the 13 files, 337 matrix tests, 18 rollback copies, 7 read-recheck copies, 12 of 14 race-ordering tests, 4 of 6 `operation-crash` tests, small items (at least 421 tests, 32%); extend `command-replay` to all 12 families and delete per-family copies (about 1,300 lines to 300); run the admin fixture's app on the restricted runtime role; `runtime-role` as a seed plus a table; add list-exclusion assertions after erase, a foreign-child-id matrix entry, a real user-delegated token at `/api/admin`; fix docs/04.

## Found while landing A (2026-10-04)

The acceptance's "real ID" runs with Better Auth's origin and CSRF checks off: `packages/acceptance/src/id.ts` spawns `apps/id/scripts/mcp-e2e-fixture.ts` with the inherited environment, `bun test` sets `NODE_ENV=test` in its process (measured: `process.env.NODE_ENV` is `test` under `bun test`, undefined under plain `bun`), and Better Auth reads that. The fixture itself builds its `Environment` with `testEnvironment()` and calls `createApp` directly, so A's new `startRuntime` guard does not affect it. Follow-up for the landing tree: start the fixture's auth with the checks on (A's fixture option) so the journeys prove the OAuth flow as deployed.
