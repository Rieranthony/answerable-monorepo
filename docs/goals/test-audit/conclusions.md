# Conclusions: the tests, from first principles

Written after the change sets landed on `main` (491c9e9 → 79b080b, 4 October 2026). Every number comes from a run recorded in [findings.md](findings.md), [progress.md](progress.md), the four audits under [audits/](audits/mcp-kit.md) and the evidence report.

## What the tests are for

The platform decides identity and authority for every product and every MCP server. A failure that matters in production is one of six: a token issued to the wrong person, audience or scope, or after offboarding; one organisation seeing another's rows; a tool run for a principal whose current grants do not carry it; a change applied twice, half-applied, or to a target that moved; a consumer broken by a moved contract; the service failing under load or a dependency outage. A test earns its place by holding one of those, by pinning a contract a consumer reads, or by checking behaviour a person sees. Nothing else does.

Three layers do that work, each with a job the others cannot do:

| Layer | Job | Trusts | After the change |
| --- | --- | --- | --- |
| The acceptance (`packages/acceptance`) | The system as a host sees it: real ID from its migrations on the restricted role, the official MCP OAuth client, Chromium through ID's pages, the e2e MCP, the Toolbox, the admin MCP | Nothing faked except the company directory | 53 journeys in 82 s, now with Better Auth's origin and CSRF checks on, and the staff tools against real ID |
| ID integration (`apps/id`) | ID's behaviour at its HTTP surface against Postgres, with the upstream directory stubbed in process | The in-process OIDC issuer | 1,555 tests in 127 files at 100%; the admin HTTP tests run on the restricted runtime role, so they see grants and row-level security |
| Units with fakes (`packages/*`, `mcps/*`) | The kit's rules, each server's own logic, fast | The test issuer, the fake ID | 471 tests in 6 to 8 s; the fake ID validated against `openapi.admin.json` |

A fact is proved once, at the layer closest to the consumer. Lower layers prove only what the higher one cannot reach.

## Are the tests useful?

**Before: useful with dead weight and holes.** Of 149 security and correctness checks broken on purpose, 129 failed at least one test; most of the 3,517 tests held a documented invariant, a contract or visible behaviour. But about a thousand restated a fact a test closer to the consumer already held, or existed to light a line for the 100% gate, and twenty real guards were held by nothing: the JWT algorithm allow-list, zero clock tolerance, hashed commit tokens, the evidence chain's link, the escalation guard on nine of the eleven admin tools, a second linked resource at token exchange, the `email_verified` claim, an erased group still listed, and the rest in the report. Fourteen more probes on ID's authorisation could not be run by the audit; all fourteen ran during implementation and every one was caught.

**After:** 2,079 tests; every probe is caught by a named test; nothing passes silently (a conformance check that does not apply is reported as skipped, not passed).

## Do we test the right things?

**Before: not where it mattered most.**

- The biggest ID file (4,007 lines, 22% of the suite's time) tested a Better Auth it built itself, with a test-written token endpoint, never the production `createAuth` or `createApp`.
- The suite and the acceptance ran ID with Better Auth's origin and CSRF checks off, because `bun test` sets `NODE_ENV=test` and Better Auth reads it. Measured: a cross-site sign-out answered 200 where deployment answers 403.
- 73 of the 88 admin files connected as a Postgres superuser, so row-level security, the tenant isolation mechanism, was invisible to them.
- The conformance kit, the SDK's promise to provider authors, mostly re-ran what the SDK already refuses: 11 of 21 checks could not fail for a provider built with `defineTool`.
- The admin MCP's staff tools, the writes that decide who is staff, never ran against real ID; the fake's access view is static.
- Each admin entity was tested at up to five layers (query, service, route, replay, audit), that is, by implementation layer rather than by contract.

**After:** ID's OAuth and federation facts run on the production fixture; the acceptance proves ID as deployed; 42 admin files run app code on the restricted role; the kit keeps the ten checks a real provider can fail; the journeys grant and revoke staff roles through the tools; admin CRUD is proved at the HTTP layer, with the schema constraints and the admission rules (`db/queries/grants`, `db/queries/access`) kept below it.

## Do we test enough?

**For what can be proved locally, yes, now.** The gaps the probes found each have a test, and so do the properties nothing exercised: unregistered and mismatched `redirect_uri`, expired code, unknown `resource`, PKCE and client-authentication refusals, `aud` as a list, `sid`, no `nonce` on refresh, upstream tokens with a wrong audience, expired or unknown key, signing-key rotation through the JWKS, the production rate limit, `private_key_jwt` client credentials, a real issued token accepted by `@answerable/auth`, lists excluding erased rows, foreign child ids on every organisation route, a real user-delegated token refused at the admin API, and each of ID's two authorisation layers on its own.

**What stays unproved needs the outside world,** and is recorded as gates in the release decision plan (E1 to E8): a real Entra tenant and its claims, the OmniChat consumer, key custody and rotation in the intended secret store, the deployment topology and its budgets, backups and restore. No local test can close them and none was invented; `docs/02` forbids speculative hardening. Two things were recommended as operator measurements rather than unit tests: evidence throughput for one organisation under concurrent calls (every row takes a per-organisation lock) and grant-cache miss latency at ten thousand cached members.

## Unnecessary, overcomplicated, or on weak assumptions

| Challenged | Verdict | Evidence |
| --- | --- | --- |
| 100% line and function coverage as the measure of test quality | Kept as a dead-code detector, with a rule: a test that exists only to light a line goes with the branch it lit; test support (the acceptance kit) has no gate | Coverage revealed none of the twenty uncaught probes: each was one operand of a condition on an executed line |
| The conformance kit as proof a provider follows the standard | Eleven checks deleted; the kit runs only checks an SDK-built provider can fail | 66 duplicate tests in the kit, 81 in the admin MCP, 6 per scaffolded server; probes M1, M3, M9, M19 showed `packages/mcp`'s own tests catch the regressions those checks would |
| A test-built Better Auth beside the production fixture | Deleted; its twenty facts run on the production fixture | 122 cases, 106 to 118 s per run; 13 of 48 call sites repeated the production file |
| Five test layers per admin entity | Query and service copies deleted; HTTP, schema and admission rules kept | Measured: the suite stays green without the 13 files; one journal probe failed 27 tests in 15 files |
| Route-independent middleware checks repeated for 81 routes | Run once each; "no credentials" kept per route | 337 of 813 generated tests, about 7 s, same middleware before any route code |
| The fake ID as ground truth for the admin MCP and the Toolbox | Kept, made faithful, validated against `openapi.admin.json`; the acceptance holds the rest | Replacing it with real ID in process would make the admin MCP import `apps/id`, which docs/11 forbids (now a test); the fake diverged in seven measured ways and ignored abort signals |
| The acceptance's Docker, Playwright and real-ID setup | Kept; it got cheaper and truer | The only layer proving the OAuth flow as hosts run it, ID's pages, real ETags and audit rows, the computed access view; lost 7 s of duplicates, gained the staff tools and the origin checks |
| The hand-demo lanes | Kept for people; their untested check mode deleted | No test or CI step ran `--check`; the journeys hold its one extra assertion |
| Crash, lock-order and race-ordering tests of the operation journal | Cut to the two proofs that remain per mechanism; the public idempotency promise kept as one table over all twelve command families | No consumer can observe lock order; `packages/id-admin` and the admin MCP rely only on same key same result, different input 409, stale precondition 412, a 5xx left nothing |
| `NODE_ENV=test` as a harmless setting | The runtime refuses it; the acceptance fixture turns the checks on explicitly | Better Auth drops its origin checks under it and ID skipped its runtime-role check |

## Deleted entirely

The test-built Better Auth harness (`user-grant-boundary`, 4,007 lines); thirteen ID query, service and migration test files plus `grant-subjects`, `services/domains`, `entitlement-replay` and `session-queries`; the kit's `testing.test.ts`; eleven conformance checks with their self-tests and all nineteen `todo` registrations; the demo provider's 41 registered checks; `kit.journeys.test.ts`; the acceptance kit's five plumbing test files and its coverage gate; the lanes' check mode; the scaffold's template pins; the protocol-era copies. Dead source went with the tests that reached it: the inert and placeholder federation branches, the SSO probe's bypass on the production app object, `UserNotRetirableError`, duplicate input checks in the operation journal, the redundant request-signal join, test-only exports.

## Simplified

Two guard tables in the admin MCP instead of single-tool tests; one idempotency table over twelve families instead of per-family copies; one refusal table in `verified-sso`, one claim matrix in `federation`, one `race()` helper and one `refresh()` helper in `user-oauth`; one foreign-child entry in the route matrix instead of service tests per entity; one `startToolboxStack` shared by the lane and the journeys; one test-database helper in `@answerable/mcp-postgres/testing`; the runtime-role proof split into three files that run alone; the fake ID's answers checked by one table against the OpenAPI document.

## Considered and left as it is

The per-case cost of `createAdminFixture` (a median 619 ms before each ID auth case, about 160 s of the suite): optimising is the lowest preference and the suite now fits CI with 257 s to spare. The ten runtime-role isolation tests as a table: each also asserts write refusals and secret exclusions, so a plain table would drop facts. The middleware's `tier` variable and `authorize.test.ts`: the only way to tell ID's two authorisation layers apart. `mcps/example`: the docs include its files. The migration catalogue and CI's fresh-install proof. Stale local branches and worktrees from finished work: listed, not deleted.

## Measured result

| Gate | Before | After |
| --- | --- | --- |
| CI job on `main` | 888 s of a 900 s timeout | 643 s |
| ID coverage step in CI | 582 s | 414 s |
| ID suite | 2,040 tests, 142 files; 3 fail with the root `.env` loaded; three files could not run alone | 1,555 tests, 127 files, 100%; hermetic; every file runs alone |
| MCP suites | 701 registered, 31 todo | 471, 0 todo |
| Acceptance | 78 tests, 87 to 90 s, origin checks off | 53 tests, 82 to 83 s, origin checks on |
| Probes caught by nothing | 20 (+14 not run) | 0 |
