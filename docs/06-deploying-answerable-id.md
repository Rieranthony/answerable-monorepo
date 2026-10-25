# Deploying Answerable ID

> **TL;DR**
> - **Decides:** what a production deployment of `apps/id` needs and why each piece exists. The install itself is automated: [`infra/README.md`](../infra/README.md) runs it.
> - **Rule:** the service is reachable only through the ingress proxies you list; the application never runs as the database owner; the three deployment secret families are independent and live outside Postgres; Google and Entra use platform applications by default.
> - **Not here:** the design (`03-answerable-id.md`), the schema (`04-answerable-id-schema.md`), day-two operations (`../apps/id/OPERATIONS.md`), the release gate (`../reports/answerable-id-release-decision-plan.md`).

Everything below is derived from the code on this branch: `apps/id/src/config.ts` and `apps/id/src/env.ts` (configuration), `apps/id/src/runtime.ts` (startup checks), `apps/id/src/db/runtime-role.ts` and `apps/id/scripts/migrate.ts` (database roles), `apps/id/src/app.ts` (ingress admission), `apps/id/src/auth.ts` (provider configuration), `apps/id/src/auth/platform-applications.ts` (platform credentials and default scopes). If the code and this page disagree, the code wins; fix the page.

## What runs

| Component | What it is | Notes |
| --- | --- | --- |
| `apps/id` | One Bun process serving the OAuth/OIDC provider, the admin API, login, selection, consent, error and security pages, health and discovery on `PORT` (default 47300) | Stateless apart from per-process rate-limit buckets and a five-minute JWKS cache, so replicas are fine |
| `apps/web` | Next.js site and docs | Public website |
| PostgreSQL 17 | The only state: users, sessions, native OAuth state, policy, audit, command receipts | Local compose uses `postgres:17-alpine`; production needs your own instance with backups |
| Ingress | TLS termination and the `x-forwarded-for` header | The **only** network path to `apps/id`; see the first requirement below |

ID serves its own login, selection, consent, error and security pages at `BETTER_AUTH_URL` (`/login`, `/authorize`, `/consent`, `/error`, `/security`).

Answerable's own deployment of ID, the Toolbox and the admin MCP (Civo, Kubernetes, Cloudflare in front) is described in [`12-deployment.md`](12-deployment.md), and operated with [`infra/README.md`](../infra/README.md).

## Requirements and why they exist

| Requirement | Why | Enforced by |
| --- | --- | --- |
| `apps/id` reachable only through the proxies in `TRUSTED_PROXY_CIDRS` | Better Auth's rate limiter and every audit row key on the client address. The address is taken from `x-forwarded-for`, walking from the right and skipping listed proxies. A request that reaches the process directly has no trustworthy address; in production it is refused with `403 untrusted_ingress` before authentication | `src/app.ts` ingress check; `src/env.ts` requires the variable in production |
| The application's `DATABASE_URL` is an unprivileged login, never the owner | Row-level security does not apply to the table owner. Ten tables rely on it for tenant isolation, and audit rows are immutable only because the runtime role cannot update or delete them. Startup refuses an owner or privileged role in every environment | `src/runtime.ts` calls `assertRuntimeRole` before listening |
| A separate schema-owner login for migrations | DDL, functions, triggers and policies need ownership; the same run provisions the runtime role's permissions so the two never drift | `scripts/migrate.ts` migrates with `DATABASE_MIGRATION_URL`, then runs `configureRuntimeRole` for `DATABASE_RUNTIME_ROLE` |
| `BETTER_AUTH_URL` is the public issuer origin, `https://` | It becomes the JWT `iss`, the discovery document and the default admin audience (`${BETTER_AUTH_URL}/api/admin`). Changing it invalidates every issued token | `src/env.ts`, `src/auth.ts` |
| Non-empty origin-only `BETTER_AUTH_TRUSTED_ORIGINS` | Lists other browser origins allowed to call `/auth/*` with cookies, and identity-provider endpoint origins. The ID origin itself is always trusted. The admin API sends no CORS headers: it has no browser client yet | `src/env.ts` production refinements |
| Google and Microsoft endpoint origins in `BETTER_AUTH_TRUSTED_ORIGINS` and outbound HTTPS to them | Trust exact origins in use: Microsoft `https://login.microsoftonline.com` (discovery, authorisation, token, keys) and `https://graph.microsoft.com` (userinfo); Google `https://accounts.google.com` (discovery/authorisation), `https://oauth2.googleapis.com` (token/revocation), `https://www.googleapis.com` (JWKS), `https://openidconnect.googleapis.com` (userinfo). The service must reach these endpoints over HTTPS | Provider origin checks; SSO connectivity test reports `untrusted_origin` for a discovered endpoint outside the allowlist |
| Three independent secret families | `BETTER_AUTH_SECRET` signs browser cookies and encrypts the stored JWKS private keys; `ROOT_ADMIN_SECRET` is the break-glass principal; platform application secrets authenticate Answerable to Google and Microsoft. ID stores no upstream IdP token. Compromise of one must not expose the others, and none may be in the database or its backups | `src/env.ts` validation; `src/runtime.ts` refuses to start when the application secrets cannot decrypt the newest signing key; `src/auth/answerable-schema.ts` discards an upstream refresh token |
| `NODE_ENV=production` | Turns on the provider's rate limiter (limits under "Operating it"), the production refinements above and turns off the OpenAPI documents. The server refuses to start with `NODE_ENV=test`, which would turn off Better Auth's origin and CSRF checks and the runtime-role assertion | `src/env.ts`, `src/runtime.ts`, Better Auth defaults |
| PostgreSQL `max_connections` ≥ replicas × `DATABASE_POOL_MAX` + migration and operator sessions | Each replica opens up to `DATABASE_POOL_MAX` connections (default 20). Exhausting the server turns every request into a `database_busy` 503 | `src/db/client.ts` |

## Platform applications: Microsoft Entra and Google

Answerable uses one multi-tenant Entra app registration and one Google OAuth client. Organisation SSO rows select these applications by omitting `oidc` (or setting `oidc: {"credentials":"platform"}`). Credentials live only in the service environment and are injected when Better Auth reads a row; platform rows store no secret. Set each client ID and secret together.

**Microsoft Entra.**

1. Create an app registration. Set **Supported account types** to **Multiple Entra ID tenants** (older portals: **Accounts in any organizational directory**).
2. Under **Authentication → Add a platform → Web**, register `https://id.answerable.org/auth/sso/callback` and `https://id.answerable.org/login`. The second URI is only the landing page for admin consent. For local sign-in, register `http://localhost:47300/auth/sso/callback`.
3. Copy **Application (client) ID** from **Overview** to `MICROSOFT_CLIENT_ID`. Under **Certificates & secrets**, create a client secret and deliver its value as `MICROSOFT_CLIENT_SECRET` through the secret store. Record its expiry and rotate before it expires.
4. Obtain customer admin consent with `https://login.microsoftonline.com/<tenant-id>/v2.0/adminconsent?client_id=<MICROSOFT_CLIENT_ID>&scope=openid%20profile%20email&redirect_uri=https%3A%2F%2Fid.answerable.org%2Flogin&state=<slug>`. The landing URL returns `admin_consent=True&tenant=<GUID>`. Alternatively, a Global Administrator signs in first and ticks **consent on behalf of your organisation**; only Privileged Role Administrators see that option. The default tenant policy blocks ordinary users from consenting to unverified multi-tenant apps. Requesting `email` on v2.0 supplies the email claim for managed users.
5. Publisher verification: Not yet. It needs a Partner Center (Cloud Partner Program) ID and a verified publisher domain; track [Q-PUBLISHER-VERIFICATION](02-plan.md#open-register). A certificate credential: Not yet. Better Auth 1.7.2's `private_key_jwt` assertion lacks the `x5t#S256` header Entra requires. Use the client secret until [Q-ENTRA-CERTIFICATE](02-plan.md#open-register) resolves.

**Google.**

1. In the Cloud console, open **Google Auth Platform → Branding** and set the app name and support email.
2. Set **Audience** to **External**; **Internal** admits only our own organisation. Publish to **In production**. An app requesting only `openid`, `email` and `profile` needs no scope verification and is exempt from the 100-test-user cap, unverified-app screen and seven-day refresh-token expiry.
3. Under **Clients → Create client → Web application**, add the exact **Authorized redirect URI** `https://id.answerable.org/auth/sso/callback` (HTTPS). For local sign-in, use `http://localhost:47300/auth/sso/callback`.
4. Copy the client ID to `GOOGLE_CLIENT_ID` and the secret, shown once, to `GOOGLE_CLIENT_SECRET` through the secret store. Never put either provider's secret in an SSO PUT body when using platform credentials.
5. Workspace customers with restricted third-party apps mark the client ID **Trusted** under **Admin console → Security → Access and data control → API controls → Manage App Access → Configure new app**. The default policy allows any third-party app. The `hd` request parameter is only a hint; Answerable ID verifies the ID token's `hd` claim.

Every SSO row, platform or own credentials, defaults to `email openid profile` when scopes are omitted. ID asks for no `offline_access` and keeps no upstream refresh token. See [directory onboarding](../apps/web/content/docs/id/onboard.mdx#connect-the-directory) for tenant IDs and own credentials.

## Configuration

Required in production. In Answerable's deployment the Bootstrap workflow generates the application and root secrets and the deploy delivers every value ([`12-deployment.md`](12-deployment.md#secrets)); nothing here reads a file.

| Variable | Value | Why |
| --- | --- | --- |
| `NODE_ENV` | `production` | See above |
| `PORT` | listener port, default 47300 | Ingress upstream |
| `BETTER_AUTH_URL` | `https://id.answerable.org` | Issuer, discovery, admin audience |
| `BETTER_AUTH_TRUSTED_ORIGINS` | `https://login.microsoftonline.com,https://graph.microsoft.com,https://accounts.google.com,https://oauth2.googleapis.com,https://www.googleapis.com,https://openidconnect.googleapis.com`; use the IdP origins in use, with no paths or trailing slash | Browser CORS/CSRF and IdP endpoint trust |
| `TRUSTED_PROXY_CIDRS` | comma-separated IPv4/IPv6 networks of the ingress proxies | Client address resolution |
| `DATABASE_URL` | `postgres://answerable_id_runtime:…@host/answerable_id` | Application connection, restricted role |
| `DATABASE_MIGRATION_URL` | owner login, used only by the migration Job; never given to the service | DDL and permission provisioning |
| `DATABASE_RUNTIME_ROLE` | `answerable_id_runtime` unless you named it differently | Which role migration provisions |
| `BETTER_AUTH_SECRET` | ≥ 32 characters, high entropy | Cookie signing, JWKS private-key encryption |
| `GOOGLE_CLIENT_ID` | Google Web application client ID | Set together with `GOOGLE_CLIENT_SECRET` when using Google platform credentials |
| `GOOGLE_CLIENT_SECRET` | Google client secret from the secret store | Environment only; never stored in platform SSO rows |
| `MICROSOFT_CLIENT_ID` | Multi-tenant Entra Application (client) ID | Set together with `MICROSOFT_CLIENT_SECRET` when using Microsoft platform credentials |
| `MICROSOFT_CLIENT_SECRET` | Entra client secret from the secret store | Environment only; record expiry and rotate before it |
| `ROOT_ADMIN_SECRET` | ≥ 32 characters | Break-glass bearer for first run and recovery |
| `ROOT_ADMIN_BREAK_GLASS` | `false` (set `true` only during a recovery) | Root stops working once a human holds `platform:write` |

Optional, with defaults that hold for a first deployment: `BETTER_AUTH_SECRETS` (versioned ring for rotation; promotion signs everyone out, see the ID README), `DATABASE_POOL_MAX` 20.

Fixed in `apps/id/src/env.ts`, not configurable: the admin API's resource `${BETTER_AUTH_URL}/api/admin`; the platform organisation's slug `answerable` and name `Answerable`, seeded at first boot and bound by immutable id afterwards; statement timeout 10 s, lock timeout 2 s, idle-in-transaction timeout 15 s, pool checkout 5 s and pool idle 10 s; operational log every 30 s; protocol sweep every 60 s in batches of 1,000; OpenAPI routes outside production only.

## Install

Answerable installs ID from CI, never by hand: [`infra/README.md`](../infra/README.md#first-run) is the procedure and [`12-deployment.md`](12-deployment.md) the design. What each step does, so a failure reads plainly:

- **Database roles.** The `ops-bootstrap` Job creates the database and the logins; the migration Job applies the committed migrations as the owner login and provisions the runtime role (`scripts/migrate.ts`). Repeating it is safe: applied migrations are skipped, and a migration file that changed after the database applied it stops the run with its name. The migration connection waits at most 5 s for a lock and 5 minutes for a statement: while DDL waits for a table lock, every later query on that table queues behind it, so on a live database a migration gives up rather than stall the service; rerun it once the blocking transaction ends.
- **Startup.** ID verifies the runtime role, then on an empty database seeds the platform organisation, admin resource, `platform-admins` group, its entitlement and the platform capability. Later starts verify that binding, refuse a changed admin resource identifier (a changed `BETTER_AUTH_URL`) and restore only the admin resource's definition. An unsafe role, a missing variable or application secrets that cannot decrypt the newest stored signing key stop the process before it listens; the error names the variable, the privilege or the key.
- **The image.** `apps/id/dist` runs without `node_modules`: the build bundles the server and the migration script and compiles the sign-in pages' stylesheet into `dist/tailwind.css`. Run it with `bun --no-install`, or Bun tries to install the optional packages a library imports on demand.
- **Smoke test.** Through the ingress, not the pod: `/healthz` answers without touching the database, `/readyz` after one `select 1`, `/.well-known/openid-configuration` names the issuer and `/auth/jwks` (the first call generates the signing key). `bun infra/pipeline/src/cli.ts smoke` runs these.
- **First run.** The root bearer adds the staff domain and directory, a person signs in and joins `platform-admins`, and root locks itself: [`onboard.mdx` § First run](../apps/web/content/docs/id/onboard.mdx#first-run). Each write sends a new `Idempotency-Key`, or none.
- **The first application.** Register it as a client and grant its entitlements through the admin API: [`oauth.mdx`](../apps/web/content/docs/id/oauth.mdx) and the admin reference at `/docs/id/admin-api`.

## Operating it

- **Health.** `/healthz` is liveness only. `/readyz` runs one query and is the signal for the load balancer.
- **Logs.** Every 30 seconds each process prints `[id] operations` followed by JSON with request counts by route class and status, plus pool counts. Provider diagnostics print a severity, the event name `provider_diagnostic` and, for a thrown error, its class and SQLSTATE, never message text. A refused sign-in or token request that verified no identity is the log line `signin_rejected` or `token_rejected`, not an audit event. The signals and what to do about each are in [`OPERATIONS.md`](../apps/id/OPERATIONS.md#signals).
- **Rate limits.** In production Better Auth refuses a client address with `429` past these bursts: `POST /auth/sign-in/sso` 60 per 10 s, `GET /auth/sso/callback` 300 per 10 s, `/auth/oauth2/authorize` 300 a minute, `POST /auth/oauth2/token` 600 a minute; other routes keep Better Auth's defaults (`src/auth.ts`). They are sized for shared addresses: an office signs in through one egress address, and a server-side host refreshes every user's token from one address, so 600 token calls a minute serve 9,000 users on 900 s tokens from one host address. Buckets live in memory, keyed per client address per process, so each replica adds its own allowance. They are not a volumetric defence; that is Cloudflare's rate limiting in front (`Q-ADMIN-API-RATE-LIMIT`).
- **Scaling.** Add replicas; nothing is process-local except rate-limit buckets and the JWKS cache. Size `max_connections` from the pool formula above. Long lock waits fail at 2 s and stuck transactions at 15 s by design; raise them only with evidence.
- **Backups.** Back up PostgreSQL with your provider's tooling and keep `BETTER_AUTH_SECRET` and `BETTER_AUTH_SECRETS` in the secret store with their own retention: a restored database is unreadable without the keys that were active when its rows were written. The restore procedure is in [the runbook](../infra/README.md#restore); its drill is E7 below.
- **Storage growth.** `admin_operations` keeps one receipt per administrative command and `audit_events` one row per recorded event, both permanently: nothing prunes them, so plan their disk and index growth with the database. Expired sessions, OAuth access and refresh tokens and client assertions do not accumulate: every 60 seconds ID deletes them in batches of 1,000 rows, an advisory lock keeps two replicas from deleting at once, and a run that deleted rows prints `[id] protocol sweep` with the count per table.
- **Platform application rotation.** Create a new secret in the provider console, update the environment and rolling-restart every replica while both secrets remain valid; retire the old secret afterwards. No SSO rows, revisions or grants change. Replacing a platform client ID interrupts in-flight sign-ins with `?error=invalid_state&error_description=sso_provider_changed_during_authentication`: the SSO plugin detects the changed application, without a row revision change, so `SSO_PROVIDER_CHANGED` does not apply. For Entra it also changes every user’s pairwise `sub`, so existing accounts stop matching. See [sign-in errors](../apps/web/content/docs/id/sign-in.mdx#when-sign-in-is-refused).
- **Rotation.** Application secret rotation is in [ID's README](../apps/id/README.md#application-secret-rotation), and every family's in [the runbook](../infra/README.md#rotate). Promoting a new head application secret signs every browser session out.

## Not ready yet

These include release evidence and unbuilt capabilities. The release gate in `../reports/answerable-id-release-decision-plan.md` lists them as E1 to E8; the ones a deployment plan must schedule are below. The topology, where each secret lives (GitHub environments, Terraform state and Kubernetes Secrets) and the backup system Answerable deploys with are in [`12-deployment.md`](12-deployment.md); what they prove waits for the first staging run's evidence.

- Real tenant validation against an Entra tenant and a second provider (E1) and against the first consumer (E2, E3): Not yet. See the [release plan](02-plan.md#open-register).
- Publisher verification and an Entra certificate credential: Not yet. Track [Q-PUBLISHER-VERIFICATION and Q-ENTRA-CERTIFICATE](02-plan.md#open-register); the certificate work gates E1.
- A restore drill against production-shaped data with the real backup system and RTO/RPO (E7).
- A load test through the real ingress with agreed latency and refusal budgets (E6).
- A monitoring destination and alert budgets for the signals above. Where secrets live is settled (`Q-SECRET-STORE` in `02-plan.md`, resolved on 19 October 2026); a store with a read audit waits for a second team or a compliance need.
- Upstream-disable detection and downstream logout delivery are not implemented (E4); local revocation is immediate, remote sessions are not.
