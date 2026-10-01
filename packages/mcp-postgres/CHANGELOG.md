# Changelog

## 0.1.0

`createEvidence`, `createPostgresIntentStore`, `withEvidence` and the migrator moved out of the Toolbox (`mcps/toolbox/src/evidence.ts`, `intents.ts`, `intent-evidence.ts`, `db/migrate.ts`) so that a second server can use them. Nothing about them changes.

- `migrations/0002_evidence.sql` and `migrations/0004_intents.sql` moved with their names and contents, so the Toolbox's databases, whose `schema_migrations` already lists them, do not apply them again. `migrate(db, directories)` records a file by its name alone, whichever directory holds it; the Toolbox's own test proves that a database migrated with all four files in one directory is not migrated again by the split.
- `migrate(db, directories)` takes the directories to read, and applies their files in the order of their names across all of them; two files with one name are refused. `migrations` is the URL of this package's directory, for a server that has no tables of its own: `migrate(db, [migrations])`.
- Its tests use the disposable database `answerable_mcp_postgres_test` (`MCP_POSTGRES_TEST_DATABASE_URL`), created by `infra/postgres/init/004-create-mcp-databases.sql`.
