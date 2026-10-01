# Admin MCP

The staff-only MCP through which Answerable staff onboard and manage organisations in Answerable ID from an AI host: read organisations, members, access and the audit log, and change them through prepared intents the person confirms. Only members of the platform organisation get a tool, and each tool only to a role at or above its minimum: the role is read from ID once per request and never cached. Development and test only. The page for staff: [The admin MCP](../../apps/web/content/docs/admin/index.mdx).

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
| `src/admin.ts` | `createAdminMcp({ auth, db, id, platform, freshSeconds, toolbox })`: the provider on `@answerable/mcp` with `allow` (the platform check, the `admin` scope and the role against each tool's minimum), every mutation controlled class, evidence for every call and refusal on the platform organisation's chain, intents in Postgres, `/health` |
| `src/roles.ts` | `createRoles`: each caller's role from ID's member access view, once per request; `roleOf`, the three grant strings; `refusal`, why a caller may not use a tool |
| `src/provider.ts` | `createAdminProvider`: `admin_whoami`, the read tools and the writes, each with its minimum role |
| `src/calls.ts` | `createCalls`: ID's admin API as the tools call it, with the call's execution id as `x-request-id`; reads with ETags, and writes with the intent's `Idempotency-Key`, sent once more when ID does not answer |
| `src/writes.ts` | What the mutations share: targets bound to ETags, the intent's key, the preview warnings, and the guard that makes every write to the platform organisation an owner's critical operation |
| `src/organisations.ts` | `organisations.create`, `.update`, `.disable` and `.enable`, `domains.add`, `sso.set` |
| `src/access.ts` | `groups.create`, `.addmember` and `.dropmember`, `access.grant`, `.revoke` and `.enable` |
| `src/staff.ts` | `staff.grant` and `staff.revoke`: a role through the group whose entitlement on the admin MCP's resource carries it |
| `src/toolbox.ts` | `createToolboxAdmin`, the Toolbox's admin API with a `toolbox:admin` token for its admin resource, and `toolbox.enable` |
| `src/fresh.ts` | `requireFresh`: the critical operations' rule on the token's `upstream_auth_time`, and `ADMIN_REAUTHENTICATION_REQUIRED` |
| `src/platform.ts` | `readPlatform`: the platform organisation's id from ID's `GET /me`, refusing a machine client of any other organisation |
| `src/environment.ts` | `readAdminEnvironment` |
| `src/server.ts` | The entry point; `src/server.test.ts` starts it against a fake ID over HTTP |
| `scripts/migrate.ts` | `db:migrate` and `db:test:migrate`: the migrations of `@answerable/mcp-postgres`, its only tables |

It builds on `@answerable/id-admin` (`createIdAdmin`, the machine client, and the fake ID in its tests) and `@answerable/mcp-postgres` (intents, evidence and the migrator). `src/test/admin.ts` holds the tests' fake Toolbox, the seeded organisations and role groups, and the in-process server, which signs a member's tokens again with the directory sign-in time a test sets. `manifest.json` is the `admin` provider's contract; `UPDATE_MANIFEST=1 bun run --filter @answerable/mcp-admin test` rewrites it.
