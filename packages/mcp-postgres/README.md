# Postgres storage for MCP servers

The intent store, the hash-chained evidence and the drizzle base schema that an MCP server with a Postgres database shares, on the model Answerable ID uses: drizzle-orm over `pg`, with drizzle-kit migrations. Used by the Toolbox and the admin MCP. Private to the monorepo; no npm release.

```ts
import { assertRuntimeRole, configureRuntimeRole, connect, createEvidence, createPostgresIntentStore, legacyBaseline, migrate, runtimeGrants } from "@answerable/mcp-postgres"
import { createMcpServer } from "@answerable/mcp"

// The migrate script, as the schema owner: the server's drizzle folder, then the runtime role's grants.
// In a deployment each URL ends in ?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.pem, which pg honours.
const owner = connect(process.env.MY_SERVER_DATABASE_MIGRATION_URL!, { max: 1 })
await migrate(owner, { folder: fileURLToPath(new URL("../drizzle", import.meta.url)), legacy: legacyBaseline })
await configureRuntimeRole(owner, "my_server_runtime", runtimeGrants)
await owner.$client.end()

// The server, as the runtime login: it refuses to listen as anything more.
const db = connect(process.env.MY_SERVER_DATABASE_URL!)
await assertRuntimeRole(db)
const evidence = createEvidence(db)
const intents = createPostgresIntentStore(db, evidence) // every intent transition becomes evidence
const server = createMcpServer({ provider, auth, intents })

console.log(await evidence.verify(organisationId)) // { ok: true, length }, or { ok: false, length, broken_at }
```

- **`connect(url, options?)`.** A drizzle database (`Database`) over a `pg` pool, which is `db.$client`; `db.$client.end()` closes it. `pg` reads `sslmode` and `sslrootcert` from the URL and verifies the server against that certificate authority. A URL with `sslrootcert` must say `sslmode=verify-full` (or `verify-ca`), or `connect` throws. `options` are the pool's, such as `max`. `Executor` is a database or a transaction on one, which every function here takes.
- **The schema.** `evidencePayloads`, `evidenceEvents` and `intents`, drizzle tables also exported from `@answerable/mcp-postgres/schema`, which a server's `src/db/schema.ts` re-exports beside its own tables, so that its drizzle folder has one journal for all of them. The columns are named as the SDK's types name their fields.
- **`createEvidence(db)`.** `record` appends an event to an organisation's chain (a trigger assigns `seq` and the hashes), `verify` recomputes the chain and checks each unerased payload's body against its hash, `erase` removes an erasable payload's body and leaves its hash. A trigger refuses any other change to a payload.
- **`createPostgresIntentStore(db, evidence, { now? })`.** An `IntentStore` on the `intents` table; every status change is one compare-and-set. It records `intent.prepared`, `intent.approval_requested`, `intent.committed`, `receipt.issued`, `intent.stale` and `intent.expired` in `evidence` as the intent moves; each call expires an intent at most once, and records the expiry it made. Like the memory store, an insert, at most once a minute, deletes the intents that can no longer be committed and committed ones a day after their commit.
- **`migrate(db, { folder, legacy? })`.** Apply the folder's pending migrations in one transaction, as drizzle's migrator does, after refusing what it would mishandle: an applied file that was edited, regenerated or removed refuses the run, naming it. With `legacy`, a database the file migrator built before drizzle is adopted first: when its `schema_migrations` lists exactly `legacy.records` (file name to SHA-256), drizzle's receipts for the journal's first `legacy.entries` entries are recorded and the table dropped, in one transaction and without DDL, since those files made the same schema; any other `schema_migrations`, or one beside drizzle's receipts, refuses the run naming what differs. `legacyBaseline` is this package's own file; a server with files of its own adds them.
- **`evidenceChainSql`.** The chain's functions and triggers, which drizzle cannot express: `sql/evidence-chain.sql`, with `--> statement-breakpoint` between statements. Each server's drizzle folder holds it as its custom migration `0001_evidence_chain.sql`, and a test keeps the file equal to it.

A server migrates as the owner and runs as a restricted login, so that the evidence triggers hold against the credential the server holds: the owner can drop them, the runtime login cannot.

- **`configureRuntimeRole(db, role, grants)`.** Run by the owner after every `migrate`. Creates `role` without login when it does not exist (its login and password belong to deployment tooling), and refuses a role with an attribute beyond login, a membership of another role, or anything it owns in the database. Revokes what the role held on schema `public` and on schema `drizzle`, `CREATE` on the schema and `TEMP` on the database for everyone, and every default privilege for the role; then grants exactly `grants`, each `{ table, privileges }` with `select`, `insert`, `update` or `delete`. A table a later migration adds stays out of the role's reach until a grant names it. A second run changes nothing, and a run takes back a privilege granted by hand.
- **`runtimeGrants`.** This package's tables: `evidence_events` select and insert; `evidence_payloads` select, insert and update (the trigger allows only an erasure); `intents` select, insert, update and delete. Nothing on schema `drizzle`, where the migration receipts are. A server with tables of its own adds a grant for each: `[...runtimeGrants, { table: "my_table", privileges: ["select", "insert"] }]`.
- **`assertRuntimeRole(db)`.** Awaited by a server before it listens. Refuses the connected role when it has `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `REPLICATION` or `BYPASSRLS`; belongs to another role; owns the database, schema `public` or anything in it; or may create in the schema, create temporary tables, update or delete events, delete payloads, reach schema `drizzle` or write its receipts, or truncate or add a trigger to any table. The error names each one: `Database role answerable is not a restricted runtime role: has SUPERUSER; …`.

## Changing the schema

Edit `src/schema.ts` (or a server's `src/db/schema.ts`), then `bun run db:generate --name <change>` writes the next migration into `drizzle/` and its journal; review the SQL and commit it. A statement drizzle cannot express goes into `bun run db:generate --custom --name <change>`. A migration that has been applied anywhere is never edited, regenerated or removed: `migrate` refuses the folder, naming the file. A test in each workspace fails when the schema drifts from the committed migrations. Migrations expand, then contract: the previous image keeps serving during a rollout.

```sh
bun run --filter @answerable/mcp-postgres test
bun run mcp:check @answerable/mcp-postgres
```

`@answerable/mcp-postgres/testing` exports `testDatabase(name, url?)` for a server's own suite: the test database's URL (`url`, else the development Postgres on port 47432), `connect()`, `runtimeLogin(grants)`, `scratch(suffix)` and `assertDisposable(action)`, each of which refuses a URL that names another database, so a reset never reaches a real one. `runtimeLogin` makes a login with a generated name and password, provisions it with `configureRuntimeRole` and returns its `role`, `url`, a connection `db` and `drop()`: a suite serves through it to prove its grants are enough. `scratch` makes an empty database `<name>_<suffix>` beside the test database, for a test that starts from nothing, such as the adoption of a database the file migrator built. `rowsOf(db)` is a tagged template that returns a query's rows, and `refusalOf(query)` the message with which the database refused one, unwrapped from drizzle's query error. The admin MCP, the Toolbox and this package name their test databases in `src/test/database.ts`.

The suite needs the development PostgreSQL 17 on port 47432 and resets `answerable_mcp_postgres_test` first (`MCP_POSTGRES_TEST_DATABASE_URL` overrides the URL; the name must stay `answerable_mcp_postgres_test`, which nothing else may use). `bunfig.toml` gates 100% line and function coverage over `src`. Changes: [CHANGELOG](CHANGELOG.md).
