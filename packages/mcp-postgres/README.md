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
- **`migrate(db, { folder, legacy?, schema? })`.** Apply the folder's pending migrations in one transaction, as drizzle's migrator does, after refusing what it would mishandle: an applied file that was edited, regenerated or removed refuses the run, naming it. The receipts are in `<schema>.__drizzle_migrations`, `drizzle` unless given; an MCP's are in its own schema. With `legacy`, a database the file migrator built before drizzle is adopted first: when its `schema_migrations` lists exactly `legacy.records` (file name to SHA-256), drizzle's receipts for the journal's first `legacy.entries` entries are recorded and the table dropped, in one transaction and without DDL, since those files made the same schema; any other `schema_migrations`, or one beside drizzle's receipts, refuses the run naming what differs. `legacyBaseline` is this package's own file; a server with files of its own adds them.
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
| Schema `<name>` owned by | the login `answerable_mcps_migrator`, which migrates every MCP | the login `answerable_mcp_<name>_owner` |
| Queries run as | the login `answerable_mcps_toolbox`, granted `USAGE` on each MCP's schema and its tables | the login `answerable_mcp_<name>_runtime` |
| Logins | two, whatever the number of MCPs: `answerable_mcps_migrator` and `answerable_mcps_toolbox`, which serves every MCP | two per MCP |

`<name>` is the provider id (a lowercase letter, then up to 11 lowercase letters or digits); `public` and `drizzle` are refused. No role is made for an MCP. Every table is limited to the caller's organisation by row-level security, through the setting `answerable.organisation_id`: the serving login owns no table, so the policy binds it.

```ts
// As the shared database's administrator, then as the migrator login, then as the serving login.
await provisionMcps(sql, { mcps: [{ name: "acme" }], logins: sharedMcps.logins })
await migrateMcp({ client: migrator, name: "acme", folder: "mcps/acme/drizzle", serving: sharedMcps.logins.toolbox })
await assertServingLogin(serving, { names: ["acme"] })
const db = mcpDatabase(serving.$client, { name: "acme", schema, organisation: () => organisationOfTheCall() })
```

- **`provisionMcps(sql, { mcps, logins })`.** On `answerable_mcps`, as a login that holds the migrator's privileges, such as a managed database's administrator that is a member of it: locks the database to the two logins, then makes each MCP's schema, owned by the migrator, with `USAGE` for the serving login. It makes no role. Idempotent; never drops anything. `sql` must be one connection: it runs in one transaction, under the lock that statements on a database's privileges take, since two grants on one database at once fail; `sqlOf(client)` makes it of a connected pg client.
- **`provisionOwnMcp(sql, { name, owner, runtime })`.** On `answerable_mcp_<name>`, as its owner login: the schema and `USAGE` for the runtime login.
- **`migrateMcp({ client, name, folder, serving })`, `migrateMcps(list, connection)`.** As the schema's owner, `migrate` with the journal in the MCP's schema (`<name>.__drizzle_migrations`): drizzle's migrator, after refusing a changed applied file. A statement that fails names the MCP and its file. Then the grants, in one transaction: `serving` gets `USAGE` on the schema, read and write on every table but the journal, and its sequences; everything else is revoked, `PUBLIC`'s included, a `GRANT` a migration made itself too.
- **`withoutSchemaCreation(text, name)`.** A migration drizzle-kit has just generated, without its `CREATE SCHEMA "<name>";` line: provisioning makes the schema.
- **`organisationIsolation(column)`.** The policy that limits a table to the caller's organisation, beside `.enableRLS()`.
- **`mcpDatabase(pool, { name, schema, organisation })`.** The drizzle database an MCP's tools use. Each borrow sets the schema as the search path and the organisation, in one round trip; the next borrow sets both again, so nothing is reset on release. A connection whose setup fails, or that is released inside a transaction, is destroyed.
- **`assertServingLogin(db, { names })`.** Refuses, on each pool a server's MCPs borrow from, a login that is more than the one provisioning made: an attribute beyond `LOGIN`, a membership, anything it owns, `CREATE` on a schema, `CREATE` or `TEMPORARY` on the database, or no `USAGE` on the schema of one of `names`, naming each problem.
- **`sharedMcps`, `ownMcpDatabase(name)`.** The names the deployment and the development Postgres give: `answerable_mcps` and its two logins; `answerable_mcp_<name>` and its `_owner` and `_runtime` logins.
- **`declaredMcps`, `DeclaredMcp`.** The zod schema of the chart's list as a variable holds it, JSON `[{ name, serve, database, scopes }]`, for the ops Jobs' `OPS_MCPS` and the migration Job's `MCPS_DECLARED`, and the type of one entry, which the smoke test and the chart tests read too.

**The trust boundary.** One serving login reaches every MCP its process serves, and a provider runs in that process, so provider code is trusted first-party code: a query in one MCP that names another MCP's schema reaches it, and a migration of one could alter another's tables. Review is the guard, with two checks: `bun mcp db generate` refuses a table outside the MCP's schema, and drizzle's tables are always schema-qualified. Organisation isolation holds across MCPs alike: every borrow sets the caller's organisation, and every table's policy binds the serving login.

**Tests.** An MCP's tests are served the way production serves it (`src/mcp-test-database.ts`): schema `<name>` in `answerable_mcps_test` (`MCPS_TEST_DATABASE_URL`) dropped and recreated, provisioned for a fresh serving login, migrated as the migrator, and reached through that login, with `asOrganisation(id, fn)`, which awaits `fn` as that organisation, and `close()`, which drops the login. Suites for different MCPs run at once, each in its own schema as a login of its own. `bun bench/mcp-database.ts` measures, in a database of its own that it drops afterwards, provisioning and migrating 200 MCPs, the roles the cluster gained, a borrow, and a burst over the 200 (not a gate).

An MCP whose provider declares a `database` imports `createTestMcp(provider, options?)` and `assertProviderConformance(provider, fixture)` from here rather than from `@answerable/mcp/testing`: they are the SDK's, served with the provider's `db`; the fixture's `examples` functions and `moveTarget` also receive that database, `{ db, asOrganisation }`, as their last argument (`DatabaseFixture`), made from `provider.database` as above, with the SDK's `callerOrganisation` as its organisation. Each connection then sees only its organisation's rows (`connect({ organizationId })`), and `close()` or the end of the checks drops the login. `createTestMcp` also returns that `db` and `asOrganisation(id, fn)`, to seed and read rows as an organisation, and takes `server`, which builds the server from `{ auth, profiles, provider, db }` for `createMcpServer` options such as `intents` or `policyClass`. `src/test-mcp.test.ts` serves `src/test/fixtures/mpgfixa-provider.ts` both ways.

## Changing the schema

Edit `src/schema.ts` (or a server's `src/db/schema.ts`), then `bun run db:generate --name <change>` writes the next migration into `drizzle/` and its journal; review the SQL and commit it. A statement drizzle cannot express goes into `bun run db:generate --custom --name <change>`. A migration that has been applied anywhere is never edited, regenerated or removed: `migrate` refuses the folder, naming the file. A test in each workspace fails when the schema drifts from the committed migrations. Migrations expand, then contract: the previous image keeps serving during a rollout.

```sh
bun run --filter @answerable/mcp-postgres test
bun run mcp:check @answerable/mcp-postgres
```

`@answerable/mcp-postgres/testing` exports `testDatabase(name, url?)` for a server's own suite: the test database's URL (`url`, else the development Postgres on port 47432), `connect()`, `runtimeLogin(grants)`, `scratch(suffix)` and `assertDisposable(action)`, each of which refuses a URL that names another database, so a reset never reaches a real one. `runtimeLogin` makes a login with a generated name and password, provisions it with `configureRuntimeRole` and returns its `role`, `url`, a connection `db` and `drop()`: a suite serves through it to prove its grants are enough. `scratch` makes an empty database `<name>_<suffix>` beside the test database, for a test that starts from nothing, such as the adoption of a database the file migrator built. `rowsOf(db)` is a tagged template that returns a query's rows, and `refusalOf(query)` the message with which the database refused one, unwrapped from drizzle's query error. The admin MCP, the Toolbox and this package name their test databases in `src/test/database.ts`.

The suite needs the development PostgreSQL 17 on port 47432 and resets `answerable_mcp_postgres_test` first (`MCP_POSTGRES_TEST_DATABASE_URL` overrides the URL; the name must stay `answerable_mcp_postgres_test`, which nothing else may use). It also makes, then drops, the schemas of the fixture MCPs `mpgfixa`, `mpgfixb` and `mpgprova` to `mpgprovc` in `answerable_mcps_test`. `bunfig.toml` gates 100% line and function coverage over `src`.
