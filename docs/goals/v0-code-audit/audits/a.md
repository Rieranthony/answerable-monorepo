# Audit A: the auth layer

Auditor A, v0 code audit, 20 October 2026. Tree `60c98f65` in an isolated worktree, Postgres 17 `audit-pg-a` on 47433. Read-only: every spike was reverted with `git checkout -- .`; probe scripts and logs are under `/tmp/v0-code-audit/probes/a/`.

## 1. Scope and method

### Files read in full (non-test lines)

| File | Lines | File | Lines |
| --- | ---: | --- | ---: |
| `src/auth.ts` | 247 | `auth/machine-provider.ts` | 160 |
| `auth/member-permission.ts` | 432 | `auth/sso-origin.ts` | 160 |
| `auth/user-oauth-flow.ts` | 446 | `auth/database-adapter.ts` | 160 |
| `auth/verified-sso.ts` | 421 | `auth/user-token-revocation.ts` | 157 |
| `auth/user-token-boundary.ts` | 414 | `auth/machine-audit.ts` | 136 |
| `auth/user-provider.ts` | 205 | `auth/tenant-authentication.ts` | 125 |
| `auth/user-token-assertions.ts` | 181 | `auth/user-resource-policy.ts` | 101 |
| `auth/create-resource-grant.ts` | 170 | `auth/machine-identity.ts` | 100 |
| `auth/native-code-replay.ts` | 82 | `auth/native-refresh-family.ts` | 81 |
| `auth/answerable-schema.ts` | 79 | `auth/upstream-token-storage.ts` | 77 |
| `auth/machine-capability.ts` | 75 | `auth/native-client-authentication.ts` | 73 |
| `auth/platform-applications.ts` | 72 | `auth/lock-resource-grant-policy.ts` | 72 |
| `auth/grant-authentication.ts` | 70 | `auth/fresh-authentication.ts` | 43 |
| `auth/audit-hooks.ts` | 44 | `auth/user-oauth-audit.ts` | 39 |
| `auth/grant-scopes.ts` | 37 | `auth/narrow-authorization-code.ts` | 29 |
| `auth/native-token-cleanup.ts` | 27 | `auth/grant-error.ts` | 21 |
| `http/auth-allowlist.ts` | 190 | `http/openapi.ts` | 202 |
| `http/signin-audit.ts` | 52 | `http/oauth-metadata.ts` | 37 |
| **36 files** | **5,017** | | |

`grant-locks`, `ip-metadata` and `logging` exist only as tests; they were read for what they promise, with `user-oauth.integration.test.ts` (setup and the fault cases), `verified-sso.integration.test.ts` (the revalidation cases), `account-storage.integration.test.ts`, `native-shapes.test.ts`, `ip-metadata.test.ts` and `schema.integration.test.ts` (the plugin case). Context read: `app.ts`, `env.ts` (secrets), `operations/preflight.ts`, `services/federation.ts` (head and adapter reads), `http/admin/sso-providers.ts` (credentials), `db/queries/sso-providers.ts` (serialisation), `packages/id-admin/src/index.ts` (token cache), the three earlier goals' plans and conclusions, docs/02, docs/05, the V0 cleanup's audit A.

### Installed sources read (pinned 1.7.2)

- `@better-auth/oauth-provider/dist/introspect-C6P1zrTr.mjs`: `tokenEndpoint` 1274–1298, `getOAuthProviderApi` 1308–1347, `invalidateRefreshFamily` 1498–1527 (family = client + user), `revokeTokensIssuedForAuthorizationCode` 1528–1544 (swallows `deleteMany` errors), `createRefreshToken` 1545–1602, `createUserTokens` 1779–1891 (rotation replay stored at 1882), `checkVerificationValue` 1893–1955, `handleAuthorizationCodeGrant` 1956–2056, `handleClientCredentialsGrant` 2057–2099, `handleRefreshTokenGrant` 2100–2195 (revoked branch at 2146: cached replay or family invalidation).
- `@better-auth/oauth-provider/dist/authorize-BmTe2VYG.mjs` 5235–5266: the plugin's rate limits (token 20/60 s, authorize 30/60 s, revoke 30/60 s, userinfo 60/60 s).
- `@better-auth/sso/dist/index.mjs`: `resolveSSOUser` 1600–1612, `lockSSOProviderForAccountLink` 2097–2111, OIDC callback 3800–4060 (state errors 3800–3815, default scopes with `offline_access` 3826, ID token required with `resolveUser` 3909, the transaction 3961, `handleOAuthUserInfo` with `refreshToken` 3993, `deferNonDatabaseWrites` 4017).
- `better-auth/dist/context/create-context.mjs` 69–80 (`options.secrets ?? BETTER_AUTH_SECRETS`), 169–174 (limiter on when `isProduction`, 100 per 10 s); `context/secret-utils.mjs` 13–28 (`parseSecretsEnv` quotes the entry in its error); `api/rate-limiter/index.mjs` 233–300 (key = resolved IP + path, plugin rules), 302–312 (`/sign-in*` 3 per 10 s); `api/to-auth-endpoints.mjs` 49–50 (every endpoint call runs inside `runWithRequestState`); `plugins/organization/organization.mjs` 705–870 (organization, member with required `role`, invitation, `session.activeOrganizationId`).
- `@better-auth/core/dist/context/request-state.mjs` (`defineRequestState`, `hasRequestState`, exported from `@better-auth/core/context`).

### Probes

| # | Command (from `apps/id`; probe bunfig `/tmp/v0-code-audit/probes/a/bunfig.probe.toml` turns coverage off) | Result |
| --- | --- | --- |
| 00 | `bun test --timeout 15000` | 1,558 pass, 0 fail, 133 files, 100% lines and functions, 476 s |
| 02 | Spike: `assertUserTokenResponse` returns `parseScope(response.scope)` after the response parse; `bun test src/auth src/http` | 1,167 pass, 3 fail: the three fault-injection tests (`user-oauth:528`, `:569`, `:661`); every policy, replay, race and revocation test passes |
| 03a | Spike: drop `current()` from `resolve` and the body of `beforeSession` in `verified-sso.ts`; verified-sso, federation, tenant-authentication, both erasure suites | 132 pass, 2 fail: `native resolution rolls back when callback revalidation reports lost-authority/database-failure`, which fault the second of two identical checks |
| 03b | 03a plus the `AsyncLocalStorage` replaced by `defineRequestState` and `auth.ts`'s `handler` override deleted; same files plus `app.test.ts`; typecheck | 159 pass, the same 2 fail; typecheck clean |
| 04 | `bun 04-upstream-transform.ts`: encrypt/decrypt a 1,800-byte token 5,000 times | 45.4 µs encrypt, 45.6 µs decrypt, 3,686 bytes stored |
| 04b | Spike: `upstreamTokenStorage` replaced by a field transform `input: () => null`; `src/auth.integration src/auth src/operations`, federation, signin-audit, env, users, erasure | 427 pass, 7 fail: all seven test the storage itself (encryption, key rotation, custody preflight, plaintext refusal) |
| 05 | `05-roundtrips.test.ts`: production `createAuth`/`createApp`, restricted runtime role, `pg.Client.query` counted per phase; 300 sequential refreshes; JSC sampling profile of 150 | §6; refresh 37 round trips, 1 transaction, 7 locking reads, 22.3/s sequential, 22.9 ms user CPU each; CPU mostly Drizzle query building |
| 07 | `07-rejection-rows.test.ts`: 16 concurrent unauthenticated callers for 5 s each, limiter off | ~1,000–1,200 audit rows/s per process; 300 B (token) and 192 B (callback) per row; refused user grants write none |
| 08 | `NODE_ENV=production TEST= bun 08-production-limits.ts`: bursts from one client address | `/sign-in/sso` 429 after 3; `/oauth2/authorize` after 30; `/oauth2/token` after 20; `/get-session` and `/sso/callback` after 100 |
| 09 | `bun 09-routes.ts`: every endpoint `createAuth` mounts, by plugin, against the allowlist | 111 mounted, 16 open, 16 allowlist entries, none allowlisted but unmounted |
| 10 | Spikes, one at a time: `withNativeRefreshFamily`, `withNativeCodeReplay`, `withNativeTokenCleanup`, `narrowAuthorizationCode`, the assertion-marker acknowledgement made pass-through; user-oauth, grant-locks, narrow, token suites | 4, 7, 3, 2 and 1 failures, each a behaviour test (`10-spike-*.log`) |
| 11 | Spike: `organization()` replaced by two model declarations (organization: name, slug, status, deletedAt; member: organizationId, userId, status, deletedAt); auth, app, OpenAPI drift, schema, federation, verified-sso, tenant-authentication, user-oauth, pages | 363 pass, 1 fail: `schema.integration` asserting the plugin's `auth.api.addMember` exists and throws; the OpenAPI drift test passes unchanged |
| 12 | Spike: unauthenticated machine rejections and SSO-callback rejections not written (`09b-no-unauthenticated-rows.log`); auth, signin-audit, federation, token, pages, app | 412 pass, 26 fail: all read the audit row as the oracle (13 federation refusal cases read the reason from it) |

## 2. Verdict table

| Id | Mechanism | Files | Verdict | Lines | Consumer or threat | Evidence | What holds after |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A1 | Better Auth's default rate limits on sign-in, authorise and token | `auth.ts` (no `rateLimit`) | **Unsafe at scale** (§4) | config | Offices behind one NAT; server-side hosts | Probe 08; `rate-limiter/index.mjs:302-312`; `authorize-BmTe2VYG.mjs:5235-5266` | — |
| A2 | Issuance assertions | `user-token-assertions.ts`, `user-token-boundary.ts` | **Delete** (with A2b) | −181, ~−25 boundary, −164 test | None found: only injected faults fail | Probe 02; no real catch in git history | Pre-issuance policy, `currentGrantAuthentication`, the claims callback's grant/client equality, 1,167 tests |
| A2b | `OAUTH_REFRESH_REUSE_INTERVAL_SECONDS` | `env.ts`, `auth.ts`, docs | **Delete**, or keep A2 for the replay branch only (Q1) | ~−10, docs | 0 in every deployment (docs/02 `Q-REFRESH-PARALLEL`) | `.env.example:50`, docs/06 | Native rotation, interval 0 |
| A3 | Verified-SSO re-checks and request store | `verified-sso.ts`, `sso-origin.ts`, `auth.ts` | **Simplify** | ~−25, −47 test | — | Probes 03a, 03b; `to-auth-endpoints.mjs:49-50` | `beforeTransaction`'s check under its locks; 132 verified-sso/federation tests |
| A4 | Upstream refresh-token storage and its key ring | `upstream-token-storage.ts`, `env.ts`, `preflight.ts`, workflows, pipeline, chart, kind stack, docs | **Delete** (column stays) | ~−130 app, ~−350 test, ~−40 infra, docs | `Q-AID-RECHECK` is Not yet; nothing reads the token | Probe 04b | A discard transform; federation and sign-in suites |
| A5 | `credentials: "platform"` per SSO row | `platform-applications.ts`, sso-providers | **Keep** | — | Admin MCP writes and reads it (`mcps/admin/src/organisations.ts:133,170`, `provider.ts:103`); revision-bound stored bytes | grep | — |
| A6 | Exact-pair evaluator and the grant path | `member-permission.ts`, `user-resource-policy.ts`, `create-resource-grant.ts`, `lock-resource-grant-policy.ts`, `grant-authentication.ts` | **Keep** (optimisation noted, not proposed) | — | docs/05 §3 truth table | Probe 05: 11.1 refreshes/s needed at 10k users vs 22.3/s sequential per process | — |
| A7 | Machine ceiling, one audit event per machine token | `machine-*.ts` | **Keep** | — | Toolbox, admin MCP via `packages/id-admin` (token reused to 30 s before expiry) | Probe 05: 15 round trips; 1,552 B per event | — |
| A8 | Route allowlist | `http/auth-allowlist.ts` | **Keep** | — | Exact (16 of 111); also the public OpenAPI's operation ids and summaries | Probe 09 | — |
| A9 | Database rows for unauthenticated refusals | `http/signin-audit.ts`, `machine-audit.ts`, `machine-provider.ts` | **Simplify** to a log line; keep attributed rows (Q2) | ~−30, 26 tests change | No programmatic reader; docs only | Probes 07, 12 | `oauth.token.rejected` after client authentication; `logEvent` |
| A10 | `BETTER_AUTH_SECRETS` parser and ring | `env.ts`, `auth.ts`, README | **Keep** | — | Rotating a leaked secret; Better Auth's parser echoes a malformed entry | `secret-utils.mjs:18-22` | — |
| A11 | `organization` plugin | `auth.ts`, `openapi.ts` | **Simplify**: declare the two models | ~−10, 22 dead routes, 1 test | Federation reads `member` and `organization` through the adapter | Probe 11 | federation, verified-sso, OpenAPI drift |
| A11b | jwt and `openAPI` plugins | `auth.ts`, `openapi.ts` | **Keep** | — | Signing; `generateOpenAPISchema` builds `/openapi.json` | Probe 09 | — |
| A12 | Five-minute freshness | `fresh-authentication.ts` | **Keep** | — | One constant and one SQL predicate; `httpCommand` reads it once; verified SSO is the only other caller | grep | — |
| A13 | `native-*` wrappers, `narrowAuthorizationCode`, `user-token-revocation` | `native-*.ts`, `narrow-authorization-code.ts`, `user-token-revocation.ts` | **Keep** | — | Grant-scoped families and code replay (tenant boundary), retryable cleanup, RFC 7009 repeat revocation, consumed `private_key_jwt` markers | Probe 10; dist 1498–1544 | — |
| A14 | `observe` and `beforeTransaction` adapter hooks | `database-adapter.ts`, `verified-sso.ts` | **Keep** | — | No plugin hook between state parsing and the callback's transaction; our locks must precede native's provider lock | `sso/index.mjs:3813-3815, 3961-3962` | — |

## 3. Findings in detail

### A2 Delete the issuance assertions (and A2b, the reuse interval)

**Evidence.** With the assertion reduced to "parse the response, return its scopes" (probe 02), 1,167 of 1,170 tests in `src/auth` and `src/http` pass. The three that fail inject the fault themselves: a replaced JWT signer (`user-oauth:528`), database triggers that rewrite inserted token rows (`:569`), a re-encrypted rotation cache built with the service's own secret (`:661`). Every check compares Better Auth's output with inputs ID gave it in the same transaction: the identity claims come from ID's own `claims.accessToken` callback (`identity(decision)`, `user-token-boundary.ts:62-78,114-141`), the scopes from the grant ID re-authorised just before calling native (`:294-302`). An inconsistency needs a library defect, a writer with DDL rights or the auth secret. `git log --all` shows no failure it caught; `reports/id-production-oauth.md` §"Issuance assertion correction" records two divergences, both injected.

The one real-world divergence is the replay branch: with `OAUTH_REFRESH_REUSE_INTERVAL_SECONDS > 0`, native returns a cached response minted earlier (`introspect:2146-2153`) whose claims carry that moment's authorisation versions. ID's policy check still runs first (the tests "cached native refresh responses recheck policy" and "`${change}` denies cached and rotated refresh" pass without the assertion), so a revoked or narrowed grant is refused; only a version bump that leaves the grant allowed would replay old version claims, for at most the interval. The interval is 0 everywhere deployed.

**Proposal.** Delete `user-token-assertions.ts` (181) and, in `user-token-boundary.ts`, the bookkeeping only it reads: the `create` wrapper and `storedTokens` (`:196-208`), `minted`, `startedAt`, `replayed` (`:340-367`) and the call (`:368-384`, replaced by `parseScope(response.scope)` for the audit's `scopes`). Delete `OAUTH_REFRESH_REUSE_INTERVAL_SECONDS` with it until `Q-REFRESH-PARALLEL` has a measured host; if the owner keeps the interval, keep only an identity-claim comparison for replayed responses (about 20 lines). docs/05 §3's "Actual signed/opaque token outputs and persisted token/grant state must agree before commit" becomes the pre-issuance check; the README boundaries line and `docs/id/oauth.mdx` "Response retry" change.

**A user would notice** nothing. **Tests:** the three fault tests go (−164 lines). **Risk at scale:** a Better Auth upgrade that changed token output would no longer fail closed at runtime; the suite's positive claim tests catch it at upgrade time. Saves one refresh-row read and two JWT decodes per exchange and refresh.

### A3 Simplify verified SSO: one check under the locks, Better Auth's request state

**Evidence.** `beforeTransaction` locks the user, both organisations and both providers, then runs `current()`; `resolve` runs the same `current()` again inside the same transaction a few statements later, and `beforeSession` runs it a third time, plus a freshness check on the `authTime` that `resolve` already checked (`verified-sso.ts:155-259`). Removing the second and third (probe 03a) fails only the two tests that fault the second call while letting the first pass (`verified-sso.integration.test.ts:682-728`), a state the held locks rule out except for a database failure, which the first call already maps. A throw in `beforeTransaction` is redirected with its code by the callback's catch, the same outcome as `resolve`'s `reject`.

The `AsyncLocalStorage` and `auth.ts`'s `handler` override exist to carry per-request state from the callback's before hook to the adapter hooks. Better Auth already runs every endpoint inside its own request state (`to-auth-endpoints.mjs:49-50`) and exports `defineRequestState`/`hasRequestState` from `@better-auth/core/context`, which ID already imports. Probe 03b replaced the store and deleted the override: same results, typecheck clean.

**What stays (A14).** `observe` on provider reads and `beforeTransaction` are needed by the plugin's construction: state is parsed and the provider read inside the callback (`sso/index.mjs:3800-3815`), with no hook before `runWithTransaction` (3961), whose first statement is native's provider lock (3962). `resolveUser` runs after that lock, so it cannot carry the lock order.

**Proposal.** Delete `current()` and its try/catch from `resolve` (6 lines), `beforeSession` and its call at `sso-origin.ts:118` (8), swap the ALS and `run` for `defineRequestState`, drop the `handler` override (4). About −25 source lines and the two mechanism tests (−47). Nothing visible; three fewer statements per link or reauthentication.

### A4 Delete upstream refresh-token storage and its key ring

**Evidence.** Nothing reads a stored upstream refresh token: no open route (`/get-access-token` and `/refresh-token` are closed, probe 09), no service, no job. The output transform decrypts it on every Better Auth account read for federation to ignore; the preflight decrypts every account only to prove it can. Discarding the value at write (probe 04b) fails seven tests, all of the storage mechanism. The token is a live credential at the customer's directory: Microsoft sign-ins request `offline_access` (`platform-applications.ts:12`), and generic OIDC rows without scopes get Better Auth's default, which includes it (`sso/index.mjs:3826`). It is held for `Q-AID-RECHECK`, whose design is undecided between iframe re-checks and refresh-token probes (docs/02:58).

**Cost today.** 45 µs per sign-in and per account read (probe 04), negligible; 3.7 KB per account; a third secret family generated, delivered and rotated by `bootstrap.yml:29,120-141`, `infra/pipeline/src/deploy.ts:95`, `charts/answerable/templates/id.yaml:20`, `infra/k8s/local/stack.ts:368`, `default.env`, `.env.example`, the README, OPERATIONS, docs/06, `onboard.mdx` and `reports/answerable-id-upstream-token-custody.md`. The exposure: a backup plus the key yields a Microsoft refresh token for every Entra user.

**Proposal.** Replace the plugin with a field transform that discards the value (about 10 lines), or stop requesting it (Q3). Delete `UPSTREAM_TOKEN_SECRETS` from env, the preflight's account scan (keep the signing-key scan), the bootstrap generation, the pipeline's required list, the chart and kind entries and the docs; the column stays (schema settled) and stays null. **A user would notice** nothing; with `offline_access` dropped, Entra's consent screen loses "Maintain access to data you have given it access to". **Migration:** none; existing ciphertext can be nulled by one update in a later release. **Returning later** costs the 77-line plugin from git, the variable and its bootstrap step, and each user's next sign-in before a token exists. **Tests:** `upstream-token-storage.test.ts` (77), most of `account-storage.integration.test.ts` (211), four federation cases and one preflight case go; the sign-in suites hold.

### A9 Unauthenticated refusals: a log line, not a row

**Evidence.** In process with the limiter off (the database's ceiling), 16 callers make ID write about 1,000 `oauth.token.rejected` rows a second with an unknown client, 1,130 with a known client and wrong secret, and 1,210 `auth.signin.rejected` rows with a forged callback state (probe 07); 300 and 192 bytes per row before indexes (the table grew 7.4 MB for 16,697 rows). Refused user code and refresh exchanges write nothing, so the machine path is the only grant that audits an unauthenticated caller. The unattributed rows carry no actor, tenant or target (`machine-audit.ts:104-135` records no IP; `signin-audit.ts:33-45` has IP and user agent): a request id, a time and a reason, which a log line holds. Nothing reads them programmatically (grep across `mcps`, `packages`, `infra`); `manage.mdx:104` and `sign-in.mdx:176` describe them.

**Bound in production.** Better Auth's limiter caps one address at 20 token requests a minute and 100 callbacks per 10 s per process (probe 08); a distributed caller is bounded only by Cloudflare.

**Proposal.** Write unattributed refusals with `logEvent` (request id, IP, reason) and keep the row once the client has authenticated (`stage !== "authentication"`), where it is tenant evidence. About −30 lines. **Tests:** 26 change (probe 12); 13 federation refusal cases would read the reason from the redirect's `error` parameter instead of the row. **Risk:** a customer that wants failed sign-ins in the database loses them (Q2).

### A11 Declare the two models instead of mounting the organisation plugin

**Evidence.** The plugin mounts 22 routes (all closed, probe 09), declares an `invitation` model with no table, a required `member.role` with no column (the schema test proves `addMember` throws on it) and `session.activeOrganizationId`, which `openapi.ts:95` deletes from the public document. ID uses only the `organization` and `member` declarations, for federation's adapter reads. Replacing the plugin with those two (probe 11) fails one test, which asserts the plugin's `addMember` exists; the OpenAPI drift test passes unchanged. **Proposal:** two models in `answerableSchema()`, drop `allowUserToCreateOrganization`, the `activeOrganizationId` entry in `openapi.ts` and the plugin case in `schema.integration.test.ts`. Nothing visible; 22 routes stop existing rather than being hidden.

### Challenged keeps

- **A13 native-* modules.** Each wrapper fails behaviour tests when made pass-through (probe 10). The plugin invalidates a refresh family by client and user (`introspect:1498-1527`), so one replayed token would delete that user's refresh tokens for that client in every organisation; ID confines it to the grant. Code-replay cleanup swallows `deleteMany` errors (`:1528-1544`); ID makes it a retryable 503 and revokes the grant. `withNativeClientAuthentication` keeps a `private_key_jwt` marker consumed when issuance rolls back. These are tenant policy (docs/05 §3, §4), not duplicates; `native-shapes.test.ts` pins the shapes they intercept.
- **A6 the evaluator.** Refresh is one transaction of 37 round trips, 31 statements and 7 locking reads (probe 05). Rows read more than once: the grant 4 times, the client 3 (authentication before the transaction, the share lock, native validation), the refresh-token row 3 (ID, native, the assertion), `jwks` 2, the user 2. Checks repeated between layers: liveness (member, user, organisation, account, provider) in `currentGrantAuthentication` and again in the policy statement; the pair's link in the policy and in native's resource check. "Continue" re-locks the four target rows and re-checks authentication right after `createResourceGrant` did both (50 round trips, 13 locking reads). At 10,000 users with 900 s tokens the need is 11.1 refreshes a second; one process does 22.3 sequentially in process (the schema audit measured about 135/s concurrent). The CPU (22.9 ms user per refresh) is mostly Drizzle building SQL: 31% of samples in Drizzle's `is`, `sql`, `mergeQueries` and dialect builders, 12% `pg` protocol, 6% Better Auth's adapter transforms, 3% the provider. Fewer statements is an optimisation; nothing is proposed. The binding limit at that scale is U1, not this.
- **A7 machine grants.** 15 round trips and 3 locking reads per `client_credentials`; one 1.55 KB event per token. `packages/id-admin` reuses a token until 30 s before expiry (`index.ts:98-121`), so issuance is about one per server process, audience and scope per token lifetime: negligible rows.
- **A8 allowlist.** Exact: 16 open routes of 111 mounted, each with a consumer. A denylist would list 95 routes and open whatever a Better Auth upgrade adds; the allowlist also supplies the public OpenAPI's operation ids, summaries and request bodies (`openapi.ts:85-135`).
- **A10 secret ring.** Better Auth reads `BETTER_AUTH_SECRETS` itself when `secrets` is absent (`create-context.mjs:69`), but its parser puts a malformed entry, secret included, in the thrown message (`secret-utils.mjs:18-22`); ID's 28-line parser refuses without echoing and requires 32 characters where Better Auth warns. It is the only way to rotate a leaked `BETTER_AUTH_SECRET`, which encrypts the signing keys.
- **A5, A12, A11b, A14** as in the table.

## 4. Unsafe or wrong

**U1 (capacity, blocks enterprise use): Better Auth's default rate limits refuse ordinary traffic from shared addresses.** `createAuth` sets no `rateLimit`, so production uses the defaults, keyed on the resolved client address per process (probe 08, `NODE_ENV=production`, one address behind a trusted proxy):

| Route | Allowed before 429 | Source |
| --- | --- | --- |
| `POST /auth/sign-in/sso` | 3 per 10 s | `rate-limiter/index.mjs:302-312` (`/sign-in*`) |
| `GET /auth/oauth2/authorize` | 30 per minute | `authorize-BmTe2VYG.mjs:5241-5245` |
| `POST /auth/oauth2/token` | 20 per minute | `authorize-BmTe2VYG.mjs:5236-5240` |
| `GET /auth/get-session`, `GET /auth/sso/callback` | 100 per 10 s | `create-context.mjs:171-173` |

An enterprise office signs in through one egress address: 18 sign-ins a minute per ID replica, so a morning wave of a few hundred people meets 429s. A server-side host (OmniChat, LibreChat) refreshes every user's token from its own address: with 900 s access tokens, 300 active users already need 20 refreshes a minute and the 21st gets 429, which a host usually turns into re-authorisation. Two replicas double the figures. `ip-metadata.test.ts:113-151` asserts the 20-a-minute token limit, so the number is known, but no doc states it as a capacity limit (docs/06 says only that production "turns on the provider's rate limiter"). **Reproduce:** `cd apps/id && NODE_ENV=production TEST= bun /tmp/v0-code-audit/probes/a/08-production-limits.ts`. Not fixed; the remedy is a deliberate `rateLimit` configuration (`customRules`, or the provider's `rateLimit.token`/`authorize`) sized to the release checklist's topology (E6), alongside `Q-ADMIN-API-RATE-LIMIT`.

No security hole was found in the auth layer.

## 5. Open questions for the owner

- **Q1 (A2/A2b).** Delete the issuance assertions with the refresh reuse interval (simplest; the interval is 0 everywhere), or keep the interval for `Q-REFRESH-PARALLEL` with a 20-line replay-only claim check?
- **Q2 (A9).** Are failed sign-ins and failed client authentications evidence the product keeps in the database (a customer's audit or SIEM export), or operational signals (a log line)? Neither can be attributed to a tenant.
- **Q3 (A4).** Discard the upstream refresh token at write, or stop asking for it (`offline_access` out of the Microsoft scopes and the OIDC default), which also removes Entra's "maintain access" consent line?

## 6. Measured numbers

| Number | Source |
| --- | --- |
| 1,558 tests, 133 files, 476 s, 100% lines/functions | Probe 00 |
| Per phase (round trips / statements / locking reads / transactions / ms wall, in process): authorize 5/5/0/0/43; flow details 10/8/1/1/22; continue 50/40/13/1/70; consent 35/29/7/1/56; code exchange 43/37/7/1/76; refresh 37/31/7/1/39–47; userinfo 31/25/6/1/45; client credentials 15/13/3/1/90–216; refused client credentials 4/2/0/1/8; refused refresh 1/1/0/0/4; forged SSO callback 4/4/0/0/8 | Probe 05 (`05-roundtrips.log`) |
| 300 sequential refreshes: 22.3/s, 44.9 ms each, 34.8 ms in the database, 22.9 ms user + 2.4 ms system CPU each | Probe 05 |
| Refresh CPU samples: 31% Drizzle query building, 12% `pg` protocol, 6% Better Auth adapter, 3% provider, 2% route-table construction | Probe 05 (`05-profile-sources.txt`, 12,778 samples at 100 µs) |
| 11.1 refreshes/s needed at 10,000 users with 900 s tokens | 10,000 ÷ 900 |
| Upstream transform: 45.4 µs encrypt, 45.6 µs decrypt, 1,800 → 3,686 bytes | Probe 04 |
| Unauthenticated rows per process, limiter off: ~1,000/s unknown client, ~1,130/s wrong secret, ~1,210/s forged callback; 300/300/192 B per row; audit table 7.4 MB after 16,697 rows | Probe 07 |
| Event sizes: `oauth.token.issued` 1,552 B, `oauth.token.rejected` with decision 707 B, `client.created` 740 B | `pg_column_size` on the test database after the probes |
| Production limits per address per process: sign-in 3/10 s, authorize 30/min, token 20/min, get-session and callback 100/10 s | Probe 08 |
| 111 Better Auth routes mounted, 16 open; by plugin: core 32 (3), organization 22 (0), jwt 2 (1), sso 14 (2), verified-sso 2 (2), oauth-provider 37 (8), open-api 2 (0) | Probe 09 |
| Spike failures: assertions 3; verified-SSO re-checks 2; request state 0 more; upstream discard 7; organisation plugin 1; unattributed rows 26; native wrappers 4/7/3/2/1 | Probes 02, 03a, 03b, 04b, 11, 12, 10 |
