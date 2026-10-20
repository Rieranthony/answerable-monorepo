# Answerable ID

Identity and authorisation service for Answerable. Own-tenant SSO, verified linking, fresh sensitive authority, production user/machine OAuth, repeat-safe administration and terminal product deletion are implemented. ID has never shipped; the [release checklist](../../reports/answerable-id-release-decision-plan.md) lists what production still needs.

## HTTP surface

- Better Auth: `/auth/*` behind an explicit allowlist, including SSO, session routes and production OAuth authorisation-code, refresh and machine grants. The [production OAuth report](../../reports/id-production-oauth.md) describes the reachable routes and policy checks. SSO administration/SAML and provider client-administration routes remain closed; client administration uses the admin API
- Browser pages: `/login`, `/authorize`, `/consent`, `/error` and `/security`, rendered on the server with `hono/jsx` and the shared theme from `packages/ui`; the stylesheet and font are served under `/assets`. The pages call the allowlisted Better Auth routes in-process and use no browser JavaScript
- Admin API: `/api/admin/v1` — caller, organisations, domains, SSO provider, users, sessions, members, groups and group members, clients and their owners/resource links, resources, entitlements, access views and audit events
- Public OpenAPI contract: `/openapi.json` — the reachable routes only; snapshot: `apps/id/openapi.json`
- Admin OpenAPI: `/api/admin/openapi.json` — snapshot: `apps/id/openapi.admin.json`; regenerate both snapshots with `UPDATE_SNAPSHOT=1 bun test src/openapi.integration.test.ts` from `apps/id`
- Liveness: `/healthz` (no database query)
- Readiness: `/readyz` (one `select 1`)

The documented production configuration uses `https://id.answerable.org` as `BETTER_AUTH_URL`; Better Auth's separate `basePath` is `/auth`. Local development keeps `BETTER_AUTH_URL=http://localhost:47300`.

`src/env.ts` validates `Bun.env` once during startup and returns a typed configuration object. `DATABASE_URL` and `BETTER_AUTH_SECRET` are required and produce a named startup error when absent. `BETTER_AUTH_URL` is required in every environment, normally `http://localhost:47300` locally. Trailing slashes are dropped when the environment is read, so the issuer, the pages and the admin audience (`${BETTER_AUTH_URL}/api/admin`) spell it alike. `BETTER_AUTH_TRUSTED_ORIGINS` is a comma-separated browser/IdP origin allowlist (empty when unset); the ID origin itself is always trusted. Production requires non-empty origin-only `BETTER_AUTH_TRUSTED_ORIGINS` (no path or trailing slash) and `TRUSTED_PROXY_CIDRS`. The OpenAPI routes are served outside production only. `DATABASE_POOL_MAX` defaults to 20. Every connection runs with a 10-second statement timeout, a 2-second lock timeout and a 15-second idle-in-transaction timeout; these, the pool's timeouts, the operational log and sweep intervals and the platform organisation's slug (`answerable`) and name (`Answerable`) are constants in `src/env.ts`, each with its reason. `GOOGLE_CLIENT_ID` with `GOOGLE_CLIENT_SECRET` and `MICROSOFT_CLIENT_ID` with `MICROSOFT_CLIENT_SECRET` configure the platform applications. Each pair must be supplied together or omitted together. Their secrets stay in the environment, never in platform SSO rows. Variables declare their defaults in the same schema; see [`.env.example`](../../.env.example).

**Ingress admission.** The service must be reachable only through the ingress proxies listed in `TRUSTED_PROXY_CIDRS` (comma-separated IPv4/IPv6 networks). Network rules must refuse traffic that does not arrive through those proxies. The ingress supplies `x-forwarded-for`; Better Auth walks it from the right, skips listed proxies and selects the first untrusted address. The same resolver supplies rate-limit keys, session IPs and administrative/sign-in audit IPs. In production, unresolved addresses on `/auth/*` and `/api/admin/*` receive `403 {"error":"untrusted_ingress"}`, `Cache-Control: no-store` and a request ID before authentication, with no audit event. Health and readiness remain reachable. The header resolver cannot verify the socket peer; the network restriction is required.

## Commands

The [operations runbook](OPERATIONS.md) covers the runtime bounds, the log signals and the keys ID holds. The [deployment guide](../../docs/06-deploying-answerable-id.md) explains what a production deployment needs and why; Answerable's own topology and secret delivery are in [`docs/12`](../../docs/12-deployment.md), operated with [the infrastructure runbook](../../infra/README.md).

From the repository root:

```bash
bun install
docker compose up -d --wait postgres
bun --env-file=.env run --filter @answerable/id db:migrate
bun --filter @answerable/id db:test:migrate
bun --filter @answerable/id typecheck
bun --filter @answerable/id lint
bun --filter @answerable/id build
bun --filter @answerable/id test
```

**Stylesheet.** The pages serve a prebuilt stylesheet and never compile it. `scripts/build-css.ts` writes it next to the module that serves it: `dev` and the test preload write `src/http/pages/tailwind.css` (ignored by git), `build` writes `dist/tailwind.css`, so `dist` runs without `node_modules`.

**Local PostgreSQL.** `docker-compose.yml` runs PostgreSQL 17 (`postgres:17-alpine`), the version every environment runs. A data volume made by the earlier `postgres:16-alpine` does not start on 17: run `bun run env:reset` once, then `bun run env:up`, which recreates the databases and logins from `infra/postgres/init`. The reset deletes local data.

**First run.** Copy `.env.example` to `.env`, start PostgreSQL and run `db:migrate` with that environment loaded. First-volume initialisation creates the unprivileged local `answerable_id_runtime` login, and the Toolbox's and the admin MCP's runtime logins; migration grants their runtime permissions. Existing volumes need those logins created by the database administrator using `infra/postgres/init/002-create-runtime-role.sql` and `005-create-mcp-runtime-roles.sql`. Set `ROOT_ADMIN_SECRET`, start the service (the platform organisation, admin resource and admin group are seeded and bound by immutable IDs at boot), then with the root bearer add the platform domain and SSO provider, sign in once, and add yourself to the `platform-admins` group; root locks itself afterwards. Removing the last platform administrator through membership, group or capability changes is allowed. Recover with the root secret and `ROOT_ADMIN_BREAK_GLASS=true`. Global user disable and erasure retain their last-writer safeguard.

**Upstream tokens.** ID stores no upstream token. Sign-in asks a directory for `email openid profile` unless its SSO row names other scopes, so not for `offline_access`, and the account's `refresh_token` column stays null even when a directory returns one (`src/auth/answerable-schema.ts`). The directory re-check `Q-AID-RECHECK` in the [plan](../../docs/02-plan.md#open-register) would need a stored token: Not yet.

**Initial installation.** ID has never shipped to production. Two migrations install the complete schema in one transaction:

- `drizzle/0000_initial.sql` is untouched drizzle-kit output from `src/db/schema/index.ts`: tables, columns, constraints, indexes, policies and RLS.
- `drizzle/0001_invariants.sql` is reviewed by hand. It holds what drizzle-orm 0.45.2 cannot express: the deferrable audit-to-operation foreign key, `NULLS NOT DISTINCT` on two partial unique indexes, the custom functions and triggers, and the execution grants.

Bootstrap establishes the platform binding once; repeated migration and startup preserve it. The first start provisions the platform organisation, admin resource, `platform-admins` group, its entitlement and the platform capability. Every later start verifies the binding, refuses a changed admin resource identifier (a changed `BETTER_AUTH_URL`) and restores only the admin resource's name, token lifetime and scopes, which the admin API cannot change; the organisation's name, the group, the entitlement and the capability belong to operators, and a removed capability stays removed. `bootstrap.applied` is recorded only when a start created or changed something. There is no development-database upgrade or binding-import command. Use an empty database for this baseline; non-disposable data requires a separate reviewed recovery plan.

**Changing the schema before production.** Edit the schema modules, and `0001_invariants.sql` for a function, trigger or grant. Run `bun --filter @answerable/id db:regenerate`, recreate existing databases, then run the tests. The script empties `drizzle/`, has drizzle-kit write `0000_initial.sql` and an empty custom `0001_invariants.sql`, and puts the invariants back. Without a schema change it leaves the folder as it was. Delete the script after the first production migration (at the first staging deploy, brief B7a, whose receipts must survive); from then on `db:generate` adds forward migrations and an applied file never changes.

`db:generate` generates migrations in `apps/id/drizzle` without a database connection. `db:migrate` applies committed migrations to `DATABASE_MIGRATION_URL`, then provisions permissions for `DATABASE_RUNTIME_ROLE` (default `answerable_id_runtime`). Its connection waits at most 5 s for a lock and 5 minutes per statement ([why](../../docs/06-deploying-answerable-id.md#install)). `db:test:migrate` drops the `public` and `drizzle` schemas, recreates `public`, and applies the committed migrations. The reset script refuses any database whose name is not exactly `answerable_id_test`; data in that explicitly disposable database is not recoverable after a run.

**Receipt check.** Drizzle's migrator records each applied file's hash and journal time but compares neither, and skips every file not newer than the last receipt: an edited applied file would be ignored silently, and a regenerated one would run again. Before applying anything, migration compares the receipts with the files in order and refuses, naming the file, when one changed or disappeared.

**Migration proofs.**

- `src/db/migrations.test.ts`: the last snapshot matches the schema modules.
- `src/db/migrations.integration.test.ts`: the committed migrations, and `generateMigration(empty, schema)` followed by `0001_invariants.sql`, each build the schema inside a rolled-back transaction. Postgres' catalogue of the two must match: tables, columns, defaults, constraints, index definitions, functions with their grants, triggers, policies, RLS flags and foreign-key deferral.
- A fresh install: `db:test:migrate`, which `bun --filter @answerable/id test` runs first, migrates the empty `answerable_id_test` database, and every integration test runs on the result.
- `src/db/migrate-script.integration.test.ts`: `scripts/migrate.ts` on the migrated test database applies nothing; `src/db/migrate.integration.test.ts`: an edited or regenerated applied file is refused.

Coverage thresholds require 100% of application lines and functions. Tests, fixtures, generated output, and the composition-only `src/server.ts` process entry are excluded; its runtime behavior lives in the fully tested `src/runtime.ts`.

## Database roles

Run migrations and permission provisioning with a separate schema-owner connection. From `apps/id`, with `DATABASE_MIGRATION_URL` loaded:

```bash
bun scripts/migrate.ts
```

Migration includes permission provisioning. Local first-volume initialisation supplies the runtime login with password `answerable`. For deployments, the provisioner creates a role without login credentials, or validates an existing unprivileged role, and configures its permissions transactionally. Enable LOGIN on that role itself and supply its password through deployment tooling. Set the application's `DATABASE_URL` to this runtime login. Do not pass the migration credentials to the application. `db:migrate` provisions after every run, so tables a migration adds receive the same permissions.

The runtime can read and write eligible application rows, consume protocol records, insert audit events and create the initial system binding. It cannot DELETE/TRUNCATE product rows or grant contexts; deletion uses terminal tombstones and credential clearing/revocation, and a grant is only ever revoked. It cannot update/delete audit events, write `audit_event_users`, alter the system binding or completed operation reservations, truncate tables, create public-schema objects, create temporary tables, update or delete signing keys, or update client-assertion replay markers. Owner-executed triggers record the users each event concerns in the same transaction.

Every non-test startup checks role attributes, memberships, ownership and protected-object permissions before bootstrap or listening. An unsafe role fails startup and closes the pool. Auth/app construction or listen failures also close that pool before propagating the startup error. Development uses the restricted runtime login in `.env.example`; migrations keep the separate owner connection. These permissions restrict the application credential; database owners and backup administrators remain trusted. Targeted tenant RLS is implemented; intended-environment proof remains in the external checklist.

## Application-secret rotation

`BETTER_AUTH_SECRET` remains required as the legacy decryption secret. Optional `BETTER_AUTH_SECRETS` uses the provider's native comma-separated `version:secret` format: the first entry is active and remaining entries decrypt retained versions. Versions must be distinct non-negative safe integers; every secret must contain at least 32 characters. Generate independent high-entropy values. Invalid configuration fails without printing values. Startup decrypts the newest stored signing key with the configured secrets and refuses to listen when it cannot (`SigningKeyCustodyError`), so a wrong secret fails the rollout instead of every issuance.

For an existing installation, stage a ring whose first entry has the existing secret value, retaining the new secret as a later entry. After all instances have the staged configuration, coordinate promotion of the new first entry. **Promotion requires users to sign in again:** Better Auth 1.7.2 verifies ordinary browser cookies with the active secret only. Drain in-flight authentication callbacks and avoid serving different active versions across replicas. This is not seamless rolling session rotation. Changing configuration does not delete the stored sessions or revoke already-issued JWTs.

Keep the original singular secret while legacy ciphertext remains. Adding the ring does not rewrite existing private keys. Newly generated signing keys use versioned encryption; previous keys remain readable with retained versions. Do not remove a version until all dependent ciphertext and retained backups have been accounted for. Removing a required version fails signing rather than replacing its key. Retiring any required decryption key needs retained-data/backup evidence. Automatic rewrapping is not implemented. Emergency signing-key rotation, production secret delivery and post-snapshot recovery require the intended-environment rehearsal.

The integration test proves staged cookie continuity, cookie refusal after promotion, fresh native SSO accepted only by the promoted active version, legacy signing continuity, a provider-generated key under the active version when none is stored, retained-version signing and refusal when that version is removed. The server-only signing API used in this proof does not open a public JWT endpoint. See [the custody evidence](../../reports/answerable-id-upstream-token-custody.md#application-secret-rotation).

## Boundaries

- Public discovery and `/auth/jwks` describe production code/refresh/machine grants. Login-only access is opaque; resource access uses signed audience-bound JWTs. [OAuth guide](../web/content/docs/id/oauth.mdx).
- One server-bound flow fixes tenant/client/resource/consent. Every new flow requests consent except explicit first-party bypass. Every exchange and refresh rechecks current policy before native issuance; token persistence and user audit commit together. A reused rotated refresh token revokes its family.
- Human tenant authority requires that tenant's current SSO. Sensitive commands/linking require five-minute verified upstream freshness, checked before replay and again after the command's waits. Unknown upstream time stays unknown.
- RLS protects ten tables with transaction-local scopes; administrative contexts and trusted native broker checks remain necessary. Native adapter transactions and standalone membership operations use protocol scope; routing reads and audit inserts are available without scope. [Isolation inventory](../../reports/answerable-id-isolation-inventory.md).
- Every administrative mutation is journalled with a permanent reservation, under the caller's `Idempotency-Key` or, without one, a server key; a retry with the same key returns the receipt. [Mutation inventory](../../reports/answerable-id-mutation-inventory.md).
- Ordinary browser sign-out can preserve refresh delegation. Administrative revocation, offline JWT expiry and downstream session termination are separate contracts.
- DCR/CIMD, introspection, PAR, device flow, OIDC logout, bounded directory polling and downstream logout delivery are not implemented. Real Entra/OmniChat/Claude and deployment acceptance remain open.

## Product deletion

Fourteen product tables use terminal `deletedAt` ([the list](../../docs/04-answerable-id-schema.md#soft-deletion)). Ordinary reads and eligibility exclude deleted rows; credential material is cleared/revoked and grant contexts retain revocation. Product data, UUID audit and command recovery remain. This is not anonymisation. Physical product purge jobs and their duration are deferred; no named-identity recovery feature is required.

Explicit membership reinstatement remains supported for revoked, undeleted memberships and never restores removed assignments or revoked grants. Organisation deletion preserves global people/sessions and clears tenant selection. See [soft deletion](../../docs/04-answerable-id-schema.md#soft-deletion) and the [deletion table](../web/content/docs/id/manage.mdx#deletion-and-retained-data).
