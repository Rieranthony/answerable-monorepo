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
const server = createMcpServer({ provider, auth, profiles, intents })

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

## A database for every MCP

Each MCP keeps its tables in a schema named after it, in one of two modes ([design](../../docs/goals/mcp-cli/design.md#database): D1, D19). The tables and the code are the same in both, so an MCP moves between them by dumping and restoring its schema.

| | `shared`, the default | `own` |
| --- | --- | --- |
| Database | `answerable_mcps`, owned by `answerable_mcps_migrator`; tests use `answerable_mcps_test` | `answerable_mcp_<name>` |
| Schema `<name>` owned by | the role `mcp_<name>_owner` (`NOLOGIN`), which the migrations run as | the login `answerable_mcp_<name>_owner` |
| Queries run as | the role `mcp_<name>` (`NOLOGIN NOINHERIT`), taken on every borrow | the login `answerable_mcp_<name>_runtime` |
| Logins | three, whatever the number of MCPs: `answerable_mcps_migrator`, `answerable_mcps_toolbox`, `answerable_mcps_standalone` | two per MCP |

`<name>` is the provider id (a lowercase letter, then up to 11 lowercase letters or digits); `public` and `drizzle` are refused. Tests use the role prefix `mcp_test` in place of `mcp`. Every table is limited to the caller's organisation by row-level security, through the setting `answerable.organisation_id`.

```ts
// As the shared database's administrator, then as the migrator login, then as a serving login.
await provisionMcps(sql, { mcps: [{ name: "acme", servedBy: ["toolbox"] }], logins: { migrator: "answerable_mcps_migrator", toolbox: "answerable_mcps_toolbox", standalone: "answerable_mcps_standalone" } })
await migrateMcp({ client: migrator, name: "acme", folder: "mcps/acme/drizzle", mode: "shared" })
await assertServingLogin(serving, { names: ["acme"] })
const db = mcpDatabase(serving.$client, { name: "acme", schema, mode: "shared", organisation: () => organisationOfTheCall() })
```

- **`provisionMcps(sql, { mcps, prefix?, logins })`.** On `answerable_mcps`, as a `CREATEROLE` login holding the migrator's privileges: locks the database to the three logins, then makes or brings back in line each MCP's two roles, its schema and the memberships its `servedBy` needs (`WITH INHERIT FALSE, SET TRUE`), revoking the rest. Idempotent; never drops anything.
- **`provisionOwnMcp(sql, { name, owner, runtime })`.** On `answerable_mcp_<name>`, as its owner login: the schema and `USAGE` for the runtime login.
- **`migrateMcp({ client, name, folder, mode, … })`, `migrateMcps(list, connection)`.** Pending migrations, the journal (`<name>.__drizzle_migrations`) and the grants, in one transaction as the owner. drizzle's own migrator cannot run there: it creates its journal's schema, and the owner has no `CREATE` on the database. Refuses a changed applied file, and a pending one that creates a schema, grants, takes a role or names another schema, with its file and line. The runtime role gets read and write on every table but the journal, or exactly `grants`; everything else is revoked, `PUBLIC`'s included.
- **`withoutSchemaCreation(text, name)`.** A migration drizzle-kit has just generated, without its `CREATE SCHEMA "<name>";` line.
- **`organisationIsolation(column)`.** The policy that limits a table to the caller's organisation, beside `.enableRLS()`.
- **`mcpDatabase(pool, { name, prefix?, schema, mode, organisation })`.** The drizzle database an MCP's tools use. Each borrow takes the runtime role, the schema and the organisation in one round trip; the release resets them, and a connection whose reset fails, or that is released inside a transaction, is destroyed.
- **`assertServingLogin(db, { prefix?, names })`.** Refuses a serving login that holds anything but its MCPs' runtime roles, naming each problem.
- **`ensureLocalMcpDatabases(adminUrl)`.** Runs `infra/postgres/init/006-create-mcps-databases.sql` on the development Postgres.

**The trust boundary.** A serving login may take the runtime role of every MCP its process serves, and a provider runs in that process, so provider code is trusted first-party code. Two guards: `scripts/mcp-role-switching.test.ts` fails on `set role`, `reset role`, `set session authorization` or `answerable.organisation_id` in `mcps/*/src`, and `assertServingLogin` checks the login has nothing of its own. Migrations are refused the same role switches.

**Tests.** `testMcpDatabase({ name, schema, folder, organisation? })`, from `@answerable/mcp-postgres/testing`, serves an MCP's tests the way production does: it creates the local databases when missing, drops and recreates schema `<name>` in `answerable_mcps_test` (`MCPS_TEST_DATABASE_URL`), provisions it with the `mcp_test` prefix, migrates it, and returns `db` through a fresh serving login, `asOrganisation(id, fn)` to set the organisation, and `close()`, which drops the login. It never drops a role, so suites for different MCPs run at once. `bun bench/mcp-database.ts` measures a borrow and a burst over 200 MCPs (not a gate).

An MCP whose provider declares a `database` imports `createTestMcp(provider, options?)` and `assertProviderConformance(provider, fixture)` from here rather than from `@answerable/mcp/testing`: they are the SDK's, served with the provider's `db`, which `testMcpDatabase` makes from `provider.database` with the SDK's `callerOrganisation` as its organisation. Each connection then sees only its organisation's rows (`connect({ organizationId })`), and `close()` or the end of the checks drops the login. `src/test-mcp.test.ts` serves `src/test/fixtures/mpgfixa-provider.ts` both ways.

## Changing the schema

Edit `src/schema.ts` (or a server's `src/db/schema.ts`), then `bun run db:generate --name <change>` writes the next migration into `drizzle/` and its journal; review the SQL and commit it. A statement drizzle cannot express goes into `bun run db:generate --custom --name <change>`. A migration that has been applied anywhere is never edited, regenerated or removed: `migrate` refuses the folder, naming the file. A test in each workspace fails when the schema drifts from the committed migrations. Migrations expand, then contract: the previous image keeps serving during a rollout.

```sh
bun run --filter @answerable/mcp-postgres test
bun run mcp:check @answerable/mcp-postgres
```

`@answerable/mcp-postgres/testing` exports `testDatabase(name, url?)` for a server's own suite: the test database's URL (`url`, else the development Postgres on port 47432), `connect()`, `runtimeLogin(grants)`, `scratch(suffix)` and `assertDisposable(action)`, each of which refuses a URL that names another database, so a reset never reaches a real one. `runtimeLogin` makes a login with a generated name and password, provisions it with `configureRuntimeRole` and returns its `role`, `url`, a connection `db` and `drop()`: a suite serves through it to prove its grants are enough. `scratch` makes an empty database `<name>_<suffix>` beside the test database, for a test that starts from nothing, such as the adoption of a database the file migrator built. `rowsOf(db)` is a tagged template that returns a query's rows, and `refusalOf(query)` the message with which the database refused one, unwrapped from drizzle's query error. The admin MCP, the Toolbox and this package name their test databases in `src/test/database.ts`.

The suite needs the development PostgreSQL 17 on port 47432 and resets `answerable_mcp_postgres_test` first (`MCP_POSTGRES_TEST_DATABASE_URL` overrides the URL; the name must stay `answerable_mcp_postgres_test`, which nothing else may use). It also makes, then drops, the fixture MCPs `mpgfixa`, `mpgfixb` and `mpgprova` to `mpgprovc` in `answerable_mcps_test`, with their `mcp_test` roles. `bunfig.toml` gates 100% line and function coverage over `src`. Changes: [CHANGELOG](CHANGELOG.md).
