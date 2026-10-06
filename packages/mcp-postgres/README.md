# Postgres storage for MCP servers

The intent store, the hash-chained evidence and the migrator that an MCP server with a Postgres database shares. Used by the Toolbox; the admin MCP is its second consumer. Development and test only.

```ts
import { SQL } from "bun"
import { createEvidence, createPostgresIntentStore, migrate, migrations, withEvidence } from "@answerable/mcp-postgres"
import { createMcpServer } from "@answerable/mcp"

const db = new SQL(process.env.MY_SERVER_DATABASE_URL!)
await migrate(db, [migrations]) // this package's tables: evidence_events, evidence_payloads, intents
const evidence = createEvidence(db)
const intents = withEvidence(createPostgresIntentStore(db), evidence) // every intent transition becomes evidence
const server = createMcpServer({ provider, auth, intents })

console.log(await evidence.verify(organisationId)) // { ok: true, length }, or { ok: false, length, broken_at }
```

- **`createEvidence(db)`.** `record` appends an event to an organisation's chain (a trigger assigns `seq` and the hashes), `verify` recomputes the chain and checks each unerased payload's body against its hash, `erase` removes an erasable payload's body and leaves its hash. A trigger refuses any other change to a payload.
- **`createPostgresIntentStore(db, { now? })`.** An `IntentStore` on the `intents` table; every status change is one compare-and-set. Like the memory store, an insert, at most once a minute, deletes the intents that can no longer be committed and committed ones a day after their commit.
- **`withEvidence(store, evidence)`.** Records `intent.prepared`, `intent.approval_requested`, `intent.committed`, `receipt.issued`, `intent.stale` and `intent.expired` as the store moves; each call expires an intent at most once, and records the expiry it made.
- **`migrate(db, directories)`.** Applies the `.sql` files of the directories that `schema_migrations` does not list: the directories in the order given, each one's files in the order of their names, each file in its own transaction under an advisory lock. A directory is `{ name, url }`, with a URL that ends in `/`; a file is recorded as `<name>/<file>` with the SHA-256 of its text. A server that has tables of its own passes this package's directory first: `migrate(db, [migrations, { name: "my-server", url: new URL("../migrations/", import.meta.url) }])`, and numbers its own files from `0001`.

A recorded file whose text has changed refuses the run, naming it: put a change in a new file. Never rename an applied file either, or it applies again.

```sh
bun run --filter @answerable/mcp-postgres test
bun run mcp:check @answerable/mcp-postgres
```

`@answerable/mcp-postgres/testing` exports `testDatabase(name, url?)` for a server's own suite: the test database's URL (`url`, else the development Postgres on port 47432), `connect()` and `assertDisposable(action)`, each of which refuses a URL that names another database, so a reset never reaches a real one. The admin MCP, the Toolbox and this package name theirs in `src/test/database.ts`.

The suite needs the development Postgres on port 47432 and resets `answerable_mcp_postgres_test` first (`MCP_POSTGRES_TEST_DATABASE_URL` overrides the URL; the name must stay `answerable_mcp_postgres_test`, which nothing else may use). `bunfig.toml` gates 100% line and function coverage over `src`. Changes: [CHANGELOG](CHANGELOG.md).
