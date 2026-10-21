# Drizzle for the MCP servers' Postgres storage

**Goal.** One migration model for every database: `packages/mcp-postgres`, `mcps/toolbox` and `mcps/admin` move onto drizzle-orm over node-postgres (`pg`) with drizzle-kit, as Answerable ID already is. The owner's decision of 21 October 2026: "Everything should be using drizzle, we should have the same model for everything."

**Branch.** `claude/drizzle-mcps-6f10cc` in the worktree `.claude/worktrees/drizzle-mcps-6f10cc`. Never pushed to main: the owner lands it after the first staging tag.

**Brief.** The task message of 21 October 2026 (eight points): drizzle everywhere with ID's model; the shared base stays shared (the package's tables as drizzle schema, the trigger SQL exported, each server composes its schema and owns one journal); adoption of a database the old file migrator built, proven by a test; every guarantee kept with the same tests; the chart's Jobs and the images; docs; gates; branch discipline.

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | Read the kit, ID's drizzle model, the servers, the chart, the deployment | complete |
| 2 | Plan files written; dependency versions decided | complete |
| 3 | `packages/mcp-postgres` on drizzle: schema, connect, migrate (with legacy adoption), evidence, intents, runtime role, testing, drizzle folder, tests green at 100% | complete |
| 4 | `mcps/toolbox` on drizzle: composed schema, catalogue/search/admin queries, migrate script, drizzle folder, legacy fixture and adoption test, tests green at 100% | complete |
| 5 | `mcps/admin` on drizzle: schema, migrate script, drizzle folder, tests green at 100% | complete |
| 6 | `infra/ops`, `packages/acceptance`, `infra/k8s` (stack probe), Dockerfiles, chart test | complete |
| 7 | Docs: READMEs, AGENTS.md, docs/09, docs/11, the five docs pages, `docs/02-plan.md` register row, CHANGELOGs, reference.mdx if needed | complete |
| 8 | Gates: typecheck, lint, build, mcp:test, mcp:check ×4, web test, ID suite (dependency upgrade), knip | in_progress |
| 9 | Acceptance (`mcp:test:e2e`) and the kind stack (`infra:test`, once) | pending |
| 10 | Commits and the report | pending |

## Decisions

- **D1 Versions.** drizzle-orm 0.45.2 → 0.45.4, drizzle-kit 0.31.10 → 0.31.11, pg 8.16.3 → 8.23.1, @types/pg 8.15.6 → 8.23.1, for the whole repository (ID included), since every changelog entry between is additive (findings.md). ID's suite runs as a gate because of it.
- **D2 Driver.** `connect(url, options?)` returns a drizzle `NodePgDatabase` over a `pg.Pool` (`db.$client`), as ID's `createDatabase` does; the pool reads `sslmode` and `sslrootcert` from the URL (pg-connection-string). `connect` still refuses `sslrootcert` without `sslmode=verify-full` or `verify-ca`. Callers close with `db.$client.end()`.
- **D3 Schema names.** The drizzle tables name every constraint as Postgres named it when the old SQL files created it (`intents_check`, `intents_check1`, `evidence_events_payload_ref_fkey`, `capabilities_pkey`, …), so a database the old migrator built equals a fresh drizzle one and its adoption is bookkeeping only, with no DDL.
- **D4 Triggers.** The functions and triggers live in `packages/mcp-postgres/sql/evidence-chain.sql`, exported as `evidenceChainSql`, with `--> statement-breakpoint` between statements. Each workspace's drizzle folder has a custom migration `0001_evidence_chain.sql` whose text a test asserts equals the export.
- **D5 Migrator.** `migrate(db, { folder, legacy })` is ID's `runMigrations` (refuse an edited, regenerated or removed applied file, naming it) plus adoption: a `schema_migrations` table whose rows are exactly the legacy records (names and SHA-256) is replaced, in one transaction, by drizzle's receipts for the journal's first `legacy.entries` entries, then dropped; any other `schema_migrations` content, or one beside drizzle's receipts, refuses the run naming what differs.
- **D6 Runtime role.** The guarantee "nothing on `schema_migrations`" becomes "nothing on schema `drizzle`": `configureRuntimeRole` revokes the role's privileges there and `assertRuntimeRole` refuses `USAGE` on schema `drizzle` or any write privilege on `drizzle.__drizzle_migrations`.
- **D7 JSON round trip.** The intent store keeps reading and writing JSON as text (`::text` casts in drizzle `sql` fragments) so a JSON `null` and an absent field stay distinct, as today.
- **D8 Concurrency.** Two migrators at once are no longer tested: ID's migrator has no such test, and Helm runs one Job per database. Noted in findings.
- **D9 Linker.** `bunfig.toml` sets Bun's hoisted linker for the repository. The isolated linker (Bun 1.3's default) gave each workspace its own `drizzle-orm` instance per set of resolved optional peers (`pg` and `@types/pg` for the package and ID, `@opentelemetry/api` for the Toolbox, none for the admin MCP), and drizzle's types are nominal (private fields), so the Toolbox could not pass its tables to the package's `Executor`. One copy for every workspace is the only clean answer; the four Dockerfiles keep `bunfig.toml` in their manifests stage so the images install the same way. The scaffold test, which linked the e2e server's `node_modules`, links the repository's.
- **D10 Property names.** The drizzle tables' properties are the column names (`organisation_id`, not `organisationId`), as the SDK's `Intent` and `EvidenceEvent` types name their fields, so rows go in and come out without a mapping. ID uses camelCase; the model (drizzle tables, drizzle-kit journal, ID's migrator) is the same.
- **D11 JSON hashes.** `record` hashes a payload as `sha256(<param>::text::jsonb::text)`, the body as Postgres prints it, which is what `verify` reads back; the old `insert … select` form did the same from the inserted row.

## Errors encountered

| Error | Attempt | Resolution |
|-------|---------|------------|
| `Types have separate declarations of a private property 'shouldInlineParams'` across the package and the Toolbox | 1 | Two `drizzle-orm` instances under the isolated linker; D9, the hoisted linker |
| Scaffold test: `Cannot find module '@answerable/mcp'` in its temporary server | 1 | It linked `mcps/e2e/node_modules`, gone under hoisting; it links the repository's `node_modules` at the temporary root |
| Parallel shell calls shared one working directory, so two edits ran in `mcps/admin` | 1 | Absolute paths in every command |
| `DROP DATABASE cannot run inside a transaction block` from `scratch()` | 1 | A multi-statement simple query is one implicit transaction: the drop and the create run as two statements |
| An adoption after a run without `legacy` was refused as "beside drizzle's receipts" | 1 | Drizzle's migrator creates its empty receipts table before the failed transaction; "applied" now means at least one receipt |

## Report

(Written at the end.)
