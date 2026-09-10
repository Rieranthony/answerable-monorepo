# SSO initiation revision binding

Bounded T1 implementation on baseline `09badf2d52b30791955c734838d87e3f66b82e3a`. This closes initiation-to-callback provider revision binding only. It does not implement tenant admission, identity linking, fresh human administration, soft deletion or production user OAuth.

## Reproduction

The native restricted-role regression starts through production `createAuth`, follows the local upstream IdP's authorisation redirect, changes provider configuration, then submits the callback. The existing native provider fingerprint omits the client secret and does not include Answerable's revision; the existing observer starts a new revision map for each HTTP request.

On the baseline, secret-only rotation and a domain change followed by restoration both returned no callback error despite advancing the stored revision. The unchanged-write control passed: **one pass, two failures, 12 assertions**, `/private/tmp/id-sso-initiation-before.log`. The required rejection was `SSO_PROVIDER_CHANGED`.

## Change

- The existing database adapter observes provider lists as well as individual provider reads and awaits the observer before native state generation.
- The existing request map keeps each provider's first observed revision. Native `addOAuthServerContext` carries those UUID/revision pairs in `serverContext.answerableSsoProviderRevisions` across the redirect.
- Native SSO remains responsible for selecting and verifying the provider UUID. The resolver reads `getOAuthState().serverContext` and requires that chosen UUID's initiation revision and callback first-read revision to equal the locked provider revision before identity writes.
- Missing or mismatched evidence returns the existing `SSO_PROVIDER_CHANGED` error. Callback-time observation, provider locks, session-origin storage and transaction rollback remain intact.

No schema, migration, package version, public response schema or OAuth grant allowlist change. State expires and is protected by the existing native storage and cookie mechanism. Requests started before this binding exists must restart; there is no legacy-flow acceptance path.

## Review correction

The first implementation observed only `findOne`. A targeted compatibility regression showed that uppercase-domain and subdomain email hints use native `findMany` selection and were wrongly rejected: **two passes, two failures, six assertions**, `/private/tmp/id-sso-initiation-routing-before.log`.

The superseded full coverage run was stopped; it is not verification evidence. The existing guarded `db:test:migrate` command rebuilt only `answerable_id_test` before the routing reproducer. Log: `/private/tmp/id-sso-initiation-test-reset.log`.

Observing both query forms preserves the native matching rules. When native selection reads a list, state contains candidate UUID/revision pairs; the native provider reference still determines the one accepted provider. No extra provider query, configuration copy or competing selector is introduced. A second auth instance can complete the callback using persisted state, with its own callback observer.

## Validation

- Initial corrected initiation cases: three pass, 26 assertions, `/private/tmp/id-sso-initiation-focused.log`.
- Complete SSO/origin suite after the list correction: 54 pass, 328 assertions, `/private/tmp/id-sso-initiation-boundaries-final.log`.
- Final focused suite, including multiple-provider routing and observation input guards: 15 pass, 80 assertions, `/private/tmp/id-sso-initiation-final-focused.log`.
- Final root typecheck and lint pass: `/private/tmp/id-sso-initiation-typecheck-final.log`, `/private/tmp/id-sso-initiation-lint-final.log`. The first typecheck lacked Next.js-generated route types in the fresh checkout; the build generated them before the successful rerun.
- Web: 71 pass, 240 assertions, `/private/tmp/id-sso-initiation-web.log`. Countries: five pass, 304 assertions, `/private/tmp/id-sso-initiation-countries.log`.
- Final full ID coverage: 1,904 pass, zero failures, 25,455 assertions across 143 files; 100% line and function coverage, `/private/tmp/id-sso-initiation-final-full.log`.
- Final root build passes for both apps, `/private/tmp/id-sso-initiation-final-build.log`. The web build reused the successful unchanged build cache from `/private/tmp/id-sso-initiation-build.log`; ID rebuilt from the final source.
- Post-test cleanup removed one unused generated runtime-test role after confirming no connections, dependencies or memberships. No `id_test_` roles remain: `/private/tmp/id-sso-initiation-cleanup.log`. `git diff --check` passes.

The new tests cover secret-only changes, change-and-revert, unchanged saves, successful fresh retries, cross-instance callbacks, missing/malformed/wrong-provider state and browser-supplied state fields. Native selection is exercised with another provider present, organisation slugs, exact-domain email hints, uppercase domains and subdomains. Existing token-exchange and callback-first races remain in the full SSO suite. Failed initiation checks leave no user, account, membership or session; the change scenarios also assert no successful sign-in event.

No shared database suites overlap. No development/production database reset, restore rehearsal or unrelated workload rerun is part of this slice.

## Delete, simplify, optimise

Retain the callback observer because it independently covers configuration changes during the callback. Reuse its map and native state instead of adding a new flow table, provider selector, migration or replay system. Persist only provider UUID/revision pairs, not configuration or credentials. No performance optimisation is justified by these functional regressions.

## Handoff

The public sign-in guide and native-origin schema description now state the initiation requirement. `auth.ts` changes only the observer wiring; tasks changing provider installation must retain it. The native server-context key is an internal interface for subsequent SSO work. The final migration owner has no new schema requirements from this slice.

The user's accepted own-tenant SSO and verified identity-binding rules remain for the next dispatch. Soft-deletion integration must exclude deleted providers from discovery and reject deleted users, tenants and memberships before authentication or binding can restore authority. This commit adds no `deletedAt` fields or deletion behaviour. UUID-based audit attribution and deferred physical cleanup remain the coordinator's contract.
