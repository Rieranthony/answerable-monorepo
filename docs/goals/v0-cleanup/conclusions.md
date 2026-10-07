# Conclusions: the V0 cleanup, from first principles

Written after the three tracks landed on `claude/v0-cleanup` (7 October 2026). Every number comes from a run recorded in [progress.md](progress.md), the seven audits under [audits/](audits/a-id-auth.md) or the baseline in [findings.md](findings.md); the decisions and their reasons are in [task_plan.md](task_plan.md).

## What the goal was

The whole codebase was written by AI agents, test first, over five weeks. Before it ships as V0 the owner asked for an audit of what is unnecessary, overly complicated or built on a weak assumption, what can be deleted, and what can be simplified once the dead pieces are gone, with the preference order delete, simplify, optimise, automate, and the rule that this is a cleanup of dead, ugly and unsafe code, not a mass deletion. The tests and the schema had been reviewed in the two goals before this one and were not reopened.

## How it was done

A mechanical baseline first (knip, jscpd, `tsc` with unused checks, greps for suppressions, casts, console output, raw SQL; the env, script and dependency inventories), then seven read-only audits by area, each reading every file in scope in full and giving each finding its evidence, a proposal, a size and the test that holds it: A the auth layer, B1 the admin HTTP and service layers, B2 the queries, database and operations, C the service shell, pages, scripts and test support, D the MCP kit packages, E the servers and the acceptance, F the web app and the UI packages; the coordinator took G, the repository itself. 187 findings; a decision for each, including the keeps; then implementation in three tracks (ID sequentially B2, B1, C, A; MCP D then E then C35; web F), each step reviewed on its diff and landed with its gates.

## Measured result

| | Before (436909e) | After (branch head) |
| --- | --- | --- |
| Non-test source lines, all workspaces | 39,888 | 37,450 |
| `apps/id` non-test source | 27,423 | 25,577 |
| `apps/web` and `packages/ui` non-test source | 5,343 | 4,722 |
| ID test lines | ~45,000 | 43,343 |
| Local `requireRow`-style helpers in ID services | 8 (12 with the variants) | 0 (`found`) |
| Local `audit` wrappers in ID services | 11 | 2 (`recordCommandEvent`, one entity keeps its audience step) |
| Runtime capability-context checks | 172 call sites, 23 tests | 0 (brand types and typed lint) |
| Raw `deletedAt is null` SQL | 170 | 11, all in the schema modules' index predicates |
| Routes restating the idempotency contract | 49, in 10 wordings | 0 (one sentence from `adminRoute()`) |
| Drizzle relations | 17 | 5 (the ones Better Auth joins) |
| Direct dependencies removed | | `motion`, `shiki`, `shadcn`, `clsx`, `tailwind-merge`, `next-themes` (web), `cn` (ui), `@scalar/hono-api-reference` (ID), `@answerable/auth` (admin MCP) |
| knip | 5 false positives, 3 unused dependencies, 1 unlisted, 54 unused exports, 13 unused types | 5 false positives (the docs snippets) |

Commits: 181 over `main`, 411 files, +8,068/−11,127 outside the planning files. Gates on the final tree: typecheck and lint 14/14, build 3/3, web 89, countries 5, the migration proof, the ID suite 1,564 tests in 132 files at 100% line and function coverage (421 s), the MCP suites 467 pass, the acceptance 53 journeys in 83 s.

## Unsafe or wrong, now fixed

- ID closed its database pool under in-flight requests at every shutdown (`server.stop` not awaited); typed `no-floating-promises`/`no-misused-promises` lint now guards the class (it found six sites, three in tests).
- A platform admin capability removed through the admin API came back at the next restart with every admin scope; boot now provisions once and verifies afterwards, and owns only the admin resource's definition.
- A body sent without a JSON `Content-Type` was validated as `{}` while the handler parsed the real body, answering 500; it answers 400.
- `/me` was the one admin response without `Cache-Control: no-store`.
- The SSO probe's hand-rolled private-address list missed three ranges Better Auth's own check covers.
- OAuth grants answered 500 for a deadlock or a pool timeout where the admin API answered 503; one `isRetryableDatabaseError` now serves both.
- Expired-session cleanup was audited as a user sign-out.
- A `tools/list` or `tools/call` that failed outside a `ToolError` answered 500 with nothing in the log; a caller could write newlines into the log through the tool name of a refused call; a committed intent's receipt was replayed for any commit token.
- The Toolbox counted a grant limited to one host client as a grant through every host; it now counts it through the token's own client only.
- The web app forced dark but let `next-themes` resolve the OS scheme for the mosaic's settings; a hidden tab committed a 300×150 frame as the hero photo for the life of the page; the flag images loaded from a moving third-party branch.

## Deleted entirely

The runtime context registry (WeakSets, `require*Context`, `close()` flags, `releaseAuthority`, frozen copies); `scopeAlternatives`; the Scalar page and its dependency; `services/readiness.ts`, `services/operation-status.ts`, `lib/service-url.ts`, `scripts/configure-runtime-role.ts`, the three lock files (into `db/locks.ts`); 12 drizzle relations; the dead SSO provider-revision map and its `run` wrapper; the lenient session branch only tests reached; 37 orphaned test-support exports; the vendored dither kit, `ThemeProvider`, both brand-logo components, `Textarea`, the combobox chips family and the other unused UI exports; the Open Graph `.webp` twin; the Redis service and its variable; an unlinked report; `PUBLIC_ID_URL`, the `start` script, `dbCredentials`; `withEvidence` and the bare Postgres store's test-only methods; the admin MCP's per-plan idempotency keys.

## Simplified and shared

`found`, `recordCommandEvent`, `assertRevision`, `pageSchema`, `etag: true`, the generated command contract in `adminRoute()`, one `platformCommand`, freshness checked once in `httpCommand`; `optionalEq`, `contains` (with LIKE escaping), `cursorPage` in the query layer, `softDeleteEntitlements`, `softDeleteAssignments`, `eraseTokensAndConsents`, `revokeGrantContexts`, `db/locks.ts`, `lib/scopes.ts`, `lib/log.ts`, `errorFields`; `isNull(table.deletedAt)` everywhere; the bootstrap split into provision and verify; `env.ts` through two numeric helpers and one `BETTER_AUTH_URL` normalisation; one test-database reset and one runtime-login helper; `temporarilyUnavailable`, `grantTransaction`, `withAdapter`, one grant lifetime; `parseEnvironment`, `errorCodeOf`, `pages`, the intent id on `commit`, one handler in `createMcpServer`; `refreshRefused`, `serveCallback`, the kit's admin helpers provisioning the acceptance tenants; a static `<html class="dark">`, one `DitherWash`, one comma box, one rotation list.

## Challenged and kept

The two authorisation layers (tier middleware and in-transaction authority: both sources agree on all 81 routes and drift fails closed); the 86 `req.param()!` assertions (safe by construction; removing them needs a cast); the per-entity route modules (a generator would hide the per-route contract); the issuance assertions in `user-token-assertions.ts` (docs/05 §3); the view build in a child process (docs/07); the hand-written protected-resource metadata; the fake ID; the `/oauth-test` consumer; the light colour tokens ("dark only for now"); the docs redirects; the three short migrate scripts; `hono-tailwind` at runtime (needs a spike); the session-less `effectiveGrants` path (the permission suite's seam); the SSO config's byte order (revision-bound).

## Deferred, for the owner

- F10, baking the mosaic's dither at build time (removes the runtime WebGL and 261 lines; changes the look slightly); F11 goes with it.
- C30, serving the prebuilt stylesheet without `hono-tailwind` at runtime (a spike must show the bundle runs without `node_modules`).
- F23, splitting the docs' CSS from the landing page's (an optimisation, unproven).
- Schema notes recorded by the audits, out of this goal's scope: `entitlements_scopes_check` does not refuse null array elements; `sessions_authentication_origin_check` still accepts an origin-less row the app no longer writes.
- Follow-ups outside cleanup: evidence for the Toolbox admin API's writes; a stated clock skew for upstream `auth_time`; the two adapter rebuilds left by hand in `user-token-boundary.ts` and `user-token-revocation.ts`.
