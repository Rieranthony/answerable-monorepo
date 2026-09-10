# Production user OAuth

Implemented on `codex/id-production-oauth`, based on
`c2450604cc1ee523621514cf303078263c1f8c2c`. The integration checkout remained
read-only. Database work is complete and the disposable `answerable_id_test` slot is released.
No active test-database sessions or `id_test_*` roles remained at handoff.
No deployment, external consumer cutover, purge or migration consolidation is
included. T5 must consolidate the final schema after integration.

## Protocol and authority

The installed Better Auth OAuth provider (1.7.2) remains responsible for request
validation, signed browser continuation, PKCE, client authentication, code
consumption, token signing, refresh rotation, encrypted response reuse, UserInfo
and revocation. The production composition wraps its supported endpoint,
post-login, claims and database-adapter boundaries. There is no fork or second
OAuth protocol implementation.

A native-signed request carries a server-generated flow UUID. Its verification
record retains the canonical request, initiating global user (once known), grant
UUID, expiry and terminal state. The browser can select only its own effective
membership. Grant admission requires that tenant's current accepted SSO tuple;
another tenant's session or a shared email cannot supply it. Native SSO initiation
preserves the verified OAuth server context so the callback resumes the original
request. Selection, consent and code issuance recheck that binding under locks.

Each authorisation gets one immutable grant. Consent is required for each new
flow except a server-configured first-party bypass. Repeated selection, duplicate
consent, completed/denied flows, changed users and forged requests cannot create
another code. The browser renders registered application/resource details and
eligible memberships returned by the verified flow endpoint.

The retained authentication snapshot includes global user, membership, original
session, account, tenant, provider instance/revision, broker authentication time,
nullable verified upstream time and original session expiry. Database validation
rejects a snapshot that differs from the accepted tuple; the existing immutable
grant trigger prevents rewriting it. Legacy null snapshots remain readable as
history and are refused by production grant consumers.

Login-only grants require a client-only authorisation capability and assignment.
Service grants additionally require the exact client/resource capability and
assignment. Refresh requires a separate renewal capability for the same target;
login-only renewal therefore permits a null resource. Every code exchange and
refresh checks current authentication, effective membership, target eligibility,
original scope ceiling and current permissions before invoking native issuance,
including before a native cached response can be returned.

The lock order remains subject/owner users (sorted), tenant, client, resource and
grant; current provider/account evidence is also locked. Client assertion
consumption occurs in autocommit before the issuance transaction and survives a
rejected grant. Native replay cleanup is confined to the immutable grant family;
intentional revocation barriers survive cleanup failures while ordinary issuance
failures roll back code/token/consent effects.

## Tokens, lifetime and revocation

Native ID tokens and resource access JWTs carry the global user subject and
matching tenant, membership, grant, client-instance and resource-instance claims.
The broker `auth_time` and nullable `upstream_auth_time` have distinct meanings.
Client and organisation authorisation versions reflect issuance-time policy.
Returned native token material is checked against the decision before commit;
the follow-up correction below completes the original issuance assertions.
Resource custom claims cannot replace those identity fields. Login-only access
tokens remain native opaque tokens; UserInfo rechecks their retained grant.

Native resource TTLs remain bounded by the provider defaults. The retained grant
has an absolute 30-day default ceiling, so rotation cannot extend delegation
indefinitely. Five-minute upstream freshness remains confined to T1 sensitive
commands and linking. Normal browsing and ordinary sign-out retain their
separate session/delegation behaviour. Explicit administrative revocation and T3
terminal deletion invalidate the relevant grants. Reinstatement cannot revive
revoked contexts.

`OAUTH_REFRESH_REUSE_INTERVAL_SECONDS` defaults to zero. A configured interval
uses the native encrypted cached response and re-evaluates authority before
returning it; replay has a distinct audit action. Reusing an already-rotated
refresh token outside that mechanism revokes only that grant family.

Refresh revocation closes a family; opaque access revocation removes that token.
Unknown and foreign tokens return empty success without crossing client/family
boundaries. Native self-contained JWT revocation is unsupported. Resource
servers must enforce expiry and their own current-authority contract.

## Audit and public contract

Schema version 4 records `oauth.user.authorized`, `oauth.user.denied`,
`oauth.user.issued`, `oauth.user.replayed` and `oauth.user.revoked`. Required
outcome audit commits in the same database transaction as native effects. Audit
storage failure returns a retryable 503 and rolls back success. The trigger
validates actor, tenant, grant and authentication evidence and records durable
UUID subjects for user, membership, tenant, client, resource, session, account,
provider and the decision's capability/assignment/group evidence. Runtime roles
still cannot directly write subject rows. Failed pre-authentication requests are
not claimed as durable user outcome events.

Supported public routes now include discovery, JWKS, GET authorisation, signed
flow details, continuation, consent, code/refresh tokens, UserInfo and revocation.
Registration, introspection, device grants, PAR and OIDC logout remain closed.
Discovery derives its cryptographic settings from the installed native provider
and advertises only supported endpoints/features. OpenAPI files are generated
from source. The new static documentation page is `/docs/id/oauth`, with a linked API
landing page at `/docs/id/api`; existing
onboarding, sign-in and management pages link to the implemented contract.

Migrations 0049–0052 add the authentication snapshot, client-only renewal shape,
validated OAuth audit subjects and reserved user claims. No historical migration
was squashed. Existing resource custom claims using the newly reserved identity
fields must be corrected before applying migration 0052.

## Evidence

### Issuance assertion correction

Coordinator review found that the original commit's return-material statement
was too broad. Its boundary checked ID claims only when an ID token was returned,
and did not compare returned refresh material to its stored row. Two production
HTTP fault cases confirmed this: a missing ID token and a mismatched replacement
refresh scope both returned 200 before the correction
(`/private/tmp/id-oauth-assertions-before.log`).

`user-token-assertions.ts` now runs once after native code issuance, refresh or
encrypted replay, inside the same transaction and before required outcome audit.
It checks the complete effective scope set, required/forbidden ID and refresh
token presence, access-token kind, JWT scope/audience/identity/type, opaque and
refresh row bindings/scopes/resources, native configured expiry, and the opaque
access-to-refresh relationship. Returned opaque and refresh strings are hashed
through the provider API and read from the current transaction. Refresh rows
must also retain broker authentication time and agree with access-token DPoP
confirmation. ID assertions cover nonce, native lifetime, broker/tenant claims
and `at_hash` against the actual returned access token.

The pinned provider deliberately routes standard profile/email claims to
UserInfo (`introspect-C6P1zrTr.mjs`, `STANDARD_CLAIMS`, `userNormalClaims` and
`ID_TOKEN_SCOPE_CLAIM_GUARDS`); it does not require them in an ID token. The
production assertion preserves their absence there. Code ID tokens retain the
authorisation nonce; refresh ID tokens omit it. Native token-kind semantics are
preserved: removing `openid` removes the ID token, while removing `offline_access`
can create one final narrowed replacement whose use yields no further refresh
token. The configured resource and provider TTLs, including scope expirations,
remain the authority; this correction introduces no new lifetime policy.

Consent already had a native subset check before filtering
(`authorize-BmTe2VYG.mjs`, `consentEndpoint`, lines 42–48), plus the production
`postLogin.consentReferenceId` subset guard. The missing part was applying the
valid consent subset to the policy decision and its audit evidence. The flow now
does so before native processing; issuance/replay audits record the actual
filtered response scopes. No alternate consent or token protocol was added.

Fault regressions prove rollback of code consumption, opaque/refresh creation,
refresh rotation and required success audit. Cached-output and stored replacement
divergences return no replay success audit. Positive cases cover native resource
filtering, configured TTLs, consent narrowing, the final refresh without
`offline_access`, UserInfo email and signing-algorithm-dependent access hashes.
The original duplicated inline checks were replaced by the shared assertion;
no schema, migration, native package or public API schema changed.

The expanded production matrix passes 45 tests and 1,700 assertions
(`/private/tmp/id-oauth-assertions-focused-final.log`). The additional configured
signing regression passes with supported ES256/ES512
(`/private/tmp/id-oauth-assertions-signing-final.log`); an earlier test-only ES384
configuration was rejected by typecheck and removed along with its unused hash
case. The original before-fix faults returned 200; the corrected paths return
400 without committing native effects or a success audit. Focused runs exit 1
only because their partial-file coverage does not meet the repository-wide gate.

Final typecheck and lint pass in all four packages
(`/private/tmp/id-oauth-assertions-root-typecheck.log`,
`/private/tmp/id-oauth-assertions-root-lint.log`). Both applications build in
19.969s (`/private/tmp/id-oauth-assertions-build.log`). Web tests pass 71/71 with
240 assertions (`/private/tmp/id-oauth-assertions-web.log`); country tests pass
5/5 with 304 assertions (`/private/tmp/id-oauth-assertions-countries.log`). These
gates were run serially. The static OAuth guide was rebuilt with the corrected
nonce, UserInfo and narrowed-refresh contract.

The final full ID gate on the unchanged correction source passes **2,031 tests,
zero failures, 29,860 assertions, 100% line and function coverage**, across 147
files in 590.74s, exit 0 (`/private/tmp/id-oauth-assertions-full-final.log`). The
new assertion module also has 100% line/function coverage. The database ownership
slot is released: the final check found zero other `answerable_id_test` sessions
and zero `id_test_*` roles (`/private/tmp/id-oauth-assertions-db-release.log`).
The original commit `7a1e2fe3b42e4e009e3f0326bdab3ac4344072e6` remains intact;
the correction is delivered as its direct follow-up.

### Original implementation evidence

All database suites are serial and use `answerable_id_test`, including the
restricted-runtime production HTTP fixture. Names such as OmniChat and Microsoft
365 in these tests identify synthetic local registrations, not validated external
integrations.

- Before implementation: the production seam redirected to consent without the
  required tenant-selection flow (`/private/tmp/id-oauth-seam-before.log`).
- Production HTTP matrix: native SSO resumption, independently linked A/B tenant
  grants, signed-request/identity forgery, live provenance changes, login-only
  renewal, resource claims, PKCE, consent terminal states, concurrent code/consent,
  audit rollback, current UserInfo, revocation and native cached refresh.
  `/private/tmp/id-oauth-http-matrix-second.log`: 19 pass, 683 assertions.
  `/private/tmp/id-oauth-native-sso-matrix.log` exposed duplicate fixture cookies;
  merge-by-cookie-name corrected the browser simulation and the B-tenant check
  passed (`/private/tmp/id-oauth-target-sso-second.log`).
- Expanded production matrix and source-generated discovery/OpenAPI checks:
  `/private/tmp/id-oauth-expanded-second.log`: 37 pass, zero failures, 1,288
  assertions. Later focused checks add public PKCE and private-key assertion
  consumption through the actual HTTP app (`/private/tmp/id-oauth-client-auth-final.log`).
  The final contract matrix also verifies native ID-token broker time against the
  immutable grant and rejects inconsistent refresh metadata:
  `/private/tmp/id-oauth-final-contract.log`: 40 pass, zero failures, 1,392 assertions.
- Actual browser acceptance used web 47910, ID 47930, local consumer 47920, a fake
  upstream issuer and restricted database credentials. Work-email sign-in reached
  selection and consent, then the consumer verified tenant/user claims and received
  access, ID and refresh tokens. A second request required consent again. The
  denial callback contained `access_denied`, the original state and issuer, and no
  code. The test consumer was changed to HTML because the in-app browser did not
  render its plain-text denial response. No production UI correction was needed.
  `/private/tmp/id-oauth-browser-result.json`,
  `/private/tmp/id-oauth-browser-server.log`,
  `/private/tmp/id-oauth-browser-server-second.log` and
  `/private/tmp/id-oauth-browser.manual.test.ts` retain the local evidence.
  The temporary servers, browser tab and restricted fixture roles were closed.
- First full regression: 1,997 pass, nine failures, 28,853 assertions, 663.81s,
  99.90% functions / 99.95% lines (`/private/tmp/id-oauth-full-first.log`). This was
  an interim run while contracts were being finished. Failures identified obsolete
  closed-grant/schema expectations, discovery paths missing from the OpenAPI test,
  a freshness-boundary fixture with insufficient timing margin, and expected
  migration/snapshot drift during generation. The fixtures were corrected without
  weakening protocol/authority assertions. The subsequent expanded run also hit
  one transient test reset statement timeout before a test began; its repeat
  passed.

Repository gates on the completed implementation:

- `bun run typecheck`: four packages pass (`/private/tmp/id-oauth-typecheck-final.log`).
- `bun run lint`: four packages pass (`/private/tmp/id-oauth-lint-final.log`).
- `bun run build`: both applications pass, including the static OAuth guide,
  API landing page and generated endpoint pages (`/private/tmp/id-oauth-build-final.log`).
- `bun --filter web test`: 71 pass, zero failures, 240 assertions
  (`/private/tmp/id-oauth-web-final.log`).
- `bun --filter @answerable/countries test`: five pass, zero failures, 304 assertions
  (`/private/tmp/id-oauth-countries-final.log`).
- Disposable schema reset/migration through 0052 passes
  (`/private/tmp/id-oauth-migrate-final.log`); generated schema and database
  constraint/index checks pass in the expanded matrix.
- `/docs/id/oauth`, `/docs/id/api` and their Markdown counterparts are generated
  statically. Both `/llms.txt` and `/llms-full.txt` include the new pages.

The clean full ID gate passes: **2,023 tests, zero failures, 29,491 assertions,
100% line and function coverage**, 147 files in 612.93s, exit 0
(`/private/tmp/id-oauth-full-clean.log`). The ID application and test sources were unchanged throughout that run. The API landing-page documentation
was built separately during it. Focused suite exit codes reflect the
repository-wide 100% coverage threshold and are not reported as full coverage
passes. Turborepo emitted sandbox cache-write warnings while the listed gates
completed successfully.

## Remaining external acceptance

1. Real Entra administrative consent and issuer/tenant pinning with the intended
   customer configuration.
2. An actual OmniChat cell login and the fork's per-user MCP behaviour, including
   resource indicators, consent handling, encrypted token persistence, rotation,
   retries and delegation after browser-session expiry.
3. External Claude Code/resource-server end-to-end validation, including exact
   issuer/audience/tenant checks and JWKS caching/stale-serving behaviour in each
   consumer library.
4. Lifecycle enforcement at consumers within the agreed SLA, including existing
   offline JWTs and downstream sessions after local revocation/deletion.
5. Operational cutover: stopped old writers, provisioned runtime/retention roles,
   separate key custody, backup/restore rehearsal with the consolidated final
   schema, consumer inventory and public endpoint inventory from outside the
   deployment boundary.

Passing local production-handler tests does not close these gates or establish
production readiness of external applications or infrastructure.
