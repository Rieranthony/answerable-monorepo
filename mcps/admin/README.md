# Admin MCP

The staff-only MCP through which Answerable staff read organisations, members, access and the audit log in Answerable ID from an AI host. Only members of the platform organisation get a tool, and each tool only to a role at or above its minimum: the role is read from ID once per request and never cached. Development and test only. The page for staff: [The admin MCP](../../apps/web/content/docs/admin/index.mdx).

```sh
bun run --filter @answerable/mcp-admin test
bun run mcp:check @answerable/mcp-admin
```

The suite needs the development PostgreSQL on port 47432; `test` resets `answerable_admin_test` and applies the migrations first. `bunfig.toml` gates 100% line and function coverage over `src`.

## Run it

```sh
bun --env-file=.env run --filter @answerable/mcp-admin db:migrate   # ADMIN_DATABASE_URL from the root .env
bun run admin:dev                                                   # serves http://localhost:47520/mcp
```

It needs its registrations in ID and the `ADMIN_*` variables, which `default.env` lists: [Run it locally](../../apps/web/content/docs/admin/index.mdx#run-it-locally).

| File | Job |
| --- | --- |
| `src/admin.ts` | `createAdminMcp({ auth, db, id, platform })`: the provider on `@answerable/mcp` with `allow` (the platform check, the `admin` scope and the role against each tool's minimum), evidence for every call and refusal on the platform organisation's chain, intents in Postgres, `/health` |
| `src/roles.ts` | `createRoles`: each caller's role from ID's member access view, once per request; `roleOf`, the three grant strings; `refusal`, why a caller may not use a tool |
| `src/provider.ts` | `createAdminProvider`: `admin_whoami` and the read tools, each with its minimum role, reading ID's admin API with the call's execution id as `x-request-id` |
| `src/platform.ts` | `readPlatform`: the platform organisation's id from ID's `GET /me`, refusing a machine client of any other organisation |
| `src/environment.ts` | `readAdminEnvironment` |
| `src/server.ts` | The entry point; `src/server.test.ts` starts it against a fake ID over HTTP |
| `scripts/migrate.ts` | `db:migrate` and `db:test:migrate`: the migrations of `@answerable/mcp-postgres`, its only tables |

It builds on `@answerable/id-admin` (`createIdAdmin`, the machine client, and the fake ID in its tests) and `@answerable/mcp-postgres` (intents, evidence and the migrator). `manifest.json` is the `admin` provider's contract; `UPDATE_MANIFEST=1 bun run --filter @answerable/mcp-admin test` rewrites it.
