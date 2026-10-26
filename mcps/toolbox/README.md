# Toolbox

One MCP endpoint on Answerable ID that serves each person exactly the capabilities their organisation granted them, directly or through its meta tools. It mounts every MCP whose `mcp.json` says `"serve": "toolbox"` or `"both"`, from `src/mounted.generated.ts`, and serves every one that says `"standalone"` or `"both"` alone, at `<TOOLBOX_STANDALONE_ORIGIN>/<name>/mcp`, with its own resource ([Served alone](../../apps/web/content/docs/mcp/servers.mdx#served-alone)). Deployed to staging since 2026-10-23 ([evidence](../../reports/staging-evidence.md)); production: Not yet.

```sh
bun run --filter @answerable/mcp-toolbox test
bun run mcp:check @answerable/mcp-toolbox
```

The suite needs the development PostgreSQL 17 on port 47432 (`bun run env:up`); `test` resets `answerable_toolbox_test`, applies the migrations and provisions the runtime role first, and the run makes the mounted MCPs' database of its own, `answerable_toolbox_test_mcps`, with a serving login of its own (`src/test/mcps.ts`, dropped by `src/test/preload.ts`). The tests that serve go through a fresh login with the Toolbox's runtime grants (`serving()` in `src/test/database.ts`), so the suite proves those grants are enough. `bunfig.toml` gates 100% line and function coverage over `src`.

## Run it

```sh
bun --env-file=.env run --filter @answerable/mcp-toolbox db:migrate   # as the owner, TOOLBOX_DATABASE_MIGRATION_URL; provisions the runtime role
bun mcp db e2e migrate && bun mcp db example migrate  # each mounted MCP's schema in answerable_mcps
bun run toolbox:dev                                    # as the runtime login, TOOLBOX_DATABASE_URL; serves http://localhost:47400/mcp
```

The Toolbox serves as a restricted login and refuses to start as the owner, or as any login that could change the evidence; `db:migrate` grants `TOOLBOX_DATABASE_RUNTIME_ROLE` (`answerable_toolbox_runtime`) exactly `runtimeGrants` from `src/db/migrate.ts`. A new table needs its grant there. The local login comes from `infra/postgres/init/005-create-mcp-runtime-roles.sql`: [Database roles](../../apps/web/content/docs/toolbox/index.mdx#database-roles).

It reaches the mounted MCPs' tables in `answerable_mcps` as the serving login `answerable_mcps_toolbox` (`TOOLBOX_MCPS_DATABASE_URL`), granted each MCP's schema and tables, and refuses to start when that login holds more than provisioning gave it or lacks `USAGE` on a mounted MCP's schema. Register the Toolbox in ID, then enable an organisation with one call to the admin API: [Administer the Toolbox](../../apps/web/content/docs/toolbox/admin.mdx). To mount another MCP: [Add tools to the Toolbox](../../apps/web/content/docs/toolbox/add-tools.mdx). The variables are listed in `default.env`. Changes: [CHANGELOG](CHANGELOG.md).

It builds on three shared packages: `@answerable/mcp-platform` (the evidence and spans of every call and refusal, the audit-log poller, `/health` and each MCP's database, shared with the admin MCP), `@answerable/id-admin` (`createIdAdmin`, the Toolbox's one machine client on ID's admin API, shared by the grants reader, who is calling (`createIdProfiles`), the poller and the enable operation: reads with `platform:read`, the enable operation with `platform:read platform:write`; `found` makes ID's 404 an answer; the fake ID for tests) and `@answerable/mcp-postgres` (`connect`, `createEvidence`, `createPostgresIntentStore`, which records every step of an intent as evidence, the drizzle base schema and `migrate`).

| File | Job |
| --- | --- |
| `src/mounted.generated.ts` | The MCPs the Toolbox mounts, which `bun mcp` writes from `mcps/*/mcp.json`, with this workspace's dependencies on them. Never edited by hand |
| `src/toolbox.ts` | `createToolbox({ mount, pools, auth, db, id, spans })`: the endpoint on `@answerable/mcp`, each mounted provider with its own `db`, authority, who is calling (read beside the grants on a call) and the projection per request, evidence and a span per call and refusal, `RESULT_TOO_LARGE` above 100 KiB, `/health` from its own database, with the MCP databases' state and the mounted providers |
| `src/grants.ts` | `createGrantsReader`: grant strings from the Toolbox targets of ID's member access view, cached 60 seconds, a client-limited one counted only through its client; an invalidation sends `tools/list_changed`. `allowedScopes(providers)`, the Toolbox resource's allowed scopes |
| `src/admin.ts` | The platform-tier admin API under `/admin/v1`: authentication (a machine client's token with `toolbox:admin`), routing, and the routes for providers, catalogue entries and host clients; `toolboxAdminResource` |
| `src/admin-enable.ts` | The enable operation: what ID holds, what is missing, and the ID calls that make it |
| `src/problem.ts` | `Problem`, the `{ error: { code, message } }` answer, and body parsing |
| `src/catalogue.ts` | Manifest ingestion, one read and one write per provider (new capabilities stay disabled for organisations that have the provider enabled), each organisation's catalogue, and each host client's settings, their defaults and their rows; `bench/scale.ts` measures it, and calls through the Toolbox, at 200 providers |
| `src/projection.ts` | `allowed`, policy classes, tool order and `projectionOf`, direct or meta |
| `src/meta.ts` | The Toolbox's own provider, `toolbox`: `toolbox_whoami` and the meta tools `toolbox_search`, `toolbox_describe`, `toolbox_execute` and `toolbox_prepare` |
| `src/search.ts` | Postgres full-text ranking over `capabilities.search` |
| `src/environment.ts` | `readToolboxEnvironment` |
| `src/db/schema.ts`, `drizzle/` | The drizzle schema: `@answerable/mcp-postgres`'s tables and the Toolbox's own (providers, capabilities, organisation_catalogue, host_clients); `drizzle/0000_initial.sql` is generated from it and `0001_evidence_chain.sql` is the package's trigger SQL. `db:generate` writes the next migration after a change; a test fails when the schema drifts |
| `src/db/migrate.ts` | `migrate(db)`: the folder through the package's migrator, adopting a database the file migrator built; `runtimeGrants`, the runtime role's grants on every table |
| `scripts/migrate.ts` | `db:migrate` and `db:test:migrate`: the migrations, then `configureRuntimeRole` with `runtimeGrants` |
| `src/server.ts` | The entry point: `assertRuntimeRole` and the serving login's assertion before the boot's ingest, the audit-log poller over the grants and the profiles; `src/server.test.ts` starts it against the test databases, as a runtime login, as the owner, and with a serving login without `USAGE` on a mounted MCP's schema, which it refuses |

`manifest.json` is the `toolbox` provider's contract; `UPDATE_MANIFEST=1 bun run --filter @answerable/mcp-toolbox test` rewrites it. The journeys against real ID are `packages/acceptance/src/journeys/toolbox.journeys.test.ts`, run by `bun run mcp:test:e2e`. The acceptance imports this package through its `exports` (`./admin`, `./grants`, `./migrate`, `./mounted`, `./toolbox`).
