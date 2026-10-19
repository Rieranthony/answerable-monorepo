# Postgres storage for MCP servers

The intent store, the hash-chained evidence and the migrator that an MCP server with a Postgres database shares. Used by the Toolbox; the admin MCP is its second consumer. Private to the monorepo; no npm release.

```ts
import { assertRuntimeRole, configureRuntimeRole, connect, createEvidence, createPostgresIntentStore, migrate, migrations, runtimeGrants } from "@answerable/mcp-postgres"
import { createMcpServer } from "@answerable/mcp"

// The migrate script, as the schema owner: this package's tables (evidence_events, evidence_payloads, intents), then the runtime role's grants.
// In a deployment each URL ends in ?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.pem, which connect honours.
const owner = connect(process.env.MY_SERVER_DATABASE_MIGRATION_URL!, { max: 1 })
await migrate(owner, [migrations])
await configureRuntimeRole(owner, "my_server_runtime", runtimeGrants)

// The server, as the runtime login: it refuses to listen as anything more.
const db = connect(process.env.MY_SERVER_DATABASE_URL!)
await assertRuntimeRole(db)
const evidence = createEvidence(db)
const intents = createPostgresIntentStore(db, evidence) // every intent transition becomes evidence
const server = createMcpServer({ provider, auth, intents })

console.log(await evidence.verify(organisationId)) // { ok: true, length }, or { ok: false, length, broken_at }
```

- **`connect(url, options?)`.** A `Bun.SQL` pool on the URL, which reads `sslrootcert` as libpq and `pg` do. Bun 1.3.1 honours `sslmode` but ignores `sslrootcert`, and sends any parameter it does not know to Postgres, which refuses it; `connect` removes the parameter and gives the file to Bun as the certificate authority to verify the server against. A URL with `sslrootcert` must say `sslmode=verify-full` (or `verify-ca`), or `connect` throws. `options` are `Bun.SQL`'s, such as `max`.
- **`createEvidence(db)`.** `record` appends an event to an organisation's chain (a trigger assigns `seq` and the hashes), `verify` recomputes the chain and checks each unerased payload's body against its hash, `erase` removes an erasable payload's body and leaves its hash. A trigger refuses any other change to a payload.
- **`createPostgresIntentStore(db, evidence, { now? })`.** An `IntentStore` on the `intents` table; every status change is one compare-and-set. It records `intent.prepared`, `intent.approval_requested`, `intent.committed`, `receipt.issued`, `intent.stale` and `intent.expired` in `evidence` as the intent moves; each call expires an intent at most once, and records the expiry it made. Like the memory store, an insert, at most once a minute, deletes the intents that can no longer be committed and committed ones a day after their commit.
- **`migrate(db, directories)`.** Applies the `.sql` files of the directories that `schema_migrations` does not list: the directories in the order given, each one's files in the order of their names, each file in its own transaction under an advisory lock. A directory is `{ name, url }`, with a URL that ends in `/`; a file is recorded as `<name>/<file>` with the SHA-256 of its text. A recorded file whose text has changed, or that is no longer in its directory, refuses the run before anything applies, naming it; records of a directory not given are not checked. A server that has tables of its own passes this package's directory first: `migrate(db, [migrations, { name: "my-server", url: new URL("../migrations/", import.meta.url) }])`, and numbers its own files from `0001`.

A recorded file whose text has changed refuses the run, naming it: put a change in a new file. Never rename an applied file either, or it applies again.

A server migrates as the owner and runs as a restricted login, so that the evidence triggers hold against the credential the server holds: the owner can drop them, the runtime login cannot.

- **`configureRuntimeRole(db, role, grants)`.** Run by the owner after every `migrate`. Creates `role` without login when it does not exist (its login and password belong to deployment tooling), and refuses a role with an attribute beyond login, a membership of another role, or anything it owns in the database. Revokes what the role held on schema `public`, `CREATE` on the schema and `TEMP` on the database for everyone, and every default privilege for the role; then grants exactly `grants`, each `{ table, privileges }` with `select`, `insert`, `update` or `delete`. A table a later migration adds stays out of the role's reach until a grant names it. A second run changes nothing, and a run takes back a privilege granted by hand.
- **`runtimeGrants`.** This package's tables: `evidence_events` select and insert; `evidence_payloads` select, insert and update (the trigger allows only an erasure); `intents` select, insert, update and delete. Nothing on `schema_migrations`. A server with tables of its own adds a grant for each: `[...runtimeGrants, { table: "my_table", privileges: ["select", "insert"] }]`.
- **`assertRuntimeRole(db)`.** Awaited by a server before it listens. Refuses the connected role when it has `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `REPLICATION` or `BYPASSRLS`; belongs to another role; owns the database, schema `public` or anything in it; or may create in the schema, create temporary tables, update or delete events, delete payloads, write `schema_migrations`, or truncate or add a trigger to any table. The error names each one: `Database role answerable is not a restricted runtime role: has SUPERUSER; …`.

```sh
bun run --filter @answerable/mcp-postgres test
bun run mcp:check @answerable/mcp-postgres
```

`@answerable/mcp-postgres/testing` exports `testDatabase(name, url?)` for a server's own suite: the test database's URL (`url`, else the development Postgres on port 47432), `connect()`, `runtimeLogin(grants)` and `assertDisposable(action)`, each of which refuses a URL that names another database, so a reset never reaches a real one. `runtimeLogin` makes a login with a generated name and password, provisions it with `configureRuntimeRole` and returns its `role`, `url`, a connection `db` and `drop()`: a suite serves through it to prove its grants are enough. The admin MCP, the Toolbox and this package name theirs in `src/test/database.ts`.

The suite needs the development PostgreSQL 17 on port 47432 and resets `answerable_mcp_postgres_test` first (`MCP_POSTGRES_TEST_DATABASE_URL` overrides the URL; the name must stay `answerable_mcp_postgres_test`, which nothing else may use). `bunfig.toml` gates 100% line and function coverage over `src`. Changes: [CHANGELOG](CHANGELOG.md).
