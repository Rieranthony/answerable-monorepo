# Tenant authentication admission and account provenance

Bounded T1 implementation from `afddd7f65f668753b595678be435d719b310003b`, including the integrated initiation binding and soft-deletion contract. Branch: `codex/id-tenant-authentication-admission`. Local implementation and verification are complete for coordinator review; this report does not claim release completion.

## Reproduction and correction

The real native fixture signs in through the production SSO handler and uses a restricted PostgreSQL login for the admission consumers. The baseline admitted an A-authenticated user to B resource-grant creation and B administration merely because that user had B membership and permissions. Sessions lacked accepted account UUID and upstream authentication time. Four new tests failed, 117 assertions: `/private/tmp/id-tenant-authentication-before.log`.

The initial correction added a provider lock after human permission evaluation. A focused regression reproduced permission expiry during that wait: the command still admitted. One failure, 29 assertions: `/private/tmp/id-tenant-authentication-permission-before.log`. Authentication locks now precede permission evaluation. The same helper rechecks membership and session expiry with database time after waits.

Final review also reproduced admission after the stored accepted account's provider binding was changed to another provider while its user/issuer still matched. One failure, 29 assertions: `/private/tmp/id-tenant-authentication-account-provider-before.log`. The shared decision and session insertion guard now require the account's provider ID to match the recorded provider instance too. The superseded final coverage attempt was stopped before running this regression; `/private/tmp/id-tenant-authentication-full-interrupted.log` is not completion evidence. The existing guarded migration command rebuilt only `answerable_id_test` afterwards, `/private/tmp/id-tenant-authentication-migrate-final.log`.

## Implemented contract

- Native SSO retains the exact accepted account UUID from the verified issuer/subject resolution. Session creation requires the same user. Browser/profile fields cannot supply origin or upstream time. Missing or substituted native evidence rolls back without a new session or sign-in success.
- Migration 0048 adds session `authenticationAccountId` and nullable `upstreamAuthTime`, extends the immutable origin guard, and validates the account/user/provider/issuer relationship on insert. Provider deletion leaves historical session origin intact. Missing account evidence grants no authority.
- Existing sessions lacking account provenance must sign in again before tenant admission. No backfill guesses their account or upstream time. This is a first-release migration sequence; consolidation remains last.
- `auth_time` is accepted only from native `verifiedIdTokenClaims`, as a non-negative integer Unix timestamp no later than acceptance. Missing means unknown; malformed, null, negative, fractional or future values reject with `invalid_auth_time`. No fallback to broker/session creation and no freshness duration.
- `tenantAuthentication` reads under the caller's existing user/organisation locks and trusted transaction scope, locks provider/account/session evidence, then checks the current provider UUID/revision, account/user/issuer/provider binding, live organisation, effective membership and session expiry. It returns one internal snapshot or null, without foreign existence details.
- Existing resource-grant creation consumes this decision after its existing sorted user → organisation → client → resource locks. Human principal and command authority also consume it. Human permission windows are evaluated after all authentication locks. Authentication is rechecked before journal replay.
- Human permissions come only from the session's authenticated organisation. Platform support uses platform-origin SSO and explicit platform permissions to manage another tenant. Machine/root paths and entitlement-only diagnostics retain their separate existing contracts.
- A selected organisation never establishes authority. Secret rotation, change-and-revert, provider deletion/recreation and deleted accounts/users/members reject old origin. No-op configuration saves preserve it. Explicit membership reinstatement remains supported; terminal deletion cannot be reinstated.

## Sign-in event contract

`auth.signin.succeeded` version 2 uses the global user UUID as actor, the session UUID as target, and the native verified authentication organisation as tenant. Its data fields are `authenticationAccountId`, `authenticationProviderId`, `authenticationProviderRevision` and nullable ISO `upstreamAuthTime`. No email, credential or selected organisation supplies attribution. A user with independently verified A/B accounts has correctly attributed B sign-in history. Historical version 1 events remain unchanged.

This replaces membership-count inference and the later session-selection write. Native session creation sets the origin organisation as the initial selection. The existing after-callback sign-in audit lifecycle remains; this slice does not introduce a new audit transaction coordinator or change the native protocol lifecycle. Durable actor/target UUID subjects use the existing audit insertion contract.

## T2 and subsequent T1 handoff

The internal `TenantAuthentication` result contains:

| Field | Meaning and consumer rule |
| --- | --- |
| `userId`, `memberId` | Exact global user and target-tenant membership UUIDs; recheck current eligibility and terminal deletion |
| `authenticationOrganizationId` | Must equal the target tenant; platform support is a direct administration rule, not resource-grant cross-tenant trust |
| `authenticationAccountId` | Exact account accepted by native SSO; retain the UUID and revalidate the bound user/issuer/provider and non-deleted state |
| `authenticationProviderId`, `authenticationProviderRevision` | Exact provider instance and configuration used at authentication; revalidate the same current tenant/provider/revision |
| `authenticationSessionId` | Immutable provenance reference; does not mean a downstream grant may recreate a deleted session |
| `brokerAuthenticatedAt` | Broker session acceptance time; not upstream freshness |
| `upstreamAuthTime` | Validated upstream claim or null; null must never become a synthetic recent time |
| `sessionExpiresAt` | Current live-session deadline for initial admission; separate from subsequent grant lifetime |

T2 owns the shared grant schema and must persist the immutable authentication tuple alongside the existing user/member/tenant/client/resource identities, purpose, scope ceiling and grant expiry. Existing grant `authTime` still means session creation; it is not an upstream freshness claim. T2 must use an explicit broker-versus-upstream representation for login-only and resource grants and make actual claims, persistence and issuance audit agree.

New grants require the live-session decision. Later code/refresh consumers must validate the persisted tuple under their existing ordered locks, current user/member/account/tenant/provider eligibility, irreversible revocation and policy. Do not reconstruct origin from mutable selection or from whichever account happens to match an email. Grant renewal lifetime and whether a browser session must still exist are separate from the initial live-session check; preserve current explicit session-revocation effects. The snapshot alone is not permission, consent or authentication by possession of IDs.

The test-only B binding reserves a distinct upstream identity for the same global user, then performs a real native B login. It is not a production linking journey. Deliberate linking, conflict/replay rules and sensitive-command freshness follow this slice. A replacement provider's native account-binding conflicts remain governed by the pinned native protocol; no silent account adoption is added.

## Validation

- Admission, expiry, replay and invalid-time matrix: 25 pass, zero failures, 777 assertions, `/private/tmp/id-tenant-authentication-matrix.log` (before the final permission-wait and provenance-fault additions).
- Native grant lifecycle compatibility: the user-grant tests passed; the combined 183-test run had only five expected principal/schema snapshot failures, subsequently corrected. `/private/tmp/id-tenant-authentication-native-grants.log`.
- Provenance rollback, independent B evidence and corrected principal/schema assertions: eight pass, zero failures, 111 assertions, `/private/tmp/id-tenant-authentication-corrections.log`.
- Final focused native SSO, admission, provenance rollback and human policy boundaries: 94 pass, zero failures, 1,438 assertions, `/private/tmp/id-tenant-authentication-boundaries-final.log`.
- First full run: 1,941 pass, two legacy-fixture failures, 26,659 assertions, 100% line/function coverage. The restricted policy fixture now supplies its explicit stored account/provider origin; the receipt-visibility fixture now requires independent tenant SSO after losing platform authority. Both corrected fixtures pass, 26 assertions: `/private/tmp/id-tenant-authentication-fixtures-final.log`. The superseded full log is `/private/tmp/id-tenant-authentication-full.log`.
- Final root typecheck and lint pass: `/private/tmp/id-tenant-authentication-root-types-final.log`, `/private/tmp/id-tenant-authentication-root-lint-final.log`.
- Last account/provider and fixture corrections: four pass, zero failures, 91 assertions, `/private/tmp/id-tenant-authentication-last-corrections.log`.
- Root build passes, `/private/tmp/id-tenant-authentication-build-final.log`. The first sandboxed attempt failed because Turbopack could not bind its internal port; the permitted rerun needed no source change.
- Web: 71 pass, zero failures, 240 assertions, `/private/tmp/id-tenant-authentication-web.log`. Countries: five pass, zero failures, 304 assertions, `/private/tmp/id-tenant-authentication-countries.log`.
- Both served OpenAPI documents still match the existing generated snapshots; hidden internal fields do not change the public schemas. No hand-edit or regeneration was needed.
- Final full ID coverage: 1,944 pass, zero failures, 26,713 assertions across 145 files in 514.08 seconds; 100% line and function coverage. `/private/tmp/id-tenant-authentication-full-final.log`.
- After the final suite, removed the one unused generated role left by the interrupted run, after verifying zero connections, dependencies and memberships. No generated test roles remain. `/private/tmp/id-tenant-authentication-cleanup-inspect.log`, `/private/tmp/id-tenant-authentication-cleanup.log`.

All shared database suites ran serially against the exclusively assigned disposable `answerable_id_test`. All required local gates pass. Database work is complete and ownership is released at handoff. No non-test reset, migration squash, purge work, public user-grant opening, push or deployment.

## Delete, simplify, optimise

Reuse the current session, transaction, lock ordering, scope machinery and journal. Remove membership-derived sign-in attribution and its extra discovery/session-write work. One shared authentication decision serves grant creation and human authority; restrict human permission discovery to the authenticated tenant while preserving entitlement-only diagnostics. Keep independent callback/initiation checks. No extra provider selector, authentication epoch, permission framework or identity-merging heuristic is needed.

No production topology, capacity, recovery or consumer acceptance claim follows from these local tests. T5 consolidates to one initial migration only after schema integration is finished.
