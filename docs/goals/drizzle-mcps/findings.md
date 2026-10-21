# Findings

## Versions (21 October 2026)

- Pinned by ID: drizzle-orm 0.45.2 (27 March 2026), drizzle-kit 0.31.10, pg 8.16.3 (27 June 2025), @types/pg 8.15.6.
- Latest: drizzle-orm 0.45.4 (8 October 2026; 0.45.3 adds a Netlify driver, 0.45.4 fixes postgres-js `.prepare(name)`), drizzle-kit 0.31.11 (21 September 2026; warns about silent migration skips on `check`), pg 8.23.1 (30 September 2026; 8.17 better URL-parse error, 8.18 `connect` returns the client, 8.19 deprecates the internal query queue and passes parameters to the password callback, 8.20 `onConnect`, 8.21 SCRAM error handling and `scramMaxIterations`, 8.22 `sslnegotiation=direct`, 8.23 pipelining), @types/pg 8.23.1. All additive: upgrade the repository together (D1).
- drizzle-orm 1.0.0 is at rc.4 (June 2026): a major with a new casing API and codecs; not taken.

## The old model

- `packages/mcp-postgres/migrations/0001_initial.sql`: evidence_payloads, evidence_events, `evidence_field()`, `evidence_chain()` (BEFORE INSERT), `evidence_append_only()` (UPDATE/DELETE row, TRUNCATE statement), `evidence_payload_erase_only()` (same shape), intents. Recorded by the file migrator as `mcp-postgres/0001_initial.sql` with the SHA-256 of its text in `schema_migrations (name, checksum, applied_at)`.
- `mcps/toolbox/migrations/0001_initial.sql`: providers, capabilities (with a stored generated `tsvector` column `search`), organisation_catalogue, host_clients. Recorded as `toolbox/0001_initial.sql`.
- The admin MCP has no tables of its own.
- Constraint names Postgres gave the old files (kept by D3): evidence_payloads_pkey, evidence_payloads_check; evidence_events_pkey, evidence_events_kind_check, evidence_events_outcome_check, evidence_events_data_check, evidence_events_payload_ref_fkey, evidence_events_organisation_id_seq_key; intents_pkey, intents_policy_class_check, intents_commit_token_hash_check, intents_status_check, intents_check (expires_at > created_at), intents_check1 ((status = 'committed') = (receipt is not null)); providers_pkey; capabilities_pkey, capabilities_provider_id_fkey, capabilities_kind_check, capabilities_risk_check, capabilities_check; organisation_catalogue_pkey, organisation_catalogue_provider_id_fkey; host_clients_pkey, host_clients_projection_check, host_clients_direct_limit_check.

## ID's model (copied)

- `apps/id/drizzle.config.ts`: dialect postgresql, schema `src/db/schema/index.ts`, out `drizzle`, strict, verbose.
- `apps/id/src/db/migrate.ts` `runMigrations(db, folder)`: reads the journal and `readMigrationFiles`, compares each receipt in `drizzle.__drizzle_migrations` (hash and `created_at` = journal `when`) with the file at that index, refuses naming the file, then drizzle's `migrate`.
- `apps/id/scripts/migrate.ts`: `Pool({ connectionString, max: 1, lock_timeout: 5_000, statement_timeout: 300_000 })`, `runMigrations`, `configureRuntimeRole`, `pool.end()`, prints `Migrated database <name>`.
- `apps/id/src/db/migrations.test.ts`: journal tags match the files and snapshots, the first snapshot's `prevId` is zeros, and `generateMigration(previous snapshot, generateDrizzleJson(schema))` is empty.
- `apps/id/src/db/migrate.integration.test.ts`: three refusals (edited file, regenerated journal time, removed entry).
- Drizzle's migrator records `hash` (SHA-256 of the file text) and `created_at` (the journal's `when`) in `drizzle.__drizzle_migrations (id serial, hash text, created_at bigint)` and skips every entry whose `when` is not after the last receipt's `created_at`.

## Drivers

- Bun.SQL today: `db\`…\`` tagged templates, `db.begin`, `db.unsafe(text).simple()`, `db.reserve()`, `tx(row)` insert helper, objects as JSON parameters, timestamptz as Date.
- drizzle over pg: `db.execute(sql\`…\`)` returns `{ rows }`; drizzle's node-postgres session asks pg for timestamp, timestamptz, date and interval as strings (type parsers), so raw rows carry strings and the query builder's `timestamp({ mode: "date" })` columns become Dates. A raw `sql.raw(text)` with no parameters runs over pg's simple protocol, so a multi-statement text works.
- pg-connection-string 2.14 reads `sslrootcert` from the URL into `ssl.ca` (synchronously, when a client is made). Without `uselibpqcompat`, `prefer`, `require` and `verify-ca` are aliases of `verify-full` (full verification) and emit one `process.emitWarning` per process saying pg 9 will give them libpq's weaker meaning; `verify-full` is silent. `connect` keeps refusing `sslrootcert` without `verify-full` or `verify-ca`. ID's kind test proves `verify-full` with the URL's `sslrootcert` end to end.
- drizzle-orm 0.45 wraps every driver error in `DrizzleQueryError` (`Failed query: … params: …`) with the pg error as `cause`, so a test reads the database's message through `refusalOf` in `@answerable/mcp-postgres/testing`.
- Postgres 17 says `permission denied to create temporary tables in database "…"`; the old test matched the prefix only.

## Deployment

- The Toolbox's and the admin MCP's Dockerfiles copy the whole workspace directory (`COPY mcps/toolbox mcps/toolbox`), so `drizzle/` ships with the sources; `.dockerignore` excludes tests, markdown and local installs only. The ops image copies `packages/mcp-postgres` whole; its comment about `connect()` being the only runtime import changes, since the package now needs drizzle-orm and pg, which the production install of a workspace's dependencies brings in (the Toolbox image already relies on this for `@answerable/mcp`).
- The chart's Jobs run `bun mcps/toolbox/scripts/migrate.ts` and `bun mcps/admin/scripts/migrate.ts` with `*_DATABASE_MIGRATION_URL` and `*_DATABASE_RUNTIME_ROLE`: unchanged.
- The kind stack's TLS probe in the toolbox pod uses `connect` and Bun.SQL; it becomes pg through `connect`, as ID's probe is.

## Bun's linker

- Bun 1.3.1 installed this repository with the isolated linker (no `bunfig.toml`; `node_modules/.bun/<name>@<version>+<hash>` per instance). An instance is keyed by the optional peers resolved from the dependent's direct dependencies: `drizzle-orm@0.45.4+fb0578cf…` held `pg` and `@types/pg` (the package and ID), `+e40b0dfd…` held `@opentelemetry/api` (the Toolbox), and a bare one served the admin MCP. Runtime tolerated it (drizzle's `is()` compares entity kinds by name) but the types did not.
- With `linker = "hoisted"` every workspace's `node_modules` is empty but for version conflicts (`apps/id` keeps `jose` and `zod`), and `node_modules/drizzle-orm` is the one copy. The lockfile changed by 21 insertions and 13 deletions (resolution order), not by versions.
- `bunx knip` printed `Saved lockfile` and left the lockfile unchanged.
