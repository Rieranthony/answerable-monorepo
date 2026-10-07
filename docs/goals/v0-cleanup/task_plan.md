# V0 cleanup audit (opened 2026-10-07)

**Goal.** The codebase is V0 and was written entirely by AI. Audit every workspace from first principles and remove what is not production worthy: dead code, ugly code, unsafe code, logic written twice. Prefer deleting over simplifying, simplifying over optimising, optimising over automating. Not a mass deletion: every removal has evidence (no caller, no reader, a gate that stays green) and every simplification keeps the behaviour a consumer or a test relies on. Reuse where it exists; build a shared helper only where the same logic lives in three or more places.

**Owner's questions.** Is anything unnecessary, overly complicated or built on a weak assumption? What can be deleted entirely? What can be simplified once the dead pieces are gone? Then make the changes. The goal ends when the whole codebase has been checked.

**Already done, not re-litigated.** The tests (`docs/goals/test-audit/conclusions.md`, landed 4 October) and the schema and migrations (`docs/goals/schema-audit`, landed 7 October). This goal covers the application source: `apps/id`, `apps/web`, `packages/*`, `mcps/*`, `scripts`, plus the repository's configuration, docs and reports as far as they describe code that no longer exists.

## Phases

| # | Phase | Status |
|---|-------|--------|
| 0 | Worktree `claude/v0-cleanup` in `.claude/worktrees/v0-cleanup`, planning files, dependencies | complete |
| 1 | Mechanical baseline: knip (unused files, exports, dependencies), jscpd (duplicated blocks), tsc unused locals, smell greps, env and script inventories | complete |
| 2 | Audits by area (Opus for ID and the SDK, Sonnet for the servers and the web), read-only, findings with evidence into `audits/` | complete: 7 audits, 187 findings |
| 3 | Consolidate: one findings table with a verdict per item (delete, simplify, dedupe, fix, keep with reason); cross-check contradictions; decide | complete: decisions per area below |
| 4 | Implement by area in waves, each with its workspace's gates; coordinator reviews every diff | in_progress |
| 5 | Full gates on the branch, docs and READMEs updated, branch pushed for CI, memory updated | pending |

## Layout

- Planning files: this directory. Agent audits in `audits/`.
- Scratchpad (session): `briefs/`, tool output under `baseline/`.
- Databases: the development Postgres on 47432 is the owner's; test suites reset only `*_test` databases. Never `bun run env:up` from the worktree.
- Branch stays a branch: the owner asked for a new branch, so nothing lands on main from this goal; the branch is pushed so CI runs on it.

## Areas

| Area | Scope | Lines (src) | Model |
|------|-------|-------------|-------|
| A | `apps/id/src/auth` (Better Auth plugins, OAuth, SSO, machine clients) | 4,374 | Opus |
| B | `apps/id/src/http/admin`, `src/http/*`, `src/services`, `src/db/queries` (the admin API: routes, services, queries, operation journal) | ~15,500 | Opus (split B1 routes+services, B2 queries+operations) |
| C | `apps/id/src/db` (client, isolation, locks, runtime role, migrate), `src/db/schema`, `src/operations`, `src/lib`, `src/__tests__` support, `scripts`, `src/app.ts`, `env.ts`, `bootstrap.ts`, `runtime.ts`, pages | ~5,300 | Opus |
| D | `packages/mcp`, `packages/mcp-postgres`, `packages/auth`, `packages/id-admin`, `scripts` (mcp:new) | ~3,300 | Sonnet |
| E | `mcps/toolbox`, `mcps/admin`, `mcps/e2e`, `mcps/example`, `packages/acceptance` | ~3,800 | Sonnet |
| F | `apps/web`, `packages/ui`, `packages/countries` | ~5,400 | Sonnet |
| G | Repository: root docs, `reports/`, `docs/drafts`, `apps/community-mcp`, `default.env`, `turbo.json`, CI, READMEs, `package.json` scripts | n/a | coordinator |

## Decisions

Taken by the coordinator on 2026-10-07 (the owner asked for the changes to be made on a branch they will review; every decision below is reversible on that branch). Preference order: delete, simplify, optimise, automate. "Keep" is recorded where a mechanism was challenged and stays.

### D, MCP kit (audit `audits/d-mcp-kit.md`)
Take all 14: D1, D2, D7, D9 (dead exports and options), D3 (`onerror` on `createMcpHandler`, logging every non-ToolError failure), D4 (serve the refusal envelope only for a name a tool could have), D5 (commit token checked before the status replay; permission check stays after), D6 (`parseEnvironment` in `@answerable/mcp`, error text unchanged; the Toolbox and admin readers call it), D8 (merge `createPostgresIntentStore` with `withEvidence`: one store that takes the evidence; `expire`/`read`/`move` private), D10 (one handler in `server.ts`), D11 (`errorCodeOf` exported; the three server sites use it), D12 (`Bun.fileURLToPath` at the seven `import.meta.url).pathname` sites), D13, D14 (README wording).

### C, ID shell (audit `audits/c-id-shell.md`)
- Take: C1 (`await server.stop()`), C2–C5 as the provision/verify split with this ownership rule (Q1): the first boot provisions the platform organisation, group, entitlement, capability, admin resource and binding; every later boot verifies the binding and refuses a changed admin identifier; the admin resource's definition is code-owned (boot syncs its scopes and the admin API refuses `updateResource` on the bound resource, as it already refuses disable and delete); the organisation name, group, entitlement and capability belong to operators after the first boot; `bootstrap.applied` is recorded only when something was created or changed. `PLATFORM_ORGANIZATION_SLUG` and `_NAME` stay as first-boot inputs (Q4: keep).
- Take: C6–C9 (env helpers, dead bounds, test-only pool default, `BETTER_AUTH_URL` normalised once and `lib/service-url.ts` deleted), C10 (delete `configure-runtime-role.ts`, `db/client.ts` fields required; with B2-30/31), C11 (delete the Scalar page and dependency; Q2 yes), C12 (delete `start`), C13 (Q9 yes), C14 (inline the public URL; build the export on `testEnvironment()` so `openapi:export` needs no `.env`; AGENTS.md command updated), C15 (one reset helper and `scripts/reset-test-database.ts`; `migrate.ts` production-only), C16 (H3 runtime-login helper, adopted in the seven tests too), C17–C22 (test support), C23 (code-shaped `error_description` only; Q3 yes), C24 (log once in `gateway.callAuth`), C25 (`slugPattern` in `columns.ts`), C26–C29, C31 (shutdown handlers), C32, C33, C34 (G: `id#test` passes only `TEST_DATABASE_URL`; CI drops the three unread values; `PROTOCOL_SWEEP_*` added to `id#dev`).
- Q5: drop the `/api/admin/*` CORS middleware until a browser console exists (no browser client today; `/auth/*` CORS stays). Q6: enable typed `@typescript-eslint/no-floating-promises` and `no-misused-promises` for `apps/id` `src` and `scripts` (the guard that replaces the context registry, B1-14, and the rule that found C1). Q10: `problem.ts`, the sweep and the pages log `error.name`, the SQLSTATE and the constraint name, never the message. Q11: not taken (the export script stays, on `testEnvironment()`).
- Defer: C30 (`hono-tailwind` at runtime; needs a spike that the bundle runs without `node_modules`). C35 decided with area E.

### B1, admin HTTP and services (audit `audits/b1-admin-http-services.md`)
- Take all 38. B1-14: delete the runtime context registry (WeakSets, `require*Context` membership checks, single-use `close()` flags, `releaseAuthority`, frozen copies); keep the private-symbol brand types, `authorizeCommand`, `setDatabaseScope`, the lock order and `run(mutate, metadata)`; call sites read `context.tx`; the 23 "Invalid or expired" assertions go; typed lint (C Q6) replaces the property. B1-20: one canonical sentence generated by `adminRoute()` for every non-read route: "Requires Idempotency-Key. Identical authorised retries return the receipt without repeating the mutation or its audit event; changed input returns idempotency_key_reused." B1-15: `found(row, title)` keeps each entity's title. B1-31: a body without a JSON `Content-Type` answers 400 `validation_failed` (no new error code). B1-29: `httpCommand` owns freshness (one guard after authorisation, one check after the mutation).
- Cross-area: B1 Q5 → queries return the page (`cursorPage` in the query layer, one rule); services keep one-line list functions. B2 Q6 → the unreachable 404 branch in `services/organizations.ts` goes.

### B2, queries, db, operations (audit `audits/B2.md`)
- Take all 32. B2-2 (Q3): `isNull(table.deletedAt)` everywhere, no `live()` helper; area A converts its `sql` sites too. B2-3 (Q1): adopt "filter `deleted_at` on the table you read; a parent reached through a live foreign key needs no predicate", with each deleted predicate's foreign key named in the commit and verified in `drizzle/0000_initial.sql`; B2-12's three exact repeats first. B2-4, B2-29 (Q2): the audit payload shapes change before launch; docs/04 changes with them. B2-31 (Q4): delete with C10. B2-28: `no-duplicate-imports` added to ID's lint.
- Q7 (`entitlements_scopes_check` not refusing null elements): schema, out of scope; recorded as a follow-up for the owner.
- Revised at implementation: B2-13 kept (29 tests, not 5, use the session-less `effectiveGrants` path as the permission suite's seam for multi-organisation cases; both production callers pass a session); B2-14 taken only for the four `undefined` keys (the stored bytes are revision-bound and a test pins them). The list helpers live in `db/queries/lists.ts`.

### G, repository (findings.md)
Take G1 (Redis service and variable), G3 (turbo lists, with C34), G4 (unlinked report), G5 (`knip.json` kept, command in AGENTS.md); G2, G6, G7 keep.

### A, ID auth (audit `audits/a-id-auth.md`)
- Take A1–A25 (26 findings, no unsafe). A11: one exported `revokeGrantContexts(executor, where)` in `db/queries/grant-contexts.ts` serves the three auth sites and B2-9's seven. A15: `isRetryableDatabaseError` extracted from `mapDatabaseError`, used by `rethrowGrantError`. A16 (Q1): fail closed, every session without an SSO origin is refused. A10 (Q2): delete the leftover ID-token arithmetic; name the 30-day grant lifetime once and pass it as `refreshTokenExpiresIn`. A19 (Q3): `type: "string"` for the three status fields; regenerate `openapi.json`. A23: `logEvent(area, event, fields)` in `lib/log.ts` for the eight operational logs, with C Q10's fields (`error.name`, SQLSTATE, constraint; never the message). A24 + B2-27: `db/locks.ts` holds `lockOrganization`, `lockClient`, `lockResource`, `lockUser`. A25: `uniqueSorted` and `parseScope` in `lib/scopes.ts`, used by the 19 unique-sort sites in auth, http and services (B1-25 points there too).
- A26 (Q4): delete the organisation, member and domain declarations and `user.disabledAt`; keep `user.status` (`principal.ts` reads it). Q5 (clock skew): no change, nothing measured. Q7: docs/05's stale audit version numbers are fixed in the docs pass.

### E, MCP servers and acceptance (audit `audits/e-mcp-servers-acceptance.md`)
- Take E1 as option B: a `client_resource` target counts only when `target.id === principal.clientId` (the cache holds targets, not the union), so `access_grant`'s "only through this OAuth client" promise holds in the Toolbox and other hosts get nothing; the test and `docs/toolbox/index.mdx:159` change with it. Take E2, E3, E4, E5 (= D6), E6 (`pages` in `@answerable/id-admin`), E7 first part only (the intent id reaches `commit` and is the upstream `Idempotency-Key`; `applied_changes` defaults not taken, the explicit report stays), E9, E10, E13, E14, E15 (= D12), E16.
- Keep: E8 (three short migrate scripts; a shared CLI saves nine lines), E11 (two sites), E12 (write the reason for the 900-second lifetime next to `admin-mcp.ts:43`). Q2: the Toolbox admin API's reliance on ID's platform-only linking gets one line in docs/08's invariants; evidence for its writes is a follow-up, not cleanup. Q4 (C35): the fixture stops provisioning tenants and `startId` does it with the kit's helpers, as the last MCP step after the ID track lands, gated by the acceptance. Q6: leave.

### F, web and UI (audit `audits/f-web-ui.md`)
- Take F1, F2, F3, F4 (one `DitherWash` component, the vendored kit and `clsx`/`tailwind-merge` go), F5 (with C29 for ID's logo), F6, F7 (static `<html class="dark">`, `next-themes` dropped from the web app), F8, F9 (the shader keeps running: a minimum capture width and the shader unmounted once captured), F12, F13, F14, F15, F16, F17 (wired as `check:metadata`, not deleted), F18, F19, F20 (pin the flag CDN to the commit matching `countries.json`), F21 (point the Markdown and the two API index pages at the docs' own published contract, not production ID), F22, F24, F25, F26.
- Defer: F10 (baking the dither changes the hero's look; the owner decides), F11 (reseeds the layout; goes with F10), F23 (an unproven CSS split, an optimisation).
- Keep (F Q3, Q5, Q8, Q9): the light colour tokens in `packages/ui` (the landing went dark only "for now", the owner's words), `/oauth-test` (AGENTS.md names it as the web app's OAuth consumer), the three docs redirects (the AGENTS.md rule), the waitlist autofocus (a design call). F5 includes ID's `pages/ui/logo.tsx` (C29) so the shared `LOGO_PATHS` shape changes once; C skips C29.

### Cross-area placements
`lib/log.ts` (`logEvent`) and `lib/scopes.ts` (`uniqueSorted`, `parseScope`) are created by the first ID step that needs them (B2 for `uniqueSorted`; C for `logEvent`, A converts its sites); `db/locks.ts` by B2; `revokeGrantContexts` by B2; `isRetryableDatabaseError` by B1; `parseEnvironment`, `errorCodeOf` and the intent id on `commit` by D; `pages` by E.

## Implementation plan (phase 4)

Tracks, each in its own worktree from the landing branch, agents sequential inside a track because their files overlap, tracks parallel:
1. **ID** (`impl-id`, Postgres 47433 `answerable_id_test`): B2 (queries, db, operations, including the `require*Context` call sites in queries reading `context.tx`) → B1 (registry deletion, http, services, typed lint) → A ∥ C (auth; shell, env, bootstrap, scripts, test support). Each step ends with `bun run mcp:check`-equivalent for ID: typecheck, lint, `db:test:migrate` + `test:coverage` at 100%.
2. **MCP** (`impl-mcp`, Postgres 47433 for the Toolbox, admin and mcp-postgres test databases): D → E. Ends with `bun run mcp:test` and the acceptance.
3. **Web** (`impl-web`): F. Ends with web typecheck, lint, test, build.
4. **G**: coordinator, directly on the landing branch, first.
Landing: fast-forward each track onto `claude/v0-cleanup`, full gates, docs, push the branch for CI.

## Errors encountered

| Error | Attempt | Resolution |
|-------|---------|------------|
