# Toolbox

One MCP endpoint on Answerable ID that serves each person exactly the capabilities their organisation granted them. It mounts the e2e provider. Development and test only.

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

Register the Toolbox resource, a host client and the Toolbox's machine client in ID first, and write a catalogue row: [The Toolbox](../../apps/web/content/docs/mcp/toolbox.mdx#run-it-locally). The variables are listed in `default.env`.

| File | Job |
| --- | --- |
| `src/toolbox.ts` | `createToolbox({ providers, auth, db, id, spans? })`: the endpoint on `@answerable/mcp`, authority per request, evidence and a span per call, `/health` |
| `src/grants.ts` | `createGrantsReader`: grant strings from ID's member access view, cached 60 seconds; `allowedScopes(providers)`, the Toolbox resource's allowed scopes |
| `src/poller.ts` | `startGrantsPoller`: reads ID's audit log every 15 seconds and invalidates the organisations it names |
| `src/id.ts` | The machine client's token and GETs on ID's admin API |
| `src/catalogue.ts` | Manifest ingestion, and each organisation's catalogue (`readCatalogue`, `writeCatalogue`) |
| `src/projection.ts` | `allowed`, policy classes, tool order and result truncation |
| `src/whoami.ts` | The Toolbox's own provider, `toolbox`, with `toolbox_whoami` |
| `src/evidence.ts` | `createEvidence(db)`: `record`, `verify` and `erase` |
| `src/spans.ts` | One server span per call; OTLP/HTTP export when `OTEL_EXPORTER_OTLP_ENDPOINT` is set |
| `src/environment.ts` | `readToolboxEnvironment` |
| `src/db/migrate.ts`, `migrations/` | Numbered SQL files and `schema_migrations` |
| `src/server.ts` | The entry point |

`manifest.json` is the `toolbox` provider's contract; `UPDATE_MANIFEST=1 bun run --filter @answerable/mcp-toolbox test` rewrites it. The journeys against real ID are `packages/acceptance/src/journeys/toolbox.journeys.test.ts`, run by `bun run mcp:test:e2e`. The acceptance imports this package through its `exports`.
