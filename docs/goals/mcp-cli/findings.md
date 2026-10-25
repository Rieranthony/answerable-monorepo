# MCP CLI and shipping: findings

Every fact here was read from the tree at `bfabca12` or measured by a probe in a throwaway worktree (deleted afterwards) on 24 and 25 October 2026. "Ran" marks a measurement, "read" a reading of code, with file and line.

## F1. Today's path from idea to running MCP

- **Scaffold (ran).** `bun run mcp:new acme`, `bun install`, `UPDATE_MANIFEST=1 … test`, `bun run mcp:check`: 0.15 s, 0.2 s, 0.2 s, 2.4 s. 6 tests, 5 of them conformance checks, 100% coverage.
- **The scaffold only makes a laptop server (read).** `scripts/mcp-templates.ts:22-29` writes a four-statement `server.ts`:
  - it binds `127.0.0.1`, and `readMcpEnvironment` has no host variable (`packages/mcp/src/environment.ts:4-8`);
  - `MCP_PORT` defaults to 47500, the e2e server's port. Ran: a container started from the image listened on 47500;
  - intents live in memory, the `createMcpServer` default (`packages/mcp/src/server.ts:160`);
  - there is no database, Dockerfile, evidence, spans or SIGTERM handling.

  Only a read-tool template exists. The scaffold copies its config files and version pins from `mcps/e2e` when it runs (`scripts/mcp-new.ts:14, 26-28`).
- **Mounting in the Toolbox (ran).** It takes three hand edits:
  - `exports` in the MCP's `package.json`;
  - a workspace dependency in `mcps/toolbox/package.json`;
  - the import in `mcps/toolbox/src/server.ts:21-23`.

  The Toolbox suite passed (83 tests, 6.5 s) and the image built (19.8 s). The image then failed at start with `Cannot find module '@answerable/mcp-acme/provider'`, because `mcps/toolbox/Dockerfile:33-39` copies only e2e. The add-tools guide and `agents.mdx` never mention the Dockerfile.
- **A standalone server touches about 22 files in about 40 places (read).** Among them:
  - `infra/civo/modules/edge/variables.tf:44-47`, which accepts exactly `id`, `toolbox` and `admin_mcp`;
  - `.github/workflows/deploy-staging.yml:110-118` and `promote-production.yml:63, 145`;
  - `infra/pipeline/src/deploy.ts:130, 157`;
  - `infra/ops/src/bootstrap.ts:16-20` and `infra/ops/src/register.ts:79-110`;
  - the chart's values, helpers, migrations, network policies and ops templates;
  - the kind stack and 12 test files.

  There is also a manual GHCR visibility flip per image (`infra/README.md:57`).
- **After the root lock, register can't run (read).** The deploy runs `register` only when a client Secret is missing, and only with the root secret (`infra/pipeline/src/deploy.ts:338-347`). `register.ts:50` explains the refusal. D13 (the Job gets its own machine client) is decided and not built (`docs/02-plan.md` Q-OPS-REGISTER-CLIENT).

## F2. One image for every MCP (ran)

- **It works.** A Dockerfile that installs `--production --filter './mcps/*'` and copies `packages/{auth,id-admin,mcp,mcp-postgres}` plus `mcps/` built in 10.2 s, warm. The image is 265 MB, the same as today's Toolbox image alone (today's admin MCP image is 246 MB).
- **Every server starts from it.** The Toolbox, the admin MCP, e2e and a scaffolded `acme` all resolved their modules and stopped only at environment validation. `acme` served `/health` with 200. The image contained no `*.test.ts`.
- **Restarts don't change (read).** Each image already carries `ARG REVISION` in a label (`mcps/toolbox/Dockerfile:26-30`), so every commit already changes every digest and restarts every service. A shared image keeps that behaviour.
- **What it removes:**
  - the per-image GHCR flip;
  - the per-image matrix entry;
  - the Dockerfile COPY that breaks a Toolbox mount.

## F3. Path routing under one host (ran)

- **The SDK already serves both paths.** With `MCP_RESOURCE_URL=http://localhost:47518/acme/mcp`, the scaffolded server answered as follows.

  | Path | Answer |
  | --- | --- |
  | `POST /acme/mcp` | `401` |
  | `GET /.well-known/oauth-protected-resource/acme/mcp` | `200`, with the right `resource` |
  | `/mcp` and the unprefixed metadata path | `404` |
  | `/health` | `200`, at the root |

  `WWW-Authenticate` pointed at the path-scoped metadata.
- **ID accepts path resources (read, auditor D).** `apps/id/src/http/admin/resources.ts:53` checks only that the identifier is a URL. Matching is exact everywhere (`apps/id/src/auth/user-oauth-flow.ts:283-299`). The verifier has no rule on the path (`packages/auth/src/index.ts:83-94`). Path resources already exist: `${id}/api/admin` and `${toolbox}/admin`. A trailing slash makes a different resource.
- **The edge needs one host, added once (read, auditor C).** The edge accepts one more hostname, `mcp`. Its DNS record, its Origin CA certificate and its rule expressions follow from the map (`infra/civo/modules/edge/main.tf:5, 11, 142-159, 177, 201`), and nothing changes per MCP after that. Traefik merges Ingresses that share a host. Not yet proven through Traefik and Cloudflare.

## F4. The database at 200 MCPs (ran, disposable Postgres 17.9, 127.0.0.1:47433, `max_connections` 100)

Both models were run with the admin MCP's real drizzle migrations (the `@answerable/mcp-postgres` base tables and the evidence chain).

| | (a) A database per MCP | (b) One database, a schema per MCP |
| --- | --- | --- |
| Create 200 + 400 logins or roles | 25.7 s | 2.1 s |
| First migration of 200 | 14.2 s | 7.1 s |
| A pass with nothing pending, 200 | 3.2 s | not measured |
| Disk | 7.6 MiB each, 1,511 MiB total | 29.9 MiB total |
| One query to each of 200 MCPs at once, as the Toolbox would | 95 ok, **105 refused** (connection limit), 95 connections | 1,000 queries ok in 302 ms on **10 connections** |
| Cost per query | — | 1.41 ms in a role-switched transaction against 0.50 ms plain (sequential, 2,000) |
| Isolation | Database `CONNECT` privilege | `permission denied for schema s001` from s000's role; the hub login alone refused |

- **(a)'s cold connections:** 10.0 ms each without TLS. A Civo connection adds TLS and SCRAM: not measured.
- **(a) fails at scale because of connections, not disk.** A connection belongs to one database and one login. A Toolbox process that mounts N database-backed MCPs holds N pools, so a burst reaches N × pool size per replica. Auditor C's estimate: 8,000 connections at 200 MCPs, 4 replicas and pg's default pool of 10. Civo's `max_connections` hasn't been measured (`docs/12-deployment.md:127`).
- **(b) keeps the Toolbox at one pool whatever the number of MCPs.** Prototype (ran): a pool-shaped view of one shared `pg.Pool` for each MCP, which takes the MCP's role and search path when a connection is borrowed and resets them on release.
  - Drizzle queries and transactions ran as the MCP's role.
  - A thrown transaction rolled back (0 rows).
  - A cross-schema read was refused.
  - The shared pool stayed at 4 connections.
  - After use, every pooled connection was `hub` again with the default search path.

  Drizzle uses a client as a pool when its constructor name contains `Pool` (`drizzle-orm@0.45.4/node-postgres/session.js:181`).
- **What (b) needs, with no change to (a) (read, auditor C):**
  - `packages/mcp-postgres/src/runtime-role.ts` assumes schemas `public` and `drizzle` (:32-35, 52-60, 98-111), and `migrate.ts:36` fixes `drizzle.__drizzle_migrations`.
  - The base tables are plain `pgTable` (`schema.ts:23-77`), and drizzle-kit writes `REFERENCES "public".…` (`mcps/admin/drizzle/0000_initial.sql:69`).
  - `revoke temporary on database` (`runtime-role.ts:99`) needs the database's owner.
  - `assertRuntimeRole` refuses a login with memberships (:30, 42), which the hub login needs in order to switch role.
  - The chain's advisory lock key `hashtext(organisation_id)` (`sql/evidence-chain.sql:16`) is database-wide, so every MCP would serialise on one key per organisation. Its functions name tables without a schema and pin no `search_path`.
- **drizzle-kit and a named schema (ran).** Tables declared with `pgSchema("acme")` come out fully qualified, foreign keys included. The first migration starts `CREATE SCHEMA "acme";`, with no `IF NOT EXISTS`. Drizzle's migrator runs `CREATE SCHEMA IF NOT EXISTS <migrationsSchema>` (`drizzle-orm/pg-core/dialect.js:54`), and F10 shows that statement is refused to an owner role without `CREATE` on the database. So an MCP's journal is applied by our own loop, in the MCP's schema.

## F5. ID at 200 MCPs (read, auditor D)

- **Scope lists have no item cap.** `allowedScopes` and entitlement `scopes` are `z.array(z.string().min(1)).min(1)` (`resources.ts:47`, `entitlements.ts:58`), stored as `text[]`. The only cap is ID's 256 KiB request body (`request-limits.ts:4`).
- **The Toolbox resource at 200 providers** (5 capabilities in 2 domains each): 1,603 grant strings, roughly 45–78 KB. That reaches the body cap at about 650 providers. Tokens carry only `toolbox`, so they don't grow. `checkScopes` is O(requested × allowed) (`apps/id/src/services/entitlements.ts:221-235`).
- **What grows with enables:** every enable PATCHes the whole list with `If-Match` (`mcps/toolbox/src/admin-enable.ts:49-56`), so concurrent enables get 412. Every update writes the before and after list into ID's audit row.
- **Rows for a standalone MCP:** 3 per MCP (resource, client, link) with its own host client. Per organisation that uses it, 6 more: login and resource capabilities and entitlements (`packages/acceptance/src/admin.ts:50-62`).
- **One client can be linked to many resources** (unique per pair, `oauth.ts:167`). But a shared client is one scope ceiling and one off switch for every MCP (`apps/id/src/services/clients.ts:308-316`).
- **D13's machine client would hold `platform:read platform:write`.** That covers 40 operations, and no narrower scope exists. Nothing stops it minting further clients or rotating secrets (`command-authority.ts:141-143`). It doesn't count toward the root lock (`apps/id/src/db/queries/grants.ts:131-160`). Not verified: a machine principal creating resources and clients.

## F6. Deployment mechanics for a declared list (read, auditor C)

- **The chart can't read `mcps/*`.** A generated `charts/answerable/mcps.json`, read with `.Files.Get … | fromJson` and drift-tested, keeps `helm template`, `infra:check` (`check.ts:212-220`) and `charts.test.ts` working. It must not be named `values-*.yaml`: `check.ts:169-172` would treat it as an environment overlay.
- **Bootstrap and the ops Role** should get the list through the chart (`OPS_DATABASES`), not baked into the ops image, so they always agree (`ops.yaml:26`).
- **One migration Job for every MCP** (weight -9) replaces one hook per database. One MCP's failure fails the release (`deploy.ts:281`), and `activeDeadlineSeconds: 600` (`values.yaml:121`) covers them all.
- **The register Job must become data-driven and run on every deploy.** An existing write counts as done (`register.ts:53-58`), so a changed scope set is never applied: it needs GET, compare, then PATCH with `If-Match`, without ever narrowing the Toolbox resource.
- **Removing an MCP leaves behind:**
  - its database or schema, logins and Secrets;
  - its ID resource and client;
  - the Toolbox catalogue rows and the entitlements.

  Reusing the name later would inherit them, so removal needs a tombstone list.
- **`run-job` checks out main's chart with the deployed images** (`deploy.ts:376-393`). An MCP on main that isn't deployed yet would get a Deployment on an image without it.
- **Not verified:** the Helm release Secret's 1 MiB limit at 200 MCPs.
- **Cost of one Deployment per standalone MCP:** a minimum of 2 replicas × 128 Mi requests is about 50 GiB at 200 MCPs, against staging's 2 × 4 GB nodes. One process serving every standalone MCP by path avoids that.
- **The order on a first deploy:**
  1. ops RBAC (-30);
  2. bootstrap (-20);
  3. `id-migrate` (-10), then the MCP migrations (-9);
  4. the Deployments, with the Toolbox rolling with the new provider;
  5. `--wait`;
  6. register (+10);
  7. smoke.

  Between steps 4 and 6 an MCP is served with no ID resource, which is harmless.
- **The image is identical in staging and production,** so holding an MCP back from production needs a per-environment switch in its declaration.

## F7. What the acceptance kit gives local development (read, auditor D)

- **What it has:**
  - `startId` boots a disposable ID with test company directories (`packages/acceptance/src/id.ts:55-113`);
  - `registerResource`, `registerClient`, `linkClient`, `grantOrganisation` and `registerMachine` (`admin.ts:28-86`);
  - a headless `signIn` (`browser.ts:96`);
  - the lanes print `claude mcp add` (`host-lane.ts:56-72`).
- **What it lacks:**
  - Its ports (47532, 47600) and Compose project name (`answerable-mcp-e2e`) are fixed, so a dev command would collide with an acceptance run.
  - `startToolboxStack` mounts e2e alone (`toolbox.ts:53`).
  - There is no generic way to load `mcps/<name>`.
  - `grantOrganisation` isn't idempotent (`admin.ts:19`).
  - Nothing persists across restarts.
- **What a person needs today:** Docker and Chromium.

## F8a. More probe results (ran)

- **One process, two MCPs.** A Bun process routing `/<id>/…` and `/.well-known/oauth-protected-resource/<id>/mcp` to one `createMcpServer` per MCP served two scaffolded MCPs:
  - each answered `401` at its path, with its own metadata;
  - an unknown MCP got `404`;
  - `/health` answered `200` at the root;
  - the SDK's Host check stayed on: a request to `127.0.0.1` for a `localhost` resource got `403 Invalid Host`.
- **Toolbox boot ingest with 200 providers × 5 tools** (`mcps/toolbox/src/catalogue.ts:24-55`): 1.6 s on the first boot, 1.8 s on an unchanged boot, locally with no network latency. It makes about 2 queries per tool in one transaction, on every replica at every boot; batching it per provider is cheap.
- **`bun mcp` from the root.** `bun mcp new acme --serve toolbox --description "…"` reached a root `mcp` script with the arguments verbatim, and `stdin`/`stdout` `isTTY` were false in the agent's shell. From `mcps/acme`, `bun mcp …` answered `error: Script not found "mcp"`.
- **Production follows staging.** `promote-production.yml` refuses a commit whose images staging didn't build and sign: "staging has not shipped $GITHUB_SHA; tag it staging/<name> first".
- **The scaffold today.** `scripts/mcp-new.test.ts` tests the name rules, the existing-directory refusal and the files written. The docs render the scaffold's files through `scaffoldSources` (`apps/web/components/docs/generated.tsx:16, 47`). The SDK's name and description rules are module constants (`packages/mcp/src/tool.ts:43, 46-53`; `provider.ts:52`), not exports. The conformance check `descriptions_operational` only requires a mutation's description to say "prepare" or "intent" (`packages/mcp/src/conformance.ts:137-141`).

## F9. What ID can tell a tool about its caller (read, 2026-10-25)

- **The resource access token carries ids, not profile data.** Its claims are `subject_type`, `organization_id`, `membership_id`, `grant_id`, `client_instance`, `resource_instance`, `organization_authorization_version`, `authorization_version` and `upstream_auth_time` (`apps/id/src/auth/user-token-boundary.ts:58-71`), plus `sub`, `client_id`, the scopes and the times. `@answerable/auth`'s `UserPrincipal` exposes them (`packages/auth/src/index.ts:17-40`). There is no name, email or organisation name; an ID token leaves out `email` unless it is asked for (`user-oauth.integration.test.ts:3583`).
- **ID's admin API has the rest, under `platform:read`:**
  - `GET /api/admin/v1/organizations/{organizationId}/members/{memberId}` returns `userId`, `email`, `name`, `status`, `membershipStatus`, `validFrom`, `validUntil`, `effective` and `groups` (each `groupId`, `slug`, `name`, `validFrom`, …);
  - `GET /api/admin/v1/organizations/{organizationId}` returns `name`, `slug`, `status` and `authorizationVersion`.
- **The Toolbox already reads the member access view per caller,** cached 60 s (`mcps/toolbox/src/grants.ts:40-51`). Its poller drops entries on `capability.`, `entitlement.`, `group_member.`, `group.`, `member.`, `organization.` and `user.` events (`mcps/toolbox/src/poller.ts:10-12`), which covers every profile change.
- **drizzle-orm 0.45.4 has row-level security:** `pgPolicy` (`pg-core/policies.d.ts:24`) and `enableRLS()` (`pg-core/table.d.ts:22`). Not yet probed with the role-switching pool.

## F10. Postgres facts the briefs rest on (ran on Postgres 17, 2026-10-25)

- **`CREATE SCHEMA IF NOT EXISTS` is refused even when the schema exists.** Run by a role that owns schema `acme` but has no `CREATE` on the database, it answered `ERROR: permission denied for database mcps`. The same role created `acme.notes` and `acme.__drizzle_migrations` without trouble.
- **A `CREATEROLE` login that isn't a superuser can provision,** after a `grant <owner> to current_user`:
  - without it, `create schema beta authorization beta_owner` answered `must be able to SET ROLE "beta_owner"`;
  - with it, the schema, a `NOLOGIN NOINHERIT` runtime role, its `USAGE`, and `grant beta to hub with inherit false, set true` all worked.

  `infra/ops/src/bootstrap.ts:79` already does the same for databases.
- **An unset custom setting reads as `NULL`, a reset one as `''`.** `current_setting('answerable.organisation_id', true)` is `NULL` before any `set_config`, and `''` after `reset answerable.organisation_id`. That is why the policy reads `nullif(…, '')::uuid`.
- **The admin MCP has no tool that creates capabilities** (read). `access.grant`, `access.revoke` and `access.enable` write entitlements only (`mcps/admin/src/access.ts:122, 183-184`). Only the Toolbox's enable operation writes pair capabilities (`mcps/toolbox/src/admin-enable.ts:73`). A standalone MCP therefore needs a `standalone_enable` before an organisation can sign in.
- **Small facts from the review:**
  - the callback-port value is `ops.claudeCallbackPort` (`charts/answerable/values.yaml:134`);
  - `turbo.json`'s `web#build` inputs list `../../scripts/mcp-templates.ts`;
  - the `scripts` workspace has no `bunfig.toml`, so no coverage gate;
  - `migrate()` fixes the journal at `packages/mcp-postgres/src/migrate.ts:36`.

## F8. Related work in flight

- **Typed configuration** (`docs/goals/typed-config/`, approved on 2026-10-21, not started) moves every service's variables onto `@answerable/config` with development defaults in code and generated inventories, `readMcpEnvironment` included. A new MCP's settings should use it rather than add hand-written lines to `default.env`.
