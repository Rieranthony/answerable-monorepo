# Schema and migration audit (opened 2026-10-06)

**Goal.** A clean storage state before production: every database Answerable runs (ID's `answerable_id`, the Toolbox's `answerable_toolbox`, the admin MCP's `answerable_admin`) with the right tables, columns, constraints, indexes, functions, triggers and policies, nothing dead, nothing cleverer than the problem needs, and exactly one initial migration per directory. Report and decisions before any code. Nothing has shipped, so no migration history needs preserving.

**Questions the owner asked.** Are the indexes right? Are we trying to be too smart? Will it scale? Is there dead code or logic? What is unnecessary, overly complicated or built on a weak assumption; what can be deleted; what can be simplified once the dead pieces are gone. Prefer deleting over simplifying, simplifying over optimising, optimising over automating. A verdict of "keep" is a fine outcome; nothing has to be found.

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | Orient: read every migration, the Drizzle schema, the design doc, the migrators, the catalogue test | complete |
| 2 | Audits by four Opus agents on throwaway Postgres 47433–47436, probes and measured numbers (A columns and vocabularies, B triggers, functions and RLS, C indexes, growth and the migration tooling, D Toolbox, mcp-postgres and admin MCP) | complete |
| 3 | Consolidate: findings table with verdicts, cross-check contradictions, re-run any probe the report leans on | complete |
| 4 | Report (artifact) and decisions for the owner, with recommendations | in_progress: report v1 https://claude.ai/artifact/8Nb5XhGQz472qjLLpvXLRa; decisions D1–D12 asked |
| 5 | After approval: implementation briefs, gates, land on main, update docs/02 and docs/04, memory | in_progress: all five change sets on claude/schema-audit (M 9a59b4b, C1 3c5f3bc, C2 5458e50, B fcaf830, A bc31c27); full gates running |

## Layout

- Planning files: this directory. Audits land in `audits/` once consolidated.
- Scratchpad: briefs in `briefs/`, agent output in `audits/`, probes in `probes/<letter>/`.
- Throwaway Postgres: `audit-pg-a..d` on 47433–47436 (postgres:16-alpine, `infra/postgres/init`, `pg_stat_statements`). Remove with `docker rm -f audit-pg-a audit-pg-b audit-pg-c audit-pg-d` when the goal closes. Never `bun run env:up` from a worktree; never touch 47432.

## Decisions

Taken by the owner on 2026-10-06, all as recommended in the report:

- **D1, D2** Reset both migration sets: ID to a generated `0000_initial.sql` plus a reviewed `0001_invariants.sql` with an equivalence test replacing the hash catalogue and a shrunk `test-migrations.ts`; MCP to one file per directory with namespaced, checksummed records applied in directory order. Every existing ID database is recreated.
- **D3, D4, D5** Delete the parent-liveness trigger from sessions and both token tables; replace the generic parent and deletion guards on the configuration tables with generated `live` columns, composite FKs and per-table CHECKs (drizzle-kit modelling proved in a spike first); close the temp-table search-path hole (qualified names, `pg_temp` last, TEMP revoked, startup assertion, a test).
- **D7, D8, D9, D11** One audit payload version per action; `audit_event_users (user_id, event_id)`; typed grant evidence; the dead columns deleted and the three renames taken; ID provisions membership at sign-in (boot without `invitations` proved first), then `invitations` and `members.role` go; the small deletions; `grant_contexts` cascades to `restrict`.
- **D6, D10** A batched sweep job in ID for expired protocol rows; Toolbox and mcp-postgres: intents swept like the memory store, expiry recorded once, payload bodies verified with an update guard, two CHECKs, the unwritten columns, kinds, `intents.approval`, `capabilities.status`, four `providers` columns and the GIN index deleted.
- **D12** Upstream tokens: keep storing them (coordinator's call during implementation): docs/02 `Q-AID-RECHECK` plans upstream refresh-token probes for offboarding detection, a consumer the audit did not weigh; record in docs/04 that nothing reads them today. No spike.

## Implementation order (phase 5, on the owner's word)

1. Spikes, each a throwaway branch with a one-line result: drizzle-kit on a composite FK onto a generated column (D4); boot and sign-in without `invitations` with plugin provisioning off (D9); whether the SSO plugin can skip upstream token storage (D12).
2. ID schema and code, one worktree per area with disjoint files where possible: (a) columns, renames and audit trail (A, D7, D8, D9); (b) triggers, constraints and search path (B, D3, D4, D5, D11); (c) sweep job, migration reset and tooling (C, D1, D6). (c) lands last because it regenerates the migration from the cleaned schema.
3. MCP side in its own worktree (D2, D10), independent of ID.
4. Gates on the landing tree, acceptance, docs (docs/02, docs/04, `reports/id-initial-migration.md` supersession, READMEs, web docs), push to main, Vercel check, remove `audit-pg-a..d`, update the memory.

## Errors encountered

| Error | Attempt | Resolution |
|-------|---------|------------|
| Audits A, B and C stopped after ~40 min with API network errors (ENOTFOUND, ECONNREFUSED); probe files and containers intact | 1 | Resumed each agent from its transcript with SendMessage; D unaffected |
