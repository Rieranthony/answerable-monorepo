# Deploying Answerable ID

> **TL;DR**
> - **Decides:** what a production deployment of `apps/id` needs, in what order, and why each piece exists.
> - **Rule:** the service is reachable only through the ingress proxies you list; the application never runs as the database owner; the four deployment secret families are independent and live outside Postgres; Google and Entra use platform applications by default.
> - **Not here:** the design (`03-answerable-id.md`), the schema (`04-answerable-id-schema.md`), day-two operations (`../apps/id/OPERATIONS.md`), the release gate (`../reports/answerable-id-release-decision-plan.md`).

Everything below is derived from the code on this branch: `apps/id/src/env.ts` (configuration), `apps/id/src/runtime.ts` (startup checks), `apps/id/src/db/runtime-role.ts` and `apps/id/scripts/migrate.ts` (database roles), `apps/id/src/app.ts` (ingress admission), `apps/id/src/auth.ts` (provider configuration), `apps/id/src/auth/platform-applications.ts` (platform credentials and default scopes). If the code and this page disagree, the code wins; fix the page.

## What runs

| Component | What it is | Notes |
| --- | --- | --- |
| `apps/id` | One Bun process serving the OAuth/OIDC provider, the admin API, login, selection, consent, error and security pages, health and discovery on `PORT` (default 47300) | Stateless apart from per-process rate-limit buckets and a five-minute JWKS cache, so replicas are fine |
| `apps/web` | Next.js site and docs | Public website |
| PostgreSQL 16 | The only state: users, sessions, native OAuth state, policy, audit, command receipts | Local compose uses `postgres:16-alpine`; production needs your own instance with backups |
| Ingress | TLS termination and the `x-forwarded-for` header | The **only** network path to `apps/id`; see the first requirement below |
| Redis | Reserved for later caching | Not used by `apps/id` today; do not provision it for ID |

ID serves its own login, selection, consent, error and security pages at `BETTER_AUTH_URL` (`/login`, `/authorize`, `/consent`, `/error`, `/security`).

## Requirements and why they exist

| Requirement | Why | Enforced by |
| --- | --- | --- |
| `apps/id` reachable only through the proxies in `TRUSTED_PROXY_CIDRS` | Better Auth's rate limiter and every audit row key on the client address. The address is taken from `x-forwarded-for`, walking from the right and skipping listed proxies. A request that reaches the process directly has no trustworthy address; in production it is refused with `403 untrusted_ingress` before authentication | `src/app.ts` ingress check; `src/env.ts` requires the variable in production |
| The application's `DATABASE_URL` is an unprivileged login, never the owner | Row-level security does not apply to the table owner. Eleven tables rely on it for tenant isolation, and audit rows are immutable only because the runtime role cannot update or delete them. Startup refuses an owner or privileged role in every environment except `NODE_ENV=test` | `src/runtime.ts` calls `assertRuntimeRole` before listening |
| A separate schema-owner login for migrations | DDL, functions, triggers and policies need ownership; the same run provisions the runtime role's permissions so the two never drift | `scripts/migrate.ts` migrates with `DATABASE_MIGRATION_URL`, then runs `configureRuntimeRole` for `DATABASE_RUNTIME_ROLE` |
| `BETTER_AUTH_URL` is the public issuer origin, `https://` | It becomes the JWT `iss`, the discovery document and the default admin audience (`${BETTER_AUTH_URL}/api/admin`). Changing it invalidates every issued token | `src/env.ts`, `src/auth.ts` |
| Non-empty origin-only `BETTER_AUTH_TRUSTED_ORIGINS` | Lists other browser origins allowed to call the API with cookies and identity-provider endpoint origins. The ID origin itself is always trusted | `src/env.ts` production refinements |
| Google and Microsoft endpoint origins in `BETTER_AUTH_TRUSTED_ORIGINS` and outbound HTTPS to them | Trust exact origins in use: Microsoft `https://login.microsoftonline.com` (discovery, authorisation, token, keys) and `https://graph.microsoft.com` (userinfo); Google `https://accounts.google.com` (discovery/authorisation), `https://oauth2.googleapis.com` (token/revocation), `https://www.googleapis.com` (JWKS), `https://openidconnect.googleapis.com` (userinfo). The service must reach these endpoints over HTTPS | Provider origin checks; SSO connectivity test reports `untrusted_origin` for a discovered endpoint outside the allowlist |
| Four independent secret families | `BETTER_AUTH_SECRET` signs browser cookies and encrypts the stored JWKS private keys; `UPSTREAM_TOKEN_SECRETS` encrypts the upstream IdP tokens stored on accounts; `ROOT_ADMIN_SECRET` is the break-glass principal; platform application secrets authenticate Answerable to Google and Microsoft. Compromise of one must not expose the others, and none may be in the database or its backups | `src/env.ts` validation; `src/auth/upstream-token-storage.ts` |
| `NODE_ENV=production` | Turns on the provider's rate limiter, the runtime-role assertion, the production refinements above and turns off the OpenAPI documents | `src/env.ts`, Better Auth defaults |
| PostgreSQL `max_connections` ≥ replicas × `DATABASE_POOL_MAX` + migration and operator sessions | Each replica opens up to `DATABASE_POOL_MAX` connections (default 20). Exhausting the server turns every request into a `database_busy` 503 | `src/db/client.ts` |

## Platform applications: Microsoft Entra and Google

Answerable uses one multi-tenant Entra app registration and one Google OAuth client. Organisation SSO rows select these applications by omitting `oidc` (or setting `oidc: {"credentials":"platform"}`). Credentials live only in the service environment and are injected when Better Auth reads a row; platform rows store no secret. Set each client ID and secret together.

**Microsoft Entra.**

1. Create an app registration. Set **Supported account types** to **Multiple Entra ID tenants** (older portals: **Accounts in any organizational directory**).
2. Under **Authentication → Add a platform → Web**, register `https://id.answerable.org/auth/sso/callback` and `https://id.answerable.org/login`. The second URI is only the landing page for admin consent. For local sign-in, register `http://localhost:47300/auth/sso/callback`.
3. Copy **Application (client) ID** from **Overview** to `MICROSOFT_CLIENT_ID`. Under **Certificates & secrets**, create a client secret and deliver its value as `MICROSOFT_CLIENT_SECRET` through the secret store. Record its expiry and rotate before it expires.
4. Obtain customer admin consent with `https://login.microsoftonline.com/<tenant-id>/v2.0/adminconsent?client_id=<MICROSOFT_CLIENT_ID>&scope=openid%20profile%20email%20offline_access&redirect_uri=https%3A%2F%2Fid.answerable.org%2Flogin&state=<slug>`. The landing URL returns `admin_consent=True&tenant=<GUID>`. Alternatively, a Global Administrator signs in first and ticks **consent on behalf of your organisation**; only Privileged Role Administrators see that option. The default tenant policy blocks ordinary users from consenting to unverified multi-tenant apps. Requesting `email` on v2.0 supplies the email claim for managed users.
5. Publisher verification: Not yet. It needs a Partner Center (Cloud Partner Program) ID and a verified publisher domain; track [Q-PUBLISHER-VERIFICATION](02-plan.md#open-register). A certificate credential: Not yet. Better Auth 1.7.2's `private_key_jwt` assertion lacks the `x5t#S256` header Entra requires. Use the client secret until [Q-ENTRA-CERTIFICATE](02-plan.md#open-register) resolves.

**Google.**

1. In the Cloud console, open **Google Auth Platform → Branding** and set the app name and support email.
2. Set **Audience** to **External**; **Internal** admits only our own organisation. Publish to **In production**. An app requesting only `openid`, `email` and `profile` needs no scope verification and is exempt from the 100-test-user cap, unverified-app screen and seven-day refresh-token expiry.
3. Under **Clients → Create client → Web application**, add the exact **Authorized redirect URI** `https://id.answerable.org/auth/sso/callback` (HTTPS). For local sign-in, use `http://localhost:47300/auth/sso/callback`.
4. Copy the client ID to `GOOGLE_CLIENT_ID` and the secret, shown once, to `GOOGLE_CLIENT_SECRET` through the secret store. Never put either provider's secret in an SSO PUT body when using platform credentials.
5. Workspace customers with restricted third-party apps mark the client ID **Trusted** under **Admin console → Security → Access and data control → API controls → Manage App Access → Configure new app**. The default policy allows any third-party app. The `hd` request parameter is only a hint; Answerable ID verifies the ID token's `hd` claim.

Google defaults to `email openid profile`; Entra defaults to `email offline_access openid profile`. Own-credential rows for these issuers receive the same defaults when scopes are omitted. See [directory onboarding](../apps/web/content/docs/id/onboard.mdx#connect-the-directory) for tenant IDs and own credentials.

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
| `BETTER_AUTH_TRUSTED_ORIGINS` | `https://login.microsoftonline.com,https://graph.microsoft.com,https://accounts.google.com,https://oauth2.googleapis.com,https://www.googleapis.com,https://openidconnect.googleapis.com`; use the IdP origins in use, with no paths or trailing slash | Browser CORS/CSRF and IdP endpoint trust |
| `TRUSTED_PROXY_CIDRS` | comma-separated IPv4/IPv6 networks of the ingress proxies | Client address resolution |
| `DATABASE_URL` | `postgres://answerable_id_runtime:…@host/answerable_id` | Application connection, restricted role |
| `DATABASE_MIGRATION_URL` | owner login, used only by `db:migrate` runs you start by hand; never given to the service | DDL and permission provisioning |
| `DATABASE_RUNTIME_ROLE` | `answerable_id_runtime` unless you named it differently | Which role `db:migrate` provisions |
| `BETTER_AUTH_SECRET` | ≥ 32 characters, high entropy | Cookie signing, JWKS private-key encryption |
| `UPSTREAM_TOKEN_SECRETS` | `[{"version":1,"value":"<base64url key>"}]` | Upstream token encryption; required before the first SSO login |
| `GOOGLE_CLIENT_ID` | Google Web application client ID | Set together with `GOOGLE_CLIENT_SECRET` when using Google platform credentials |
| `GOOGLE_CLIENT_SECRET` | Google client secret from the secret store | Environment only; never stored in platform SSO rows |
| `MICROSOFT_CLIENT_ID` | Multi-tenant Entra Application (client) ID | Set together with `MICROSOFT_CLIENT_SECRET` when using Microsoft platform credentials |
| `MICROSOFT_CLIENT_SECRET` | Entra client secret from the secret store | Environment only; record expiry and rotate before it |
| `ROOT_ADMIN_SECRET` | ≥ 32 characters | Break-glass bearer for first run and recovery |
| `ROOT_ADMIN_BREAK_GLASS` | `false` (set `true` only during a recovery) | Root stops working once a human holds `platform:write` |
| `PLATFORM_ORGANIZATION_SLUG`, `PLATFORM_ORGANIZATION_NAME` | `answerable`, `Answerable` | Seeded at first boot, bound by immutable id afterwards |

Optional, with defaults that hold for a first deployment: `ADMIN_RESOURCE_IDENTIFIER` (defaults to `${BETTER_AUTH_URL}/api/admin`), `BETTER_AUTH_SECRETS` (versioned ring for rotation; promotion signs everyone out, see the ID README), `DATABASE_POOL_MAX` 20, `DATABASE_STATEMENT_TIMEOUT_MS` 10000, `DATABASE_LOCK_TIMEOUT_MS` 2000, `DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS` 15000, `DATABASE_CONNECTION_TIMEOUT_MS` 5000, `DATABASE_POOL_IDLE_TIMEOUT_MS` 10000, `OPERATIONAL_LOG_INTERVAL_MS` 30000, `OAUTH_REFRESH_REUSE_INTERVAL_SECONDS` 0, `OPENAPI_ENABLED` (off in production).

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

The build compiles the sign-in pages' stylesheet into `apps/id/dist/tailwind.css`. The bundle still loads `hono-tailwind` from `node_modules` when it starts, so run it from an installed checkout.

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

**6. Deploy `apps/web`** for the site and docs.

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
  -d '{"issuer":"https://login.microsoftonline.com/<tenant-id>/v2.0","domain":"answerable.org"}' \
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
- **Platform application rotation.** Create a new secret in the provider console, update the environment and rolling-restart every replica while both secrets remain valid; retire the old secret afterwards. No SSO rows, revisions or grants change. Replacing a platform client ID interrupts in-flight sign-ins with `?error=invalid_state&error_description=sso_provider_changed_during_authentication`: the SSO plugin detects the changed application, without a row revision change, so `SSO_PROVIDER_CHANGED` does not apply. For Entra it also changes every user’s pairwise `sub`, so existing accounts stop matching. See [sign-in errors](../apps/web/content/docs/id/sign-in.mdx#when-sign-in-is-refused).
- **Rotation.** Application secret and upstream key rotation are documented in the ID README. Promoting a new head application secret signs every browser session out.

## Not ready yet

These include release evidence and unbuilt capabilities. The release gate in `../reports/answerable-id-release-decision-plan.md` lists them as E1 to E8; the ones a deployment plan must schedule are:

- Real tenant validation against an Entra tenant and a second provider (E1) and against the first consumer (E2, E3): Not yet. See the [release plan](02-plan.md#open-register).
- Publisher verification and an Entra certificate credential: Not yet. Track [Q-PUBLISHER-VERIFICATION and Q-ENTRA-CERTIFICATE](02-plan.md#open-register); the certificate work gates E1.
- A restore drill against production-shaped data with the real backup system and RTO/RPO (E7).
- A load test through the real ingress with agreed latency and refusal budgets (E6).
- A monitoring destination and alert budgets for the signals above; the choice of secret store (`Q-SECRET-STORE` in `02-plan.md`).
- Upstream-disable detection and downstream logout delivery are not implemented (E4); local revocation is immediate, remote sessions are not.
