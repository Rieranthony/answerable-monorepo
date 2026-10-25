# Changelog

## 0.9.0

`@answerable/mcp-postgres/testing` exports `createTestMcp` and `assertProviderConformance` for a provider with a `database`: `@answerable/mcp/testing`'s, given the provider's `db`, which `testMcpDatabase` makes from `provider.database` with the SDK's `callerOrganisation` as its organisation, so each connection sees only its organisation's rows. A test checks that the MCP name rule agrees with the SDK's `checkProviderId`.

## 0.8.0

A database for every MCP, in a shared database or one of its own ([design](../../docs/goals/mcp-cli/design.md#database)). Nothing breaks: the hubs' `migrate`, `configureRuntimeRole` and `assertRuntimeRole` are unchanged.

- `provisionMcps` and `provisionOwnMcp` make each MCP's schema and roles; `migrateMcp` and `migrateMcps` apply its migrations as its owner role, with drizzle's journal in its schema, then its grants; `withoutSchemaCreation` removes drizzle-kit's schema line from a new migration.
- `organisationIsolation(column)` is the row-level security policy that limits a table to the caller's organisation, and `mcpDatabase` sets that organisation, the MCP's role and its schema on every borrowed connection, destroying one whose reset fails.
- `assertServingLogin` refuses a serving login that holds anything but its MCPs' runtime roles; `ensureLocalMcpDatabases` and `infra/postgres/init/006-create-mcps-databases.sql` make the local shared databases and logins.
- `@answerable/mcp-postgres/testing`: `testMcpDatabase` serves an MCP's tests through its own schema in `answerable_mcps_test`; `mcpPostgresTestConfig` defines `MCP_POSTGRES_TEST_DATABASE_URL` and `MCPS_TEST_DATABASE_URL`.

## 0.7.0

The package moves onto drizzle, the model Answerable ID uses: drizzle-orm over `pg` with drizzle-kit migrations, one model for every database. Breaking: `connect` returns a drizzle database over a `pg` pool, `migrate` takes a drizzle folder, the SQL-file migrator, its `migrations/` directory and `schema_migrations` are gone, and a database the file migrator built is adopted on the next `migrate`.

- `connect(url, options?)` returns a drizzle `Database` over a `pg.Pool`, `db.$client`; close it with `db.$client.end()`. `pg` reads `sslmode` and `sslrootcert` from the URL; a URL with `sslrootcert` still needs `sslmode=verify-full` or `verify-ca`. `Executor` is a database or a transaction on one.
- The tables are drizzle schema: `evidencePayloads`, `evidenceEvents` and `intents`, from the package and from `@answerable/mcp-postgres/schema`, with every constraint named as Postgres named it under the SQL files. A server's `src/db/schema.ts` re-exports them beside its own tables and generates one journal; `evidenceChainSql` (`sql/evidence-chain.sql`) is its custom migration `0001_evidence_chain.sql`.
- `migrate(db, { folder, legacy? })` is ID's migrator: drizzle's, refusing an applied file that was edited, regenerated or removed, naming it. With `legacy` (`legacyBaseline` for this package's own file), a database whose `schema_migrations` lists exactly the legacy files is adopted: drizzle's receipts for the journal's first entries are recorded and the table dropped, without DDL; anything else there refuses the run.
- `configureRuntimeRole` also revokes the role on schema `drizzle`; `assertRuntimeRole` refuses `USAGE` on schema `drizzle` and any write privilege on `drizzle.__drizzle_migrations`, in place of `schema_migrations`.
- `@answerable/mcp-postgres/testing`: `testDatabase(...).scratch(suffix)` makes an empty database beside the test database; `rowsOf(db)` runs a tagged query and returns its rows; `refusalOf(query)` gives the database's message from drizzle's query error.
- Two migrators at once are no longer tested; Helm runs one Job per database.

## 0.6.0

The migrations reset to one file. Breaking: recreate a database migrated before this version (drop its `public` schema, then migrate).

- `migrations/0001_evidence.sql` and `0002_intents.sql` are one file, `0001_initial.sql`: the evidence, then the intents, their text unchanged, so a new database has the same tables, triggers and functions.
- `migrate` refuses a run, before anything applies, when a file recorded under a directory it is given is no longer in that directory, naming the file: `Migration mcp-postgres/0001_evidence.sql was applied but its file is gone; restore it, or recreate the database`. A database migrated before this version used to fail only with `relation "evidence_payloads" already exists`. Records of a directory not given are not checked.

## 0.5.0

A server runs as a restricted runtime login and migrates as the owner, as Answerable ID does, so that the evidence triggers hold against the credential the server holds; and it can verify its database against a private certificate authority. Nothing breaks: `migrate` is unchanged.

- `configureRuntimeRole(db, role, grants)` provisions a server's runtime role after `migrate`: created without login when it does not exist, refused when privileged, a member of another role or an owner, then given exactly `grants` and nothing by default privileges. Idempotent.
- `runtimeGrants` holds this package's tables' grants: events are appended and read, payloads also erased, intents moved and swept; nothing on `schema_migrations`. `Grant` and `Privilege` are the types a server's own grants use.
- `assertRuntimeRole(db)` refuses to serve as a login with an attribute beyond login, a membership, an ownership, or a privilege that could change the evidence, and names each one.
- `testDatabase(...).runtimeLogin(grants)` in `@answerable/mcp-postgres/testing` makes a provisioned login with a generated name and password, for a suite to serve through.
- `connect(url, options?)` opens a `Bun.SQL` pool that verifies the server against the URL's `sslrootcert`. Bun 1.3.1 reads `sslmode` from a URL but not `sslrootcert`, so `?sslmode=verify-full&sslrootcert=<file>` failed every handshake against a private certificate authority, and Postgres refused the parameter as a startup setting. A URL that names `sslrootcert` without `sslmode=verify-full` or `verify-ca` is refused.

## 0.4.0

The intent store records its own evidence. Breaking: `withEvidence` and the `PostgresIntentStore` and `EvidenceKind` types are gone, and `createPostgresIntentStore` takes the evidence.

- `createPostgresIntentStore(db, evidence, { now? })` returns an `IntentStore` that records every step of an intent, as `withEvidence(createPostgresIntentStore(db), evidence)` did, the only way either server used it. Replace that call with this one; the events, the expiry once per call and its record are unchanged.
- `expire`, `read` and `move` are private steps of `get` and `transition`.
- `EvidenceKind`, which nothing imported, is no longer exported; `EvidenceEvent["kind"]` names the same kinds.

## 0.3.0

The schema audit's reset. Breaking: `migrate` takes named directories and records files under new names, the files restart at `0001`, the evidence table loses four columns and eight kinds, and `expire` returns the intent. Nothing was deployed; recreate a database migrated by 0.2.0 (drop its `public` schema, then migrate).

- `migrate(db, directories)` takes `{ name, url }` directories. It applies them in the order given and each one's files in the order of their names, and records each file as `<name>/<file>` with the SHA-256 of its text in `schema_migrations (name, checksum, applied_at)`. A recorded file whose text has changed refuses the run before anything applies, naming it; before, an edited file was skipped silently. One file name may appear in several directories: the global order by name and the refusal of duplicate names are gone. `migrations` is `{ name: "mcp-postgres", url }`, and a server passes it first.
- The files are `migrations/0001_evidence.sql` and `0002_intents.sql`, with the changes below inside them.
- `evidence_events` drops `on_behalf_of`, `operation_id`, `target_type` and `target_id`, which nothing wrote, from the table, the chained layout and `EvidenceEvent`. `kind` accepts only the eight kinds written: `capability.completed`, `capability.denied`, `intent.prepared`, `intent.approval_requested`, `intent.committed`, `intent.stale`, `intent.expired` and `receipt.issued`.
- `verify` also fails at the first event whose payload is gone, or whose unerased body no longer hashes to the payload's `hash` and the event's `payload_hash`; a changed body used to pass. A trigger refuses any change to `evidence_payloads` but an erasure (`body` to null with `erased_at`), and refuses deletes and truncation.
- `intents` drops `approval` and refuses `expires_at` not after `created_at` and a `commit_token_hash` that is not 64 lower-case hex digits.
- The store sweeps like the memory store: an insert, at most once a minute by the store's clock, deletes the intents that can no longer be committed (expired, failed and stale ones, and unclaimed ones past `expires_at`) and committed ones a day after their commit. Before, the table grew forever.
- Expiry runs once per call. `expire(intentId)` returns the intent it expired, or `undefined` (it returned a boolean); `read` and `move` are `get` and `transition` without expiring first. `withEvidence` records `intent.expired` from that one step, so an intent whose `expires_at` fell between two reads of the clock in one call no longer ends `expired` with no event.

## 0.2.0

`@answerable/mcp-postgres/testing` exports `testDatabase(name, url?)`, the one helper for a server's disposable test database: its URL, `connect()` and `assertDisposable(action)`, each of which refuses a URL that names another database. The admin MCP and the Toolbox used two copies of it, and this package a third; each now names its database in `src/test/database.ts`.

## 0.1.1

`migrate` creates `schema_migrations` under its advisory lock too. Two migrators starting on a fresh database at once collided in Postgres's catalogue (`pg_type_typname_nsp_index`), so one of them failed; now both succeed and each file is applied once.

## 0.1.0

`createEvidence`, `createPostgresIntentStore`, `withEvidence` and the migrator moved out of the Toolbox (`mcps/toolbox/src/evidence.ts`, `intents.ts`, `intent-evidence.ts`, `db/migrate.ts`) so that a second server can use them. Nothing about them changes.

- `migrations/0002_evidence.sql` and `migrations/0004_intents.sql` moved with their names and contents, so the Toolbox's databases, whose `schema_migrations` already lists them, do not apply them again. `migrate(db, directories)` records a file by its name alone, whichever directory holds it; the Toolbox's own test proves that a database migrated with all four files in one directory is not migrated again by the split.
- `migrate(db, directories)` takes the directories to read, and applies their files in the order of their names across all of them; two files with one name are refused. `migrations` is the URL of this package's directory, for a server that has no tables of its own: `migrate(db, [migrations])`.
- Its tests use the disposable database `answerable_mcp_postgres_test` (`MCP_POSTGRES_TEST_DATABASE_URL`), created by `infra/postgres/init/004-create-mcp-databases.sql`.
