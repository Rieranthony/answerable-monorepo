# v0 code audit (opened 2026-10-20)

**Goal.** The last audit of Answerable ID's application code before v0 ships. Challenge what the three earlier goals kept ([test audit](../test-audit/conclusions.md), [V0 cleanup](../v0-cleanup/conclusions.md), [v0 schema audit](../v0-schema-audit/task_plan.md)): what is unnecessary, overly complicated or built on a weak assumption; what can be deleted entirely; what can be simplified once the dead pieces are gone. Prefer deleting over simplifying, simplifying over optimising, optimising over automating. A verdict of keep is a fine outcome. Report and decisions before any code. Enterprise grade: thousands of users, every detail counts.

**Owner's words (20 October 2026).** "I want you for the last time to audit our id platform code, is anything here unnecessary, overly complicated in our current setup, or based on weak assumptions? Challenge them. What can be deleted entirely? What can be simplified now that unnecessary pieces are gone? Prefer deleting over simplifying, simplifying over optimizing, and optimizing over automating. You can delegate to Opus 5.5 for complicated audit tasks and to Sonnet 5.5 for low level tasks. Report with a plan before coding anything, this should be an enterprise-grade solution, it will impact thousands of users, little details are important."

**Scope.** `apps/id` (source, scripts, configuration, its docs), `packages/auth`, `packages/id-admin`; the consumers only as evidence of what the admin API must keep serving (admin MCP, Toolbox, acceptance, ops Jobs, docs). Out of scope, settled by the earlier goals unless an audit brings new evidence: the schema and migrations (v0 schema audit, 19 October), the test suite's shape (test audit, 4 October), line-level slop (V0 cleanup, 7 October), the deployment (`infra/*`).

**Baseline (main 60c98f65).** `apps/id/src` 22,990 non-test lines in 150 files; 45,535 test lines; 81 admin operation ids; 48 mutations; `packages/auth` 152 lines, `packages/id-admin` 191 + 568 (fake ID). ID suite at the last landing: 1,558 tests at 100% line and function coverage in 322 s.

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | Orient: the three earlier goals' decisions and do-not-re-propose lists, docs/02/03/05, README, OPERATIONS.md, `app.ts`, `auth.ts`, `env.ts`; the assumption list below; planning files and briefs | complete |
| 2 | Five audits in isolated worktrees: A auth layer (Opus), B1 admin API contract (Opus), B2 services, queries, database runtime (Opus), C shell, operations, pages, scripts, packages, docs (Opus), D mechanical baseline and consumer map (Sonnet); throwaway Postgres 17 on 47433–47436 | complete (audits in `audits/`) |
| 3 | Consolidate: one verdict table; re-run the probes the report leans on; cross-check contradictions and consumers | complete (U1 re-run and read in the dist; U3, U2, U4 logs read; U5, U6, the tier readers and `/auth/ok` verified by grep; no contradiction between the five: B1 keeps the in-transaction layer that B2 trims, A and B1 agree on refusal rows, A4 and C2 interlock) |
| 4 | Report with decisions and recommendations for the owner; no code before the owner decides | complete: [report.md](report.md), decisions D1–D13 |
| 5 | After approval: implementation briefs, gates, land on main, docs/02, memory | in progress: owner took D1–D13 as recommended (Opus 5.5); change sets 1–3 running, 4 after |

## Layout

- Planning files: this directory. Briefs in `briefs/`, the agents' audits in `audits/`, probe scripts and logs under `/tmp/v0-code-audit/probes/<letter>/` (copied into `audits/` only when the report cites them).
- Throwaway Postgres 17: `audit-pg-a..d` on 47433 (A), 47434 (B1), 47435 (B2), 47436 (C), `postgres:17-alpine` with `infra/postgres/init`. Remove with `docker rm -f audit-pg-a audit-pg-b audit-pg-c audit-pg-d` when the goal closes. The owner's 47432 is never touched; never `bun run env:up` from a worktree.
- Agents run in isolated worktrees (`.claude/worktrees/agent-*`); the main checkout stays clean. They write their audit to this directory by absolute path.

## Assumptions put to the evidence

Each audit challenges the assumptions in its brief. The headline ones:

1. **The idempotency journal on all 48 mutations** with permanent reservations, receipts, `Operation-Id`/`Idempotency-Replayed` headers, crash and replay proofs: what a staff MCP and a cURL caller actually need, what a `noop` receipt buys, whether a TTL or a subset (create, rotate, erase) keeps the safety.
2. **Revisions, ETags and `If-Match`** on seven PATCH routes and two PUTs: who sends them (the admin MCP binds one), what a stale write would cost without them.
3. **Two authorisation layers** (tier middleware and in-transaction `authorizeCommand`) and the six-scope vocabulary with `x-tier`, `x-scopes`, `x-kind`: whether one layer and fewer scopes hold the same guarantees.
4. **Denial and rejection audit events written to the database for unauthenticated requests** (`denial-audit.ts`, `signin-audit.ts`, token rejections): an amplifier under a credential-stuffing or scanning load, with no rate limiter on `/api/admin` (`Q-ADMIN-API-RATE-LIMIT`).
5. **Upstream refresh-token storage, its separate key ring (`UPSTREAM_TOKEN_SECRETS`) and the custody preflight**, kept for `Q-AID-RECHECK`, a feature that is Not yet.
6. **The native-* and user-token-* modules** (`native-client-authentication`, `native-code-replay`, `native-refresh-family`, `native-token-cleanup`, `user-token-assertions`, `user-token-boundary`, `user-token-revocation`): what re-implements the pinned `@better-auth/oauth-provider` 1.7.2 and what the plugin cannot do.
7. **Verified SSO's AsyncLocalStorage `run`, adapter `observe` and `beforeTransaction` hooks** and the own-tenant membership provisioning in the callback: whether Better Auth's own hooks carry it.
8. **Hand-rolled operational metrics** (`operations/metrics.ts`, fixed-cardinality JSON summaries) beside the OpenTelemetry the Toolbox already uses.
9. **The root secret, its self-lock and `ROOT_ADMIN_BREAK_GLASS`**, now that `infra/ops` has `bootstrap`, `register` and `make-admin` Jobs.
10. **Diagnostics, the SSO probe (`sso-test.ts`), access explanations (`getMemberAccess`, `listTargetAccess`), `getOperationStatus`, `getMemberConfiguration`**: who calls them and what they cost to keep.
11. **The platform applications injected on read** (`platform-applications.ts`): a credential mode on every SSO row for two providers.
12. **`hono-tailwind` at runtime** (C30, deferred twice): serve the prebuilt stylesheet.
13. **`packages/id-admin`'s fake ID** (568 lines imitating the admin API) beside the acceptance against real ID.
14. **Documentation that hedges** (`OPERATIONS.md`, docs/03, docs/05, docs/06, 12 reports): what describes code that exists, what describes a Not yet in the present tense, what a second engineer needs.

## Decisions

Put to the owner with [the report](report.md) on 2026-10-20; none taken yet. Recommended option first.

- **D1 Rate limits (U1).** Configure Better Auth's `rateLimit` for shared addresses and hosts, numbers written into docs/06; or rely on Cloudflare only. Recommended: configure.
- **D2 Refusal evidence (U2, A9).** Unauthenticated refusals as log lines, rows once the credential verified. Recommended.
- **D3 Idempotency (U3, B1-1).** Fresh keys in `make-admin` and the docs; `Idempotency-Key` optional with a server key. Recommended: both.
- **D4 Upstream tokens and preflight (A4, C2, U4).** Stop requesting `offline_access`, delete the storage, ring and preflight; add the startup decrypt check. Alternative: discard at write, keep the scope. Recommended: stop requesting.
- **D5 Issuance assertions (A2, A2b).** Delete with the reuse interval. Alternative: a 20-line replay-only check. Recommended: delete.
- **D6 One authorisation layer (B1-3, b2-1).** Tier middleware, `x-tier`, `org:write` and the per-lock re-evaluation go; accept ≤2 s per lock wait of window slack. Alternative: a horizon comparison. Recommended: no horizon.
- **D7 Routes (B1-5).** Delete `getMemberConfiguration`, `getOperationStatus`, `revokeUserSession`; keep the other uncalled routes. Recommended.
- **D8 Environment (C4).** 13 variables → constants, production URL default out, `DATABASE_POOL_MAX` stays. Recommended.
- **D9 Runtime and image (C6, C11, C8).** Prebuilt stylesheet, bundled migrate, snapshot test writes OpenAPI. Recommended: all.
- **D10 The rest of the simplifications** (A3, A11, b2-3, b2-4, b2-5, b2-8, b2-15, B1-10, B1-11, B1-12, U5, U6, response fields, `/auth/ok`, fake drift). Recommended: all.
- **D11 Scripts (b2-6, b2-7).** `test-migrations.ts` now, `regenerate-migrations.ts` at B7a. Recommended.
- **D12 Docs (C12).** Delete four changelog reports, trim three, de-duplicate, fix false statements, docs/06 points at the runbook. Alternative: archive under `docs/goals/`. Recommended: delete.
- **D13 The ops Job after the root lock (B1 Q2).** A machine client for `register`, in the civo-deploy goal. Recommended.

## Errors encountered

| Error | Attempt | Resolution |
|-------|---------|------------|
