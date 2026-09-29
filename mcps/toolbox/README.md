# Toolbox

One MCP endpoint on Answerable ID that serves each person exactly the capabilities their organisation granted them, directly or through its meta tools. It mounts the e2e provider. Development and test only.

```sh
bun run --filter @answerable/mcp-toolbox test
bun run mcp:check @answerable/mcp-toolbox
```

The suite needs the development PostgreSQL on port 47432 (`bun run env:up`); `test` resets `answerable_toolbox_test` and applies the migrations first. `bunfig.toml` gates 100% line and function coverage over `src`.

## Run it

```sh
bun --env-file=.env run --filter @answerable/mcp-toolbox db:migrate   # TOOLBOX_DATABASE_URL from the root .env
bun run toolbox:dev                                    # builds the e2e view, serves http://localhost:47400/mcp
```

Register the Toolbox in ID, then enable an organisation with one call to the admin API: [Administer the Toolbox](../../apps/web/content/docs/mcp/toolbox-admin.mdx). The variables are listed in `default.env`. Changes: [CHANGELOG](CHANGELOG.md).

| File | Job |
| --- | --- |
| `src/toolbox.ts` | `createToolbox({ providers, auth, db, id, spans })`: the endpoint on `@answerable/mcp`, authority and the projection per request, evidence and a span per call, `RESULT_TOO_LARGE` above 100 KiB, `/health` |
| `src/id.ts` | `createIdAdmin`, the Toolbox's one machine client on ID's admin API, shared by the grants reader, the poller and the enable operation: reads with `platform:read`, the enable operation with `platform:read platform:write`. `found` makes ID's 404 an answer |
| `src/grants.ts` | `createGrantsReader`: grant strings from ID's member access view, cached 60 seconds; an invalidation sends `tools/list_changed`. `allowedScopes(providers)`, the Toolbox resource's allowed scopes |
| `src/poller.ts` | `startGrantsPoller`: reads ID's audit log every 15 seconds and invalidates the organisations it names |
| `src/admin.ts` | The platform-tier admin API under `/admin/v1`: authentication (a machine client's token with `toolbox:admin`), routing, and the routes for providers, catalogue entries and host clients; `toolboxAdminResource` |
| `src/admin-enable.ts` | The enable operation: what ID holds, what is missing, and the ID calls that make it |
| `src/problem.ts` | `Problem`, the `{ error: { code, message } }` answer, and body parsing |
| `src/catalogue.ts` | Manifest ingestion (new capabilities stay disabled for organisations that have the provider enabled), each organisation's catalogue, and each host client's settings, their defaults and their rows |
| `src/projection.ts` | `allowed`, policy classes, tool order and `projectionOf`, direct or meta |
| `src/meta.ts` | The Toolbox's own provider, `toolbox`: `toolbox_whoami` and the meta tools `toolbox_search`, `toolbox_describe`, `toolbox_execute` and `toolbox_prepare` |
| `src/search.ts` | Postgres full-text ranking over `capabilities.search` |
| `src/intents.ts` | `createPostgresIntentStore(db, { now? })`: intents in the `intents` table |
| `src/intent-evidence.ts` | `withEvidence(store, evidence)`: every intent transition as evidence |
| `src/evidence.ts` | `createEvidence(db)`: `record`, `verify` and `erase` |
| `src/spans.ts` | One server span per call; OTLP/HTTP export when `OTEL_EXPORTER_OTLP_ENDPOINT` is set |
| `src/environment.ts` | `readToolboxEnvironment` |
| `src/db/migrate.ts`, `migrations/` | Numbered SQL files and `schema_migrations` |
| `src/server.ts` | The entry point; `src/server.test.ts` starts it against the test database |

`manifest.json` is the `toolbox` provider's contract; `UPDATE_MANIFEST=1 bun run --filter @answerable/mcp-toolbox test` rewrites it. The journeys against real ID are `packages/acceptance/src/journeys/toolbox.journeys.test.ts`, run by `bun run mcp:test:e2e`. The acceptance imports this package through its `exports`.
