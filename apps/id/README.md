# Answerable ID

Identity and authorisation service for Answerable. Own-tenant SSO, verified linking, fresh sensitive authority, production user/machine OAuth, repeat-safe administration and terminal product deletion are implemented. ID has never shipped; see the [local acceptance](../../reports/id-release-acceptance.md) and [production no-go conditions](../../reports/answerable-id-release-decision-plan.md).

## HTTP surface

- Better Auth: `/auth/*` behind an explicit allowlist, including SSO, session routes and production OAuth authorisation-code, refresh and machine grants. The [production OAuth report](../../reports/id-production-oauth.md) describes the reachable routes and policy checks. SSO administration/SAML and provider client-administration routes remain closed; client administration uses the admin API
- Admin API: `/api/admin/v1` — caller, organisations, domains, SSO provider, users, sessions, members, groups and group members, clients and their owners/resource links, resources, entitlements, access views and audit events
- Public OpenAPI contract: `/openapi.json` — the reachable routes only; snapshot: `apps/id/openapi.json`
- Admin OpenAPI: `/api/admin/openapi.json` — snapshot: `apps/id/openapi.admin.json`; regenerate both snapshots with `bun run openapi:export`
- Admin docs: `/api/admin/docs` in development and test only
- Liveness: `/healthz` (no database query)
- Readiness: `/readyz` (one `select 1`)

The documented production configuration uses `https://id.answerable.org` as `BETTER_AUTH_URL`; Better Auth's separate `basePath` is `/auth`. Local development keeps `BETTER_AUTH_URL=http://localhost:47300`.

`src/env.ts` validates `Bun.env` once during startup and returns a typed configuration object. `DATABASE_URL`, `BETTER_AUTH_URL`, and `BETTER_AUTH_SECRET` are required and produce a named startup error when absent. `BETTER_AUTH_TRUSTED_ORIGINS` is a comma-separated browser/IdP origin allowlist (defaults to `AUTH_PAGES_URL` when unset), and `AUTH_PAGES_URL` is the absolute login/consent-page origin (default `http://localhost:47100`). Production requires explicit `AUTH_PAGES_URL`, non-empty origin-only `BETTER_AUTH_TRUSTED_ORIGINS` (no path or trailing slash) and `TRUSTED_PROXY_CIDRS`. `OPENAPI_ENABLED` defaults to false in production and true otherwise, with an explicit override. `DATABASE_POOL_MAX` defaults to 20 (1 in tests). Pool startup settings apply `DATABASE_STATEMENT_TIMEOUT_MS=10000`, `DATABASE_LOCK_TIMEOUT_MS=2000` and `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS=15000` to every connection. Runtime settings declare their defaults in the same schema; see [`.env.example`](../../.env.example).

**Ingress admission.** The service must be reachable only through the ingress proxies listed in `TRUSTED_PROXY_CIDRS` (comma-separated IPv4/IPv6 networks). Network rules must refuse traffic that does not arrive through those proxies. The ingress supplies `x-forwarded-for`; Better Auth walks it from the right, skips listed proxies and selects the first untrusted address. The same resolver supplies rate-limit keys, session IPs and administrative/sign-in audit IPs. In production, unresolved addresses on `/auth/*` and `/api/admin/*` receive `403 {"error":"untrusted_ingress"}`, `Cache-Control: no-store` and a request ID before authentication, with no audit event. Health and readiness remain reachable. The header resolver cannot verify the socket peer; the network restriction is required.

**Request admission.** `MAX_CONCURRENT_REQUESTS` bounds active handlers per application instance (one per service process), default 64; it must be a positive safe integer. Admission includes body acquisition, authentication and handler work. Excess requests are not queued: they receive plain-text `503 Service Busy`, `Retry-After: 1`, `Cache-Control: no-store` and a request ID before authentication or database work. Rejected bodies are cancelled without waiting for cancellation cleanup. Only bodyless GET/HEAD `/healthz` bypasses the limit; readiness participates and may report overload. Do not use liveness as an overload signal.

**Public authentication admission.** `/auth/*` requests now share a pre-body, pre-credential concurrency bound across app and Drizzle wrappers using the same PostgreSQL pool. The bound is `max(1, actual pool maximum − 1)`: a pool with at least two connections admits fewer authentication requests than its connection count. A one-connection pool still accepts one authentication request. This counts handlers, not individual connection checkouts. Excess requests receive the existing plain-text `503 Service Busy`, `Retry-After: 1`, `Cache-Control: no-store` and request ID; their body is cancelled and the provider is not called. Capacity remains held until the handler and its audit work finish, including after disconnect. Admitted token failures retain their usual rejection audit; requests refused before authentication create no token-attempt event. This does not identify a tenant from an unverified claim, allocate a dedicated database connection, bound admin-route authentication or provide cluster-wide rate limits. Other work can still consume shared connections; legitimate authentication can be refused when this lane is occupied.

**Shared machine issuance admission.** After client authentication and current identity/policy locks, the token endpoint admits at most two concurrent machine issuance transactions per immutable owner organisation across instances using the same PostgreSQL database. All that organisation's clients share the two slots. A full tenant receives OAuth JSON `503 temporarily_unavailable` with `Retry-After: 1`; rejected issuance records its authenticated client/tenant through the existing failure-audit path. Retry with fresh client authentication, including a new assertion where applicable. Slots cover policy evaluation, signing and successful audit commit and release with the transaction. The fixed limit avoids configuration drift between replicas; all replicas must run the enforcing version before claiming the deployment-wide bound. Two is an initial conservative limit, not a benchmark-derived capacity target. This adds no queue or lease table. It does not bound authentication queries, policy-lock waits, connection checkout, failure-audit work, administrative/user flows or unauthenticated rates; it does not establish overall tenant fairness.

A slot is released when the handler finishes, including errors. Disconnecting a client does not free capacity while its handler continues. Retry with backoff; keep the same idempotency key and input for an administrative command. This early transport refusal can precede CORS headers. It is not a per-tenant/IP rate limit, cross-replica quota, TCP connection limit, total request deadline or bound on future streaming-response lifetime. Tune the default using production capacity evidence; the implementation does not claim that 64 is a measured optimum.

## Commands

The [operations runbook](OPERATIONS.md) covers process summaries, the finite mixed
capacity workload, read-only custody checks and recovery with known post-snapshot
gaps. It lists the production inputs that remain unknown.

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

**First run.** Copy `.env.example` to `.env`, start PostgreSQL and run `db:migrate` with that environment loaded. First-volume initialisation creates the unprivileged local `answerable_id_runtime` login; migration grants its runtime permissions. Existing volumes need that login created by the database administrator using `infra/postgres/init/002-create-runtime-role.sql`. Set `ROOT_ADMIN_SECRET`, the dedicated `OPERATION_REPLAY_CONFIG` keys and `UPSTREAM_TOKEN_SECRETS` described below, start the service (the platform organisation, admin resource and admin group are seeded and bound by immutable IDs at boot), then with the root bearer add the platform domain and SSO provider, sign in once, and add yourself to the `platform-admins` group; root locks itself afterwards.

**Upstream token storage.** `UPSTREAM_TOKEN_SECRETS` is a JSON array such as `[{"version":1,"value":"<canonical-base64url-encoded random 32-byte key>"}]`. Versions are distinct positive integers; the first key encrypts new values and all listed keys can decrypt their own versions. Keep these keys outside PostgreSQL and separate from authentication/signing and operation-replay secrets. Invalid supplied configuration stops environment loading without echoing values. The provider's supported account transforms encrypt access, refresh and ID tokens; the provider's separate access/refresh flag stays disabled to avoid double encryption. Missing keys, plaintext, unversioned legacy encryption and damaged ciphertext are refused. Null imported credentials remain valid. A missing key during native SSO produces safe `500 authentication_unavailable` and rolls back that attempt's identity/session writes.

**Rotation.** First distribute a new key to every instance while leaving the old version first; only then promote the new version to first. Never reuse a version number for different key material. Retain old keys until every surviving token field and required backup can be read without them. See the [operations runbook](OPERATIONS.md) for custody and recovery checks.

**Initial installation.** ID has never shipped to production. `drizzle/0000_initial.sql` installs the complete schema, including the custom security functions, triggers, RLS and privilege restrictions. It has one generated initial snapshot and one journal entry. Bootstrap establishes the platform binding once; repeated migration and startup preserve it. There is no development-database upgrade or binding-import command. Use an empty database for this baseline; non-disposable data requires a separate reviewed recovery plan.

`db:generate` generates migrations in `apps/id/drizzle` without a database connection. `db:migrate` applies committed migrations to `DATABASE_MIGRATION_URL`, then provisions permissions for `DATABASE_RUNTIME_ROLE` (default `answerable_id_runtime`). `db:test:migrate` drops the `public` and `drizzle` schemas, recreates `public`, and applies the committed migrations, so the catalogue contract test guards them. The reset script refuses any database whose name is not exactly `answerable_id_test`; data in that explicitly disposable database is not recoverable after a run.

**Migration failure rehearsal.** `bun --filter @answerable/id test:migrations` uses only the explicitly disposable `answerable_id_test` database. It checks statement rollback, SIGKILL before and after commit, retry, concurrent bootstrap and repeated migration against the committed catalogue and receipts. It finishes with a clean migrated schema. Run it separately from database tests and restore; CI runs it before coverage. See the [consolidation evidence](../../reports/id-initial-migration.md).

**Disposable restore rehearsal.** With local Compose PostgreSQL running and the test schema migrated, run `bun --filter @answerable/id test:restore` from the repository root. Run it separately from database tests and local test processes. It creates synthetic fixtures in `answerable_id_test`, verifies that Compose and the application see the same fixture UUID, and takes a PostgreSQL custom-format dump. It refuses non-local/default-port source targets.

Restore runs in a new temporary cluster using the source container's exact local image ID, with no image pull, persistent data volume or public listener. The target uses a temporary filesystem and random loopback port. The proof checks a different PostgreSQL system identifier, rebuilds the missing runtime role/permissions using the production provisioner, and requires newly supplied login credentials. It restores encrypted tokens, sessions, migration receipts, real command responses and audit subjects. Missing keys fail safely, purged responses cannot rerun a command, and revoked tenant B stays blocked while A can sign in. Keys remain separate from the archive. Signing recovery independently verifies pre-backup and new machine tokens with the original public key; the retained application secret resumes signing without replacing keys. Wrong application-secret custody returns `500 authentication_unavailable` without a successful issuance fact. This does not test managed key rotation or production secret delivery. A newly provisioned retention login is checked against restored data: direct payload reads, reservation deletion and forged audit writes are refused; an audit failure rolls back purging; bounded expiry cleanup preserves fresh responses and permanent reservations. The rehearsal also starts the actual production-mode runtime in child processes: the owner login is refused before listening; two restricted-login starts preserve platform bindings, revisions and capability ceilings, serve health/readiness and recover the restored browser session. This uses supplied configuration and a loopback listener, not production ingress or environment distribution.

CI runs this after coverage. The temporary cluster/archive and source live identities/runtime role are removed on normal completion or handled failure. Permanent test audit, operation and identifier records remain until the disposable schema is reset. It is a local recovery proof, not a production restore procedure: remote backup storage, production maintenance scheduling/signing-key custody, post-snapshot revocation/replay reconciliation, capacity and recovery objectives still need rehearsal. See the [restore evidence](../../reports/answerable-id-upstream-token-custody.md#populated-postgresql-restore-proof).

Coverage thresholds require 100% of application lines and functions. Tests, fixtures, generated output, and the composition-only `src/server.ts` process entry are excluded; its runtime behavior lives in the fully tested `src/runtime.ts`.

## Database roles

Run migrations and permission provisioning with a separate schema-owner connection. From `apps/id`, with `DATABASE_MIGRATION_URL` loaded:

```bash
bun scripts/migrate.ts
```

Migration includes permission provisioning. Local first-volume initialisation supplies the runtime login with password `answerable`. For deployments, the provisioner creates a role without login credentials, or validates an existing unprivileged role, and configures its permissions transactionally. Enable LOGIN on that role itself and supply its password through deployment tooling. Set the application's `DATABASE_URL` to this runtime login. Do not pass the migration credentials to the application. Rerun permission provisioning after migrations add tables.

The runtime can read and write eligible application rows, consume protocol records, insert audit events and create the initial system binding. It cannot DELETE/TRUNCATE product rows; deletion uses terminal tombstones and credential clearing/revocation. It cannot update/delete audit events, write audit subjects or identifier reservations directly, alter the system binding or completed operation reservations, truncate tables or create public-schema objects. Owner-executed triggers capture subjects and reserve identifiers atomically; direct invocation of the subject-capture function is revoked.

Every non-test startup checks role attributes, memberships, ownership and protected-object permissions before bootstrap or listening. An unsafe role fails startup and closes the pool. Auth/app construction or listen failures also close that pool before propagating the startup error. Development uses the restricted runtime login in `.env.example`; migrations keep the separate owner connection. These permissions restrict the application credential; database owners and backup administrators remain trusted. Targeted tenant RLS and the separate bounded retention function are implemented; production scheduling and intended-environment proof remain in the external checklist.

## Application-secret rotation

`BETTER_AUTH_SECRET` remains required as the legacy decryption secret. Optional `BETTER_AUTH_SECRETS` uses the provider's native comma-separated `version:secret` format: the first entry is active and remaining entries decrypt retained versions. Versions must be distinct non-negative safe integers; every secret must contain at least 32 characters. Generate independent high-entropy values. Invalid configuration fails without printing values. Keep these secrets separate from `UPSTREAM_TOKEN_SECRETS` and `OPERATION_REPLAY_CONFIG`.

For an existing installation, stage a ring whose first entry has the existing secret value, retaining the new secret as a later entry. After all instances have the staged configuration, coordinate promotion of the new first entry. **Promotion requires users to sign in again:** Better Auth 1.7.2 verifies ordinary browser cookies with the active secret only. Drain in-flight authentication callbacks and avoid serving different active versions across replicas. This is not seamless rolling session rotation. Changing configuration does not delete the stored sessions or revoke already-issued JWTs.

Keep the original singular secret while legacy ciphertext remains. Adding the ring does not rewrite existing private keys. Newly generated signing keys use versioned encryption; previous keys remain readable with retained versions. Do not remove a version until all dependent ciphertext and retained backups have been accounted for. Removing a required version fails signing rather than replacing its key. Retiring any required decryption key needs retained-data/backup evidence. Automatic rewrapping is not implemented. Emergency signing-key rotation, production secret delivery and post-snapshot recovery require the intended-environment rehearsal.

The integration test proves staged cookie continuity, cookie refusal after promotion, fresh native SSO accepted only by the promoted active version, legacy signing continuity, provider-generated versioned keys after simulated expiry, retained-version signing and refusal when that version is removed. The server-only signing API used in this proof does not open a public JWT endpoint. See [the custody evidence](../../reports/answerable-id-upstream-token-custody.md#application-secret-rotation).

## Replay keys and retention

`OPERATION_REPLAY_CONFIG` is a JSON object with `activeKeyId` and `keys`, a map from key IDs to canonical base64url-encoded random 32-byte keys. Supply it through deployment secret storage, independently of `BETTER_AUTH_SECRET`. It is required for every administrative mutation; without it these routes return 503 before changing state. Invalid configuration stops environment loading without echoing key values. New results use the active key; retain prior keys until their live replay windows have closed. Backups and key retirement need their own retention policy.

Provision the maintenance role using `DATABASE_MIGRATION_URL`, from `apps/id`:

```bash
bun scripts/configure-retention-role.ts answerable_id_retention
```

Enable LOGIN on the retention role and provision credentials separately. Give only the maintenance process its `DATABASE_RETENTION_URL`. It has no table read/write privileges; it can invoke the fixed purge function. The application runtime cannot invoke that function.

```bash
bun scripts/purge-operation-results.ts
```

Each invocation deletes at most 1,000 expired ciphertext rows, using database time and skipping rows another purge holds. It records the removed operation IDs and count atomically in `operation.results_purged`. Audit failure restores the deleted ciphertext. Empty runs make no audit event. Permanent operation reservations are never removed, so a purged result cannot cause a command to run again.

Schedule this command in deployment operations, and repeat when a batch reaches 1,000. Physical deletion occurs when the job runs; the replay deadline is enforced independently. No production schedule has been installed by this change. Reapply role provisioning after migrations. Do not give runtime processes the migration or retention credentials.

## Boundaries

- Public discovery and `/auth/jwks` describe production code/refresh/machine grants. Login-only access is opaque; resource access uses signed audience-bound JWTs. [OAuth guide](../web/content/docs/id/oauth.mdx).
- One server-bound flow fixes tenant/client/resource/consent. Every new flow requests consent except explicit first-party bypass. Native replay rechecks current policy; actual token output, persistence and user audit commit together.
- Human tenant authority requires that tenant's current SSO. Sensitive commands/linking require five-minute verified upstream freshness, including replay and post-lock checks. Unknown upstream time stays unknown.
- RLS protects eleven tables with transaction-local scopes; administrative contexts and trusted native broker checks remain necessary. Native adapter transactions and standalone membership operations use protocol scope; routing reads and audit inserts are available without scope. [Isolation inventory](../../reports/answerable-id-isolation-inventory.md).
- All 49 mutations use current-authority replay, permanent reservations and appropriate revision preconditions. [Mutation inventory](../../reports/answerable-id-mutation-inventory.md).
- Ordinary browser sign-out can preserve refresh delegation. Administrative revocation, offline JWT expiry and downstream session termination are separate contracts.
- DCR/CIMD, introspection, PAR, device flow, OIDC logout, bounded directory polling and downstream logout delivery are not implemented. Real Entra/OmniChat/Claude and deployment acceptance remain open.

## Product deletion

Fifteen product tables use terminal `deletedAt`. Ordinary reads and eligibility exclude deleted rows; credential material is cleared/revoked and grant contexts retain revocation. Product data, UUID audit and command recovery remain. This is not anonymisation. Physical product purge jobs and their duration are deferred; no named-identity recovery feature is required.

Explicit membership reinstatement remains supported for revoked, undeleted memberships and never restores removed assignments or revoked grants. Organisation deletion preserves global people/sessions and clears tenant selection. See [deletion effects](../../reports/id-soft-deletion.md) and [operations](OPERATIONS.md).
