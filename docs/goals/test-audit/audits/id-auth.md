# Test audit, area A: Answerable ID authentication and federation

Audited on 2026-10-03 against `491c9e9` in an isolated worktree, with a disposable Postgres on port 47433. Every number below comes from a run, a grep or a probe; the commands and raw outputs are in the scratchpad folder `audit-a/` next to the brief. No source or test was changed: every probe edit was reverted, and `git status --short` printed nothing at the end.

## Summary

- **Verdict: worth keeping, but too slow and less sharp than it looks.** The tests cover most of the documented invariants. 24 mutation probes on the area's security checks: 19 caught, 15 of them by a test on the production path (HTTP or end-to-end SSO). But 26% of cases (191 of 722) are duplicate, coverage-fill or implementation-coupled, and three security checks are held by nothing.
- **Counts.** 54 files, 21,408 test lines, 722 tests (492 call sites). By case: INV 401, CON 58, BEH 72, DUP 115, FILL 53, IMPL 23. The area takes 292.0 s and 260.6 s of the 503.9 s and 456.6 s of test-case time in two full runs; the full suite took 527.4 s and 477.1 s wall.
- **Finding 1: the biggest file never touches production.** `auth/user-grant-boundary.integration.test.ts` (4,007 lines, 122 cases, 105.6–118.4 s, about 40% of the area's time) builds its own `betterAuth` with a test-written `oauth2Token` endpoint. It never calls `createAuth` or `createApp`. It proves the shared building blocks; 13 of its 48 call sites repeat facts that `user-oauth.integration.test.ts` proves on the real app. Its refresh-denial matrix and lock races have no production-path equivalent.
- **Finding 2: the suite runs with Better Auth's origin and CSRF checks off.** Better Auth 1.7.2 sets `skipOriginCheck` whenever `NODE_ENV=test` (`create-context.mjs:210`). Measured on the real app, a cross-site `POST /auth/sign-out` with a session cookie and an off-origin `callbackURL` on `/auth/sign-in/sso` each return 200 under the suite's configuration and 403 with the checks on. Only `verified-sso:787` turns them back on; a deployment started with `NODE_ENV=test` would also lose them, and skip the runtime-role check (`runtime.ts:32`).
- **Finding 3: three security checks are held by no test in the whole suite** (one full run with the mutations applied: 2,040 pass, 0 fail): an upstream ID token **without** `email_verified` is accepted (`federation.ts:169`); the token-exchange `resource` comparison (`user-token-boundary.ts:282`); the flow-to-signed-query binding (`user-oauth-flow.ts:174`). Two more uncaught guards are redundant behind database triggers (P3, P15). Also untested: an unregistered `redirect_uri`, an expired code, and upstream tokens with a wrong `aud`, an expired `exp` or an unknown key.
- **The suite is not hermetic** (the coordinator's two findings, mechanisms confirmed): `testEnvironment()` leaves `betterAuthSecrets` undefined, so Better Auth reads `BETTER_AUTH_SECRETS` from the process; and Bun's runtime transpiler cache makes the two files over 50 KB in this area fail when run alone (a cache hit, then the font is parsed as JavaScript).

## Inventory

Per file: lines; tests (JUnit cases); summed test-case time in two full-suite runs (`full1.xml` at 527.4 s wall, then `full-uncaught5.xml` at 477.1 s wall, the second with five uncaught probe edits that changed no result); wall time and result when run alone (`bun test --timeout 15000 ./<file>`, coverage on, so exit 1 from the coverage threshold is expected and ignored).

The two files that fail alone pass alone with `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`:
- `user-oauth`: 51.2 s, 59 pass.
- `user-grant-boundary`: 115.7 s with 121 pass and 1 fail, then 122 pass on each of two reruns. See [The suite is not hermetic](#the-suite-is-not-hermetic).

Time is concentrated. Five files hold 265 cases that each run `createAdminFixture()` in `beforeEach`: `user-grant-boundary`, `user-oauth`, `verified-sso`, `tenant-authentication` and `pages.integration`.
- Measured alone, the fixture costs 543, 619 and 831 ms (minimum, median and maximum of 10 runs).
- The per-case floor in those files is 0.64–0.73 s.
- So about 160 s of the area's 260–292 s is fixture setup: truncate 21 tables, start an OIDC issuer, create 3 organisations and run 9 IdP sign-ins.
- Two tests wait out the fixed 5 s body deadline (`requestBodyTimeoutMs`), one each in `runtime.test.ts:186` and `app.test.ts:650`: 10 s for one fact.

| file | lines | tests | suite s (run 1 / run 2) | alone wall s, result | layer | what it proves |
|---|---:|---:|---:|---|---|---|
| `src/auth/user-grant-boundary.integration.test.ts` | 4007 | 122 | 118.41 / 105.64 | 0.48 FAILS (font parse) | test-built Better Auth over HTTP, service, query (Postgres) | shared token-issuance building blocks, refresh denial after authority changes, lock races, grant-context triggers and RLS; not production `createAuth` |
| `src/auth/user-oauth.integration.test.ts` | 2149 | 59 | 57.66 / 48.85 | 0.33 FAILS (font parse) | HTTP on production `createApp` and `createAuth`, restricted role | the production user OAuth flow: PKCE, consent, code, refresh, replay, revocation, discovery, JWKS, audit rollback |
| `src/auth/verified-sso.integration.test.ts` | 1326 | 41 | 32.54 / 32.28 | 31.11 pass | HTTP, end-to-end SSO via in-process issuer | linking and reauthentication, five-minute freshness, races and rollback |
| `src/auth/tenant-authentication.integration.test.ts` | 965 | 32 | 24.12 / 23.48 | 23.70 pass | HTTP admin plus service lock races | own-tenant SSO authority, provider revision, rechecks after lock waits |
| `src/services/federation.integration.test.ts` | 1304 | 50 | 11.65 / 9.33 | 11.29 pass | HTTP, end-to-end SSO | sign-in claim policy and reject codes, origin capture, token storage, platform applications |
| `src/http/pages/pages.integration.test.ts` | 461 | 11 | 8.29 / 6.85 | 8.23 pass | HTTP pages, real auth and fake IdP | browser login, selection and consent flow |
| `src/auth/grant-locks.integration.test.ts` | 541 | 15 | 5.56 / 5.12 | 6.13 pass | production `createAuth` handler with pause hooks | client_credentials issuance ordering against writers |
| `src/app.test.ts` | 801 | 33 | 5.24 / 5.22 | 5.48 pass | HTTP on `createApp` with stub auth | auth allowlist, CORS, body guard, request ids, OpenAPI switches |
| `src/runtime.test.ts` | 374 | 11 | 5.06 / 5.05 | 5.42 pass | process start with injected factories | startup order, role check, body cap, pool close, log redaction |
| `src/auth/machine-audit.integration.test.ts` | 889 | 19 | 4.43 / 3.21 | 4.14 pass | HTTP on the real app | machine issuance and rejection audit |
| `src/services/sso-providers.integration.test.ts` | 544 | 17 | 3.56 / 2.44 | 3.11 pass | service | SSO configuration changes, grant revocation, platform credentials |
| `src/http/token-identity.integration.test.ts` | 288 | 13 | 3.45 / 2.87 | 3.77 pass | HTTP, query | machine token claims; disable, rotation and deletion revoke |
| `src/services/diagnostics.integration.test.ts` | 258 | 11 | 2.60 / 1.46 | 2.03 pass | service | sign-in diagnostics verdicts |
| `src/services/users.integration.test.ts` | 499 | 9 | 1.96 / 1.64 | 1.68 pass | service | user disable and erasure effects |
| `src/bootstrap.integration.test.ts` | 261 | 8 | 1.86 / 1.61 | 1.54 pass | service | idempotent platform seeding bound by system binding |
| `src/auth/ip-metadata.test.ts` | 111 | 9 | 1.67 / 1.86 | 1.76 pass | production subprocess plus in-process | proxy walk, production `untrusted_ingress` |
| `src/services/sessions.integration.test.ts` | 374 | 7 | 1.51 / 1.38 | 1.54 pass | service | administrative session revocation effects |
| `src/auth/application-secrets.integration.test.ts` | 138 | 1 | 0.85 / 0.82 | 1.34 pass | HTTP plus `api.signJWT` | `BETTER_AUTH_SECRETS` rotation and signing custody |
| `src/auth/machine-provider.integration.test.ts` | 513 | 9 | 0.41 / 0.40 | 0.79 pass | test-built Better Auth | machine policy, assertion consumption |
| `src/http/pages/pages.test.ts` | 550 | 14 | 0.41 / 0.37 | 0.61 pass | HTTP pages with stub auth | page routing, server-built callbacks, headers, escaping, copy |
| `src/http/root.integration.test.ts` | 252 | 1 | 0.27 / 0.26 | 1.16 pass | HTTP, real stack | root bearer lifecycle and lock |
| `src/http/token.integration.test.ts` | 330 | 13 | 0.15 / 0.12 | 0.82 pass | HTTP | client_credentials wire format and refusals |
| `src/openapi.integration.test.ts` | 84 | 2 | 0.08 / 0.07 | 0.48 pass | snapshot | OpenAPI snapshots match the generated documents |
| `src/auth/account-storage.integration.test.ts` | 237 | 2 | 0.06 / 0.05 | 0.52 pass | adapter | upstream token encryption on every adapter path, key rotation |
| `src/services/platform-users-context.integration.test.ts` | 358 | 7 | 0.04 / 0.05 | 1.27 pass | service | platform context guard |
| `src/auth.integration.test.ts` | 41 | 2 | 0.04 / 0.04 | 0.32 pass | composition | `createAuth` wiring |
| `src/env.test.ts` | 492 | 35 | 0.02 / 0.04 | 0.07 pass | unit | environment parsing, production rules, secret rings, `default.env` inventory |
| `src/http/principal.test.ts` | 790 | 47 | 0.01 / 0.01 | 0.19 pass | unit with mocked dependencies, real jose | admin admission, bearer verifier, JWKS cache, denial audit |
| `src/services/sso-test.test.ts` | 336 | 19 | 0.01 / 0.01 | 0.13 pass | unit with injected fetch | SSO connectivity probe and SSRF guards |
| `src/auth/logging.test.ts` | 70 | 2 | 0.01 / 0.00 | 0.25 pass | unit | auth error boundary and log contract |
| `src/auth/native-shapes.test.ts` | 40 | 2 | 0.00 / 0.00 | 0.02 pass | greps Better Auth dist text | pins vendor internals the wrappers depend on |
| `src/http/validation.test.ts` | 130 | 5 | 0.00 / 0.00 | 0.06 pass | unit | validation error envelope |
| `src/http/problem.test.ts` | 218 | 15 | 0.00 / 0.00 | 0.06 pass | unit | problem+json envelope and database error mapping |
| `src/http/authorize.test.ts` | 209 | 12 | 0.00 / 0.00 | 0.08 pass | unit, mocked db | admin route authorisation middleware |
| `src/http/signin-audit.test.ts` | 122 | 7 | 0.00 / 0.00 | 0.07 pass | unit, stub db | rejected sign-in audit |
| `src/auth/member-permission.test.ts` | 191 | 4 | 0.00 / 0.00 | 0.05 pass | unit | scope evaluation, exact pair, refresh ceiling |
| `src/auth/upstream-token-storage.test.ts` | 76 | 3 | 0.00 / 0.01 | 0.06 pass | unit | key ring and ciphertext formats |
| `src/services/federation.test.ts` | 356 | 12 | 0.00 / 0.00 | 0.07 pass | unit, fake adapter answering by call order | `resolveFederatedUser` branches |
| `src/http/pagination.test.ts` | 48 | 4 | 0.00 / 0.00 | 0.05 pass | unit | limit and cursor contract |
| `src/http/pages/gateway.test.ts` | 86 | 2 | 0.00 / 0.00 | 0.03 pass | unit | header forwarding to Better Auth |
| `src/services/actor.test.ts` | 52 | 3 | 0.00 / 0.00 | 0.03 pass | unit | audit actor shape |
| `src/auth/sso-origin.test.ts` | 62 | 2 | 0.00 / 0.00 | 0.12 pass | unit, fake hook context | origin hook guards |
| `src/auth/platform-applications.test.ts` | 99 | 4 | 0.00 / 0.00 | 0.10 pass | unit | platform credentials injection |
| `src/auth/audit-hooks.test.ts` | 58 | 1 | 0.00 / 0.00 | 0.07 pass | unit, fake executor | sign-out audit row |
| `src/http/pages/login-routing.test.ts` | 69 | 5 | 0.00 / 0.00 | 0.02 pass | unit | slug, hint and signed-query routing |
| `src/auth/narrow-authorization-code.test.ts` | 42 | 1 | 0.00 / 0.00 | 0.02 pass | unit | code narrowing throw |
| `src/services/client-secrets.test.ts` | 25 | 2 | 0.00 / 0.00 | 0.02 pass | unit | client secret hashing |
| `src/http/pages/error-copy.test.ts` | 79 | 6 | 0.00 / 0.00 | 0.02 pass | unit | literal error copy |
| `src/lib/user-agent.test.ts` | 20 | 1 | 0.00 / 0.00 | 0.02 pass | unit | user-agent bound |
| `src/auth/grant-scopes.test.ts` | 39 | 3 | 0.00 / 0.00 | 0.03 pass | unit | scope intersection |
| `src/http/auth-allowlist.test.ts` | 8 | 1 | 0.00 / 0.00 | 0.02 pass | unit | token endpoint allows POST only |
| `src/services/root-secret.test.ts` | 11 | 4 | 0.00 / 0.00 | 0.02 pass | unit | constant-time secret comparison |
| `src/lib/id.test.ts` | 14 | 1 | 0.00 / 0.00 | 0.02 pass | unit | UUIDv7 generation |
| `src/lib/service-url.test.ts` | 11 | 1 | 0.00 / 0.00 | 0.02 pass | unit | trailing slash removal |
| **total (54 files)** | 21408 | 722 | 292.0 / 260.6 | | | |

## Classification

**How the tests were classified.** Every call site was classified by reading it against the docs. Six read-only reviewers each took one group of files. Two of their claims were contradicted by measurement and are corrected in the tables below: how much page copy breaks on an edit, and whether app-served discovery is covered.

A loop (`for … test(…)`) is one row, with its generated cases in `n`. Totals by group (call sites, then cases):

| group | files | call sites | cases | INV | CON | BEH | DUP | FILL | IMPL |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `user-grant-boundary` | 1 | 48 | 122 | 33 | 0 | 0 | 13 | 2 | 0 |
| user OAuth, token, OAuth units | 9 | 81 | 107 | 40 | 13 | 2 | 9 | 11 | 6 |
| SSO and federation | 7 | 80 | 114 | 54 | 1 | 6 | 10 | 8 | 1 |
| tenant, machine, locks, logging | 9 | 57 | 92 | 41 | 5 | 2 | 5 | 3 | 1 |
| pages and HTTP | 13 | 118 | 151 | 24 | 13 | 28 | 27 | 18 | 8 |
| env, runtime, bootstrap, lib, services | 15 | 108 | 136 | 27 | 15 | 22 | 32 | 7 | 5 |
| **call sites** | **54** | **492** | | **219** | **47** | **60** | **96** | **49** | **21** |
| **cases** | | | **722** | **401** | **58** | **72** | **115** | **53** | **23** |

**Read the INV count with care.** 107 of the 401 INV cases are in `user-grant-boundary`. It drives a token endpoint written inside the test (lines 225–529: `oauthProvider` plus a hand-written `oauth2Token` wrapper and claims extension, then `betterAuth(authOptions)` at :527). It never calls `createAuth`: `grep -n "createAuth\|createApp" src/auth/user-grant-boundary.integration.test.ts` finds nothing.

Its invariants hold for the shared building blocks it calls: `userResourcePolicy`, `createResourceGrant`, `withNativeCodeReplay`, `withNativeRefreshFamily`, `withNativeTokenCleanup`, the grant triggers and RLS. They do not hold for `createUserTokenBoundary().handle`, the production token path. Probes P5, P6 and P7 edited production-only code; this file cannot see such changes, because it imports neither `user-token-boundary.ts` nor `user-oauth-flow.ts`.

**Question 4, pages:**
- The 37 page call sites (38 cases) split as follows:
  - 20 check routing, redirects, escaping, headers or the browser flow (INV/BEH).
  - 12 are copy or branch fill (FILL/IMPL), 5 of them in `error-copy.test.ts`.
  - 3 are DUP and 2 are CON.
- Most still assert English copy along the way: `grep -c 'toContain('` finds 45 lines in `pages.test.ts` and `pages.integration.test.ts`, 15 of them `not.toContain`.
- Measured: an edit to the four most-asserted strings fails 12 page tests. They include `pages.integration.test.ts:406` "unknown and disabled domains do not start SSO", whose behaviour did not change.
- Open redirect: pages never take a redirect target from the request. Every `callbackURL` is built from `serviceOrigin` (`routes/login.ts`, `routes/oauth.ts`, `routes/security.ts`), and `pages.test.ts:110` and `:167` hold the local redirects.
- CSRF: the pages rely on forwarding the browser's `Origin` to Better Auth (`gateway.ts:28`). Under test Better Auth ignores it (see Gaps). So the only tests that catch a broken forward are `gateway.test.ts:7` and `pages.integration.test.ts:320`, which assert the forwarded header itself (probe P20). Nothing asserts a refusal.

The per-file tables follow. Abbreviations: UO is `user-oauth.integration.test.ts`; UGB is `user-grant-boundary.integration.test.ts`; MOCK-BA means a Better Auth built or altered by the test.

### User grant boundary (`src/auth/user-grant-boundary.integration.test.ts`)

4,007 lines, 48 call sites, 122 generated cases, 5,482 assertions, 118.4 s (full1.xml; min case 0.69 s = setup floor; lock-timeout cases ~2.9 s). All need Postgres.

**Read this first.** The file does not drive production. `beforeEach` (122-530) builds its own `betterAuth` with `oauthProvider` + a test-written `oauth2Token` wrapper (≈ lines 238-529, ~290 lines) and a claims extension that evaluates policy, binds the code and writes a `verification` marker. Production composes differently: `createAuth` → `userOAuthProvider` (src/auth/user-provider.ts:56) → `createUserTokenBoundary().handle` (src/auth/user-token-boundary.ts:193-424), which runs policy/locks/`bindGrantCode` in a pre-flight *before* the native endpoint, adds `currentGrantAuthentication`, `invalid_target`/`invalid_scope` checks, `assertUserTokenResponse` and `recordUserOAuth` audit. The test's `postLogin.consentReferenceId` calls `createResourceGrant` directly (no selection/consent flow). Header comment (85-87) "Production still allows machine grants alone" is stale: the file landed 2026-09-10 (a89d9bf2), production user OAuth landed next day (2c53316c) with its own suite `src/auth/user-oauth.integration.test.ts` (production `createAuth`+`createApp`).
So "HTTP" tests here are `MOCK-BA`: they prove the shared building blocks (`withNativeClientAuthentication`, `withNativeCodeReplay`, `withNativeRefreshFamily`, `withNativeTokenCleanup`, `bindGrantCode`, `lockResourceGrantPolicy`, `userResourcePolicy`, `createResourceGrant`, the services' revocations), not `handle`.

Abbrev: UO = src/auth/user-oauth.integration.test.ts (production composition).

| file:line | test title (shortened ok) | n | layer | class | reason |
|---|---|---|---|---|---|
| 658 | code redemption and refresh preserve server-bound membership despite a supplied tenant | 1 | MOCK-BA | DUP | UO:983 "production provider binds native tenant selection, consent and code to one grant" (grant_id/organization fixed across refresh) + UO:1477 (cached replay rechecks policy). Unique bits are IMPL: `expiredCreate` "context has expired" (667), `rejectNested` autocommit guard (675), `claimsCalls` counts; the supplied `organization` field is never read by harness or production. |
| 760 | rejected issuance rolls back extension write and code consumption | 1 | MOCK-BA | DUP | UO:1560 "token audit failure preserves the code for a safe retry", UO:494 divergent claim rolls back code. Fault is thrown from the harness claims (`denyIssuance`, 300), a point production lacks. |
| 799 | rejected native user grant still consumes its private-key assertion | 1 | MOCK-BA | DUP | UO:286 "private-key authentication stays consumed when a production code exchange rolls back" (+ machine-provider:193). Lost extras: concurrent duplicate jti → one 400 + one 403 (872-882); JWKS emptied between auth and issuance → 401 (856-866). Move those ~20 lines to UO:286 if wanted. |
| 919 | public native clients still require the user's code and PKCE proof | 1 | MOCK-BA | DUP | UO:261 "registered public clients still need the native PKCE proof". |
| 965 | replayed authorization code revokes its refresh tokens without touching another grant | 1 | MOCK-BA | DUP | UO:1168 "replaying a code revokes its family and leaves a separate authorisation usable". Only adds: other grant is in tenant B; revokedAt asserted. |
| 1028 | issuance errors never commit extension writes even when shaped as invalid_grant (2 inner) | 1 | MOCK-BA | DUP | UO:546 "missing native ID token rolls back code, refresh material and issuance audit", UO:1560. The invalid_grant-shaped case only exercises the harness's own commit exemption (test 497-506), which production does not have. |
| 1065 | failed native replay cleanup is retryable and rolls back partial deletion (4 inner: model×db) | 1 | MOCK-BA | INV | Only proof of `withNativeTokenCleanup` failure branch (native-token-cleanup.ts:23-31) + code-replay savepoint: 503 Retry-After, grant stays revoked, token rows restored, retry finishes cleanup. Real DB faults reach this in production (same chain at user-token-boundary.ts:353-385). Merge with 1377. |
| 1163 | one user's two tenant grants independent; revoked cached refresh cannot return tokens | 1 | MOCK-BA | INV | Revoked context denies even a cached (within reuse interval) refresh; tenant B untouched; `grant_context_immutable` blocks un-revoking (only test of that trigger besides 1227). Matrix cell of the refresh-denial table. |
| 1227 | grant provenance cannot be forged or rewritten; expiry denies context lookup | 1 | DB | INV | docs/04:36,174. Only tests of triggers `grant_context_immutable` (7 patches) and `grant_authentication_provenance` (3 patches) — grep finds them nowhere else; plus `userResourcePolicy` → `context` for expired / foreign client / foreign resource. |
| 1299 | native refresh reuse invalidates only its immutable grant family | 1 | MOCK-BA | DUP | UO:1238 "reusing a rotated refresh token revokes only that native family and records the outcome". Adds: rows deleted, other family in tenant B. |
| 1377 | refresh-family cleanup outage preserves revocation while restoring token rows (2 inner) | 1 | MOCK-BA | INV | Refresh-family twin of 1065: revocation barrier survives `rollback to savepoint native_family_cleanup` (native-refresh-family.ts:83-90). Only test. |
| 1449 | a provider success after family invalidation cannot return token material | 1 | MOCK-BA | FILL | Hand-written `run` drives the defensive throw native-refresh-family.ts:74-77; pinned provider never reaches it (native-shapes.test.ts pins its shape). Asserts message wording. |
| 1493 | membership removal and reinstatement cannot revive native refresh in that tenant | 1 | MOCK-BA | INV | docs/03:70-71. Matrix cell (refresh denial after authority change). Service half held by members.integration:476. No production-composition equivalent. |
| 1558 | organisation disable/re-enable cannot restore A refresh or revoke B through client ownership | 1 | MOCK-BA | INV | Matrix cell; unique nuance: client owned by A, B's grant survives A's disable. Service half: organizations.integration:436/:308. |
| 1626 | global disable/re-enable cannot restore cached refresh grants in either tenant | 1 | MOCK-BA | INV | docs/03:72. Matrix cell. Service half: users.integration:397. |
| 1681 | administrative ${mode} session revocation blocks native refresh across its tenant grants | 2 | MOCK-BA | INV | docs/03:69. Matrix cell. Service half: sessions.integration:301/:324. |
| 1753 | resource disable/re-enable deny cached and rotated refresh in both tenants | 1 | MOCK-BA | INV | Matrix cell. Service half: resource-grants.integration:102. |
| 1804 | client disable/re-enable deny cached and rotated refresh in both tenants | 1 | MOCK-BA | INV | Matrix cell. Service half: client-grants.integration:110. |
| 1855 | secret rotation denies old tenant refresh grants even with the new credential | 1 | MOCK-BA | INV | Matrix cell + old secret → 401, new code works. Service half: client-grants.integration:300. |
| 1931 | secret rotation after initial client authentication denies in-flight ${kind} | 2 | MOCK-BA | INV | Only race between client authentication and grant transaction (hook `afterAuthentication`, 365). Asserts all contexts revoked, fresh credentials cannot revive. |
| 2003 | code replay revokes its context after all native token rows have disappeared | 1 | MOCK-BA | INV | Replay revocation does not depend on token rows existing. Table cell with 965/2206. |
| 2033 | code binding rejects missing contexts and duplicate code identity | 1 | DB | INV | Only tests of `bindGrantCode` refusals and constraints `grant_contexts_authorization_code_id_unique`, `grant_contexts_code_check`; late binding blocked by immutability. |
| 2089 | another authenticated client cannot revoke a code's grant or token rows | 1 | MOCK-BA | INV | `withNativeCodeReplay` clientId scoping (native-code-replay.ts:41-58,64-73). Note production pre-flight rejects a foreign client before replay cleanup can run (user-token-boundary.ts:315-333), so this is defence in depth. Refresh analogue on production: UO:1849. |
| 2146 | unexpected success during code cleanup cannot release tokens or restore its grant | 1 | MOCK-BA | FILL | Hand-written `run` drives the defensive throw native-code-replay.ts:82-83; unreachable with the pinned provider. Asserts message wording. |
| 2206 | JWT-only code issuance retains replay authority without refresh or access-token rows | 1 | MOCK-BA | INV | Replay of a code with no stored rows still revokes the context. Table cell with 965/2003. |
| 2233 | native user issuance requires an exact pair assignment despite client login permission | 1 | MOCK-BA | DUP | Same denial as 2294 mode "resource-only" (deletes the same pair entitlement); runtime-role:1095 also removes the pair entitlement → `scope`. Only extra: tenant B still works. |
| 2257 | cached refresh rechecks renewal capability before claims run | 1 | MOCK-BA | DUP | UO:1477 "cached native refresh responses recheck policy and record replay separately" + UO:1129 "login-only OAuth ... needs a separate renewal capability". |
| 2294 | native user policy denies ${mode} authority substitution | 10 | MOCK-BA | INV | docs/03:60 permission intersection. Each cell pays authorize+redeem to reach `userResourcePolicy`; an SVC-level table on `userResourcePolicy` holds the same (evaluator cases also in member-permission.test.ts, runtime-role:1095). |
| 2437 | narrowed native refresh cannot regain identity scopes from the original grant | 1 | MOCK-BA | DUP | UO:344 "refresh survives browser sign-out and can narrow resource scopes without changing tenant" (narrow, widen → 400, final has no refresh_token/id_token); UO:1977 widen → invalid_scope. |
| 2474 | native resource filtering precedes code claims policy evaluation | 1 | MOCK-BA | DUP | UO:765 "native configured expiry and identity-scope filtering determine the full returned contract" (allowedScopes narrowed → scope/refresh row = resource scope, no id_token). |
| 2500 | user policy decision preserves exact sources and rejects widening its original context | 1 | SVC | INV | Only parity check between runtime `userResourcePolicy` and the admin `memberAccess` explanation (same sources/evidence); `proof:wider` → scope; unknown id → context. |
| 2611 | group-derived pair permission records membership evidence and stops when group is disabled | 1 | MOCK-BA | INV | Group disable is a live-evaluation denial (no revocation write); matrix cell of refresh denial. Evidence shape partly in db/queries/access.integration:743/873. |
| 2699 | native context records the actual authenticated session and requested scope maximum | 1 | SVC | INV | docs/04:174; stored `requestedScopes` caps later refresh. Small; merge with 2500. |
| 2790 | ${change} committing first prevents waiting resource grant creation | 9 | SVC | INV | docs/05:62 revocation-first denies. Real `createResourceGrant` + real row locks, proven blocked via `pg_blocking_pids`. Only user-grant creation race proof. |
| 2859 | resource grant creation commits before ${change}; later policy denies the stored context | 9 | SVC | INV | docs/05:62 issuance-first. Pins which changes revoke (all but unlink) vs deny live. |
| 2946 | resource grant creation times out without partial state and retries after writer commits | 1 | SVC | INV | Lock timeout → 503 `temporarily_unavailable`, nothing written, retry works. Real lock, not injected (3.06 s: waits lock_timeout). |
| 2986 | resource grant creation rejects missing or mismatched provenance | 1 | SVC | INV | 7 patched inputs → access_denied with no rows; scope dedupe, lifetime arithmetic. Lifetime TypeError (create-resource-grant.ts:39) part is FILL. Overlaps tenant-authentication.integration:184. |
| 3034 | resource grant creation rejects ${invalidation} before inserting provenance | 9 | SVC | INV | Live-state admission table; merge with 2986 into one table. |
| 3132 | native ${kind} issuance holds policy until commit before ${change} | 20 | MOCK-BA | INV | docs/05:62 issuance-first. Pause hook `afterPolicy` sits in the harness claims; for code the harness takes locks inside claims (271-277), production takes them in pre-flight — production lock window not exercised. |
| 3259 | native ${target} lock contention is retryable without consuming the code | 4 | MOCK-BA | INV | Real row locks → 503 Retry-After, code still redeemable. ~2.9 s each (lock_timeout). 4 cells = 4 lock steps; 1-2 suffice. |
| 3341 | ${change} committing first prevents waiting native issuance | 9 | MOCK-BA | INV | docs/05:62 revocation-first. Same change list as 3132; each cell also re-asserts `lockResourceGrantPolicy({})` "active authentication transaction is required" (3446-3448) — FILL tail ×9. |
| 3452 | ${change} waits for approved native ${kind} issuance to commit | 6 | MOCK-BA | INV | Issuance-first for user-level writers (disable/session/all-sessions); same shape as 3132. |
| 3531 | erasing a client owner waits for another user's locked grant before cascading the client | 1 | SVC | INV | Owner-user lock in `lockResourceGrantTargets` (lock-resource-grant-policy.ts:25-37) for the issuance side; creation side is 2859 erase-owner. |
| 3628 | ${change} committing first denies waiting native issuance | 3 | MOCK-BA | INV | Revocation-first for user-level writers; same shape as 3341. |
| 3695 | ordinary native sign-out preserves delegation while later admin revocation stops it | 1 | MOCK-BA | DUP | UO:344 (refresh survives sign-out) + sessions.integration:324 "revoke-all includes persistent grants whose browser sessions have already disappeared". |
| 3747 | SSO ${mode} denies tenant A cached and rotated refresh while preserving tenant B | 3 | MOCK-BA | INV | docs/03:89, 04:174. Matrix cell. Service half: sso-providers.integration:261 (incl. restore never revives). |
| 3819 | grant contexts are hidden from an unscoped restricted broker connection | 1 | DB | DUP | 3836 asserts the same unscoped `runtime.db` read returns [] (3862, again 3983). |
| 3836 | grant RLS scopes isolate tenants, clients and admission sessions and restore pooled settings | 1 | DB | INV | docs/04:72, 05:33. Real restricted role; every scope kind, denied writes (42501), nested scopes, rollback, settings cleared. Startup guard separately in runtime-role:2141. |

#### Counts
- Call sites 48: INV 33, DUP 13, FILL 2, IMPL 0 (IMPL assertions are embedded: 27 `expect(claimsCalls)` counts, `inspectBinding` in every test's first token request, `expiredCreate`/`rejectNested` in 658).
- Cases 122: INV 107, DUP 13, FILL 2.
- Layers (call sites): MOCK-BA 36, SVC 8, DB 4.

#### Matrices (line spans measured from the file)
- Refresh denial after authority change: 1163, 1493, 1558, 1626, 1680, 1753, 1804, 1855, 2611 (tail), 3746 → 64+65+68+54+73+51+51+75+~30+73 ≈ 600 lines, 13 cases. Same body: issue A, rotate, look up other member, issue B (the `const [otherMember]` block occurs 12×, ~25 lines each), apply change (+ restore), refresh A/rotated → 400 + `claimsCalls` unchanged, B → 200/400, session row count. Table: shared `twoTenantGrants()` (~25) + 12 rows × ~4 + body ~25 ≈ 100 lines.
- Lock races: 1930, 2715-2788 helpers, 2789, 2858, 2946, 3119, 3258, 3330, 3450, 3531, 3627 → 73+74+69+88+40+139+72+120+81+96+68 = 920 lines, 66 cases. 7 copies of the 12-line `pg_blocking_pids` poll, 27 `Promise.withResolvers`, 11 extra pools, 3 copies of the change dispatch switch (2743-2787, 3193-3221, 3375-3405) + 2 of the user-level switch. One `race(first, second)` helper (~40) + one change table (~55) + two parameterised tests (creation, issuance) over change × order × kind (~90) + contention (~40) + rotation (~35) ≈ 300 lines.
- Policy denial modes 2233+2282: 24+155 = 179 lines → SVC table on `userResourcePolicy` ≈ 80.
- createResourceGrant admission 2986+3023: 37+96 = 133 → one table ≈ 70.
- Code replay family 965, 2003, 2089, 2206: 63+30+57+27 = 177 → table ≈ 60 (or keep 2089/2003/2206 only, 965 is DUP).
- Cleanup outage 1065+1377: 98+72 = 170 → 2×2 table ≈ 70.

#### Setup
beforeEach 122-530 (409 lines) per case: `createAdminFixture` (admin.ts:53-300: TRUNCATE 21 tables cascade, OIDC issuer server, bootstrap, machine client, 3 orgs with domain+SSO, 9 IdP sign-ins), then file seed (extra membership, client, resource, link, 6 `createCapability` via platform write context, 4 entitlements), a new Postgres role (`configureRuntimeRole` + `ALTER ROLE ... LOGIN PASSWORD`), a second pool and a full `betterAuth` with the harness. afterEach drops owned objects and the role. Per-case reset: yes (truncate). Floor ≈ 0.69 s/case ≈ 85 s of 118 s is setup.
Shareable: runtime role (beforeAll; privileges are schema-level); only tenantAdmin, outsider and platformAdmin principals are used (6 of 9 sign-ins wasted); harness construction could be once per file if `runtime` were file-scoped.

### User OAuth, token endpoint, admin authorisation, OpenAPI and auth wiring

Paths are relative to `apps/id`.

Note on layer: in `src/auth/user-oauth.integration.test.ts` the variable `auth` is rebound at :147 (and again at :806, :1487) to `{ ...provider, handler: (r) => app.fetch(r) }`, so every `auth.handler(...)`/`request(...)`/`exchange(...)` call goes through the full production Hono app (`createApp` + `createAuth`) on a restricted runtime role, including the app-served discovery (`publicOAuthMetadata`, src/app.ts:101-124). "MOCK-BA" below means the test then mutates the live Better Auth plugin options (`provider.options.*`, `signer.options.jwt.sign`) of that production instance.

Docs abbreviations: D03 = docs/03-answerable-id.md, D04 = docs/04-answerable-id-schema.md, D05 = docs/05-id-enterprise-foundation.md.

#### src/auth/user-oauth.integration.test.ts (2,149 lines, 45 call sites, 59 runtime tests, all need Postgres)

| file:line | test title (shortened ok) | n | layer | class | reason |
|---|---|---|---|---|---|
| user-oauth:261 | registered public clients still need the native PKCE proof | 1 | HTTP | INV | D03:37 PKCE; public client wrong verifier 401, right 200. Only production-HTTP proof for `none` auth. |
| user-oauth:286 | private-key authentication stays consumed when a code exchange rolls back | 1 | HTTP | INV | D04:110 "Client assertion replay protection stays consumed if later issuance rolls back"; only prod-HTTP private_key_jwt user test (user-grant-boundary:799 is the MOCK-BA twin). |
| user-oauth:344 | refresh survives browser sign-out and can narrow resource scopes without changing tenant | 1 | HTTP | INV | D03:68 sign-out keeps delegation; refresh narrows, cannot widen (400), wrong resource 400, no refresh token once offline_access dropped. |
| user-oauth:390 | unknown revocation and opaque access revocation do not revoke another grant | 1 | HTTP | CON | RFC 7009: unknown token 200, no-store, revoked opaque access fails userinfo 401, grant context untouched. |
| user-oauth:412 | each new flow needs consent unless the registered client explicitly skips it | 1 | HTTP | INV | D03:39 consent per new flow, skipConsent bypass. |
| user-oauth:435 | expired, unselected and caller-supplied flows cannot authorise | 1 | HTTP | INV | D03:39/62 server-owned flow, ten-minute flow; expires the flow row (`answerable_flow`), NOT the authorisation code. |
| user-oauth:470 | registered resource custom claims cannot replace user authority | 1 (4 fields in-loop) | DB | INV | Check constraint `oauth_resources_identity_claims_check` (drizzle/0000_initial.sql:274) for the 4 user keys; token-identity:122 holds the other 5 keys of the same constraint: merge. Asserts constraint name. |
| user-oauth:494 | native access output with a divergent ${claim} rolls back code and audit | 4 | MOCK-BA | FILL | Sets `provider.options.customAccessTokenClaims` (never set by createAuth) to forge identity claims; drives the defensive `identity` comparison in user-token-assertions.ts:139. Only reachable if Better Auth itself diverges. |
| user-oauth:521 | refresh audit failure rolls back rotation and leaves the original token usable | 1 | HTTP | INV | D05:66 failed audit rolls back success (DB trigger fault); 503, refresh row kept, retry works. |
| user-oauth:546 | missing native ID token rolls back code, refresh material and issuance audit | 1 | MOCK-BA | FILL | Replaces `signer.options.jwt.sign` to return undefined for ID tokens; drives user-token-assertions.ts:82. |
| user-oauth:581 | divergent returned refresh persistence rolls back native rotation and audit | 1 | HTTP | FILL | DB trigger rewrites inserted refresh scopes; drives `stored()` check user-token-assertions.ts:106-116; only reachable by DB corruption. |
| user-oauth:616 | native JWT scope, lifetime, type and ID nonce divergences preserve the code | 1 (5 faults in-loop) | MOCK-BA | FILL | Replaces the JWT signer to corrupt scope/exp/typ/nonce; drives user-token-assertions.ts:133-182. Vendor-fault only. |
| user-oauth:670 | opaque and refresh rows must match returned scopes, resource, reference and authentication | 1 (5 faults in-loop) | HTTP | FILL | DB triggers corrupt stored token rows; drives user-token-assertions.ts:106-167. Corruption-only branches. |
| user-oauth:724 | consent narrowing is authorised and audited before native resource filtering | 1 | HTTP | INV | Scope at consent can narrow, never widen (400, no consent row); v4 audit decision. |
| user-oauth:765 | native configured expiry and identity-scope filtering determine the full returned contract | 1 | MOCK-BA | FILL | Mutates `provider.options.accessTokenExpiresIn/refreshTokenExpiresIn/idTokenExpiresIn/scopeExpirations`, none set by createAuth (grep: no non-test use); drives `options.idTokenExpiresIn ?? 36_000` (user-token-assertions.ts:179). Incidental real facts: no id_token when resource excludes openid; email only via userinfo. |
| user-oauth:796 | cached output and returned refresh rows are checked again without a success audit on divergence | 1 (7 faults in-loop) | HTTP | FILL | Decrypts/re-encrypts `rotationReplayResponse` with the app secret to tamper cached replay; drives replay branches of assertUserTokenResponse incl. DPoP token_type. 95 lines. |
| user-oauth:892 | ID-token access hashes follow the configured native signing algorithm | 1 (ES256/ES512 in-loop) | MOCK-BA | IMPL | Replaces signer with ES256/ES512 (production signs EdDSA); at_hash is computed only in vendor code (node_modules/@better-auth/oauth-provider/dist/introspect-*.mjs:1376); no ID source branch. Tests Better Auth. |
| user-oauth:908 | native refresh authentication time must match retained broker evidence | 1 | HTTP | FILL | Direct DB update of `oauth_refresh_tokens.auth_time`; drives user-token-assertions.ts:163. Corruption-only (D04:174 "verified time stay fixed"). |
| user-oauth:926 | retained legacy or inconsistent authentication evidence cannot establish current authority | 1 | SVC | FILL | Calls `currentGrantAuthentication` with in-memory rows the DB trigger `grant_authentication_provenance` + `grant_context_immutable` forbid (0000_initial.sql:1211-1233); revoked branch already covered by :1168/:1238. |
| user-oauth:949 | JSON authorisation starts and consent details retain the selected membership | 1 | HTTP | CON | `Accept: application/json` start returns `{url}`; `/oauth2/flow` status/selectedMemberId; no-store. |
| user-oauth:962 | missing upstream authentication time stays unknown in tokens and retained evidence | 1 | HTTP | INV | D03:29/58: null upstream_auth_time never replaced; auth_time numeric. |
| user-oauth:983 | production provider binds native tenant selection, consent and code to one grant | 1 | HTTP | CON | Golden path: flow client fields, callback = exact redirect + `state` echoed, access claims, ID token aud/nonce/auth_time/upstream_auth_time, refresh rotates and keeps grant_id, v4 audit actions + subjects. |
| user-oauth:1115 | UserInfo validates resource access and returns the same tenant subject | 1 | HTTP | CON | Userinfo with resource JWT returns sub + membership_id. |
| user-oauth:1129 | login-only OAuth issues opaque access and needs a separate renewal capability | 1 | HTTP | INV | D03:58 login-only access opaque; D03:60 refresh needs its own ceiling incl. login-only. |
| user-oauth:1168 | replaying a code revokes its family and leaves a separate authorisation usable | 1 | HTTP | INV | Code single use; replay revokes family; other grant unaffected. Merge with :1518. |
| user-oauth:1202 | native refresh revocation and replay remain confined to one grant | 1 | HTTP | INV | Refresh revoke idempotent (200 twice), revoked refresh 400, other grant fine. |
| user-oauth:1238 | reusing a rotated refresh token revokes only that native family and records the outcome | 1 | HTTP | INV | Refresh reuse detection revokes family (new token also dead), other family fine, `oauth.user.revoked` audit. |
| user-oauth:1264 | signed flow forgery, wrong user, duplicate selection and duplicate consent fail closed | 1 | HTTP | INV | D03:39: tampered signed query 400, other user's cookie 400, foreign member 403, duplicate continue/consent 400, one grant. |
| user-oauth:1312 | native consent denial is terminal without a code | 1 | HTTP | INV | D03:39 terminal state: deny -> access_denied, later accept 400. pages.integration:185 (deny) is the HTML twin without the terminal check. |
| user-oauth:1332 | code issuance audit failure rolls back native code, consent and terminal flow state | 1 | HTTP | INV | D05:66; 503, no code row, retry succeeds. |
| user-oauth:1356 | discovery and JWKS describe reachable endpoints and the native issuer | 1 | HTTP | CON | Through app.fetch -> publicOAuthMetadata: issuer, authorization_endpoint, grant_types_supported, 4 closed fields absent, both well-knowns equal, jwks_uri 200, closed routes 404. Does not assert token_endpoint_auth_methods_supported / prompt_values_supported (oauth-metadata.ts:24-30). |
| user-oauth:1395 | a consumer verifies production user tokens using public discovery and JWKS | 1 | HTTP | CON | D05:49 public-JWKS proof: no private JWK members, jose verify iss/aud/typ at+jwt/exp, ID token fails as access token, forged payload fails, refreshed token keeps identity. Uses jose, not @answerable/auth. |
| user-oauth:1477 | cached native refresh responses recheck policy and record replay separately | 1 | HTTP | INV | D03:62 reuse interval rechecks current policy; replay audited `oauth.user.replayed`. |
| user-oauth:1518 | simultaneous consent and code submissions cannot create duplicate grants or active families | 1 | HTTP | INV | Concurrency: one 200 / one 400 for consent and exchange; replay revokes winner's family. |
| user-oauth:1560 | token audit failure preserves the code for a safe retry | 1 | HTTP | INV | D05:66; 503, no refresh rows, retry 200. Same shape as :521/:1332: table. |
| user-oauth:1593 | code exchange refuses changed ${change} | 7 | HTTP | INV | D05:47 code redemption rechecks policy: membership, account, provider, session, entitlement, resource mismatch (`target`), wrong PKCE verifier. Asserts only 4xx band + no refresh rows. |
| user-oauth:1672 | native SSO resumes the signed authorisation request after login | 1 | HTTP | BEH | prompt=login -> /login, SSO resumes at /authorize without prompt; overlaps pages.integration:227 (HTML) except prompt handling. |
| user-oauth:1721 | one global user needs independently verified target SSO for a second tenant grant | 1 | HTTP | INV | D03:33 own-tenant SSO, independent grants, membership expiry in A leaves B. |
| user-oauth:1838 | the native provider rejects unsupported token grant types | 1 (3 in-loop) | HTTP | CON | `unsupported_grant_type` for password/implicit/unknown. |
| user-oauth:1849 | another client cannot rotate or invalidate a ${live/revoked} refresh family | 2 | HTTP | INV | Refresh bound to its client; other client gets invalid_grant, no row changes. |
| user-oauth:1901 | authorize refuses PKCE ${plain / missing-public-challenge} before creating a flow | 2 | HTTP | INV | D03:37: plain refused, public client without challenge refused, no flow row. Loose assertion (redirect error OR 4xx). Confidential client without challenge not tested. |
| user-oauth:1977 | partial entitlement stores and issues the granted subset (skipConsent=${b}) | 2 | HTTP | INV | D05:41: granted subset in consent, code, audit, token, refresh; widening refresh -> invalid_scope. Reads verification JSON (code row). |
| user-oauth:2064 | browser authorisation drops unapproved identity scopes | 1 | HTTP | INV | Unentitled `email` dropped from issued scope. Merge with :1977. |
| user-oauth:2086 | empty ${service/login/claims} approval refuses selection without storing a grant | 3 | HTTP | INV | D05:41: empty intersection -> 403 access_denied at continue, no grant. |
| user-oauth:2120 | denying partial consent audits the offered scopes without minting a code | 1 | HTTP | CON | v4 `oauth.user.denied` payload; no consent row, no code. Deny half overlaps :1312. |

#### src/http/token.integration.test.ts (330 lines, 9 call sites, 13 runtime tests, Postgres yes)

| file:line | test title | n | layer | class | reason |
|---|---|---|---|---|---|
| token:134 | a bootstrapped client mints a resource JWT and calls the admin API | 1 | HTTP | CON | client_credentials response shape (token_type, expires_in<=600, typ at+jwt, iss/aud/sub/azp/scope). /me body half is DUP of src/http/admin/me.integration.test.ts:66 "getAdminMe: machine token". Merge claims with token-identity:112. |
| token:172 | a wrong client secret is rejected | 1 | HTTP | DUP | src/http/admin/clients.integration.test.ts:65 "... manages a client through real token minting, rotation and revocation" (old secret -> 401 invalid_client) and machine-audit.integration.test.ts:661 (wrong credential -> 401). |
| token:178 | a token without a resource is rejected | 1 | HTTP | DUP | machine-audit.integration.test.ts:709 "malformed targets and missing capabilities retain distinct rejection stages" sends the identical body and asserts 400 invalid_target + audit stage. |
| token:184 | scopes outside the client ceiling are rejected | 1 | HTTP | DUP | machine-audit.integration.test.ts:442 "verified client denial is durable..." (400 invalid_scope + audit) and :749. |
| token:190 | a machine-only client cannot exchange authorization codes | 1 | HTTP | INV | D04:178 grant kinds explicit; `unauthorized_client`. No other test. |
| token:198 | disabling a client revokes admin access and prevents minting | 1 | HTTP | DUP | Old-token half: token-identity:189 (stays 401 even after re-enable, stronger). Mint-refused half: clients.integration.test.ts:65 (disable -> mint 401). |
| token:217 | an unowned client cannot mint a token | 1 | HTTP | INV | D05:41 machine permission uses its owner; only mint-side test (principal.test.ts covers consumption-side `client_unowned`, unit). |
| token:251 | an expired resource JWT cannot call the admin API | 1 | HTTP | INV | D03:43 resource validates time; only HTTP test with a real expired token (principal.test.ts:298 is the unit twin). |
| token:279 | token endpoint handles a ${malformed} request safely | 5 | HTTP | CON | duplicate grant_type / 64 KiB scope / invalid UTF-8 / JSON body refused 4xx, chunked accepted; no-store; refused-before-auth not attributed to the client. |

#### src/http/token-identity.integration.test.ts (288 lines, 11 call sites, 13 runtime tests, Postgres yes)

| file:line | test title | n | layer | class | reason |
|---|---|---|---|---|---|
| token-identity:112 | machine JWT binds immutable client instance, owner and authorization version | 1 | HTTP | CON | Only proof ID emits the machine claims packages/auth/src/index.test.ts:70 hand-copies. Merge with token:134. |
| token-identity:122 | resource custom claims cannot replace machine identity claims | 1 | DB+HTTP | INV | Same constraint as user-oauth:470 (other 5 keys); merge into one test over all 9 keys. |
| token-identity:141 | an out-of-band ownership update is rejected and leaves the token in its original tenant | 1 | DB | DUP | src/db/identity.integration.test.ts:34 "database rejects client identity changes and version rollback" (owner change refused by the same trigger); token half is trivially true once the update fails. |
| token-identity:156 | administration cannot transfer or detach client ownership | 1 | SVC | DUP | src/http/admin/clients.integration.test.ts:65 (PUT /owner -> 409 ownership_conflict for another org and null, same owner unchanged) at HTTP; also src/services/clients.integration.test.ts:176. |
| token-identity:168 | a deleted client identifier cannot be recreated and its old token is rejected | 1 | DB+HTTP | INV | Reservation half DUP of src/db/identity.integration.test.ts:126; new fact: soft-deleted client's token -> 401. |
| token-identity:189 | disable followed by enable does not revive old tokens | 1 | HTTP | INV | D04:90 security changes advance versions; grant-locks.integration.test.ts:196 is the race variant. |
| token-identity:196 | secret rotation invalidates tokens from the previous credential version | 1 | HTTP | INV | D04:90; only end-to-end proof that rotation kills issued JWTs. |
| token-identity:207 | admin consumption rechecks the client-resource link and current resource policy | 1 | HTTP | INV | Consumption-time recheck of link, resource disable, scope ceiling. |
| token-identity:232 | organisation disable and re-enable never revive the old machine token | 1 | HTTP | INV | D03 org authorization version; grant-locks:196 (organization) is the race variant. |
| token-identity:246 | online admin consumption drops scopes when the machine capability is disabled or removed | 1 | HTTP | INV | D05:41 capability ceiling at consumption. |
| token-identity:267 | admin rejects ${none/HS256/foreign-key} bearer signatures | 3 | HTTP | INV | alg confusion. foreign-key case overlaps src/__tests__/admin-routes.ts "foreign bearer" (generated per admin route). |

#### Small files

| file:line | test title | n | layer | class | reason |
|---|---|---|---|---|---|
| narrow-authorization-code:4 | only authorisation codes bound to the grant can be narrowed | 1 | UNIT | FILL | Happy-path narrowing is held at HTTP by user-oauth:1977 (reads the stored code scope); remaining asserts drive the parse-fail/non-code passthrough and the throw branch (narrow-authorization-code.ts:11-23) whose only caller (user-oauth-flow.ts:350) passes the same decision's grant and scopes. Postgres no. |
| native-shapes:4 | the pinned native provider retains the query shapes intercepted by grant boundaries | 1 | UNIT | IMPL | Asserts verbatim source text (incl. a `TODO(invalidate-family-race)` comment) of node_modules/@better-auth/oauth-provider/dist/introspect-*.mjs; upgrade tripwire, fails on vendor reformat. Behaviour held by user-oauth:1168/1238. Postgres no. |
| native-shapes:25 | native revocation retains token-only reads scoped by user-token-revocation | 1 | UNIT | IMPL | Same, authorize-*.mjs; behaviour held by user-oauth:390/1202. Postgres no. |
| grant-scopes:4 | defaults are the intersection of every ceiling, never a union | 1 | UNIT | INV | D03:60 permission intersects ceilings; pure function used by member-permission.ts and machine-capability.ts. |
| grant-scopes:15 | explicit scopes reject overreach rather than silently narrowing the request | 1 | UNIT | INV | Same function; edge cases (empty request) not reachable cheaply over HTTP. |
| grant-scopes:26 | narrowing keeps only requested scopes in every ceiling | 1 | UNIT | INV | `narrowScopes` (member-permission.ts:277,399). |
| authorize:85 | platform grants take precedence and set tier | 1 | UNIT | IMPL | Asserts `c.get("tier")`, which no production code reads (only authorize.test.ts:80, route-table.test.ts:74). Admission itself held by admin-routes generated tests. Mock db. |
| authorize:92 | own organisation scope sets tenant tier | 1 | UNIT | IMPL | Same `tier` variable. |
| authorize:97 | denies and audits %# (x2 principals each) | 6 | UNIT | DUP | src/__tests__/admin-routes.ts generated per route: "insufficient scope", "platform reader insufficient scope", "machine insufficient scope" (WWW-Authenticate), "outsider organisation" (404 + data.organizationId). Also asserts `insert` toHaveBeenCalledTimes(1); its `x-forwarded-for` header is vacuous (ip comes from `c.set("clientIp")` at :50). |
| authorize:156 | an org scope without an organisation parameter cannot authorise | 1 | UNIT | FILL | No org-scoped admin route lacks `:organizationId` (awk over src/http/admin/*.ts route defs: none); drives authorize.ts:86 false branch. |
| authorize:166 | root is audited and admitted at platform tier %# | 2 | UNIT | DUP | src/__tests__/admin-routes.ts "root is admitted by authorisation" (every route, open ones included, one `admin.root_request` row) and root.integration.test.ts:36. |
| authorize:202 | a zero-grants principal reaches an open admin route | 1 | UNIT | DUP | src/__tests__/admin-routes.ts "no grant is admitted" (open /me with noGrant cookie). |
| openapi:28 | the public OpenAPI snapshot matches the served document | 1 | HTTP | CON | Snapshot drift guard; Session schema hides 3 internal fields; every documented auth path is allowlisted. Postgres likely no (lazy pool). |
| openapi:69 | the admin OpenAPI snapshot matches the served document | 1 | HTTP | CON | Admin snapshot drift guard. Postgres likely no. |
| auth:17 | never links an upstream identity to an existing user by email | 1 | SVC | IMPL | Title promises D03:33 behaviour but only reads `auth.options.account.accountLinking.enabled`, `trustedOrigins`, adapter `transaction` type and two OpenAPI paths (paths DUP of openapi:28 / app.test.ts:246). No behavioural test of same-email different-subject login exists (grep). Postgres no. |
| auth:35 | missing SSO callback state returns to the ID-owned error page | 1 | HTTP | BEH | Redirect to `/error?error=state_not_found`. Uses raw `auth.handler` (not app). Postgres likely no. |

#### Class counts

| file | INV | CON | BEH | DUP | FILL | IMPL | call sites | runtime tests |
|---|---|---|---|---|---|---|---|---|
| user-oauth.integration | 26 | 8 | 1 | 0 | 9 | 1 | 45 | 59 |
| token.integration | 3 | 2 | 0 | 4 | 0 | 0 | 9 | 13 |
| token-identity.integration | 8 | 1 | 0 | 2 | 0 | 0 | 11 | 13 |
| narrow-authorization-code | 0 | 0 | 0 | 0 | 1 | 0 | 1 | 1 |
| native-shapes | 0 | 0 | 0 | 0 | 0 | 2 | 2 | 2 |
| grant-scopes | 3 | 0 | 0 | 0 | 0 | 0 | 3 | 3 |
| http/authorize | 0 | 0 | 0 | 3 | 1 | 2 | 6 | 12 |
| openapi.integration | 0 | 2 | 0 | 0 | 0 | 0 | 2 | 2 |
| auth.integration | 0 | 0 | 1 | 0 | 0 | 1 | 2 | 2 |
| **total** | **40** | **13** | **2** | **9** | **11** | **6** | **81** | **107** |

#### Appendix A: distinct facts in user-oauth.integration (32)

1. PKCE: S256 only, plain refused, public client without challenge refused, wrong verifier refused: 261, 1593[pkce], 1901x2
2. private_key_jwt assertion stays consumed when issuance rolls back: 286
3. Refresh delegation survives browser sign-out: 344
4. Refresh can narrow, never widen; resource must match at refresh: 344, 1977 (widen -> invalid_scope)
5. Revocation: unknown token 200, opaque access revoke ends userinfo, refresh revoke idempotent, confined to one grant: 390, 1202
6. Consent on every new flow; skipConsent bypass: 412, 1977[true]
7. Flow integrity: unselected/expired flow, forged signed query, wrong user, duplicate selection/consent fail closed: 435, 1264, 1518 (consent half)
8. Resource custom claims cannot override identity claims (DB constraint): 470 (+ token-identity:122)
9. Defensive re-check of Better Auth output (claims, ID token presence, scope, exp, typ, nonce, stored rows, cached replay, authTime) rolls back: 494x4, 546, 581, 616, 670, 796, 908
10. Audit storage failure rolls back issuance, code/refresh stay usable: 521, 1332, 1560
11. Consent-time narrowing within offer, widening refused, audited: 724
12. Token/ID lifetimes follow provider config (config production never sets): 765
13. at_hash follows signing algorithm (vendor): 892
14. Inconsistent grant evidence yields no authority: 926
15. JSON start + /oauth2/flow details, no-store: 949, 983 (client fields)
16. auth_time = broker time; null upstream_auth_time stays null: 962, 983
17. Golden path: one grant binds member/tenant, state echoed, nonce, claims, refresh keeps grant_id, v4 audit + subjects: 983
18. Userinfo returns tenant subject (JWT and opaque): 1115, 1129, 765
19. Login-only access is opaque; refresh needs its own capability: 1129
20. Code single use; replay revokes family; other grants unaffected: 1168, 1518
21. Refresh rotation; reuse of a rotated token revokes the family; audit: 983, 1238
22. Discovery/JWKS publish only reachable endpoints; closed routes 404: 1356
23. Consumer-side verification through public JWKS (iss, aud, typ, exp, signature; ID token rejected as access token): 1395
24. Reuse interval replay rechecks policy, audited separately: 1477
25. Code exchange rechecks membership/account/provider/session/entitlement/resource: 1593x7
26. SSO resumes the signed authorisation request; prompt=login honoured: 1672
27. Second tenant needs its own verified SSO; grants independent: 1721
28. Unsupported grant types refused: 1838
29. Refresh family bound to its client: 1849x2
30. Partial entitlement: granted subset stored, issued, refreshed; unapproved identity scopes dropped: 1977x2, 2064
31. Empty approval refuses selection, no grant: 2086x3
32. Denial terminal; denial audit records offered scopes: 1312, 2120

Rewrite estimate: 2,149 now. Helpers `refresh(token, extra)` / `redeem(code, extra)` replace 24 inline refresh blocks and 16 code-exchange blocks (~200 lines saved). One fault table + runner for facts 9-10 (11 tests, ~450 lines) -> ~200. Merge 435+1264 (81 -> ~50), 1168+1202+1238 (93 -> ~55). Keep-all-facts rewrite ~1,600 lines. Dropping the 10 FILL/IMPL tests (494, 546, 581, 616, 670, 765, 796, 892, 908, 926 = 379 lines) and tabling the 3 audit-failure tests: ~1,450 lines.

#### Appendix B: OAuth/OIDC surface vs tests (HTTP = production createAuth via app.fetch)

| item | HTTP proof | also / only via internals |
|---|---|---|
| PKCE S256 required, plain refused | user-oauth:1901[plain] (loose: redirect error OR 4xx) | none |
| missing challenge | user-oauth:1901[missing-public-challenge] (public client only) | confidential client without challenge: no test |
| missing verifier | none on production | ONLY user-grant-boundary:919 (test-built betterAuth + wrapped token endpoint) |
| wrong verifier | user-oauth:261 (public 401), :1593[pkce] (confidential 4xx), :286 | also user-grant-boundary:919 |
| redirect URI exact match (authorize and token) | NO TEST (every redirect_uri in src is the registered one) | none |
| unknown resource at authorize (user) | NO TEST | machine: missing resource only, token:178 / machine-audit:709 |
| resource mismatch authorize vs token | user-oauth:1593[target]; refresh: :344 | none |
| state echoed | user-oauth:983 (success only; not on deny/error) | none |
| nonce in ID token | user-oauth:983, :1395 | :616 id-nonce fault (MOCK-BA). "refresh does not repeat nonce" (D03:58): no test |
| consent per flow / deny terminal / skipConsent | :412 / :1312 / :412, :1977[true] | pages.integration:185 HTML |
| refresh rotation | :983 (new refresh differs), :1238 | user-grant-boundary (MOCK-BA) |
| refresh reuse revokes family | :1238 | also user-grant-boundary:1299 (MOCK-BA) |
| code single use | :1168, :1518 | also user-grant-boundary:965 (MOCK-BA) |
| scope narrowing never grows | :344, :724, :1977 | grant-scopes.test (unit) |
| aud / aud array | :983 (ID aud = client), :1395 (access aud contains resource), token:134 (machine string) | array shape never asserted; enforced only in user-token-assertions.ts:124-142; packages/auth/src/testing.ts:77 signs string aud only |
| typ at+jwt | :1395, token:134 | :616 access-type (MOCK-BA); packages/auth index.test:49 (fake issuer) |
| JWKS | :1356, :1395 | none |
| key rotation | NO HTTP test | ONLY application-secrets.integration:10 via `auth.api.signJWT` + DB-read public key; never via /auth/jwks |
| discovery | :1356 | token_endpoint_auth_methods_supported, prompt_values_supported, code_challenge_methods_supported, revocation/userinfo endpoints unasserted |
| revocation endpoint | :390, :1202, :1849[revoked] | also user-grant-boundary:2089 (MOCK-BA) |
| session / sid | session binding: :983 (DB evidence), :1593[session], :344 | `sid` claim: NO TEST in user tokens (principal.test:168 refuses sid on admin bearer, unit) |
| upstream_auth_time / auth_time | :962, :983 | packages/auth index.test:60 |
| ID token not a resource bearer | :1395 line 1445 (local jose only) | never presented to /oauth2/userinfo or /api/admin |
| expired code | NO TEST (:435 expires the flow, not the code) | none |
| client auth: none | :261 | user-grant-boundary:919 |
| client_secret_basic | all exchanges (success); wrong secret only machine: token:172 | none for user flow |
| client_secret_post | NO HTTP test | ONLY machine-provider.integration:254 via `auth.api.oauth2Token` on a test-built betterAuth (machine grant) |
| private_key_jwt | :286 | also user-grant-boundary:799, machine-provider:193 |

#### Appendix C: source branches reachable only from tests

- `tier` context variable: written src/http/authorize.ts:62,76,82,91, typed src/http/context.ts:17; `grep -rn 'get("tier")' src` -> only src/http/authorize.test.ts:80 and src/http/admin/route-table.test.ts:74.
- src/http/authorize.ts:86 (org scope without `:organizationId`): awk over every `orgScope:` route in src/http/admin/*.ts finds none without `:organizationId`; only authorize.test.ts:156 drives it.
- src/auth/user-token-assertions.ts:80-183 throw branches: importer is only user-token-boundary.ts:384; failures reachable only by faulting Better Auth (`customAccessTokenClaims`, signer replacement) or DB triggers; `grep customAccessTokenClaims src` -> tests only.
- `options.idTokenExpiresIn ?? 36_000` (user-token-assertions.ts:179) and `options.refreshTokenExpiresIn ?? 2_592_000` (user-oauth-flow.ts:218): createAuth (src/auth.ts:277-287) sets neither; only user-oauth:765 mutates them.
- DPoP branches user-token-assertions.ts:156,164: only user-oauth:796 forces token_type "DPoP"; `grep -rn "dpopBound\|DPoP" src --include='*.test.ts'` -> only that line, though the admin API accepts `dpopBoundAccessTokens` (src/http/admin/clients.ts:32, resources.ts:37): untested config, not dead code.
- src/auth/grant-authentication.ts:49-60 null/mismatched evidence: `authentication` nullable but insert trigger `validate_grant_authentication` (drizzle/0000_initial.sql:1211-1233) and `grant_context_immutable` block mismatched rows; only user-oauth:926 drives with in-memory rows.
- src/auth/narrow-authorization-code.ts:19-23 throw: only caller user-oauth-flow.ts:350 passes `flow.grantId` and the same decision's `granted`; only narrow-authorization-code.test.ts:28-41 reaches it.

### SSO and federation

Worktree `agent-a919bcb2c1ec2da06`, paths relative to `apps/id`. `pg` = needs Postgres.

#### src/auth/verified-sso.integration.test.ts (1,326 lines, 24 call sites, 41 cases)

| file:line | test title (shortened) | n | layer | pg | class | reason |
|---|---|---|---|---|---|---|
| verified-sso.integration.test.ts:100 | sensitive membership commands reject missing and stale upstream time | 1 (2 inline) | HTTP | yes | INV | 05:86 five-minute freshness; 03:29 missing auth_time stays unknown. DELETE member with no auth_time and with now-301 → 403 reauthentication_required |
| verified-sso.integration.test.ts:121 | reauthentication requests fresh upstream evidence | 1 | HTTP | yes | CON | pins the redirect URL shape (prompt=login, max_age=0) promised in the OpenAPI description (verified-sso.ts:310) |
| verified-sso.integration.test.ts:139 | linking starts only from a freshly verified initiating identity | 1 | HTTP | yes | DUP | positive control only (status 200); `begin()` asserts the same 200 in verified-sso.integration.test.ts:247 "native verified linking preserves the global UUID…" |
| verified-sso.integration.test.ts:211 | native reauthentication preserves identity … permits the original command key | 1 | HTTP | yes | INV | 05:60 replays recheck freshness; a 403 does not consume the key, reauth recovers, replay header set, one member.removed audit |
| verified-sso.integration.test.ts:247 | native verified linking preserves the global UUID and profile with one atomic binding fact | 1 | HTTP | yes | INV | 03:33 binds to existing UUID, profile kept, member+audit+target session; replayed link callback refused (only callback-replay proof besides :1188) |
| verified-sso.integration.test.ts:367 | reauthentication rejects ${invalid} without changing the binding or issuing a session | 3 | HTTP | yes | INV | missing auth_time / auth_time before flow start / different subject → reauthentication_required or authentication_identity_mismatch; sessions unchanged |
| verified-sso.integration.test.ts:404 | linking requires fresh initiating evidence and preserves normal login semantics | 1 | HTTP | yes | INV | 05:86 linking needs fresh source; forged `serverContext.answerableIdentityFlow` on plain sign-in yields an ordinary new user, no link |
| verified-sso.integration.test.ts:470 | verified linking rejects ${conflict} without transfer or reinstatement | 6 | HTTP | yes | INV | 03:33/05:25 no transfer, no imported adoption, no restored revoked membership. owned/imported/deleted-binding → identity_conflict at callback; revoked/deleted/future member → 403 membership_revoked at start; accounts+sessions unchanged |
| verified-sso.integration.test.ts:573 | link callback rejects ${change} changes after initiation | 9 | HTTP | yes | INV | callback revalidates source/target provider, target membership, source user/deleted user/member/account, session, flow expiry; only asserts "not success" + no account + no new session (no error code pinned) |
| verified-sso.integration.test.ts:656 | link callback requires the initiating browser session | 1 | HTTP | yes | INV | purpose state without session cookie → 403 identity_flow_invalid, no account |
| verified-sso.integration.test.ts:680 | purpose state rejects ${replacement} even with the original native state cookie | 2 | HTTP | yes | INV | purpose bound to user and session; another user's or another session's cookie → identity_flow_invalid |
| verified-sso.integration.test.ts:713 | initiating proof expiring upstream prevents the subsequent binding | 1 | HTTP | yes | INV | 05:86; source auth_time 240 s old at start, 301 s at callback → refused, no account/session |
| verified-sso.integration.test.ts:738 | native resolution rolls back when callback revalidation reports ${failure} | 2 | HTTP+spy | yes | IMPL | spies `tenantAuthentication`, faults the 2nd call and asserts `checks === 2`; breaks on a harmless extra/fewer call. lost-authority already held by :573 (real data), fault rollback by :824 |
| verified-sso.integration.test.ts:787 | native origin validation protects both verified-flow redirect URLs | 1 (4 inline) | HTTP | yes | INV | open-redirect guard for link/reauth callbackURL+errorCallbackURL; the ONLY test with Better Auth origin/CSRF checks on (they are off under test: better-auth create-context.mjs:210 `isTest() ? true`) |
| verified-sso.integration.test.ts:824 | required linking audit failure rolls back account, membership and native session | 1 | HTTP+spy | yes | INV | atomic required audit; spy on recordAuditEvent throws for identity.linked → SSO_USER_RESOLUTION_FAILED, no account/member/session |
| verified-sso.integration.test.ts:871 | concurrent independently verified bindings cannot assign one target identity to two users | 1 | HTTP | yes | INV | race: one success, one account row, one identity.linked |
| verified-sso.integration.test.ts:903 | a stale committed replay requires reauthentication and then recovers the original receipt | 1 | HTTP | yes | INV | 05:60 replay rechecks freshness; 240 s passes, +301 s replay 403, reauth returns original Operation-Id |
| verified-sso.integration.test.ts:941 | reads and display-only edits retain session lifetime while security fields require fresh SSO | 1 | HTTP | yes | INV | 05:86 sensitive changes only; client PATCH name OK, redirectUris 403 (resources.ts:185 `unlessOnly: ["name"]`) |
| verified-sso.integration.test.ts:976 | reauthentication can renew the same account after a provider revision change | 1 | HTTP | yes | BEH | operator edits provider; users recover via reauth |
| verified-sso.integration.test.ts:999 | a target-row wait cannot let an ageing authentication commit a sensitive command | 1 | HTTP | yes | INV | 05:60 freshness rechecked after lock wait (240 s → 301 s while blocked on oauth_clients row) |
| verified-sso.integration.test.ts:1062 | no database lock spans upstream authentication; a concurrent provider change rejects the callback | 1 | HTTP | yes | INV | link-flow variant of federation.integration.test.ts:409 (that one is plain sign-in) |
| verified-sso.integration.test.ts:1107 | binding-first holds current provider and source authority until the audited native transaction commits | 1 | HTTP+spy | yes | INV | lock ordering; spy only pauses resolveFederatedUser; link-flow analogue of federation.integration.test.ts:454 |
| verified-sso.integration.test.ts:1188 | a concurrent native state read still allows only one purpose claim and binding | 1 | MOCK-BA | yes | INV | single-use purpose claim; wraps Better Auth `adapter.findMany` for `verification` and requires `reads === 2` — breaks if Better Auth switches to findOne |
| verified-sso.integration.test.ts:1264 | human authority expiry during a target-row wait prevents the sensitive mutation | 1 | HTTP | yes | INV | 05:60 authority after lock wait; no SSO involved (misplaced); overlaps tenant-authentication.integration.test.ts:650 "human permissions expiring during a provider lock wait…" and command-policy-lock.integration.test.ts:202 "session expiry during a policy lock wait…" |

#### src/services/federation.integration.test.ts (1,304 lines, 34 call sites, 50 cases)

| file:line | test title (shortened) | n | layer | pg | class | reason |
|---|---|---|---|---|---|---|
| federation.integration.test.ts:210 | repeated migration preserves native sessions, identity and encrypted upstream tokens | 1 | HTTP | yes | DUP | migration re-run no-op: db/migrate.integration.test.ts:26 "integration: migrations are idempotent"; repeat sign-in same account + `$ba$1$`: federation.integration.test.ts:287 |
| federation.integration.test.ts:242 | legacy plaintext fails native sign-in without replacing the account or creating a session | 1 | HTTP | yes | INV | README:41 plaintext refused; account row unchanged, no new session |
| federation.integration.test.ts:262 | missing upstream storage keys cannot commit a native SSO identity or session | 1 | HTTP | yes | INV | README:41 verbatim (500 authentication_unavailable, rollback) |
| federation.integration.test.ts:287 | native SSO supports encrypted account fields on first and repeated sign-in | 1 | HTTP | yes | INV | README:41/06:32 tokens encrypted; same account UUID on repeat (release plan E1) |
| federation.integration.test.ts:326 | native SSO runs through a real restricted login and reuses an unscoped connection | 1 | HTTP | yes | INV | 05 isolation: runtime role, scope GUCs empty after denied+accepted logins (guest denial part duplicates :862) |
| federation.integration.test.ts:356 | native initiation preserves provider selection ${selection} | 4 | HTTP | yes | BEH | routing by slug, email, upper-case email, subdomain email; session origin = chosen provider |
| federation.integration.test.ts:380 | native SSO initiation evidence cannot be supplied by the browser | 1 | HTTP | yes | INV | forged `answerableSsoProviderRevisions` in body ignored; sso-origin.ts:26 "request fields never supply origin" |
| federation.integration.test.ts:409 | restricted native SSO rechecks ${change} configuration after token exchange | 3 | HTTP | yes | INV | 05:25 current provider binding; delete/recreate mid-flow → SSO_PROVIDER_CHANGED, users/accounts/members/sessions all 0; also proves no lock across upstream |
| federation.integration.test.ts:454 | restricted callback commits its origin before waiting provider ${change} | 3 | HTTP | yes | INV | lock ordering via session-insert trigger + advisory lock; 113 lines |
| federation.integration.test.ts:568 | ordinary native SSO logins preserve provider revision and timestamp | 1 | HTTP | yes | INV | a login must not bump revision (which would invalidate every session bound to it, 03:29) |
| federation.integration.test.ts:584 | origin resolution rejects missing providers before identity writes | 1 | SVC | yes | FILL | calls `resolveUser` directly to reach sso-origin.ts:74 throw; native flow returns SSO_PROVIDER_CHANGED first (:409) |
| federation.integration.test.ts:614 | native SSO persists the accepted provider origin on its session | 1 | HTTP+DB | yes | INV | 03:29 origin tuple immutable: only test of `session_authentication_origin_immutable`/`_provider` constraints; origin hidden from get-session |
| federation.integration.test.ts:695 | a failed origin insert rolls back native SSO user, account and session creation | 1 | HTTP | yes | INV | atomic first login (users/accounts/sessions 0); also asserts exact console.error call (log part is FILL, held by auth/logging.test.ts) |
| federation.integration.test.ts:725 | tenant removal blocks a subsequent valid SSO login without recreating membership | 1 | HTTP | yes | INV | 05:25 revoked membership never silently restored; reinstatement keeps member id. Does not assert no session row |
| federation.integration.test.ts:753 | accepts the provider and bounds session/audit user-agent (%#) | 2 | HTTP | yes | INV | first login: active UUIDv7 user, account directory cols, member role, sign-in + sign-out audit, IP. 513-char case duplicates lib/user-agent.test.ts; IP part overlaps tenant-authentication.integration.test.ts:891 |
| federation.integration.test.ts:850 | rejects a token from a foreign issuer before user resolution | 1 | HTTP | yes | INV | 03:25 configured issuer; only upstream token-validation failure tested anywhere (invalid_provider/token_not_verified, users 0) |
| federation.integration.test.ts:862 | rejects Entra claim policy: %s | 3 | HTTP | yes | INV | 03:25 tid pin + guest (idp, acct=1) → directory_mismatch/guest_account; users 0; auth.signin.rejected audit |
| federation.integration.test.ts:886 | rejects Google claim policy: %s | 3 | HTTP | yes | INV | 03:25 personal_account, hosted_domain_mismatch, email_unverified; users 0 |
| federation.integration.test.ts:905 | rejects an email outside the organization's active domains | 1 | HTTP | yes | INV | domain_not_allowed; users 0 |
| federation.integration.test.ts:913 | does not borrow another organization's active domain | 1 | HTTP | yes | INV | tenant isolation of domains; no row assertion |
| federation.integration.test.ts:928 | binds an inert import by immutable directory identity | 1 | HTTP | yes | INV | 03:159 immutable upstream identity is the join key; import-only data path (no production writer of placeholders) |
| federation.integration.test.ts:956 | releases a disabled holder's recycled email for a new identity | 1 | HTTP | yes | BEH | email retirement for disabled holder |
| federation.integration.test.ts:976 | rejects a recycled email held by an %s user without changing it | 2 | HTTP | yes | INV | 05:25 no email merge; email_conflict, users unchanged, accounts 0 |
| federation.integration.test.ts:989 | rejects a disabled user already bound to the exact account | 1 | HTTP | yes | DUP | http/admin/users.integration.test.ts:144 "platform admin and machine administer a fresh user through … disable …" disables via API then signs in → user_disabled (operator layer); also soft-deletion.integration.test.ts:75 |
| federation.integration.test.ts:1004 | refuses Better Auth's email-linking path | 1 | HTTP | yes | INV | 05:25 no email merge when the holder has another account on the same issuer |
| federation.integration.test.ts:1020 | uses runtime discovery when endpoint fields are absent | 1 | HTTP | yes | BEH | operator config without explicit endpoints; also the only generic-OIDC success path |
| federation.integration.test.ts:1033 | turns a thrown resolver error into an error redirect atomically | 1 | HTTP | yes | INV | malformed upstream email → SSO_USER_RESOLUTION_FAILED, no user/account |
| federation.integration.test.ts:1043 | fills empty directory columns when the exact account is active | 1 | HTTP | yes | FILL | federation.ts:83-99 backfill; every account federation.ts writes already has directoryUserId (federation.ts:316-326); no import tooling exists (02-plan:34) |
| federation.integration.test.ts:1063 | reactivates an inert user already bound to the exact account | 1 | HTTP | yes | BEH | "Inert users activate at first login" (services/users.ts:149); import-only data |
| federation.integration.test.ts:1080 | keeps provider selection stable by organization slug | 1 | HTTP | yes | DUP | federation.integration.test.ts:356 row `{organizationSlug:"contoso"}` (same input, stronger assertions) |
| federation.integration.test.ts:1118 | ${application} email-first SSO sends environment credentials and binds session provenance | 2 | HTTP | yes | INV | 03:27 platform credentials injected, row stores no secret; token request carries env id/secret; scopes; session origin |
| federation.integration.test.ts:1179 | platform sign-in fails closed before state or session creation when unconfigured | 1 | HTTP | yes | INV | 503 platform_application_missing, no verification/session/token request |
| federation.integration.test.ts:1203 | platform application ${change} change between sign-in and callback | 3 | HTTP | yes | INV | removed → 503; client-id change → invalid_state/sso_provider_changed_during_authentication; secret change → uses new secret |
| federation.integration.test.ts:1251 | adapter hydrates single, multiple and transactional provider reads before observation | 1 | SVC | yes | FILL | drives authDatabaseAdapter findOne/findMany/transaction variants for coverage; fail-closed fact held by :1179 and platform-applications.test.ts:64 |

#### src/services/federation.test.ts (356 lines, 12 call sites)

All use a positional fake adapter (`databaseWithFinds`, federation.test.ts:40-51: the Nth `findOne` returns the Nth result), so reordering two lookups in federation.ts breaks them.

| file:line | test title (shortened) | n | layer | pg | class | reason |
|---|---|---|---|---|---|---|
| federation.test.ts:82 | fails closed for a non-OIDC resolver input | 1 | MOCK-BA | no | FILL | federation.ts:124; SAML ACS not in auth-allowlist.ts (only /auth/sso/callback) |
| federation.test.ts:108 | classifies tenant-scoped Entra, Google, and generic OIDC issuers | 1 | UNIT | no | DUP | all three kinds exercised end-to-end: federation.integration.test.ts:862 (Entra), :886 (Google), :1020 (generic) |
| federation.test.ts:120 | rejects a missing provider and a disabled organization | 1 | MOCK-BA | no | INV | only holder of organization_disabled (federation.ts:137-143); provider_not_found half is unreachable (sso-origin.ts:61-75 throws first) |
| federation.test.ts:132 | pins Entra tenants and rejects both guest signals | 1 | MOCK-BA | no | DUP | federation.integration.test.ts:862 "rejects Entra claim policy" (same 3 cases, E2E) |
| federation.test.ts:151 | pins Google hosted domains and verified email | 1 | MOCK-BA | no | DUP | federation.integration.test.ts:886 "rejects Google claim policy" (same 3 cases) |
| federation.test.ts:196 | requires verified generic OIDC email and an active domain | 1 | MOCK-BA | no | INV | only holder of generic-OIDC email_unverified (03:25); domain half duplicates federation.integration.test.ts:905 |
| federation.test.ts:218 | rejects a directory placeholder already owned by a non-inert user | 1 | MOCK-BA | no | INV | only holder of federation.ts:253 identity_conflict on plain sign-in (import-only data) |
| federation.test.ts:234 | rejects disabled placeholders and activates inert placeholders | 1 | MOCK-BA | no | INV | disabled placeholder → user_disabled only here; inert half duplicates federation.integration.test.ts:928 and asserts `updates.length === 2` (IMPL) |
| federation.test.ts:256 | rejects active and inert email holders | 1 | MOCK-BA | no | DUP | federation.integration.test.ts:976 "rejects a recycled email held by an %s user" |
| federation.test.ts:273 | creates a Google user with the email fallback name | 1 | MOCK-BA | no | BEH | name falls back to email; Google directoryId = hd (not asserted E2E); asserts creates[0]/[1] order |
| federation.test.ts:316 | throws when an account has no owner or the provider email is malformed | 1 | MOCK-BA | no | FILL | orphan account impossible (accounts.user_id NOT NULL FK, db/schema/auth.ts:155-157); malformed half duplicates federation.integration.test.ts:1033 |
| federation.test.ts:337 | revoked imported membership rejects activation before identity mutation | 1 | MOCK-BA | no | INV | 05:25; only holder of federation.ts:251 placeholder membership_revoked |

#### src/auth/sso-origin.test.ts (62 lines)

| file:line | test title | n | layer | pg | class | reason |
|---|---|---|---|---|---|---|
| sso-origin.test.ts:4 | provider observation ignores missing request authority or incomplete records | 1 | UNIT | no | FILL | sso-origin.ts:38-46 guards for non-object rows / missing id/revision; adapter rows are typed |
| sso-origin.test.ts:22 | session input cannot manufacture origin without trusted resolution | 1 | MOCK-BA | no | INV | fake hook context; forged origin fields nulled; /sso/callback without origin → authentication_origin_missing (only holder). Browser-supplied part also held E2E by federation.integration.test.ts:380 |

#### src/auth/platform-applications.test.ts (99 lines)

| file:line | test title | n | layer | pg | class | reason |
|---|---|---|---|---|---|---|
| platform-applications.test.ts:19 | leaves absent, projected, malformed and own rows unchanged | 1 | UNIT | no | FILL | defensive JSON-shape branches of hydrateSsoProviderRow |
| platform-applications.test.ts:39 | hydrates ${application} deterministically without mutating storage | 2 | UNIT | no | DUP | federation.integration.test.ts:1118 proves env credentials reach the token endpoint and the row stores none |
| platform-applications.test.ts:64 | missing and unsupported applications fail closed with a redacted diagnostic | 1 | UNIT | no | FILL | asserts log line; fail-closed held E2E by federation.integration.test.ts:1179; generic-issuer branch unreachable (admin rejects platform credentials there, http/admin/sso-providers.integration.test.ts:599) |

#### src/auth/upstream-token-storage.test.ts (76 lines)

| file:line | test title | n | layer | pg | class | reason |
|---|---|---|---|---|---|---|
| upstream-token-storage.test.ts:14 | upstream storage protects all fields and preserves empty/null values | 1 | UNIT | no | INV | README:41; fields input/returned false; null import credentials valid |
| upstream-token-storage.test.ts:29 | rotation uses the first version and retained keys only for decryption | 1 | UNIT | no | DUP | account-storage.integration.test.ts:183 "production account storage retains old keys through incremental rotation" (same rotation facts through createAuth); only extra: same version with a different key fails |
| upstream-token-storage.test.ts:52 | missing keys, corrupt ciphertext and all legacy formats fail safely | 1 | UNIT | no | INV | README:41 format matrix (plaintext, unversioned legacy, tampered); E2E samples in federation.integration.test.ts:242/:262 |

#### src/auth/account-storage.integration.test.ts (237 lines)

| file:line | test title | n | layer | pg | class | reason |
|---|---|---|---|---|---|---|
| account-storage.integration.test.ts:28 | supported account field transforms cover writes, reads, joins and transactions | 1 | SVC | yes | INV | README:41 encryption through every adapter path (join, select, updateMany, tx rollback, corrupt read) that E2E does not reach |
| account-storage.integration.test.ts:183 | production account storage retains old keys through incremental rotation | 1 | SVC | yes | INV | README:41 / 06:175 key ring rotation and retirement |

#### Reject codes: end-to-end holders

E2E = `/auth/sign-in/sso` (or `/auth/sso/link`) → `startOidcIssuer` → `/auth/sso/callback`.

| code (federation.ts line) | E2E test | unit test | E2E asserts no rows written? |
|---|---|---|---|
| provider_not_found (124, 131) | none; unreachable (SAML not allowlisted; sso-origin.ts:61-75 throws first) | federation.test.ts:82, :120 | n/a |
| organization_disabled (142) | none | federation.test.ts:120 | n/a |
| directory_mismatch (154) | federation.integration.test.ts:862 | federation.test.ts:132 | users 0 (+ rejection audit) |
| guest_account (157) | federation.integration.test.ts:862 (idp, acct), :326 | federation.test.ts:132 | users 0; :326 sessions total 1 |
| personal_account (165) | federation.integration.test.ts:886 | federation.test.ts:151 | users 0 |
| email_unverified (170) | federation.integration.test.ts:886 (Google only) | federation.test.ts:151 (Google), :196 (generic) | users 0 |
| domain_not_allowed (189) | federation.integration.test.ts:905, :913; http/admin/domains.integration.test.ts:304 | federation.test.ts:196 | :905 users 0; :913 and domains:304 none |
| hosted_domain_mismatch (192) | federation.integration.test.ts:886 | federation.test.ts:151 | users 0 |
| user_disabled exact account (212) | federation.integration.test.ts:989; http/admin/users.integration.test.ts:144; soft-deletion.integration.test.ts:75 | none | none assert rows |
| user_disabled placeholder (249) | none | federation.test.ts:234 | n/a |
| membership_revoked exact (215) | federation.integration.test.ts:725 | none | members still 1; sessions not asserted |
| membership_revoked placeholder (252) | none | federation.test.ts:337 | n/a |
| membership_revoked link start (verified-sso.ts:150) | verified-sso.integration.test.ts:470 (member rows; HTTP 403, no callback) | none | accounts + sessions unchanged |
| identity_conflict link (205, 242) | verified-sso.integration.test.ts:470 (owned, imported, deleted-binding) | none | accounts + sessions unchanged, no identity.linked |
| identity_conflict plain sign-in (254) | none | federation.test.ts:218 | n/a |
| email_conflict (303) | federation.integration.test.ts:976, :1004 | federation.test.ts:256 | users unchanged, accounts 0 / 1 |
| invalid_auth_time (sso-origin.ts:87) | tenant-authentication.integration.test.ts:716 | none | sessions unchanged, account 0 |
| authentication_origin_mismatch (sso-origin.ts:133) | tenant-authentication.integration.test.ts:746 (spy) | none | sessions, account, success audit unchanged |
| authentication_origin_missing (sso-origin.ts:137) | none | sso-origin.test.ts:22 | n/a |
| authentication_identity_mismatch (verified-sso.ts:222) | verified-sso.integration.test.ts:367 | none | sessions unchanged |
| identity_flow_invalid | verified-sso.integration.test.ts:656, :680 | none | account 0 |
| reauthentication_required (callback) | verified-sso.integration.test.ts:367 | none | sessions unchanged |

### Tenant authentication, machine grants, locks and logging

Paths relative to `apps/id`. Layers: HTTP = real `createApp().request`; HTTP-auth = real `createAuth().handler` (no Hono middleware); HTTP-testBA = `auth.handler` on a test-assembled `betterAuth({...machineOAuthProvider})`, not `createAuth`; MOCK-BA = wraps/replaces Better Auth internals (adapter.transaction, plugin `extensions`, internalAdapter, rateLimit storage). PG = needs Postgres.

#### src/auth/tenant-authentication.integration.test.ts (15 call sites, 32 cases)

| file:line | test title (shortened ok) | n | layer | PG | class | reason |
|---|---|---|---|---|---|---|
| tenant-authentication.integration.test.ts:153 | native session records accepted account UUID; absent upstream freshness unknown | 1 | HTTP | yes | INV | docs/03:29 missing auth_time stays null, broker time not substituted; only HTTP proof (sso-origin.test.ts:22 is unit) |
| tenant-authentication.integration.test.ts:184 | restricted grant creation rejects A authentication when B membership selected | 1 | SVC | yes | DUP | user-oauth.integration.test.ts:1721 "one global user needs independently verified target SSO for a second tenant grant" proves it over /oauth2/continue → 403 |
| tenant-authentication.integration.test.ts:207 | restricted human administration rejects foreign authority, preserves platform support | 1 | HTTP | yes | INV | docs/03:31; only HTTP proof that B membership+entitlements with an A-SSO session gets 404 (indistinguishable from absent org); platform staff 200 |
| tenant-authentication.integration.test.ts:226 | independently verified B account evidence admits same global user to B | 1 | HTTP+SVC | yes | INV | docs/03:29,31 positive half: B SSO → session/audit evidence, grant in B (SVC), admin GET on B → 200 (HTTP); grant half overlaps user-oauth:1721 |
| tenant-authentication.integration.test.ts:349 | grant and human admission recheck ${change} SSO configuration | 5 | SVC+HTTP | yes | INV | docs/03:31 "current" SSO, README:27; revision bump (secret/reverted/deleted/recreated) → grant access_denied (SVC) + admin GET 404 (HTTP); noop keeps 200 |
| tenant-authentication.integration.test.ts:405 | ${consumer} admission and provider rotation are ordered ${order} | 4 | SVC (DB locks) | yes | INV | lock ordering admission vs putSsoProvider for createResourceGrant and tenant command; not covered by user-grant-boundary (its SSO races are native token issuance) |
| tenant-authentication.integration.test.ts:521 | ${consumer} admission rechecks expiry after waiting for provider lock | 2 | SVC (DB locks) | yes | INV | session expiry evaluated after lock wait (command-authority.ts:74-89); databaseClock rewrites literal `statement_timestamp()` in SQL text |
| tenant-authentication.integration.test.ts:593 | same-key human replay rechecks current SSO after middleware admission | 1 | HTTP (+spy db.transaction) | yes | INV | README:27 replay rechecks SSO; injection relies on afterBrokerRead (2nd transaction call) — internal-order coupling |
| tenant-authentication.integration.test.ts:650 | human permissions expiring during provider lock wait cannot authorise | 1 | SVC (DB locks) | yes | INV | entitlement window evaluated after lock wait; ~60-line copy of :521 human branch (merge candidate) |
| tenant-authentication.integration.test.ts:717 | native SSO rejects invalid upstream auth_time ${value} | 5 | HTTP | yes | INV | docs/03:29 verified upstream time; sso-origin.ts:80-91; no other test |
| tenant-authentication.integration.test.ts:747 | native provenance failure ${fault} rolls back without sign-in success | 2 | MOCK-BA | yes | FILL | drives defensive branches sso-origin.ts:110-111 and :132-135 only via injected faults (resolver deletes the account it just created; BA internalAdapter.createSession substituted); sole coverage source of those lines |
| tenant-authentication.integration.test.ts:820 | missing origin or deleted ${missing} cannot establish authority | 5 | SVC | yes | INV | tenantAuthentication joins: origin, account, account-provider, member, user; docs/03:29-31, 72-73 |
| tenant-authentication.integration.test.ts:891 | native sign-in commits client address with session and audit | 1 | HTTP | yes | INV | docs/03:117 one resolver for session + sign-in audit IP with trusted-proxy walk; federation.integration.test.ts:753 covers same without proxy walk |
| tenant-authentication.integration.test.ts:923 | session reads do not emit a signed JWT header | 1 | HTTP | yes | CON | /auth/get-session wire: no set-auth-jwt (auth.ts:270); unique |
| tenant-authentication.integration.test.ts:935 | sign-in audit failure rolls back the new session | 1 | HTTP (+spy recordAuditEvent) | yes | INV | docs/03:109 audit shares the transaction; distinct fault from federation.integration.test.ts:695 |

#### src/auth/machine-audit.integration.test.ts (15 call sites, 19 cases)

| file:line | test title (shortened ok) | n | layer | PG | class | reason |
|---|---|---|---|---|---|---|
| machine-audit.integration.test.ts:123 | successful machine issuance commits one attributed, secret-free audit fact | 1 | HTTP | yes | INV | docs/03:103 no secrets in audit; untrusted `metadata` param ignored; subjects captured; overlaps db/runtime-role.integration.test.ts:56 (decision shape) |
| machine-audit.integration.test.ts:201 | audit failure prevents token release; new request succeeds after recovery | 1 | HTTP+MOCK-BA (extension push, DB trigger) | yes | INV | docs/03:109; 503 Retry-After, extension write rolled back |
| machine-audit.integration.test.ts:269 | repeated correlation IDs describe distinct OAuth issuances | 1 | HTTP | yes | BEH | x-request-id is not idempotency for token issuance; low value, operationId null already asserted in :123 |
| machine-audit.integration.test.ts:285 | audit evidence rejects mismatched client, audience and scope decisions | 1 | SVC | yes | DUP | same guard machine-audit.ts:36-50 driven over HTTP by :318; client_id/aud subcases unreachable from production |
| machine-audit.integration.test.ts:318 | machine issuance rejects ${field} diverging from its policy decision | 5 | HTTP+MOCK-BA (extension unshift) | yes | INV | issued claims must equal evaluated decision; 500, rollback, rejection audit; 5 cases exercise one boolean guard (1-2 suffice) |
| machine-audit.integration.test.ts:376 | versioned machine decision history preserves legacy events and evaluated snapshot | 1 | HTTP | yes | CON | admin audit-events API returns schemaVersion 1 and 2; snapshot not recomputed; same skeleton as :766 |
| machine-audit.integration.test.ts:442 | verified client denial is durable and does not attribute a claimed client | 1 | HTTP | yes | INV | denial audit attributed only after authentication; wrong secret → system actor, org null, no clientId/secret; refusal code half = token.integration.test.ts:172 |
| machine-audit.integration.test.ts:522 | rejection audit failure keeps original denial, safe operational signal | 1 | HTTP (DB trigger) | yes | INV | OPERATIONS.md:37 `token_rejection_audit_unavailable`, refusal remains refusal, no secrets in log |
| machine-audit.integration.test.ts:572 | tenant denial history exposes no foreign resource configuration | 1 | HTTP | yes | INV | foreign tenant_owned target → invalid_target; tenant audit API leaks no foreign ids/names/scopes |
| machine-audit.integration.test.ts:625 | client authentication storage failure is unattributed, excludes exception details | 1 | MOCK-BA (spy adapter.findOne) | yes | INV | storage failure → unattributed failure audit without exception text |
| machine-audit.integration.test.ts:661 | restricted runtime records failed authentication without claimed-client subject | 1 | HTTP (runtime role) | yes | INV | trigger-captured subjects have no client/org for unauthenticated attempt |
| machine-audit.integration.test.ts:709 | malformed targets and missing capabilities retain distinct rejection stages | 1 | HTTP | yes | CON | audit `stage` field (request vs authorization); refusal codes DUP token.integration.test.ts:178 |
| machine-audit.integration.test.ts:749 | pre-evaluation scope refusal records no invented policy decision | 1 | HTTP | yes | INV | openid in machine request → invalid_scope, decision null, raw scope not stored |
| machine-audit.integration.test.ts:766 | versioned denial history keeps evaluated ceilings after policy changes | 1 | HTTP | yes | CON | denial snapshot retained after policy change; merge with :376 |
| machine-audit.integration.test.ts:854 | extension-specific denial cannot copy arbitrary error data into audit | 1 | HTTP+MOCK-BA | yes | INV | audit reason restricted to enum (machine-audit.ts:90-135) |

#### src/auth/grant-locks.integration.test.ts (10 call sites, 15 cases)

| file:line | test title (shortened ok) | n | layer | PG | class | reason |
|---|---|---|---|---|---|---|
| grant-locks.integration.test.ts:196 | issuance commits before ${target} disable; JWT stays invalid after re-enable | 2 | MOCK-BA (extension hold) + HTTP /me | yes | INV | disable waits for in-flight issuance (org/client share locks); re-enable half DUP token-identity.integration.test.ts:189,:232; `authTransaction(pause.adapter())` throw is an IMPL assertion |
| grant-locks.integration.test.ts:244 | ${target} disable commits before identity checks and denies issuance | 2 | MOCK-BA (wrap adapter.transaction) | yes | INV | policy read after authentication; sequential version = token.integration.test.ts:198 |
| grant-locks.integration.test.ts:274 | two issuances share the organisation lock; another tenant can change | 1 | MOCK-BA | yes | BEH | liveness: share (not exclusive) lock, no cross-tenant blocking |
| grant-locks.integration.test.ts:304 | locked current client must match the authenticated instance | 1 | MOCK-BA (extension mutates BA client object) | yes | FILL | reaches machine-identity.ts:105-112 only by corrupting BA's in-memory client; same check already ran under the same lock in prepareMachineGrant (machine-identity.ts:47-55) |
| grant-locks.integration.test.ts:318 | blocked issuance times out, rolls back, retries without leaking pool settings | 1 | MOCK-BA | yes | INV | unique: pooled `lock_timeout` not leaked; 503/Retry-After/recovery half DUP db/statement-timeout.integration.test.ts:139 |
| grant-locks.integration.test.ts:382 | committed ${policy} policy changes are read after authentication | 4 | MOCK-BA | yes | INV | resource/client/grant-type/capability change committed between authentication and transaction is seen |
| grant-locks.integration.test.ts:437 | resource scope and lifetime changes wait for issuance | 1 | MOCK-BA | yes | INV | resource writer blocks; old TTL on in-flight, new TTL after |
| grant-locks.integration.test.ts:476 | resource unlink waits for issuance and denies subsequent tokens | 1 | MOCK-BA | yes | INV | link writer blocks; then invalid_target |
| grant-locks.integration.test.ts:498 | capability revocation waits for issuance then denies | 1 | MOCK-BA | yes | INV | capability writer blocks; then unauthorized_client |
| grant-locks.integration.test.ts:526 | capability expiring after issuance tx starts is denied at policy evaluation | 1 | MOCK-BA | yes | INV | windows use statement time, not transaction start |

#### src/auth/machine-provider.integration.test.ts (6 call sites, 9 cases)

| file:line | test title (shortened ok) | n | layer | PG | class | reason |
|---|---|---|---|---|---|---|
| machine-provider.integration.test.ts:107 | provider transaction: verified client and atomic extension write (${failure}) | 4 | HTTP-testBA+MOCK-BA (injected accessToken extension) | yes | INV | docs/03:109; none/policy/credentials ≈ machine-audit:201, :854, token.integration:172; signing-failure case unique |
| machine-provider.integration.test.ts:193 | client assertions remain consumed when issuance fails | 1 | HTTP-testBA+MOCK-BA | yes | INV | private_key_jwt jti single use survives grant rollback; only client_credentials assertion test anywhere |
| machine-provider.integration.test.ts:254 | machine policy rejects other grants, missing/repeated audiences, excessive scopes | 1 | HTTP-testBA + SVC (auth.api) | yes | INV | docs/03:43 exactly one resource; missing resource / over-ceiling DUP token.integration:178/:184; repeated resource, empty scope, identity scope in ceiling unique; no-request branch test-only |
| machine-provider.integration.test.ts:329 | private resources accept only owning machine tenant even with foreign link | 1 | HTTP-testBA | yes | INV | docs/03:43 tenant_owned binding; partial overlap machine-audit:572 |
| machine-provider.integration.test.ts:383 | registration and compatibility alone do not authorise a machine grant | 1 | HTTP-testBA | yes | DUP | machine-audit.integration.test.ts:709 deletes capabilities and gets unauthorized_client through the real app |
| machine-provider.integration.test.ts:414 | machine capabilities bound default/explicit scopes; stop when disabled/expired/removed | 1 | HTTP-testBA | yes | INV | docs/03:60; default scope = intersection; validFrom/validUntil windows; authorization_code capability cannot substitute; unique |

#### src/auth/application-secrets.integration.test.ts (1 call site)

| file:line | test title (shortened ok) | n | layer | PG | class | reason |
|---|---|---|---|---|---|---|
| application-secrets.integration.test.ts:10 | application secret rotation retains signing custody, requires new browser auth | 1 | HTTP (get-session, SSO) + SVC (BA api.signJWT) + DB | yes | INV | README:67-75 (README:75 names this test); IMPL couplings: `$ba$2$` ciphertext prefix (:101), server-only `api.signJWT` instead of the token endpoint, key expiry forced via `jwks.expiresAt` |

#### src/auth/member-permission.test.ts (4 call sites)

| file:line | test title (shortened ok) | n | layer | PG | class | reason |
|---|---|---|---|---|---|---|
| member-permission.test.ts:75 | resource requests exact at issuance, narrowed at authorisation | 1 | UNIT | no | INV | docs/03:60, scope-subset decision; edge cases (narrow-to-empty, beyond original) not at HTTP; main path also user-oauth.integration.test.ts:1977 |
| member-permission.test.ts:126 | login requests drop unapproved identity scopes only when narrowing | 1 | UNIT | no | DUP | user-oauth.integration.test.ts:2064 "browser authorisation drops unapproved identity scopes" and :2086 "empty ${refusal} approval refuses selection" |
| member-permission.test.ts:148 | access explanations have no granted request; public shape unchanged | 1 | UNIT | no | CON | admin access view omits grantedScopes; http/admin/access.integration.test.ts:386 uses toMatchObject so would not catch a leak |
| member-permission.test.ts:165 | narrowing preserves admission, exact-pair capabilities and refresh requirements | 1 | UNIT | no | INV | docs/03:60 refresh needs its own ceiling; narrowing cannot bypass context/capability |

#### src/auth/ip-metadata.test.ts (3 call sites, 9 cases)

| file:line | test title (shortened ok) | n | layer | PG | class | reason |
|---|---|---|---|---|---|---|
| ip-metadata.test.ts:11 | spoofed leftmost forwarding / distinct clients → rate-limit keys | 2 | MOCK-BA (forces rateLimit on, replaces customStorage) | no | INV | docs/03:117 right-walk with trusted proxies feeds rate-limit keys |
| ip-metadata.test.ts:58 | production ingress admission at ${path} | 6 | HTTP (subprocess, stub auth/db) | no | INV | docs/03:117 untrusted_ingress 403 + no-store + request id; health/readiness 200; 6 process spawns |
| ip-metadata.test.ts:96 | unresolved client context refuses authentication before dispatch | 1 | HTTP (stubAuth, disableIpTracking) | no | FILL | comment :94-95 says it exists for in-process coverage of app.ts:59-67; behaviour = :58; `disableIpTracking` set nowhere else |

#### src/auth/logging.test.ts (2 call sites)

| file:line | test title (shortened ok) | n | layer | PG | class | reason |
|---|---|---|---|---|---|---|
| logging.test.ts:11 | native error boundary sanitises unexpected errors, preserves protocol failures | 1 | UNIT | no | DUP | services/federation.integration.test.ts:695 "a failed origin insert rolls back native SSO…" asserts the 500 body and the exact console.error list over HTTP; also http/admin/user-replay.integration.test.ts:354 |
| logging.test.ts:40 | provider diagnostics retain severity without inspecting messages | 1 | UNIT (BA $context.logger) | no | INV | docs/06:173 diagnostics print only severity + `provider_diagnostic`; only test of auth.ts:66-73 |

#### src/auth/audit-hooks.test.ts (1 call site)

| file:line | test title (shortened ok) | n | layer | PG | class | reason |
|---|---|---|---|---|---|---|
| audit-hooks.test.ts:6 | ${hook} audits session attribution with null context and headers | 1 | UNIT (fake Executor) | no | IMPL | fake db mirrors recordAuditEvent's execute→insert().values() (db/queries/audit.ts:51-72); null context only from tests; lines already covered by federation.integration.test.ts:753 HTTP sign-out; unique facts requestId/organizationId belong there |

#### Totals

57 call sites, 92 cases. INV 41, CON 5, BEH 2, DUP 5, FILL 3, IMPL 1.

### Pages and HTTP layer

Worktree `apps/id`, tree 491c9e9. Read only; nothing run.
"stub" = `stubAuth()` from `src/__tests__/support.ts` (no real Better Auth). "copy" = asserts user-visible English wording (breaks on a copy edit).

#### src/http/pages/pages.test.ts (14 call sites; all HTTP on `createApp` + stub, stub DB; PG no)

| file:line | test title | n | layer | class | reason |
|---|---|---|---|---|---|
| pages.test.ts:110 | login renders signed-out, signed-in, hinted, forced-auth states | 1 | HTTP (stub) | BEH | signed-in + signed query → 302 `/authorize?…` (relative), `prompt=login`/`max_age=0` keep the form; rest is copy (8 literals) and get-session failure branches (FILL part) |
| pages.test.ts:145 | automatic sign-in and sign-in errors retain the form and email | 1 | HTTP (stub) | BEH | `?organization=` auto-starts SSO with slug and self origin (:150); 4 failure branches render alert (FILL part); copy "Work email" |
| pages.test.ts:167 | sign-out clears cookies and handles service failures | 1 | HTTP (stub) | BEH | 303 to `/login?<query>`, Set-Cookie forwarded; failure re-render copy "couldn't sign you out" |
| pages.test.ts:196 | OAuth views show request details, selection, consent and empty states | 1 | HTTP (stub) | FILL | drives every branch of `views/oauth-request.tsx` (null name/uri/resource, empty memberships, failure loops); 19 copy literals |
| pages.test.ts:262 | organisation selection validates membership and forwards the correct action | 1 | HTTP (stub) | BEH | non-UUID / foreign member id refused before BA; exact forwarded body incl. server-built `callbackURL` (IMPL part); failure copy |
| pages.test.ts:310 | consent records accept and deny and renders recoverable failures | 1 | HTTP (stub) | BEH | decision forwarded as `accept` bool; invalid decision never forwarded; copy "Your choice could not be recorded." |
| pages.test.ts:334 | error pages escape descriptions and render known, unknown and absent codes | 1 | HTTP (stub) | INV | reflected `error_description` is HTML-escaped (XSS); first loop is copy "Try another email" |
| pages.test.ts:345 | security session states and verification actions | 1 | HTTP (stub) | BEH | callback/errorCallback fixed to `<origin>/security`; provider trimmed; 4 failure branches (FILL part); 6 copy literals |
| pages.test.ts:412 | pages carry security headers and serve their assets; API routes do not | 1 | HTTP (stub) | INV | CSP `default-src 'none'`, XFO DENY, no-store, referrer same-origin, no COOP; assets served; `isPagePath` list (README:8 no browser JS) |
| pages.test.ts:454 | page mounting preserves issuer discovery at both public paths | 1 | HTTP (stub) | CON | both well-known paths answer 200 without page CSP; stubbed `getOpenIdConfig` so field stripping in `oauth-metadata.ts` is unproved |
| pages.test.ts:477 | login footer shows supported directories regardless of platform credentials | 1 | HTTP (stub) | IMPL | pins absence of a removed design ("Not available", "grayscale", `style=`); page never reads credentials; copy x3 |
| pages.test.ts:500 | invalid email re-renders with the footer without calling auth | 1 (6 inner) | HTTP (stub) | BEH | malformed emails never reach BA (requests length 0); copy "Works with" |
| pages.test.ts:518 | other pages do not show the directory footer | 1 | HTTP (stub) | IMPL | layout detail (no `<footer`) |
| pages.test.ts:526 | consent lists granted access and names withheld scopes only when needed | 1 (3 inner) | HTTP (stub) | DUP | partial case = pages.integration.test.ts:434 "partial consent displays…"; full case = pages.integration.test.ts:184; only null-grant branch unique; literal HTML with class names |

#### src/http/pages/pages.integration.test.ts (10 call sites, 11 cases; real `createAdminFixture` app + real BA + fake IdP unless noted; PG yes)

| file:line | test title | n | layer | class | reason |
|---|---|---|---|---|---|
| pages.integration.test.ts:171 | organisation login forwards state and session cookies through the issuer | 1 | HTTP | BEH | `/login?organization=` → IdP → callback → session; lands on `<origin>/login?organization=tenant`; copy "Signed in as" |
| pages.integration.test.ts:184 | browser selection and consent: accept/deny | 2 | HTTP | CON | only end-to-end of selection → consent → client callback via pages: `code` on accept, `error=access_denied` on deny |
| pages.integration.test.ts:227 | email login carries the signed OAuth query through SSO to selection | 1 | HTTP | BEH | signed `sig` query survives SSO round trip to `/authorize` |
| pages.integration.test.ts:247 | security renders both actions and forwards verification state cookies | 1 | HTTP | BEH | `/security/verify` → 302 to IdP with state cookie; copy x2 |
| pages.integration.test.ts:320 | email routing preserves SSO request headers, cookies and OAuth query | 1 (2 inner) | HTTP (stub BA, real DB) | IMPL | exact forwarded body/headers to stub; sends `Origin: https://foreign.example` and expects 302 (stub has no CSRF); headers DUP of gateway.test.ts:7 |
| pages.integration.test.ts:350 | typed email SSO failures retain the form, address and footer | 1 (4 inner) | HTTP (stub BA, real DB) | FILL | same 4 failure replies as pages.test.ts:151 on the POST branch; copy |
| pages.integration.test.ts:371 | a routing lookup failure retains the login form | 1 | HTTP | FILL | DB closed → catch at routes/login.ts:124; copy "couldn't sign you in" |
| pages.integration.test.ts:386 | a second organisation domain signs in with a normalised login hint | 1 | HTTP | BEH | domain→org lookup, trim+lowercase, `login_hint` reaches IdP |
| pages.integration.test.ts:406 | unknown and disabled domains do not start SSO or contact the issuer | 1 (2 inner) | HTTP | BEH | disabled domain not routable; `fetch` spy (IMPL part); copy "couldn't find your organisation" |
| pages.integration.test.ts:434 | partial consent displays the approved list and withheld identity scopes | 1 | HTTP | BEH | consent shows only granted scopes, names withheld; literal HTML with class |

#### src/http/pages/gateway.test.ts (2; UNIT bare Hono + stub; PG no)

| file:line | test title | n | layer | class | reason |
|---|---|---|---|---|---|
| gateway.test.ts:7 | gateway forwards only the required headers and appends every response cookie | 1 (2 inner) | UNIT | INV | forwards browser Origin (CSRF depends on it), cookie, UA, XFF; does not test that other headers are dropped; does not prove refusal |
| gateway.test.ts:73 | gateway refuses routes that clients cannot reach | 1 | UNIT | FILL | gateway.ts:21 throw; every call site passes a literal allowlisted path |

#### src/http/pages/error-copy.test.ts (6; UNIT; PG no)

| file:line | test title | n | layer | class | reason |
|---|---|---|---|---|---|
| error-copy.test.ts:25 | describes every supported error without exposing its code | 1 (16 inner) | UNIT | FILL | list omits 8 of 24 `ERRORS` keys (membership_revoked, invalid_state, platform_application_missing, SSO_PROVIDER_CHANGED, …) |
| error-copy.test.ts:35 | explains why guest directory accounts cannot sign in | 1 | UNIT | FILL | literal copy |
| error-copy.test.ts:42 | uses a calm fallback for missing and unknown codes | 1 | UNIT | FILL | literal copy |
| error-copy.test.ts:54 | distinguishes a missing platform application from an unknown organisation | 1 | UNIT | FILL | literal copy |
| error-copy.test.ts:64 | uses a general sign-in error for unknown failures and a missing URL | 1 | UNIT | DUP | error-copy.test.ts:42; `describeSSOError` is a one-line alias |
| error-copy.test.ts:73 | asks users to restart when redirect state no longer matches | 1 | UNIT | FILL | literal copy |

#### src/http/pages/login-routing.test.ts (5; UNIT; PG no)

| file:line | test title | n | layer | class | reason |
|---|---|---|---|---|---|
| login-routing.test.ts:6 | automatically routes a valid organization without a login hint | 1 | UNIT | DUP | pages.test.ts:145 (auto start at HTTP), pages.integration.test.ts:171 (real) |
| login-routing.test.ts:19 | shows the form for invalid organization slugs | 1 (6 inner) | UNIT | BEH | slug regex gate before SSO |
| login-routing.test.ts:34 | a login hint overrides automatic organization routing | 1 | UNIT | BEH | |
| login-routing.test.ts:51 | only carries a login hint into the form when it looks like email | 1 | UNIT | BEH | positive case also at pages.test.ts:110 |
| login-routing.test.ts:60 | returns a signed OAuth query only when client_id and sig are present | 1 | UNIT | BEH | |

#### src/app.test.ts (27 call sites, 33 cases; all `createApp` + stub; PG no)

| file:line | test title | n | layer | class | reason |
|---|---|---|---|---|---|
| app.test.ts:18 | health is independent from PostgreSQL and creates a UUIDv7 request id | 1 | HTTP (stub) | BEH | docs/03:117 health reachable |
| app.test.ts:38 | uses the problem handler for thrown route errors | 1 | HTTP (stub) | DUP | problem.test.ts:38 + every admin problem response (admin-routes.ts:139 "no credentials") through the same root onError |
| app.test.ts:61 | preserves a caller-provided request id | 1 | HTTP (stub) | DUP | app.test.ts:710 "maximum valid correlation ids survive…" |
| app.test.ts:74 | readiness uses the database from Hono context | 1 | HTTP (stub) | IMPL | asserts stub identity passed to injected `readinessCheck` |
| app.test.ts:92 | readiness reports an unavailable database | 1 | HTTP (stub) | BEH | 503 `{status:"unavailable"}` |
| app.test.ts:105 | publishes a valid admin OpenAPI contract and reference | 1 | HTTP (stub) | DUP | openapi.integration.test.ts:69 "the admin OpenAPI snapshot matches" (real BA); only `/api/admin/docs` 200 unique; 105 lines |
| app.test.ts:211 | publishes only reachable routes in the public OpenAPI contract | 1 | HTTP (stub) | DUP | openapi.integration.test.ts:28 (snapshot + every path allowlisted, real BA); 92 lines |
| app.test.ts:304 | builds the public OpenAPI contract with an explicit server | 1 | UNIT | FILL | `servers` option + method sort branch |
| app.test.ts:332 | can disable OpenAPI routes | 1 | HTTP (stub) | BEH | README:18 OPENAPI_ENABLED |
| app.test.ts:344 | keeps the OpenAPI contract but hides interactive docs in production | 1 | HTTP (stub) | BEH | |
| app.test.ts:356 | forwards only allowlisted Better Auth routes | 1 | HTTP (stub) | INV | docs/03:21; only HTTP test of POST /auth/organization/create → 404 |
| app.test.ts:376 | answers trusted SSO preflights without reflecting untrusted origins | 1 | HTTP (stub) | INV | docs/06:74 CORS; only CORS tests in repo (with :450) |
| app.test.ts:405 | blocks every unapproved SSO and OAuth provider endpoint | 1 (20 inner) | HTTP (stub) | INV | docs/03:21, README:7; stub returns 200 for any path so 404 proves the gate |
| app.test.ts:437 | returns structured JSON for unknown routes | 1 | HTTP (stub) | BEH | |
| app.test.ts:450 | admin CORS allows trusted preflights | 1 (2 inner) | HTTP (stub) | INV | docs/06:74 |
| app.test.ts:479 | unknown admin routes return a problem without requiring credentials | 1 | HTTP (stub) | CON | problem envelope, 404 before auth |
| app.test.ts:491 | mounted me runs principal resolution and the root problem handler | 1 | HTTP (stub) | DUP | admin-routes.ts:139 "getAdminMe: no credentials" (me.integration.test.ts, real BA); counts getSession calls |
| app.test.ts:513 | token requests preserve grants and bodies for Better Auth | 1 (4 inner) | HTTP (stub) | DUP | token.integration.test.ts:134 (real token exchange through body guard); GET 404 = auth-allowlist.test.ts:4 |
| app.test.ts:544 | auth catch-all propagates request ids and audits rejection redirects | 1 (2 inner) | HTTP (stub+stub DB) | DUP | ids: app.test.ts:587/:710; audit: federation.integration.test.ts:861 "rejects Entra claim policy" (real) |
| app.test.ts:587 | unusable correlation headers are replaced consistently before auth | 1 (4 inner) | HTTP (stub) | CON | x-request-id contract, header injection |
| app.test.ts:617 | body guard counts actual bytes despite a false content length and cancels overflow | 1 | HTTP (stub) | INV | docs/03:111 body limits; lying Content-Length not in runtime.test.ts |
| app.test.ts:650 | body deadline cancels a stalled upload before invoking the provider | 1 | HTTP (stub) | DUP | runtime.test.ts:186 (408 at a real socket); costs 5 s wall clock |
| app.test.ts:682 | unreadable bodies return a safe transport error before provider or admin work | 1 (2 inner) | HTTP (stub) | FILL | request-limits.ts:60 catch; client can't observe |
| app.test.ts:710 | maximum valid correlation ids survive in both context and auth headers | 1 (2 inner) | HTTP (stub) | CON | |
| app.test.ts:732 | preflight cannot bypass the incoming body limit | 1 | HTTP (stub) | INV | |
| app.test.ts:759 | auth allowlist rejects path bypass ${path} | 6 | HTTP (stub) | INV | encoded slash, `..`, `//`, trailing slash, case, dot-segments; asserts handler never reached |
| app.test.ts:781 | auth allowlist ignores ${header} on an allowed route | 2 | HTTP (stub) | INV | method override headers |

#### src/http/principal.test.ts (29 call sites, 47 cases; Hono + mocked `PrincipalDeps`, stub DB; PG no)

| file:line | test title | n | layer | class | reason |
|---|---|---|---|---|---|
| principal.test.ts:111 | requires credentials and advertises bearer authentication | 1 | UNIT (mock deps) | DUP | admin-routes.ts:139 "no credentials"; app.test.ts:491 exact challenge |
| principal.test.ts:119 | rejects malformed %s without consulting cookies | 3 | UNIT | INV | Bearer present → never falls back to cookie |
| principal.test.ts:131 | maps verifier failures to invalid_token | 1 | UNIT | DUP | admin-routes.ts:143 "foreign bearer"; token-identity.integration.test.ts:266 |
| principal.test.ts:143 | checks client state %# | 5 | UNIT | INV | null/disabled/unowned/org-disabled/org-null; null = token-identity.integration.test.ts:168, disabled = token.integration.test.ts:198; unowned + org-null rows unreachable in production |
| principal.test.ts:168 | rejects delegated credentials including an empty sid | 1 | UNIT | INV | user-delegated JWT never an admin credential; only proof (mocked verifier) |
| principal.test.ts:184 | intersects and sorts scopes, ignores cookies and skips CSRF | 1 | UNIT | INV | scope ceiling intersection; bearer exempt from Origin; `toHaveBeenCalledWith` (IMPL part); partial token-identity.integration.test.ts:246 |
| principal.test.ts:217 | a null client scope ceiling grants no scopes | 1 | UNIT | FILL | `findClientPrincipal` always returns an array for owned clients (client-principal.ts:120-125) |
| principal.test.ts:225 | rejects inactive users | 1 | UNIT | DUP | admin-routes.ts:207 "disabled user" |
| principal.test.ts:234 | rejects untrusted origins | 1 | UNIT | DUP | admin-routes.ts:159 "untrusted origin"; request-security.integration.test.ts:14 |
| principal.test.ts:243 | requires an origin on writes | 1 | UNIT | DUP | admin-routes.ts:151 "missing origin" |
| principal.test.ts:251 | accepts a cookie GET with origin %s | 3 | UNIT | BEH | self origin accepted (docs/06:30); loadGrants call args (IMPL part) |
| principal.test.ts:273 | allows safe methods or trusted-origin writes: %s | 3 | UNIT | BEH | |
| principal.test.ts:288 | non-bearer authorization still uses the session | 1 | UNIT | FILL | regex false branch |
| principal.test.ts:298 | validates the machine identity contract, issuer, audience, type and expiry | 1 (2+18 inner) | UNIT (real jose) | INV | only proof of aud/iss/typ/sub=client_id/azp/identity-claim rejection for admin bearer; alg attacks also at token-identity.integration.test.ts:266, expiry at token.integration.test.ts:251 |
| principal.test.ts:373 | caches for five minutes, retries rotated keys once, propagates other failures | 1 | UNIT | BEH | docs/06:14 five-minute cache; asserted by getJwks call counts |
| principal.test.ts:404 | concurrent cold and missing-key verification shares one load… | 1 | UNIT | IMPL | single-flight via call counts |
| principal.test.ts:439 | concurrent rotated-key verification shares refresh… | 1 | UNIT | BEH | old tokens verify during rotation |
| principal.test.ts:477 | failed shared key loads reject callers and allow the next request to recover | 1 | UNIT | BEH | |
| principal.test.ts:510 | default deps use Better Auth's non-refreshing session API | 1 | MOCK-BA | IMPL | asserts `getSession` call args |
| principal.test.ts:528 | root bearer skips JWT, session and CSRF on %s | 2 | UNIT | DUP | root.integration.test.ts:36 (GET me 200, POST organizations without Origin 201); admin-routes.ts:107 |
| principal.test.ts:548 | non-root bearer uses JWT with configured secret %s | 2 | UNIT | DUP | root.integration.test.ts:53-69 (wrong and unset secret → 401) |
| principal.test.ts:566 | root lockout is audited once without credentials | 1 | UNIT | DUP | root.integration.test.ts:214-231, :249 (secret not in audit) |
| principal.test.ts:604 | break-glass skips the writer lookup | 1 | UNIT | DUP | root.integration.test.ts:232-237 |
| principal.test.ts:618 | session service failures are retryable without hiding unrelated errors | 1 | MOCK-BA | CON | 503 `authentication_unavailable` + Retry-After |
| principal.test.ts:641 | HTTP admission rejects a verified token that expires during principal lookup | 1 | UNIT | INV | expiry rechecked after the DB lookup |
| principal.test.ts:676 | administrative ${reason} denial records bounded attribution without credentials | 7 | UNIT | INV | docs/03:123 bounded rejection facts; no cookie/bearer in audit |
| principal.test.ts:734 | unknown keys reload at most once per thirty seconds | 1 | UNIT | IMPL | DoS throttle asserted by call counts |
| principal.test.ts:760 | invalid bearer denial keeps the claimed client identity as unverified metadata | 1 | UNIT | INV | docs/03:123 no attribution of unverified claims |
| principal.test.ts:780 | failed administrative authentication stays refused when its audit cannot be stored | 1 | UNIT | DUP | denial-audit.integration.test.ts:51 (locked-root kind, same `recordAdministrativeDenial`) |

#### src/http/problem.test.ts (9 call sites, 16 cases; UNIT; PG no)

| file:line | test title | n | layer | class | reason |
|---|---|---|---|---|---|
| problem.test.ts:38 | serialises a problem with details and extensions | 1 | UNIT | CON | problem+json envelope |
| problem.test.ts:64 | converts HTTP exceptions | 1 | UNIT | CON | |
| problem.test.ts:90 | maps database code %s | 6 | UNIT | CON | 409/400/503 mapping |
| problem.test.ts:115 | names unique constraints and handles missing constraints | 1 | UNIT | FILL | detail wording |
| problem.test.ts:125 | omits unique constraint details when the driver does not name one | 1 | UNIT | DUP | problem.test.ts:115 second assertion (same branch) |
| problem.test.ts:129 | ignores unrelated and malformed errors | 1 (9 inner) | UNIT | FILL | type guards |
| problem.test.ts:145 | logs unexpected errors and hides internal details | 1 | UNIT | INV | 500 never leaks internals; log line wording (FILL part) |
| problem.test.ts:175 | describes problem responses with an extensible OpenAPI schema | 1 | UNIT | DUP | openapi.integration.test.ts:69 admin snapshot |
| problem.test.ts:199 | pool timeout %s has the same safe response… | 2 | UNIT | CON | 503 database_busy + Retry-After: 1, no message leak |

#### src/http/validation.test.ts (5; UNIT; PG no)

| file:line | test title | n | layer | class | reason |
|---|---|---|---|---|---|
| validation.test.ts:38 | passes typed JSON and coerced query output to handlers | 1 | UNIT | DUP | every admin integration test with a valid body |
| validation.test.ts:51 | returns nested JSON issue paths and messages | 1 | UNIT | CON | `validation_failed` + `errors[{path,message}]`; admin-routes.ts "invalid body" checks only non-empty |
| validation.test.ts:70 | returns query and root issues | 1 | UNIT | FILL | |
| validation.test.ts:88 | formats standard validation issues without a path | 1 | UNIT | FILL | spies `~standard.validate`; zod always sets path |
| validation.test.ts:115 | registers JSON and query schemas in OpenAPI | 1 | UNIT | DUP | openapi.integration.test.ts:69 |

#### src/http/signin-audit.test.ts (5 call sites, 7 cases; UNIT with stub DB; PG no)

| file:line | test title | n | layer | class | reason |
|---|---|---|---|---|---|
| signin-audit.test.ts:28 | redirect failure records correlation without trusting claimed provider or forwarded IP | 1 (2 inner) | UNIT | INV | docs/03:123; targetId null, XFF ignored |
| signin-audit.test.ts:62 | missing optional metadata stays null | 1 | UNIT | FILL | |
| signin-audit.test.ts:75 | ignores other paths, non-redirects, missing locations and successful redirects | 1 (4 inner) | UNIT | BEH | |
| signin-audit.test.ts:87 | audit failure preserves the redirect and logs one line | 1 | UNIT | INV | docs/05:66 rejection-audit failure preserves outcome; log wording |
| signin-audit.test.ts:105 | unknown callback error is not copied into permanent evidence | 3 | UNIT | INV | no free-form upstream text in audit |

#### src/http/pagination.test.ts (4; UNIT; PG no)

| file:line | test title | n | layer | class | reason |
|---|---|---|---|---|---|
| pagination.test.ts:7 | parses defaults and valid bounds | 1 | UNIT | CON | limit default 50, max 200 |
| pagination.test.ts:15 | rejects invalid limits and cursors | 1 | UNIT | CON | limit=0 and bad cursor also at management.integration.test.ts:442 |
| pagination.test.ts:20 | returns empty, partial, full and continuing pages | 1 | UNIT | DUP | paging loops in users.integration.test.ts (~:400) and organizations.integration.test.ts (~:98) |
| pagination.test.ts:41 | renders a parameterised descending cursor predicate | 1 | DB-text | IMPL | SQL text |

#### src/http/auth-allowlist.test.ts (1; UNIT)

| file:line | test title | n | layer | class | reason |
|---|---|---|---|---|---|
| auth-allowlist.test.ts:4 | only POST is allowlisted for the token endpoint | 1 | UNIT | DUP | app.test.ts:513 (GET /auth/oauth2/token → 404) and app.test.ts:759 (`/auth/oauth2/token/` → 404) at HTTP |

#### src/http/root.integration.test.ts (1; PG yes)

| file:line | test title | n | layer | class | reason |
|---|---|---|---|---|---|
| root.integration.test.ts:36 | root locks after a human administrator and supports break-glass | 1 | HTTP (real BA) | INV | README:39, docs/06:86: wrong/unset secret 401, root admitted + audited, locks after human platform:write, denial audited, break-glass, disabled admin lifts lock, secret never in audit |

#### Class counts

| file | INV | CON | BEH | DUP | FILL | IMPL | sites |
|---|---|---|---|---|---|---|---|
| pages.test.ts | 2 | 1 | 7 | 1 | 1 | 2 | 14 |
| pages.integration.test.ts | 0 | 1 | 6 | 0 | 2 | 1 | 10 |
| gateway.test.ts | 1 | 0 | 0 | 0 | 1 | 0 | 2 |
| error-copy.test.ts | 0 | 0 | 0 | 1 | 5 | 0 | 6 |
| login-routing.test.ts | 0 | 0 | 4 | 1 | 0 | 0 | 5 |
| app.test.ts | 8 | 3 | 5 | 8 | 2 | 1 | 27 |
| principal.test.ts | 8 | 1 | 5 | 10 | 2 | 3 | 29 |
| problem.test.ts | 1 | 4 | 0 | 2 | 2 | 0 | 9 |
| validation.test.ts | 0 | 1 | 0 | 2 | 2 | 0 | 5 |
| signin-audit.test.ts | 3 | 0 | 1 | 0 | 1 | 0 | 5 |
| pagination.test.ts | 0 | 2 | 0 | 1 | 0 | 1 | 4 |
| auth-allowlist.test.ts | 0 | 0 | 0 | 1 | 0 | 0 | 1 |
| root.integration.test.ts | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| **total** | **24** | **13** | **28** | **27** | **18** | **8** | **118** |

#### Literal page-copy assertions (English wording on HTML)

pages.test.ts positive (44): 113 "Work email", 114 "Continue", 124, 131 "Signed in as …", 132 "Works with", 133 "Verify sign-in or connect a work account", 142, 162, 184 "couldn&#39;t sign you out", 185 "Please try again.", 186, 199 "Choose an organisation", 200 "Application address", 205 "Continue", 211 "Access it will receive", 212-215 scope copy (4), 229 "Sign in", 243 "This application", 244 "No organisation is available for this account.", 253 "Return to the application", 258 "This request has expired or is unavailable.", 266 "Access is unavailable for this organisation.", 273, 306 ("Access is unavailable"/"start your organisation"), 326, 331 "Your choice could not be recorded.", 338 "Try another email", 348 "to verify or connect a work account.", 352 "Start again from the sign-in page.", 357 "check your sign-in", 364-366 (3), 489-491 "Works with"/"Microsoft Entra ID"/"Google Workspace", 513, 538, 540, 543, 545 "Not approved for Tenant: <code class=…>…" (copy + class markup).
pages.test.ts negative copy (5, go vacuous on a copy change rather than fail): 493 "Not available", 521 "Works with", 536 "Access it will receive", 541 "Not approved", 547 "Read your email address".
pages.test.ts markup, not copy (19): 115 `<html lang="en" class="dark">`, 119, 134, 161, 165, 193, 204, 216, 217, 218, 342 (escape), 367, 401, 409, 494, 497, 512, 522, 537; plus helper :106 `not.toContain("<script")` on every render.
pages.integration.test.ts positive (15): 180, 214, 215, 251, 252, 364, 366, 378, 380, 403, 424, 425, 455, 456, 458. Negative (3): 217, 381, 460. Markup (5): 363, 365, 379, 382, 459.
error-copy.test.ts full title/body literals: 36-39, 43-46, 55-58, 74-77 (4 tests).
Measured copy edits (probes P25 and P26): changing three strings (the `Sign in` page title, the consent heading and the fallback error title) failed 2 tests (`error-copy.test.ts:42`, `pages.integration.test.ts:371`). Changing the four most-asserted strings (`Access it will receive`, `Works with`, `Confirm who you are`, `Read your email address`) failed 12: 6 of 14 in `pages.test.ts` and 6 of 11 in `pages.integration.test.ts`. The failures include routing tests such as `pages.integration.test.ts:406` "unknown and disabled domains do not start SSO", because they assert footer copy along the way.

#### Evidence notes

- Better Auth 1.7.2 turns off its origin/CSRF check and its callbackURL/errorCallbackURL validation under the test runner: `better-auth/dist/context/create-context.mjs:210` (`skipOriginCheck: … isTest() ? true : false`), `@better-auth/core/dist/env/env-impl.mjs:36` (`isTest = nodeENV === "test" || TEST`), `api/middlewares/origin-check.mjs:15,43-69,102-108`. The only apps/id test that switches it back on is `src/auth/verified-sso.integration.test.ts:787` (link/reauthenticate only).
- Ingress admission (`untrusted_ingress`) is not in app.test.ts; it is `src/auth/ip-metadata.test.ts:50-90` (6-path subprocess in production, stubAuth) and `:94` (in-process).
- Test-only options: `AppServices.readinessCheck`, `AppServices.ssoTest` (app.ts:34-35). `grep -rln "readinessCheck\|ssoTest" src scripts` → only app.ts, http/context.ts, http/admin/sso-providers.ts and tests; production callers runtime.ts:55, scripts/export-openapi.ts:12, scripts/mcp-e2e-fixture.ts:91 set neither.
- Dead entry: signin-audit.ts:9 `"sso_provider_changed"`; `grep -n 'sso_provider_changed"' @better-auth/sso/dist/index.mjs` → none (BA emits `error=invalid_state&error_description=sso_provider_changed_during_authentication`).
- No test anywhere sends an unregistered `redirect_uri` to `/auth/oauth2/authorize` (every `redirect_uri` in src/auth/user-oauth.integration.test.ts is the registered `redirect`).
- App-served discovery (app.ts:101-124, `publicOAuthMetadata` field stripping) is fetched only with a stubbed `getOpenIdConfig` (pages.test.ts:454); user-oauth.integration.test.ts:1356 fetches it through the real app (`auth` is rebound to `app.fetch` at :147), so app-served discovery is covered there.

### Environment, runtime, bootstrap, lib and services

Worktree `agent-a919bcb2c1ec2da06`, HEAD 491c9e9, paths relative to `apps/id`. PG = needs Postgres. "ZOD" in a reason = the assertion proves zod (or Better Auth's validator), not a rule of ours.

#### src/env.test.ts (25 call sites, 35 cases, UNIT, PG no)

| file:line | test title (shortened ok) | n | layer | class | reason |
|---|---|---|---|---|---|
| env.test.ts:27 | upstream ring parses; invalid rings rejected without revealing values | 1 | UNIT | INV | Ours: README:41 ring rules + no echo. Only place `upstreamTokenSecretsSchema` (auth/upstream-token-storage.ts:5) is validated; 7 invalid shapes × (throws + no echo) |
| env.test.ts:65 | parses defaults | 1 | UNIT | BEH | ZOD `.default()`s pinned in one toEqual; ours only adminResourceIdentifier derivation, pool 20, openApi true. Pins docs/06:89 defaults; cheap, keep or drop |
| env.test.ts:94 | one test connection unless overridden | 1 | UNIT | BEH | Our `NODE_ENV==="test" ? 1 : 20` (env.ts:233), a test-only knob; testEnvironment sets databasePoolMax:1 itself (support.ts:33) |
| env.test.ts:108 | bounds operational reporting, permits 0 | 1 | UNIT | BEH | 4 of 7 values prove ZOD int/min/max; only "999"/"0"/"1000" hit our refine (env.ts:103) |
| env.test.ts:127 | parses explicit runtime options | 1 | UNIT | BEH | ZOD coerce string→number for 8 vars; ours: name trim, admin URL slash strip, origin split (dup of :476) |
| env.test.ts:164 | normalises default resource URL; rejects bad slug/admin URL | 1 | UNIT | BEH | 1 assert ours (derive from BETTER_AUTH_URL); 6 slug regex cases + z.url() are ZOD |
| env.test.ts:187 | rejects blank platform names | 1 | UNIT | BEH | ZOD trim().min(1) |
| env.test.ts:198 | rejects invalid configuration (short secret) | 1 | UNIT | BEH | ZOD min(32) |
| env.test.ts:204 | names every missing required variable | 1 | UNIT | BEH | Ours: EnvironmentValidationError names vars (README:18 "named startup error") |
| env.test.ts:210 | loads configuration from process environment | 1 | UNIT | FILL | Covers one-line `loadEnvironment()` (env.ts:280) for the function-coverage gate; mutates process.env |
| env.test.ts:218 | validates root configuration | 1 | UNIT | INV | Ours: BREAK_GLASS requires ROOT_ADMIN_SECRET (env.ts:139; docs/05:29); min(32) part is ZOD |
| env.test.ts:243 | application secret rotation validates every version without leaking | 1 | UNIT | INV | Ours: BETTER_AUTH_SECRETS ring + no echo (README:69); 8 invalid shapes |
| env.test.ts:281 | statement deadline rejects disabled/fractional/out-of-range | 1 | UNIT | BEH | ZOD coerce/int/min/max, 5 values |
| env.test.ts:297 | production defaults ID origin and admin audience when unset/blank | 1 | UNIT | CON | Ours: parseEnvironment pre-fill (env.ts:269); issuer + admin `aud` default (README:18, docs/06:73) |
| env.test.ts:310 | production preserves explicit origins, rejects invalid | 1 | UNIT | BEH | 1 assert ours, 1 ZOD z.url() |
| env.test.ts:320 | development and test still require explicit origin | 1 | UNIT | BEH | Ours: default only in production (README:18) |
| env.test.ts:332 | production disables OpenAPI unless enabled | 1 | UNIT | BEH | Ours (env.ts:240; docs/06:89) |
| env.test.ts:339 | production requires ${key} | 2 | UNIT | INV | Ours: TRUSTED_ORIGINS + TRUSTED_PROXY_CIDRS required in production (docs/06:26,30) |
| env.test.ts:351 | production rejects non-origin ${origin} | 5 | UNIT | INV | Ours: origin-only trusted origins (docs/06:30, env.ts:172-188) |
| env.test.ts:357 | rejects invalid proxy CIDR ${cidr} | 5 | UNIT | BEH | Proves Better Auth's `findInvalidTrustedProxies` (env.ts:88); one case would prove the wiring |
| env.test.ts:362 | parses IPv4 and IPv6 proxy networks | 1 | UNIT | BEH | Ours: split/trim (env.ts:86) |
| env.test.ts:373 | ${key} rejects disabled/fractional/out-of-range deadlines | 2 | UNIT | BEH | ZOD, 5 values each; same shape as :281 |
| env.test.ts:381 | platform application pairs parse in every environment; blanks unset | 1 | UNIT | INV | Ours: pairs together + no echo (README:18). 3-env loop is redundant: pair check runs before the NODE_ENV return (env.ts:146-165); 87 runtime asserts, 29 needed |
| env.test.ts:444 | default.env lists every variable with an empty value | 1 | UNIT | BEH | Ours: the README.md:51 check. ID vars + 4 tooling names only; one direction only |
| env.test.ts:476 | trusted origins trim and discard empties | 1 | UNIT | BEH | Ours: transform env.ts:216 |

#### src/runtime.test.ts (9 call sites, 11 cases, real Bun.serve or mocked serve; PG no: pool created, never queried)

| file:line | test title | n | layer | class | reason |
|---|---|---|---|---|---|
| runtime.test.ts:26 | emits operational summaries, stops reporter on shutdown | 1 | MOCK | IMPL | Spies global setInterval/clearInterval/console.log; summary shape held by operations/metrics.test.ts:10 |
| runtime.test.ts:73 | seeds once with env values before listening; shutdown idempotent | 1 | MOCK | IMPL | Mock call counts/args, `stop(false)`, pool max 1 (test knob). Order fact also held by :122 and :160 |
| runtime.test.ts:122 | failing seed closes pool and prevents listening | 1 | MOCK | BEH | docs/06:109 "fails before it listens"; pool close is the catch at runtime.ts:61-64 |
| runtime.test.ts:144 | starts Bun with one pool, shuts down idempotently | 1 | HTTP | DUP | Real server + /healthz also in runtime.test.ts:186 and :26; only unique bit is real createAuth construction |
| runtime.test.ts:160 | %s refuses an unsafe database role before seeding or listening | 2 | MOCK | INV | docs/06:27; verifyDatabaseRole mocked; real role check is db/runtime-role.integration.test.ts:59 |
| runtime.test.ts:186 | caps declared and streamed request bodies before provider work | 1 | HTTP | CON | 413/408 in OpenAPI (http/request-limits.ts:7-15). Middleware facts dup app.test.ts:617/650/732; unique: Bun `maxRequestBodySize` wiring, real socket stall. Waits the 5 s body deadline |
| runtime.test.ts:279 | startup closes pool when ${stage} construction fails | 2 | MOCK | DUP | Same catch block as runtime.test.ts:122 |
| runtime.test.ts:308 | real occupied port closes seeded runtime's pool | 1 | HTTP | DUP | Same catch block as runtime.test.ts:122 (EADDRINUSE thrown by serve) |
| runtime.test.ts:335 | startup reports only platform application availability | 1 | MOCK | INV | Client IDs/secrets never logged (docs/06:32, README:18); also pins log wording |

#### src/bootstrap.integration.test.ts (8, SVC, PG yes)

| file:line | test title | n | layer | class | reason |
|---|---|---|---|---|---|
| bootstrap.integration.test.ts:63 | creates platform, repeats without changes, repairs drift | 1 | SVC | INV | README:39,45 binding established once, restart preserves/repairs; audit per run |
| bootstrap.integration.test.ts:165 | rolls back org when resource insert fails | 1 | SVC | DUP | Same single-transaction fact as :177; failure injected via `null` identifier |
| bootstrap.integration.test.ts:177 | rolls back every row when audit insert fails | 1 | SVC | INV | docs/05:66 effects+audit atomic |
| bootstrap.integration.test.ts:190 | does not adopt pre-existing names without binding | 1 | SVC | INV | bootstrap.ts:74 "names do not establish ownership" |
| bootstrap.integration.test.ts:202 | changing slug cannot designate another org | 1 | SVC | INV | Binding, not slug, is authority |
| bootstrap.integration.test.ts:216 | does not adopt an unrelated resource | 1 | SVC | INV | Same family as :190; merge into one table |
| bootstrap.integration.test.ts:228 | binding protects its rows, rejects changed audience | 1 | DB | INV | Trigger protection of system_bindings + audience conflict |
| bootstrap.integration.test.ts:248 | preserves explicit restrictions on platform capability | 1 | SVC | INV | bootstrap.ts:210-211 restrictions survive restart |

#### src/lib/*.test.ts (3, UNIT, PG no)

| file:line | test title | n | layer | class | reason |
|---|---|---|---|---|---|
| lib/id.test.ts:7 | creates unique UUIDv7 identifiers | 1 | UNIT | DUP | Proves Bun.randomUUIDv7; app.test.ts:18 asserts UUIDv7 request ids from createId |
| lib/service-url.test.ts:4 | service URL removes trailing slashes | 1 | UNIT | CON | Issuer/base URL without trailing slash (auth.ts:1, pages/gateway.ts:4); not held elsewhere |
| lib/user-agent.test.ts:4 | user-agent bounded printable, never partial | 1 | UNIT | INV | Audit metadata log-injection guard; 513-char case also in http/principal.test.ts:713, http/signin-audit.test.ts:111 |

#### src/services/actor.test.ts, client-secrets.test.ts, root-secret.test.ts (UNIT, PG no)

| file:line | test title | n | layer | class | reason |
|---|---|---|---|---|---|
| services/actor.test.ts:18 | actorFromContext: ${type} with/without metadata | 3 | UNIT | DUP | Actor mapping in audit rows held by http/admin/sso-providers.integration.test.ts:101 (user), :185 (client), http/admin/audit-events.integration.test.ts:200 (root); UA in http/admin/organizations.integration.test.ts:150 |
| services/client-secrets.test.ts:5 | distinct 32-byte unpadded base64url secrets | 1 | UNIT | INV | 256-bit client secret entropy; nothing else checks length |
| services/client-secrets.test.ts:13 | hashes with SHA-256 base64url | 1 | UNIT | DUP | Re-derives SHA-256; real fact (Better Auth accepts the digest, auth.ts:282) held by http/token.integration.test.ts:223 and auth/machine-provider.integration.test.ts:38 |
| services/root-secret.test.ts:9 | compares digests: %s / %s | 4 | UNIT | DUP | http/principal.test.ts:527 (root accepted) and :548 (wrong, different-length secret falls through to JWT) |

#### src/services/sso-providers.integration.test.ts (9 call sites, 17 cases, SVC, PG yes)

| file:line | test title | n | layer | class | reason |
|---|---|---|---|---|---|
| sso-providers.integration.test.ts:77 | upsert keeps omitted secrets, replaces supplied, redacts, audits | 1 | SVC | DUP | http/admin/sso-providers.integration.test.ts:101 (keep secret, redaction, audit actions, delete→404); replacement stored: admin :309 |
| sso-providers.integration.test.ts:137 | missing provider and org paths 404 without audit | 1 | SVC | DUP | describeAdminRoutes "unknown ids" (admin sso-providers:24, __tests__/admin-routes.ts:223) + admin :157 |
| sso-providers.integration.test.ts:154 | secretless and null configs update; audit failures roll back | 1 | SVC | DUP | Rollback: admin sso-providers:429 and service :317; null `oidcConfig` on a live row is FILL (only by DB tampering, sso-providers.ts:118) |
| sso-providers.integration.test.ts:261 | SSO ${mode} revokes only its tenant grants, exact audit effects, keeps browser | 3 | SVC | DUP | auth/user-grant-boundary.integration.test.ts:3747 (refresh denied tenant A, kept tenant B, session kept, restore does not revive). Loses only the `effects.revokedGrantContexts` audit shape |
| sso-providers.integration.test.ts:317 | SSO ${mode} audit failure rolls back config and grant revocation | 3 | SVC | INV | docs/05:66; grant-revocation rollback only here (admin :429 covers config on update) |
| sso-providers.integration.test.ts:344 | unchanged config preserves active grants, empty effects | 1 | SVC | INV | A noop PUT must not sign people out; admin :370 checks the noop action but not grants |
| sso-providers.integration.test.ts:374 | ${application} platform create/delete audit exposes only application ids | 2 | SVC | INV | No platform secret in audit (docs/03:27 "stores no secret", docs/06:32) |
| sso-providers.integration.test.ts:432 | unsupported or missing platform apps reject before writes | 1 | SVC | DUP | http/admin/sso-providers.integration.test.ts:599 (400 unsupported, 409 missing) |
| sso-providers.integration.test.ts:465 | ${transition} preserves credential boundaries, revokes only on change | 4 | SVC | INV | docs/03:27 "Switching modes revokes the organisation's user grants"; platform-own-no-secret must not inherit a secret; only here |

#### src/services/users.integration.test.ts (7 call sites, 9 cases, SVC, PG yes)

| file:line | test title | n | layer | class | reason |
|---|---|---|---|---|---|
| users.integration.test.ts:135 | disabling already-disabled user reconciles ${kind} | 3 | SVC | DUP | http/admin/user-replay.integration.test.ts:134 (session+access+refresh together, runtime role, audit counts); docs/04:162 |
| users.integration.test.ts:200 | all missing user paths 404 without audit | 1 | SVC | DUP | describeAdminRoutes "unknown ids" in http/admin/users.integration.test.ts:142 |
| users.integration.test.ts:216 | lifecycle conflicts, kill switch counts, retired email, erasure audit | 1 | SVC | DUP | http/admin/users.integration.test.ts:144 + :324, user-replay:111. Only extra: audit never contains the original email after retirement (line 311) |
| users.integration.test.ts:326 | erase cascades memberships, accounts, sessions, tokens | 1 | SVC | DUP | http/admin/user-erasure-audit.integration.test.ts:267 |
| users.integration.test.ts:397 | global disable irreversibly revokes contexts across tenants | 1 | SVC | DUP | auth/user-grant-boundary.integration.test.ts:1626; loses only the disable audit's revokedGrantContexts list |
| users.integration.test.ts:430 | erasure audits all contexts incl. another user's via owned client | 1 | SVC | DUP | http/admin/user-erasure-race.integration.test.ts:70 (client case) + user-erasure-audit:267 (other user's history) |
| users.integration.test.ts:482 | disable reconciles unrevoked contexts on disabled user | 1 | SVC | INV | docs/04:162 for grant contexts; user-replay:134 only asserts `revokedGrantContexts: []` |

#### src/services/sessions.integration.test.ts (7, SVC, PG yes)

| file:line | test title | n | layer | class | reason |
|---|---|---|---|---|---|
| sessions.integration.test.ts:123 | missing users and sessions 404 without audit | 1 | SVC | DUP | describeAdminRoutes "unknown ids" (http/admin/sessions.integration.test.ts:132) + admin :161 |
| sessions.integration.test.ts:140 | single revocation checks ownership, revokes tokens, audits once | 1 | SVC | DUP | http/admin/sessions.integration.test.ts:161 + token-revocation-audit.integration.test.ts:67 (session mode) |
| sessions.integration.test.ts:181 | platform revocation counts sessions, includes unbound tokens | 1 | SVC | DUP | http/admin/sessions.integration.test.ts:134 + session-replay.integration.test.ts:90 (token-only applied) |
| sessions.integration.test.ts:224 | audit failure restores sessions and tokens | 1 | SVC | DUP | http/admin/token-revocation-audit.integration.test.ts:67 (rolls back subject failure) |
| sessions.integration.test.ts:301 | single revocation targets its immutable grant origin | 1 | SVC | DUP | auth/user-grant-boundary.integration.test.ts:1681 (single mode: A denied, B still refreshes) |
| sessions.integration.test.ts:324 | revoke-all includes grants whose sessions disappeared | 1 | SVC | DUP | auth/user-grant-boundary.integration.test.ts:3695 (`{revoked:0, changed:true}` then refresh denied) |
| sessions.integration.test.ts:362 | audit failure restores grant contexts | 1 | SVC | INV | docs/05:66; merge with :224 |

#### src/services/platform-users-context.integration.test.ts (6 call sites, 7 cases, SVC, PG yes: createAdminFixture)

| file:line | test title | n | layer | class | reason |
|---|---|---|---|---|---|
| platform-users-context.integration.test.ts:32 | global user mutations require a live users context | 1 | SVC | FILL | Drives "Invalid or expired" throws (platform-context.ts:140-143) reachable only by programmer misuse |
| platform-users-context.integration.test.ts:65 | failed callback expires its users context | 1 | SVC | FILL | Same guard |
| platform-users-context.integration.test.ts:77 | journal exit expires saved authorisation on commit/replay/conflict/failure | 1 | SVC | IMPL | Internal lifetime of `authority.run`/`close` inside executeOperation |
| platform-users-context.integration.test.ts:131 | journal replay releases tenant authorisation | 1 | SVC | IMPL | Same, tenant-context |
| platform-users-context.integration.test.ts:177 | platform write contexts protect 38 mutations | 1 | SVC | FILL | Calls 38 service functions with forged contexts; one call covers the guard line; 137 lines |
| platform-users-context.integration.test.ts:319 | ${factory}: actor is a frozen snapshot | 2 | SVC | IMPL | Object.freeze / copy semantics of commandActor |

#### src/services/diagnostics.integration.test.ts (11, SVC, PG yes)

| file:line | test title | n | layer | class | reason |
|---|---|---|---|---|---|
| diagnostics.integration.test.ts:75 | missing organisation is 404 | 1 | SVC | DUP | http/admin/diagnostics.integration.test.ts:57 |
| diagnostics.integration.test.ts:80 | provider precedes disabled org and routing | 1 | SVC | CON | Verdict order "first applicable" (apps/web/content/docs/id/onboard.mdx:180); only here |
| diagnostics.integration.test.ts:94 | disabled org precedes domain rejection | 1 | SVC | CON | Same; only here |
| diagnostics.integration.test.ts:102 | unrouted domains and domains routed elsewhere | 1 | SVC | CON | domain_not_allowed + routing names only this org (onboard.mdx:191); admin :68 holds only routesTo null |
| diagnostics.integration.test.ts:123 | unlinked email requires authentication | 1 | SVC | DUP | http/admin/diagnostics.integration.test.ts:29 (unknown@ → authentication_required, membership null) |
| diagnostics.integration.test.ts:130 | disabled user reported without retirement | 1 | SVC | DUP | http/admin/diagnostics.integration.test.ts:29 (disableduser → user_disabled) |
| diagnostics.integration.test.ts:144 | retirement details omitted; exact local email only | 1 | SVC | CON | Retired email no longer matches (onboard.mdx:191); admin :86 holds only "no retiredEmail field" |
| diagnostics.integration.test.ts:159 | global account changes do not affect diagnosis | 1 | SVC | DUP | http/admin/diagnostics.integration.test.ts:68/:86 (no accounts field, foreign = unknown) |
| diagnostics.integration.test.ts:177 | membership windows do not gate sign-in | 1 | SVC | DUP | http/admin/diagnostics.integration.test.ts:29 (expired member effective:false, upper-case email) |
| diagnostics.integration.test.ts:215 | revoked admission → membership_revoked | 1 | SVC | CON | Only test of membership_revoked verdict |
| diagnostics.integration.test.ts:231 | unlinked global identity / other tenant cannot change diagnosis | 1 | SVC | DUP | http/admin/diagnostics.integration.test.ts:68 (foreign result equals unknown) |

#### src/services/sso-test.test.ts (19, UNIT with injected fetch + spied dns.lookup, PG no)

| file:line | test title | n | layer | class | reason |
|---|---|---|---|---|---|
| sso-test.test.ts:57 | passing discovery, exact issuer and JWKS | 1 | UNIT | DUP | http/admin/sso-providers.integration.test.ts:225 (in-process issuer: reachable, issuerMatches, keys≥1, no problems) |
| sso-test.test.ts:76 | uses configured discovery URL | 1 | UNIT | BEH | discoveryEndpoint override |
| sso-test.test.ts:85 | rejects malformed and insecure issuer/discovery URLs | 1 | UNIT | CON | insecure_issuer (onboard.mdx:205) |
| sso-test.test.ts:99 | refuses private addresses and hostnames by default | 1 | UNIT | INV | SSRF guard, 20 hosts + private discovery URL (onboard.mdx:206 private_host) |
| sso-test.test.ts:133 | private test issuers can use HTTP with explicit option | 1 | UNIT | FILL | `allowPrivateHosts` only set by __tests__/admin.ts:90 |
| sso-test.test.ts:142 | allows public IP literals | 1 | UNIT | BEH | No false positive; IP literal skips DNS (sso-test.ts:156) |
| sso-test.test.ts:156 | discovery network/HTTP errors and redirects unreachable | 1 | UNIT | INV | Redirects refused (redirect:"manual") so a 302 to 127.0.0.1 cannot bypass SSRF |
| sso-test.test.ts:173 | timeout aborts the request | 1 | UNIT | BEH | Uses test-only `timeoutMs: 1`; production default 5000 |
| sso-test.test.ts:191 | discovery requires all fields and bounded JSON | 1 | UNIT | CON | discovery_invalid (onboard.mdx:208) |
| sso-test.test.ts:206 | accepts exactly 256 KiB, multiple chunks | 1 | UNIT | FILL | Boundary/chunk loop of readJson |
| sso-test.test.ts:217 | issuer mismatch still inspects JWKS | 1 | UNIT | CON | issuer_mismatch |
| sso-test.test.ts:226 | JWKS URL cannot bypass endpoint safety | 1 | UNIT | INV | SSRF via discovered jwks_uri |
| sso-test.test.ts:236 | JWKS errors and redirects unreachable | 1 | UNIT | CON | jwks_unreachable; mirror of :156 |
| sso-test.test.ts:247 | JWKS must be a bounded key array | 1 | UNIT | CON | jwks_invalid; mirror of :191 |
| sso-test.test.ts:261 | uses default fetch when none injected | 1 | UNIT | FILL | `options.fetch ?? fetch` branch; production never injects |
| sso-test.test.ts:272 | refuses DNS names resolving to private addresses | 1 | UNIT | INV | SSRF via DNS (discovery and JWKS) |
| sso-test.test.ts:279 | DNS failures are unreachable | 1 | UNIT | CON | NXDOMAIN → discovery_unreachable |
| sso-test.test.ts:284 | trusted origins match exactly incl. userinfo | 1 | UNIT | CON | untrusted_origin (onboard.mdx:209); admin :722 holds 4 endpoints; userinfo and trailing slash only here; asserts detail wording once |
| sso-test.test.ts:322 | untrusted origin reported even when transport refuses | 1 | UNIT | BEH | Problem accumulation order; admin :249 holds one case |

#### Class counts

| file | INV | CON | BEH | DUP | FILL | IMPL | sites | cases |
|---|---|---|---|---|---|---|---|---|
| env.test.ts | 6 | 1 | 17 | 0 | 1 | 0 | 25 | 35 |
| runtime.test.ts | 2 | 1 | 1 | 3 | 0 | 2 | 9 | 11 |
| bootstrap.integration.test.ts | 7 | 0 | 0 | 1 | 0 | 0 | 8 | 8 |
| lib/*.test.ts | 1 | 1 | 0 | 1 | 0 | 0 | 3 | 3 |
| services/actor.test.ts | 0 | 0 | 0 | 1 | 0 | 0 | 1 | 3 |
| services/client-secrets.test.ts | 1 | 0 | 0 | 1 | 0 | 0 | 2 | 2 |
| services/root-secret.test.ts | 0 | 0 | 0 | 1 | 0 | 0 | 1 | 4 |
| services/sso-providers.integration.test.ts | 4 | 0 | 0 | 5 | 0 | 0 | 9 | 17 |
| services/users.integration.test.ts | 1 | 0 | 0 | 6 | 0 | 0 | 7 | 9 |
| services/sessions.integration.test.ts | 1 | 0 | 0 | 6 | 0 | 0 | 7 | 7 |
| services/platform-users-context.integration.test.ts | 0 | 0 | 0 | 0 | 3 | 3 | 6 | 7 |
| services/diagnostics.integration.test.ts | 0 | 5 | 0 | 6 | 0 | 0 | 11 | 11 |
| services/sso-test.test.ts | 4 | 7 | 4 | 1 | 3 | 0 | 19 | 19 |
| **total** | **27** | **15** | **22** | **32** | **7** | **5** | **108** | **136** |


## Mutation probes

**Method.**
- Each probe broke one check with the simplest realistic edit, ran a group of files with `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`, and was restored with `git checkout -- <file>`.
- File groups:
  - **oauth** (303 tests): UO, UGB, token, token-identity, grant-locks, machine-audit, machine-provider, tenant-authentication, member-permission, grant-scopes, narrow-authorization-code, pages.integration, auth.integration.
  - **prod** (171): the oauth group without UGB and the machine files, plus verified-sso.
  - **sso** (186): federation unit and integration, verified-sso, tenant-authentication, account-storage, pages.integration, sso-providers, sso-test, sso-origin.
  - **http** (175): app, principal, root, token, token-identity, pages, gateway, allowlist, openapi, runtime, signin-audit, diagnostics, ip-metadata.
- The five probes nothing caught were then applied together in one full-suite run: 2,040 pass, 0 fail.
- Raw JUnit and logs: `audit-a/probes/`.

| # | what was broken | where | failed tests | verdict |
|---|---|---|---|---|
| P1 | exact-pair entitlement no longer caps resource scopes (`pairAssignments` dropped from the ceilings) | `auth/member-permission.ts:385` | 11 of 303 (oauth). UO:1477 cached refresh; UO:1977 ×2 partial entitlement; UO:2086 empty approval; UO:2120 partial deny. UGB:2233, :2294 ×3, :2611; `member-permission.test.ts:75` | held on the production path |
| P2 | resource refresh no longer needs a `refresh_token` capability | `auth/member-permission.ts:378`, `:392` | 2 of 303: `member-permission.test.ts:165` (unit), UGB:2257 (test-built endpoint) | held only off the production path. UO:1129 covers the login-only twin, not resource refresh |
| P3 | another tenant's private resource counts as eligible | `auth/member-permission.ts:63` | none of 303 (oauth), none of 267 (access, capability and resource suites in `db/` and `http/admin/`), none in the full suite | redundant guard. Triggers `protect_private_resource_assignment` and the grant-context resource check (`drizzle/0000_initial.sql:1013`, `:1071`) refuse the rows that would reach it |
| P4 | grant authentication ignores the SSO provider revision | `auth/grant-authentication.ts:81` | UO:1593 "code exchange refuses changed provider" | held on the production path |
| P5 | token exchange ignores a changed `resource` | `auth/user-token-boundary.ts:282` | none (prod); none in the full suite | **gap.** UO:1593 [target] sends an unknown resource, which Better Auth refuses anyway, and asserts only a 4xx band |
| P6 | refresh may request scopes beyond the grant | `auth/user-token-boundary.ts:291` | UO:1977 ×2 | held on the production path |
| P7 | the stored flow is no longer bound to its signed query | `auth/user-oauth-flow.ts:174` | none (prod); none in the full suite | **gap.** UO:1264's forgery changes `client_id` without re-signing, so Better Auth's signature check refuses it before this line runs |
| P8 | completed or denied flows can be resumed | `auth/user-oauth-flow.ts:176` | UO:1264, :1312, :1518 | held on the production path |
| P9 | consent may add scopes beyond the request | `auth/user-oauth-flow.ts:198` | UO:724 | held on the production path |
| P10 | refresh reuse no longer revokes the grant family (family lookup never matches) | `auth/native-refresh-family.ts:25` | UO:1202, :1238; UGB:1299, :1377, :1449 | held on the production path |
| P11 | code replay no longer revokes the grant | `auth/native-code-replay.ts:47` | UO:1168, :1518; UGB:965, :1065, :2003, :2146, :2206 | held on the production path |
| P12 | Entra `tid` no longer compared with the pinned tenant | `services/federation.ts:153` | `federation.integration.test.ts:866` (end to end), `federation.test.ts:132` | held end to end |
| P13 | an ID token **without** `email_verified` is accepted | `services/federation.ts:169` | none (sso); none in the full suite | **gap.** Every test sends `email_verified: true` or `false`, never omits it |
| P14 | Google `hd` no longer matched to the email domain | `services/federation.ts:191` | `federation.integration.test.ts:890`, `federation.test.ts:151` | held end to end |
| P15 | tenant authentication accepts any session of the user, whatever its organisation | `auth/tenant-authentication.ts:47` | none (sso); none in the full suite | redundant guard. Callers already pin the organisation (`db/queries/grants.ts:83` passes the session's own organisation; `create-resource-grant.ts:80` compares `memberId`), and the grant provenance trigger repeats the check |
| P16 | a link or reauthentication proof may predate the flow | `auth/verified-sso.ts:207` | `verified-sso.integration.test.ts:367` | held end to end |
| P17 | freshness window widened from 300 s to 3,600 s | `auth/fresh-authentication.ts:6` | `verified-sso.integration.test.ts:100`, `:713`, `:903`, `:999` | held; the tests sit at 301 s |
| P18 | production ingress admits unresolved client addresses | `app.ts:61` | `ip-metadata.test.ts:58` ×4 (production subprocess), `:96` | held |
| P19 | admin bearer audience not checked | `http/principal.ts:90` | `principal.test.ts:298` only (unit, real jose) | held at the unit layer only; no HTTP test in the area sends a token for another audience |
| P20 | pages forward the service origin instead of the browser's | `http/pages/gateway.ts:28` | `gateway.test.ts:7`, `pages.integration.test.ts:320`, both asserting the forwarded header | caught only by IMPL-style header assertions. The security outcome (a cross-site POST refused) is untested |
| P21 | every Better Auth route allowlisted | `http/auth-allowlist.ts:189` | `app.test.ts:356`, `:405`, `:513`, `:759` ×4; `auth-allowlist.test.ts:4`; `gateway.test.ts:73` | held (stub auth, which is enough because the gate runs first) |
| P22 | root stays usable after a human platform writer exists | `http/principal.ts:221` | `root.integration.test.ts:36`; `principal.test.ts:529` ×2, `:566` | held on the real stack |
| P23 | sign-in merges a new upstream identity into the user with the same email | `services/federation.ts:302` | `federation.integration.test.ts:977` ×2, `:1004`; `federation.test.ts:256` | held end to end |
| P24 | sign-in into a disabled organisation allowed | `services/federation.ts:139` | `federation.test.ts:120` only, whose fake adapter answers by call order | held only by an implementation-coupled unit test; no end-to-end test |

**Totals.**
- 24 probes: 19 caught and 5 not.
- 15 were caught by a production-path test: P1, P4, P6, P8–P12, P14, P16–P18 and P21–P23.
- 4 were caught only by a unit, test-built or header-forwarding test: P2, P19, P20, P24.
- Of the 5 uncaught, 3 are real gaps (P5, P7, P13) and 2 are guards made redundant by other layers (P3, P15).
- 100% line coverage did not reveal any of them, because each broken check is one operand of a condition on a line another test executes.

**Copy probes**, measuring copy coupling rather than security:
- P25 changed three strings (the `Sign in` title, the consent heading and the fallback error title): 2 failures.
- P26 changed the four most-asserted strings: 12 failures (6 of 14 in `pages.test.ts`, 6 of 11 in `pages.integration.test.ts`).

**Experiment E1: Better Auth's own protections, with the suite's configuration and with the checks on.** This was a temporary probe test against the real `createAuth` and `createApp`, then deleted.

| request | checks off (suite default under `NODE_ENV=test`) | checks on (`skipOriginCheck = skipCSRFCheck = false`) |
|---|---|---|
| `POST /auth/sign-out`, session cookie, `Origin: https://evil.example` | 200 | 403 |
| `POST /auth/sign-in/sso`, `callbackURL: https://evil.example/landing` | 200 | 403 |
| `GET /auth/oauth2/authorize` with an unregistered `redirect_uri` | 302 to `/error?error=invalid_redirect` | not run |

## Gaps

### Documented invariants and what holds them

| invariant (doc) | production-path holder | probe |
|---|---|---|
| No user token without that user's own current authentication (`docs/00` golden rule; `docs/03:89`) | UO:1593 (membership, account, provider, session changes) | P4 held |
| Email is never a join key; no merge by email (`docs/03:33`, `docs/04:32`) | `federation.integration:977`, `:1004` | P23 held |
| Entitlements re-checked at every grant (`docs/00` glossary; `docs/03:60`) | UO:1477, UO:1593 [scope], UO:1977, UO:2086 | P1 held |
| Refresh needs its own matching ceiling (`docs/03:60`; release plan:29) | UO:1129, login-only only | P2: resource refresh held off the production path only |
| Own-tenant SSO for tenant authority (`docs/03:31`; `docs/05:19`) | `tenant-authentication:207` (admin HTTP); UO:1721 (OAuth HTTP) | P15: redundant guard |
| Entra tenant pin, guest refusal (`docs/03:25`) | `federation.integration:862`, `:866` | P12 held |
| Verified email for Google and generic OIDC (`docs/03:25`) | `federation.integration:886` (`false` only) | **P13: a missing claim is not held** |
| Google hosted domain (`docs/03:25`, `docs/06` Google step 5) | `federation.integration:890` | P14 held |
| Five-minute verified freshness, also on replay and after waits (`docs/03:123`; `docs/05:86`) | `verified-sso:100`, `:713`, `:903`, `:999` | P17 held |
| Linking needs two independent proofs and never transfers (`docs/03:33`) | `verified-sso:247`, `:367`, `:404`, `:470` | P16 held |
| Consent on each new flow; terminal state; tabs cannot cross (`docs/03:39`; release plan:25) | UO:412, :1264, :1312, :1518 | P8, P9 held; **P7 (flow-to-query binding) not held** |
| Scope narrowing never grows (`docs/05:43`; release plan:29) | UO:344, :724, :1977 | P6, P9 held |
| Exact client/resource pair (`docs/03:43`, `:60`) | UO:1977, :2086 | P1 held; **P5 (resource at token exchange) not held** |
| Code single use; refresh rotation and reuse revocation | UO:1168, :1238, :1518 | P10, P11 held |
| Resource JWT `typ: at+jwt`, `aud` contains the resource; ID token not a bearer (`docs/03:58`) | UO:1395 (checked with local jose; `aud` as an array never asserted) | not probed |
| Code-flow ID token carries the nonce; refresh does not repeat it (`docs/03:58`) | UO:983 carries it; nothing checks refresh | not probed |
| Unknown upstream `auth_time` stays unknown (`docs/03:29`) | UO:962; `tenant-authentication:153` | not probed |
| Ingress admission in production (`docs/03:117`) | `ip-metadata:58` | P18 held |
| Only allowlisted `/auth/*` routes (`docs/03:21`) | `app.test.ts:356`, `:405`, `:759` (stub auth) | P21 held |
| Root locks after a human writer; break-glass (`docs/05:29`) | `root.integration:36` | P22 held |
| Failed audit rolls back success (`docs/05:66`) | UO:521, :1332, :1560 | not probed |
| Client assertion stays consumed when issuance rolls back (`docs/04:110`) | UO:286 | not probed |

### Question 2: the OAuth 2.1 and OIDC surface

"HTTP" below means production `createAuth` through `createApp`; UO rebinds `auth` to `app.fetch` at :147.

| property | HTTP test | only through internals or a test-built provider | status |
|---|---|---|---|
| PKCE: S256 required, plain refused | UO:1901 (loose: error redirect or 4xx) | — | held |
| PKCE: missing verifier | — | UGB:919 | production path untested |
| PKCE: wrong verifier | UO:261, UO:1593 [pkce], UO:286 | — | held |
| PKCE: confidential client with no challenge | — | — | untested |
| Exact `redirect_uri` at authorize | — | — | untested; E1 shows Better Auth refuses (302 `/error?error=invalid_redirect`). All 40 `redirect_uri` values in tests are the registered one |
| `redirect_uri` mismatch at token exchange | — | — | untested |
| `resource`: unknown at authorize | — | — | untested |
| `resource`: changed at token exchange | UO:1593 [target], not discriminating | — | **P5 uncaught** |
| `resource`: wrong at refresh | UO:344 | — | held |
| `state` echoed | UO:983 (success only) | — | held |
| `nonce` in the ID token | UO:983, UO:1395 | — | held; absent on refresh untested |
| Consent per flow, deny terminal, `skipConsent` | UO:412, :1312, :1977 | — | held (P8, P9) |
| Refresh rotation; reuse detection revokes the family | UO:983, :1238 | UGB:1299 | held (P10) |
| Code single use | UO:1168, :1518 | UGB:965 | held (P11) |
| Expired authorisation code | — | — | untested (UO:435 expires the flow row, not the code) |
| Scope narrowing never grows | UO:344, :724, :1977 | UGB:2437 | held (P6, P9) |
| Audience; `aud` as an array | UO:1395 | — | audience held; array shape untested |
| Token type `at+jwt` | UO:1395; `token.integration:134` | — | held |
| JWKS and discovery | UO:1356, :1395 | — | held; `token_endpoint_auth_methods_supported` and `prompt_values_supported` unasserted |
| Key rotation | — | `application-secrets:10` through `api.signJWT` | the signing-key rotation seen at `/auth/jwks` is untested |
| Revocation endpoint | UO:390, :1202, :1849 | UGB:2089 (code) | held |
| Session and `sid` in user tokens | — | — | untested |
| `upstream_auth_time` and `auth_time` | UO:962, :983 | — | held |
| Client authentication: none, basic, `private_key_jwt` | UO:261, every exchange, UO:286 | — | held |
| Client authentication: `client_secret_post`; a wrong secret on the user flow | — | `machine-provider:254` (test-built, machine) | untested on the user flow |
| Cross-site POST to `/auth/oauth2/consent`, `/continue`, `/auth/sign-out` | — | — | untested; E1 shows the suite runs with the checks off |

The user-flow properties proved **only** by mocking Better Auth internals: missing PKCE verifier (UGB:919), refresh denial after each authority change (the UGB matrix: membership, organisation, user, session, resource, client, secret rotation, SSO, capability, group), and the lock ordering between user issuance and admin writers (UGB:3132, :3341, :3452, :3628). For lock ordering, the test-built endpoint takes its locks inside the claims hook, while production takes them in the pre-flight in `user-token-boundary.ts:293`, so production's lock window is untested.

### Question 3: federation reject codes

The source has 12 codes, `federation.ts:48-61`; `membership_revoked` is the one not in the brief's list. "End to end" means `POST /auth/sign-in/sso`, then `startOidcIssuer`, then `/auth/sso/callback`.

| code | end-to-end test | unit only | notes |
|---|---|---|---|
| `provider_not_found` | none | `federation.test.ts:82`, `:120` | unreachable in production: `sso-origin.ts:61-75` throws first and SAML callbacks are not allowlisted |
| `organization_disabled` | none | `federation.test.ts:120` | **P24: only this order-coupled unit test catches its removal** |
| `directory_mismatch` | `federation.integration:862`, `:866` | `:132` | P12 held |
| `guest_account` | `federation.integration:862`, `:326` | `:132` | |
| `personal_account` | `federation.integration:886` | `:151` | |
| `email_unverified` | `federation.integration:886` (Google, `false`) | `:151`, `:196` (generic) | **P13: an absent claim is not held anywhere** |
| `domain_not_allowed` | `federation.integration:905`, `:913`; `http/admin/domains.integration:304` | `:196` | |
| `hosted_domain_mismatch` | `federation.integration:886`, `:890` | `:151` | P14 held |
| `user_disabled` | `federation.integration:989`; `http/admin/users.integration:144` (exact account) | `:234` (placeholder) | placeholder branch unreachable until import tooling exists |
| `membership_revoked` | `federation.integration:725` (exact account) | `:337` (placeholder) | `:725` checks members, not sessions |
| `identity_conflict` | `verified-sso:470` (link only) | `:218` (plain sign-in) | |
| `email_conflict` | `federation.integration:976`, `:1004` | `:256` | P23 held |

Rollback: most end-to-end rejections assert that no user row was written. Accounts, members and sessions all reference the user, so that is enough. `:913`, `:989` and `domains:304` assert no rows at all.

The fake issuer (`src/__tests__/oidc-issuer.ts`) checks nothing:
- it redirects to any `redirect_uri` (:62-73);
- it never compares the client secret (:85-91);
- it forces `aud`, `exp` and the signing key (:98-104);
- Better Auth SSO 1.7.2 sends no `nonce` (`grep -c nonce node_modules/@better-auth/sso/dist/index.mjs` finds none).

So no test can send an upstream token with a wrong `aud`, an expired `exp` or an unknown `kid`. No test drops or swaps the signed `state` cookie on a plain sign-in either.

### What an operator would need and nothing proves

Each item says whether a test is worth adding and what it would assert.

1. **Origin and CSRF protection as deployed.** Worth it; it is the largest gap. Run the integration fixture with Better Auth's checks on and assert 403 for:
   - a cross-site POST to `/auth/sign-out`, `/auth/oauth2/consent` and `/auth/oauth2/continue`, and to the page forms;
   - an off-origin `callbackURL` or `errorCallbackURL` on `/auth/sign-in/sso`.

   E1 measured 200 against 403.
2. **`NODE_ENV=test` in a deployment.** Better Auth then skips origin checks and `runtime.ts:32` skips the runtime-role check; nothing refuses this. This needs a guard, not a test: one line in `env.ts` or `runtime.ts` (product decision).
3. **Unregistered `redirect_uri` at authorize, and a mismatched `redirect_uri` at token exchange.** Worth it: one table. Expect a redirect to `/error?error=invalid_redirect` (E1) and `invalid_grant`, with no rows written.
4. **Expired authorisation code.** Worth it. Age the code's verification row and expect `invalid_grant` with no token rows.
5. **Upstream ID token without `email_verified`** (P13). Worth it: one row in `federation.integration`'s claim table, for Google and generic OIDC. Expect `email_unverified` and no user row.
6. **Token exchange with a second, valid, linked resource** (P5). Worth it. Expect `invalid_target` and no token rows.
7. **A correctly signed forged flow query** (P7). Worth either a test or deleting the check. Re-sign a query that changes `scope` but keeps the same `answerable_flow`, using the test secret, and expect 400. If Better Auth's signature makes this impossible in every path, delete the `binding()` comparison instead.
8. **Upstream token defects.** Worth it. Give the fake issuer three options (`aud`, `exp`, `kid`) and add a state-cookie swap. Expect each to redirect to the error page with no rows written. This pins Better Auth's behaviour at the version pin.
9. **`organization_disabled` end to end** (P24). Worth it. Disable an organisation through the admin API, sign in, expect refusal with no session; then delete `federation.test.ts:120`.
10. **Refresh denial after each authority change, on production `createAuth`.** Worth it: port UGB's 13-cell matrix onto UO's fixture (about 100 lines, see Simplifications).
11. **Signing-key rotation seen through `/auth/jwks`.** Worth it (release checklist E5). After promotion, the old `kid` must still be published and new tokens must verify through the published set.
12. **Small OAuth contract rows.** Worth one table:
    - `client_secret_post` and a wrong secret on the user flow;
    - a confidential client without a PKCE challenge;
    - the `aud` array shape;
    - `sid` in user tokens;
    - an ID token from refresh with no `nonce`.
13. **Rate limiting with the production configuration** on `/auth/oauth2/token` and `/auth/sign-in/sso`. Untested and not measured here. Worth one production-mode test that expects 429 after the configured burst from one client address.
14. **`private_key_jwt` client_credentials through the real app** (jti replay, wrong `aud`, expired assertion). Today only the test-built `machine-provider.integration` covers it. Worth porting one test.
15. **Not worth adding here:**
    - pool exhaustion and statement timeouts (held in `db/statement-timeout`, another area);
    - lock ordering for machine grants (held by `grant-locks`);
    - oversized bodies (held twice: `runtime:186`, `app.test:650`);
    - clock skew (freshness uses database `statement_timestamp()`, and the tests move the clock).

### The suite is not hermetic

**1. `BETTER_AUTH_SECRETS` leaks from the process into every `createAuth`.**

Mechanism:
- `testEnvironment()` sets `betterAuthSecrets: undefined` (`src/__tests__/support.ts:24`).
- `createAuth` passes it straight through as `secrets` (`src/auth.ts:77`).
- Better Auth 1.7.2 then falls back to the process: `options.secrets ?? parseSecretsEnv(env.BETTER_AUTH_SECRETS)` (`node_modules/better-auth/dist/context/create-context.mjs:69`). Line 70 does the same for `BETTER_AUTH_SECRET` and `AUTH_SECRET`, but `createAuth` always passes `secret`, so that one never leaks.
- `grep process.env` finds nothing because the read happens inside Better Auth.

Reproduced with `BETTER_AUTH_SECRETS="1:leaked-process-secret-that-is-at-least-32-characters"` exported:
- `application-secrets.integration.test.ts:10` fails, 0/1;
- `operations/preflight.integration.test.ts` fails, 0/1;
- UO:796 fails with `RangeError: Uint8Array.prototype.fromHex …`, 58/59.

Without the variable all three pass. The failing tests assume the singular secret is active. UO:796 decrypts the cached replay with `fixture.environment.betterAuthSecret` (:825); `application-secrets` builds its ring from it (:28).

`UPSTREAM_TOKEN_SECRETS` does not leak, because `testEnvironment` passes an explicit ring.

**Fix:** a `[test] preload` that deletes Better Auth's environment fallbacks (`BETTER_AUTH_SECRETS`, `BETTER_AUTH_SECRET`, `AUTH_SECRET`, `BETTER_AUTH_URL`) from `process.env` before any test loads. This is not measured. A code-level fix would mean always passing a non-empty ring, which changes the cipher format for existing installations; not recommended.

**2. Running the two biggest files alone fails: Bun's runtime transpiler cache.**

Mechanism:
- Bun 1.3.1 caches the transpiled output of source files of 50 KB and over. Only three test files reach that size: `user-grant-boundary` (129,841 bytes), `user-oauth` (69,058) and `db/runtime-role.integration` (80,661, another area).
- On a cache hit, the font import in `http/pages/index.ts:9` (`import fontPath from "./fonts/PublicSans-Variable.woff2"`, no loader attribute) is parsed as JavaScript: "Expected ";" but found " "".

Measured:
- A fresh copy of `user-oauth` with a unique first line passed on its first run (59 pass) and failed on the second (0 pass, 1 error).
- The original passes alone with `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` (59 pass, 51.2 s).
- In the full suite it passes because `app.test.ts` loads the font module first.
- The other 52 area files pass alone.

There is no `mock.module`, worker or spawn involved: `grep -rln "mock.module\|Bun.plugin" src` finds nothing, and importing `app.ts` or `__tests__/admin.ts` first in small probe files never failed.

**Fix options:**
- set `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` for `bun test` in the `test` and `test:coverage` scripts (measured to fix it);
- or give the font import an explicit `with { type: "file" }`. Not measured: the probe edit to `pages/index.ts` was refused by this session's permission classifier, so it remains a candidate.

**3. One intermittent failure.** `user-grant-boundary` alone with the cache off ran 121 pass and 1 fail once, then 122 pass twice. The failing test was not captured. Its 4 lock-contention cases wait about 2.9 s each on `lock_timeout` and are the likeliest to be load-sensitive; this is unproven.

## Dead and test-only code

Each finding below was confirmed with `grep` over `apps/id/src`, `apps/id/scripts`, `scripts`, `packages` and `mcps`.

| code | evidence | what it costs |
|---|---|---|
| `startRuntime` options `seed`, `databaseFactory`, `authFactory`, `appFactory`, `serve`, `verifyDatabaseRole` (`runtime.ts`) | callers of `startRuntime(` are `runtime.ts`, `server.ts` (environment only) and `runtime.test.ts` | six injection points kept for tests |
| `AppServices.readinessCheck`, `AppServices.ssoTest` (`app.ts:34-35`) | only `src/__tests__/admin.ts:90` sets `ssoTest`; `runtime.ts` sets neither | `ssoTest.allowPrivateHosts` is spread into the SSO probe (`http/admin/sso-providers.ts:255`) and disables its SSRF and HTTPS rules: a test bypass on a production path |
| `ipAddress.disableIpTracking` route into `app.ts:59-67` in-process | only `ip-metadata.test.ts:103` | FILL test `ip-metadata:96` exists for coverage (its own comment says so) |
| `"sso_provider_changed"` in `http/signin-audit.ts:9` | Better Auth SSO emits `error=invalid_state` with `error_description=sso_provider_changed_during_authentication` (`@better-auth/sso/dist/index.mjs:2934`) | dead list entry |
| defensive throws "unexpectedly returned tokens" (`native-refresh-family.ts:74-77`, `native-code-replay.ts:82-83`) | reached only by a hand-written `run` in UGB:1449, :2146 | 2 FILL tests |
| "An active authentication transaction is required" (`database-adapter.ts:134`) | reached only by UGB:3447 (asserted 9 times inside :3341) | FILL tail |
| lifetime `TypeError` in `create-resource-grant.ts:39` | the production caller passes `refreshTokenExpiresIn ?? 2_592_000` (`user-oauth-flow.ts:218`) | FILL part of UGB:2986 |
| `federation.ts:124` (non-OIDC), `:131` (`provider_not_found`), `:79` (account without owner), `:83-99` and `:216-270` (placeholder and inert users) | SAML callback not allowlisted; `sso-origin.ts:61-75` throws first; `accounts.user_id` is NOT NULL; no non-test code writes inert or placeholder users (import tooling is "Not yet", `docs/02-plan`) | about 80 source lines and 5 unit tests for branches production cannot reach today |
| `machineOAuthProvider`'s default `provider = oauthProvider(options)` (`machine-provider.ts:26`) | the production caller passes `native` (`user-provider.ts:84`); only `machine-provider.integration.test.ts:96` uses the default | test-only default |
| `tier` context variable (`http/authorize.ts:62-91`) | set in source, read only by `authorize.test.ts` and `route-table.test.ts` | unused in production |
| `user-token-assertions.ts:80-183` throw branches | fire only when Better Auth's output is faulted on purpose (UO:494, :546, :581, :616, :670, :765, :796, :892, :908, :926; 13 cases, 13.5 s and 11.7 s) | `docs/05:49` requires this cross-check, so the code stays; the 10 tests can shrink to one per branch family |
| UGB harness (lines 122-530, 409 lines of `beforeEach`) | test support larger than the code it stands in for (`user-token-boundary.ts`, 427 lines) | 105.6–118.4 s per run |

## Simplifications

### Question 1: matrices or distinct facts?

- **`user-grant-boundary`** (4,007 lines) holds **20 distinct facts**, listed in its table above.
  - Two matrices make up about 1,500 lines:
    - the refresh-denial-after-authority-change matrix, about 600 lines and 13 cases; the same "issue A, rotate, find the other member, issue B" block appears 12 times;
    - the lock races, about 920 lines and 66 cases; a 12-line `pg_blocking_pids` poll appears 7 times and the change dispatch 3 times.
  - Rewritten as tables: about 1,850 lines with the harness kept, or about 1,550 if its token tests move onto UO's production fixture.
- **`user-oauth`** (2,149 lines) holds **32 distinct facts**.
  - One matrix: 11 fault-injection tests (about 450 lines) shaped "fault, then 4xx or 503, nothing persisted, no audit, retry succeeds".
  - `refresh()` and `redeem()` helpers would replace 24 inline refresh exchanges and 16 code exchanges (about 200 lines).
  - Estimate: about 1,600 lines, or about 1,450 after dropping the 10 FILL and IMPL fault tests.
- **`verified-sso`** (1,326 lines) holds **about 25 facts**. A refusal table covering :367, :470, :573, :656, :680 and :713 shrinks 311 lines to about 165. Estimate: about 1,050 lines.
- **`federation.integration`** (1,304 lines) holds **about 30 facts**. Its claim-policy family (:850-:1018, :1033) is one matrix of about 12 rows: 192 lines become about 80. Estimate: about 1,020 lines.

### Question 5: how much of `env.test.ts` and `runtime.test.ts` proves zod?

- **`env.test.ts`** (492 lines, 35 cases, 0.02 s): 8 call sites (13 cases, about 38 assertions) test zod or Better Auth's `findInvalidTrustedProxies`: defaults, coercion, wrong types.
  - 14 call sites (about 160 assertions) test our rules: production `BETTER_AUTH_URL` default, trusted origins origin-only and required, `TRUSTED_PROXY_CIDRS` required, secret rings with values never echoed, break-glass requiring the root secret, platform credential pairs, the `default.env` inventory.
  - About 89 lines can be deleted (`:108-125` except the 999/0 refine case, `:127-162`, `:187-202`, `:281-289`, `:369-379`, `:357` cut to one case).
  - `:381` loops over three environments for a check that runs before the `NODE_ENV` branch (62 lines down to about 30).
  - The inventory test `:444` checks only names. It does not cover the Toolbox, admin MCP or web variables, and does not catch stale entries, whereas `README.md:51` claims "every variable the monorepo reads".
- **`runtime.test.ts`** (374 lines, 11 cases, 5.05–5.06 s) tests no zod.
  - About 95 lines repeat each other: `:279` and `:308` hit the same `catch` as `:122`, and `:144` repeats `:186` and `:26`.
  - `:186` and `app.test.ts:650` each spend 5.0 s waiting out the same 5 s body deadline.

### Other duplication

**Service tests** that repeat admin route tests, each named in the classification table:
- `users.integration` 6 of 7 call sites;
- `sessions.integration` 6 of 7;
- `diagnostics.integration` 6 of 11;
- `sso-providers.integration` 5 of 9.

Together that is about 780 lines, and 3.1 s and 2.7 s of measured time for the `users` and `sessions` duplicates. The facts held only at the service layer are listed in the env/runtime/services table: SSO credential-mode switches, audit-failure rollbacks, and the order of the diagnostics verdicts.

**`principal.test.ts`**: 10 of 29 call sites repeat `admin-routes.ts` generated tests or `root.integration` (about 140 lines). Its JWKS and verifier tests mirror `packages/auth/src/index.test.ts`, which is different code, so they stay.

**`app.test.ts`**:
- `:105` and `:211` (197 lines) repeat the OpenAPI snapshot tests in `openapi.integration`;
- `:650` repeats `runtime:186` (5.0 s);
- `:513` repeats `token.integration:134`.

**Helpers that would halve copies:**
- the `pg_blocking_pids` lock-wait poll (about 30 copies in 20 files, about 250 lines);
- the client_credentials request builder (about 100 lines);
- `createApp({ auth: stubAuth(), … })` in `app.test.ts` (27 copies, about 120 lines);
- the page fixture copied in `pages.integration.test.ts:261-317`.

**Fixture cost.** `createAdminFixture()` takes a median 619 ms and runs before each of 265 cases: about 164 s of the area's 260–292 s. UGB uses 3 of the 9 principals it signs in. A file-scoped fixture with a per-test reset of only the rows each file writes, or a fixture variant that signs in only the principals needed, is where the time is. The saving is estimated, not measured.

## Recommendations

### Delete

These lose no fact, by the classification evidence.

1. **UGB's 13 DUP and 2 FILL call sites**: :658, :760, :799 (move its concurrent-jti and key-change lines to UO:286 first), :919, :965, :1028, :1299, :2233, :2257, :2437, :2474, :3695, :3819, :1449, :2146. Measured 14.2 s and 11.8 s; about 600 lines.
2. **`app.test.ts:650`**, which repeats the 5 s body-deadline wait in `runtime.test.ts:186`: 5.0 s measured.
3. **Service-layer DUP tests** in `users`, `sessions`, `diagnostics` and `sso-providers` (23 call sites): about 780 lines. The `users` and `sessions` duplicates together measured 3.1 s in run 1 and 2.7 s in run 2.
4. **The zod-only cases in `env.test.ts`** (about 89 lines) and the repeated pool-close cases in `runtime.test.ts` (about 95 lines).
5. **Smaller DUP and FILL tests:**
   - `http/authorize.test.ts` (209 lines: 2 IMPL, 3 DUP, 1 FILL, all held by `admin-routes.ts`);
   - `audit-hooks.test.ts` (58 lines, IMPL, held by `federation.integration:753`);
   - `logging.test.ts:11`;
   - `error-copy.test.ts`'s five literal-copy tests, replaced by one loop over every `ERRORS` key.
6. **Dead and test-only source:**
   - `"sso_provider_changed"`;
   - the `tier` context variable;
   - `ssoTest` and `readinessCheck` on `AppServices`, replaced by a test-only SSO probe injected another way so that no production path carries `allowPrivateHosts`;
   - the unreachable `federation.ts` branches (with their 5 unit tests) until import tooling exists.

   Each removal also removes the FILL test that covers it, so the 100% gate keeps passing.

### Simplify

7. **Retire the UGB harness.** Port its unique facts onto UO's production fixture:
   - the refresh-denial matrix (about 100 lines as a table);
   - lock races as one `race(first, second)` helper and a change table (about 300 lines), with the locks taken where production takes them;
   - the grant-context triggers and RLS (UGB:1227, :2033, :3836);
   - the cleanup-outage pair (:1065, :1377).

   Then delete the file. Measured effect of the deletion: 105.6–118.4 s and 122 cases per run, about 22% of the full suite's 477–527 s wall time, offset by the time of the ported cases.
8. **Table-drive the big four files** as in Question 1: 4,007 + 2,149 + 1,326 + 1,304 lines down to about 1,550 + 1,450 + 1,050 + 1,020 (estimates).
9. **Cheapen the per-case fixture** (median 619 ms × 265 cases ≈ 164 s): file-scoped role and auth instance, and sign in only the principals each file uses.
10. **Make the suite hermetic:**
    - a test preload that clears Better Auth's environment fallbacks;
    - `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` in the test scripts, or an explicit `with { type: "file" }` on the font import.

### Add

11. **Run the integration fixture with Better Auth's origin and CSRF checks on**, and add the cross-site and off-origin refusal table (E1 measured 200 against 403). Decide separately whether `NODE_ENV=test` may ever reach a deployment.
12. **Add rows for the three uncaught checks:**
    - missing `email_verified` (P13);
    - token exchange with another valid linked resource (P5);
    - a correctly signed forged flow query (P7), or delete that check.
13. **Add one OAuth contract table** on the production fixture:
    - an unregistered or mismatched `redirect_uri`;
    - an expired code;
    - an unknown resource at authorize;
    - a confidential client without PKCE;
    - `client_secret_post` and a wrong user-flow secret;
    - `aud` as an array;
    - `sid`;
    - no `nonce` on refresh.
14. **Extend the fake issuer** with `aud`, `exp` and `kid` options and a state-cookie swap. Add `organization_disabled` end to end, replacing `federation.test.ts:120`.
15. **Prove signing-key rotation through `/auth/jwks`.** Add one rate-limit test in production mode, and one `private_key_jwt` client_credentials test on the real app.
