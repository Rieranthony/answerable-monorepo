# Verified identity linking and fresh human authentication

Bounded T1 completion from `4d660243d1003083984a6937e29aa9127f58a977`, following [tenant authentication admission](id-tenant-authentication.md). That earlier report's deferred linking and sensitive-command freshness are implemented here. The upstream freshness window is five minutes.

## Supported journey

`POST /auth/sso/reauthenticate` requires the current browser session and reauthenticates its exact accepted issuer/subject. It may renew that account against a changed configuration of the same provider instance; ordinary admission still rejects an old provider revision. `POST /auth/sso/link` additionally requires fresh initiating evidence and a target provider ID. It independently authenticates an unowned target work identity and binds it to the initiating global user UUID, preserving the existing profile. The browser entry point is `/security`, linked from the signed-in login page.

Both endpoints call the pinned native SSO endpoint with `prompt=login` and `max_age=0`. Native discovery, state cookies, provider fingerprints, token validation, verified claims, account resolution and session creation remain authoritative. Freshness requires the actual verified `auth_time`, including proof that target authentication happened after initiation. Broker acceptance time never substitutes for a missing claim.

## State, binding and races

The existing native verification store holds a server-only record containing purpose, initiating user/session/account, source and target provider UUIDs and revisions, target organisation, initiation time and expiry. Native OAuth server context carries only its random reference. The pinned OAuth callback reads then deletes its own state; the supported native `consumeVerificationValue` adapter operation atomically consumes this additional purpose record. A test forces two callbacks to read the same native state and proves that only one can claim the purpose and bind. No new table or migration is needed.

No database lock spans upstream authentication. Inside the native callback transaction, source user, ordered organisations and ordered source/target providers are locked before the native provider update. Current source identity, membership, session, provider configuration and both authentication times are checked after waits and again before session creation. Revoked, deleted, expired or not-yet-effective membership cannot be reinstated by linking. An owned or imported target identity is rejected, including a binding to the same user; email never merges or transfers accounts. Competing binds are serialised by the existing provider/account constraints.

The target account, any new active target membership, native session and required `identity.linked` version 1 fact share the native transaction. The event uses the global user UUID as actor and target account UUID as subject, with target organisation, initiating session/account, target provider UUID/revision, verified upstream time and purpose reference. An audit fault rolls the binding back. Normal sign-in retains its existing version 2 provenance event.

## Human command policy

Every admin route declares `freshAuthentication`, exported as `x-fresh-authentication`. Reads and organisation display edits use ordinary session lifetime. Client edits containing only `name`, `uri` and `contacts`, and group/resource edits containing only `name`, also use ordinary lifetime. Mixed or security changes require fresh upstream evidence. Root and machine authority retain their existing rules.

Current human authority and freshness are checked before journal replay and mutation. Existing command contexts revalidate after target locks: a regression test demonstrated that client-secret rotation previously committed after its administrator's membership expired during a row wait. The correction rejects that mutation. A final immutable-time guard also rolls back effects if target or audit waits exhaust freshness; authorised self-session revocation remains possible. A `403 reauthentication_required` supplies the supported reauthentication path and maximum age. After reauthentication, the exact original idempotency key and input can apply or replay the original receipt; authentication time does not enter the operation fingerprint.

## T2 handoff

The existing `TenantAuthentication` tuple and strict ordinary admission remain the handoff. Connecting an account grants no permission by itself: target membership, tenant/provider evidence, entitlements and ceilings still govern access. T2 must retain distinct broker acceptance and nullable upstream authentication times when persisting grants. No public user OAuth route, grant migration, recovery, implicit account merge, transfer, purge or migration consolidation is added here.

## Validation

- Before implementation, all three initial native/freshness regressions failed: `/private/tmp/id-verified-sso-before.log`.
- The authority-expiry reproduction failed before the target-lock correction: `/private/tmp/id-verified-sso-authority-wait-before.log`.
- Native callbacks, independent issuers, restricted runtime role, conflicts, deletion, membership windows, provider changes, replay, audit rollback and deterministic concurrency: 35 pass, zero failures, 1,175 assertions, `/private/tmp/id-verified-sso-final-matrix.log`.
- The first full run found three failures: the public OpenAPI stub lacked the new routes, the existing replay fixture's new SSO response lacked `auth_time`, and revalidation retained a mutable principal reference. The fixtures now match the supported contract, and command contexts capture their admitted principal before waits. That superseded run had 1,976 passes, three failures and 99.99% line coverage: `/private/tmp/id-verified-sso-coverage.log`.
- Corrected admission/replay and immutable-principal tests, plus native purpose substitution, upstream expiry, callback validation faults and production redirect-origin checks: 78 pass, zero failures, 2,359 assertions, `/private/tmp/id-verified-sso-corrections.log`. Native global origin validation replaces a redundant per-endpoint check. The corrected public API unit suite passes all 25 tests with the configured 15-second timeout: `/private/tmp/id-verified-sso-openapi-unit.log`.
- Root typecheck and lint pass: `/private/tmp/id-verified-sso-typecheck.log`, `/private/tmp/id-verified-sso-lint.log`.
- Generated both OpenAPI files from source using synthetic local configuration: `/private/tmp/id-verified-sso-openapi.log`.
- Web: 71 pass, zero failures, 240 assertions. Countries: five pass, zero failures, 304 assertions. Logs: `/private/tmp/id-verified-sso-web.log`, `/private/tmp/id-verified-sso-countries.log`.
- Final production build passes: `/private/tmp/id-verified-sso-build.log`.
- Browser interaction on isolated local ports, with synthetic ID responses, verifies both endpoint payloads, visible freshness recovery guidance and returned-URL navigation: `/private/tmp/id-security-browser-check.log`. This is a UI check; the native integration suite supplies authentication evidence. The temporary servers and browser tab are closed.

- Final full ID coverage: **1,985 pass, zero failures, 28,099 assertions across 146 files in 697.97 seconds; 100% line and function coverage**, exit 0. `/private/tmp/id-verified-sso-coverage-final.log`.
- Final generated-role inspection found no remaining `id_test_` roles: `/private/tmp/id-verified-sso-cleanup.log`.

All required local gates pass. All database suites ran serially against the exclusively assigned disposable `answerable_id_test`. Database work has stopped and ownership is released at handoff. The original integration checkout remained read-only. No non-test reset, migration squash, purge work, public user OAuth opening, push or deployment was performed. These local checks make no production capacity or recovery claim.
