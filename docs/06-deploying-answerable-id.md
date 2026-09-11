# Deploying Answerable ID

> **TL;DR**
> - **Decides:** what a production deployment of `apps/id` needs, in what order, and why each piece exists.
> - **Rule:** the service is reachable only through the ingress proxies you list; the application never runs as the database owner; every secret family is independent and lives outside Postgres.
> - **Not here:** the design (`03-answerable-id.md`), the schema (`04-answerable-id-schema.md`), day-two operations (`../apps/id/OPERATIONS.md`), the release gate (`../reports/answerable-id-release-decision-plan.md`).

Everything below is derived from the code on this branch: `apps/id/src/env.ts` (configuration), `apps/id/src/runtime.ts` (startup checks), `apps/id/src/db/runtime-role.ts` and `apps/id/scripts/migrate.ts` (database roles), `apps/id/src/app.ts` (ingress admission), `apps/id/src/auth.ts` (provider configuration). If the code and this page disagree, the code wins; fix the page.

## What runs

| Component | What it is | Notes |
| --- | --- | --- |
| `apps/id` | One Bun process serving the OAuth/OIDC provider, the admin API, health and discovery on `PORT` (default 47300) | Stateless apart from per-process rate-limit buckets and a five-minute JWKS cache, so replicas are fine |
| `apps/web` | Next.js site hosting the login, consent and authorise pages under `app/(auth)/` plus the docs | Needs `NEXT_PUBLIC_ID_URL` at **build** time; its origin is ID's `AUTH_PAGES_URL` |
| PostgreSQL 16 | The only state: users, sessions, native OAuth state, policy, audit, command receipts | Local compose uses `postgres:16-alpine`; production needs your own instance with backups |
| Ingress | TLS termination and the `x-forwarded-for` header | The **only** network path to `apps/id`; see the first requirement below |
| Redis | Reserved for later caching | Not used by `apps/id` today; do not provision it for ID |

## Requirements and why they exist

| Requirement | Why | Enforced by |
| --- | --- | --- |
| `apps/id` reachable only through the proxies in `TRUSTED_PROXY_CIDRS` | Better Auth's rate limiter and every audit row key on the client address. The address is taken from `x-forwarded-for`, walking from the right and skipping listed proxies. A request that reaches the process directly has no trustworthy address; in production it is refused with `403 untrusted_ingress` before authentication | `src/app.ts` ingress check; `src/env.ts` requires the variable in production |
| The application's `DATABASE_URL` is an unprivileged login, never the owner | Row-level security does not apply to the table owner. Eleven tables rely on it for tenant isolation, and audit rows are immutable only because the runtime role cannot update or delete them. Startup refuses an owner or privileged role in every environment except `NODE_ENV=test` | `src/runtime.ts` calls `assertRuntimeRole` before listening |
| A separate schema-owner login for migrations | DDL, functions, triggers and policies need ownership; the same run provisions the runtime role's permissions so the two never drift | `scripts/migrate.ts` migrates with `DATABASE_MIGRATION_URL`, then runs `configureRuntimeRole` for `DATABASE_RUNTIME_ROLE` |
| `BETTER_AUTH_URL` is the public issuer origin, `https://` | It becomes the JWT `iss`, the discovery document and the default admin audience (`${BETTER_AUTH_URL}/api/admin`). Changing it invalidates every issued token | `src/env.ts`, `src/auth.ts` |
| `AUTH_PAGES_URL` set explicitly, and listed in `BETTER_AUTH_TRUSTED_ORIGINS` as an origin only | Users are redirected there for login and consent; cookie-authenticated calls are accepted only from trusted origins (CSRF). The localhost default is refused in production | `src/env.ts` production refinements |
| Three independent secret families | `BETTER_AUTH_SECRET` signs browser cookies and encrypts the stored JWKS private keys; `UPSTREAM_TOKEN_SECRETS` encrypts the upstream IdP tokens stored on accounts; `ROOT_ADMIN_SECRET` is the break-glass principal. Compromise of one must not expose the others, and none may be in the database or its backups | `src/env.ts` validation; `src/auth/upstream-token-storage.ts` |
| `NODE_ENV=production` | Turns on the provider's rate limiter, the runtime-role assertion, the production refinements above and turns off the OpenAPI documents | `src/env.ts`, Better Auth defaults |
| PostgreSQL `max_connections` ≥ replicas × `DATABASE_POOL_MAX` + migration and operator sessions | Each replica opens up to `DATABASE_POOL_MAX` connections (default 20). Exhausting the server turns every request into a `database_busy` 503 | `src/db/client.ts` |

## Configuration

Required in production. Generate secrets on a machine you trust and deliver them through your secret store; nothing here reads a file.

```bash
# 32 random bytes, canonical base64url (43 characters, no padding)
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
# 48 random bytes for the application and root secrets
openssl rand -base64 48
```

| Variable | Value | Why |
| --- | --- | --- |
| `NODE_ENV` | `production` | See above |
| `PORT` | listener port, default 47300 | Ingress upstream |
| `BETTER_AUTH_URL` | `https://id.answerable.org` | Issuer, discovery, admin audience |
| `AUTH_PAGES_URL` | origin of the deployed `apps/web` | Login and consent pages |
| `BETTER_AUTH_TRUSTED_ORIGINS` | comma-separated origins, at least `AUTH_PAGES_URL`; no paths, no trailing slash | CORS and CSRF for cookie calls |
| `TRUSTED_PROXY_CIDRS` | comma-separated IPv4/IPv6 networks of the ingress proxies | Client address resolution |
| `DATABASE_URL` | `postgres://answerable_id_runtime:…@host/answerable_id` | Application connection, restricted role |
| `DATABASE_MIGRATION_URL` | owner login, used only by `db:migrate` runs you start by hand; never given to the service | DDL and permission provisioning |
| `DATABASE_RUNTIME_ROLE` | `answerable_id_runtime` unless you named it differently | Which role `db:migrate` provisions |
| `BETTER_AUTH_SECRET` | ≥ 32 characters, high entropy | Cookie signing, JWKS private-key encryption |
| `UPSTREAM_TOKEN_SECRETS` | `[{"version":1,"value":"<base64url key>"}]` | Upstream token encryption; required before the first SSO login |
| `ROOT_ADMIN_SECRET` | ≥ 32 characters | Break-glass bearer for first run and recovery |
| `ROOT_ADMIN_BREAK_GLASS` | `false` (set `true` only during a recovery) | Root stops working once a human holds `platform:write` |
| `PLATFORM_ORGANIZATION_SLUG`, `PLATFORM_ORGANIZATION_NAME` | `answerable`, `Answerable` | Seeded at first boot, bound by immutable id afterwards |

Optional, with defaults that hold for a first deployment: `ADMIN_RESOURCE_IDENTIFIER` (defaults to `${BETTER_AUTH_URL}/api/admin`), `BETTER_AUTH_SECRETS` (versioned ring for rotation; promotion signs everyone out, see the ID README), `DATABASE_POOL_MAX` 20, `DATABASE_STATEMENT_TIMEOUT_MS` 10000, `DATABASE_LOCK_TIMEOUT_MS` 2000, `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS` 15000, `DATABASE_CONNECTION_TIMEOUT_MS` 5000, `DATABASE_POOL_IDLE_TIMEOUT_MS` 10000, `OPERATIONAL_LOG_INTERVAL_MS` 30000, `OAUTH_REFRESH_REUSE_INTERVAL_SECONDS` 0, `OPENAPI_ENABLED` (off in production).

`apps/web` needs `NEXT_PUBLIC_ID_URL=https://id.answerable.org` when `next build` runs.

## Install, in order

**1. Database.** Create the database and the runtime login on your PostgreSQL 16 instance. The login has no privileges yet; `db:migrate` grants them.

```sql
CREATE DATABASE answerable_id;
CREATE ROLE answerable_id_runtime LOGIN PASSWORD '<strong password>'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
```

**2. Migrate and provision.** One migration installs the whole schema, including functions, triggers, policies and privilege restrictions, then provisions the runtime role. Repeating it is safe.

```bash
DATABASE_MIGRATION_URL='postgres://<owner>:…@host/answerable_id' \
DATABASE_RUNTIME_ROLE=answerable_id_runtime \
bun --filter @answerable/id db:migrate
```

**3. Start `apps/id`** with the configuration above. Startup verifies the runtime role, seeds the platform organisation, admin resource and `platform-admins` group, then listens. An unsafe role or missing variable fails the process before it listens; read the error, it names the variable or the privilege.

```bash
bun --filter @answerable/id build && bun apps/id/dist/server.js
```

**4. Check it is up** through the ingress, not the pod.

```bash
curl -s https://id.answerable.org/healthz      # {"status":"ok"} without touching the database
curl -s https://id.answerable.org/readyz       # {"status":"ok"} after one select 1
curl -s https://id.answerable.org/.well-known/openid-configuration | jq .issuer
curl -s https://id.answerable.org/auth/jwks    # first call generates the signing key
```

**5. Preflight the keys** once JWKS exists. This decrypts every stored signing key and upstream token with the delivered secrets and exits non-zero if any key is wrong.

```bash
DATABASE_URL='<runtime url>' BETTER_AUTH_SECRET=… UPSTREAM_TOKEN_SECRETS=… \
bun --filter @answerable/id ops:preflight
```

**6. Deploy `apps/web`** built with `NEXT_PUBLIC_ID_URL`, at the origin you put in `AUTH_PAGES_URL`.

**7. First run with the root bearer.** Every mutation needs an `Idempotency-Key` header; reuse the same key to retry. `ID=https://id.answerable.org`, `ROOT=$ROOT_ADMIN_SECRET`.

```bash
# The platform organisation id
ORG=$(curl -s -H "Authorization: Bearer $ROOT" "$ID/api/admin/v1/organizations" | jq -r '.items[] | select(.slug=="answerable") | .id')

# Your company email domain
curl -s -X POST -H "Authorization: Bearer $ROOT" -H "Idempotency-Key: platform-domain-1" \
  -H "Content-Type: application/json" -d '{"domain":"answerable.org"}' \
  "$ID/api/admin/v1/organizations/$ORG/domains"

# Your identity provider (Entra example: tenant-specific issuer)
curl -s -X PUT -H "Authorization: Bearer $ROOT" -H "Idempotency-Key: platform-sso-1" \
  -H "Content-Type: application/json" \
  -d '{"issuer":"https://login.microsoftonline.com/<tenant-id>/v2.0","domain":"answerable.org","oidc":{"clientId":"<app id>","clientSecret":"<secret>","scopes":["openid","profile","email"]}}' \
  "$ID/api/admin/v1/organizations/$ORG/sso-provider"

# Prove discovery and JWKS are reachable from the server before anyone signs in
curl -s -H "Authorization: Bearer $ROOT" "$ID/api/admin/v1/organizations/$ORG/sso-provider/test"
```

Now sign in once through the web login page with that provider. That creates your user and platform membership. Then make yourself a platform administrator; root locks itself as soon as a human holds `platform:write`.

```bash
MEMBER=$(curl -s -H "Authorization: Bearer $ROOT" "$ID/api/admin/v1/organizations/$ORG/members" | jq -r '.items[0].id')
GROUP=$(curl -s -H "Authorization: Bearer $ROOT" "$ID/api/admin/v1/organizations/$ORG/groups" | jq -r '.items[] | select(.slug=="platform-admins") | .id')
curl -s -X PUT -H "Authorization: Bearer $ROOT" -H "Idempotency-Key: platform-admin-1" \
  -H "Content-Type: application/json" -d '{}' \
  "$ID/api/admin/v1/organizations/$ORG/groups/$GROUP/members/$MEMBER"
```

If you ever remove the last platform administrator, set `ROOT_ADMIN_BREAK_GLASS=true`, restart, repeat this step, then set it back to `false`.

**8. Register the first application** as a client and grant its entitlements through the admin API; the public guide is at `apps/web/content/docs/id/oauth.mdx` and the admin reference at `/docs/id/admin-api`.

## Operating it

- **Health.** `/healthz` is liveness only. `/readyz` runs one query and is the signal for the load balancer.
- **Logs.** Every `OPERATIONAL_LOG_INTERVAL_MS` each process prints `[id] operations` followed by JSON with request counts by route class and status, plus pool counts. Provider diagnostics print only a severity and the event name `provider_diagnostic`, never message text, so a failing sign-in shows up in audit (`auth.signin.failed`), not in logs. The operator signals table is in `../apps/id/OPERATIONS.md`.
- **Scaling.** Add replicas; nothing is process-local except rate-limit buckets and the JWKS cache. Size `max_connections` from the pool formula above. Long lock waits fail at 2 s and stuck transactions at 15 s by design; raise them only with evidence.
- **Backups.** Back up PostgreSQL with your provider's tooling and keep `BETTER_AUTH_SECRET`, `BETTER_AUTH_SECRETS` and `UPSTREAM_TOKEN_SECRETS` in the secret store with their own retention: a restored database is unreadable without the keys that were active when its rows were written. There is no restore drill in the repository any more; run one against a copy of production data before relying on backups.
- **Rotation.** Application secret and upstream key rotation are documented in the ID README. Promoting a new head application secret signs every browser session out.

## Not ready yet

These are release inputs, not code. The release gate in `../reports/answerable-id-release-decision-plan.md` lists them as E1 to E8; the ones a deployment plan must schedule are:

- Real tenant validation against an Entra tenant and a second provider (E1) and against the first consumer (E2, E3).
- A restore drill against production-shaped data with the real backup system and RTO/RPO (E7).
- A load test through the real ingress with agreed latency and refusal budgets (E6).
- A monitoring destination and alert budgets for the signals above; the choice of secret store (`Q-SECRET-STORE` in `02-plan.md`).
- Upstream-disable detection and downstream logout delivery are not implemented (E4); local revocation is immediate, remote sessions are not.
