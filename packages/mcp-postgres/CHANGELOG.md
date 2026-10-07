# Changelog

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
