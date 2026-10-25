# Standalone server

One process that serves every MCP whose `mcp.json` says `"serve": "standalone"` or `"both"`, each at its own path, `<origin>/<name>/mcp`, with its own `createMcpServer`, resource and audience: a token for one MCP is refused by another. Development and test only until the deployment's M5. The page: [The standalone server](../../apps/web/content/docs/mcp/servers.mdx#the-standalone-server).

```sh
bun mcp db e2e migrate                                                       # each served MCP's local schema, in answerable_mcps
bun --env-file=.env run --filter @answerable/mcp-standalone db:migrate       # as the owner, STANDALONE_DATABASE_MIGRATION_URL; provisions the runtime role
bun run standalone:dev                                                       # serves http://localhost:47510/e2e/mcp
```

It needs its machine client, `standalone-hub` with `platform:read`, in the root `.env` (`STANDALONE_ID_CLIENT_ID`, `STANDALONE_ID_CLIENT_SECRET`): [Connect Claude Code](../../apps/web/content/docs/mcp/claude-code.mdx#register-the-servers-machine-client). Every other variable has a local default; `default.env` lists them.

| File | Job |
| --- | --- |
| `src/served.generated.ts` | The MCPs it serves, which `bun mcp` writes from `mcps/*/mcp.json`, with this workspace's dependencies on them. Never edited by hand |
| `src/standalone.ts` | `createStandalone({ serve, pools, origin, auth, db, id, spans })`: a server per MCP, routing by path (`/<name>/…` and `/.well-known/oauth-protected-resource/<name>/…`), `404` for any other path, `GET /health` at the root; evidence and a span for every call and refusal, and a refusal of a tool whose scopes the token lacks (`@answerable/mcp-platform`); intents in its database; who is calling through its machine client |
| `src/server.ts` | The entry point: the runtime login and the serving login checked before listening, the audit-log poller, `SIGTERM` closing the listener and every pool |
| `src/environment.ts` | `readStandaloneEnvironment`, from `standaloneConfig`, with an own MCP's database URL from the variable its generated entry names |
| `src/db/schema.ts`, `drizzle/`, `src/db/migrate.ts`, `scripts/migrate.ts` | Its database, `answerable_standalone`: `@answerable/mcp-postgres`'s tables and evidence chain, migrated as the owner, served as `answerable_standalone_runtime` with `runtimeGrants` |
| `src/db/migrate-mcps.ts`, `scripts/migrate-mcps.ts` | Every MCP's migrations, as the deployment's hook Job `mcps-migrate` runs them from the `mcps` image: the chart's list (`MCPS_DECLARED`), each `shared` MCP through `MCPS_DATABASE_MIGRATION_URL` as its owner role, each `own` MCP as its owner login (`MCP_<NAME>_DATABASE_MIGRATION_URL`), with the grants `mcps/<name>/src/db/grants.ts` exports. It lives here because this workspace is in the image and imports nothing that depends back on it. Locally, `bun mcp db <name> migrate` does the same for one MCP |

```sh
bun run --filter @answerable/mcp-standalone test
bun run mcp:check @answerable/mcp-standalone
```

The suite needs the development PostgreSQL 17 on port 47432: `test` resets `answerable_standalone_test` first, and the suite makes the shared MCP databases `answerable_standalone_test_mcps` (e2e and example, role prefix `mcp_std`) and `answerable_standalone_test_served` (the served list, `mcp_sts`) and a scratch Toolbox database, and drops them. `src/both.test.ts` serves e2e from the Toolbox and from this server over one schema, and restarts this one on fresh pools. `bunfig.toml` gates 100% line and function coverage over `src`. Changes: [CHANGELOG](CHANGELOG.md).
