# Customer app sign-in: implementation plan

30 October 2026. Implementation authorised: staging only, with no customers and no production deployment. W1/W2 and the local staging definition of done below are complete in Answerable, with all listed local verification gates passing. W3 requires the actual OpenCloud fork. Existing-account migration is unnecessary for this clean staging rollout; production lifecycle work remains separate future scope. See the [implementation evidence](../../../reports/customer-app-sign-in-implementation.md).

## Scope and authority

The user first requested this plan and report before coding, then explicitly authorised implementation and clarified that no customers or production deployment exist. This permits application changes and local tests for the staging integration. It does not request a cloud deployment or agent-pushed release tag. Historical future work below records the broader release design; it does not require building migration tools for a non-existent customer population.

Baseline: Answerable checkout `ff3018a3a37ec90baefa0165d1cfc439341e0c6e`, the [29 October audit](../../../reports/customer-app-sign-in-audit.md), the current ID design and release checklist. Pinned upstream snapshots are evidence, not substitutes for the actual customer forks. Record their URLs, deployed SHAs, lockfiles and image digests before editing those forks.

## Current staging definition of done

W1/W2, matching fake/admin contracts and public guides, real-library browser proof, full ID coverage and affected regression gates pass. The report records actual-fork work and deployment as outstanding. No existing-account migration or production cutover is part of this empty-staging change.

## Future customer-release definition of done

Customers authenticate through ID, reach only their assigned application/customer context, retain existing accounts and data, and lose access within the established offboarding bounds. App registration, permissions and deployment are repeatable and reviewed. Automated tests, real-consumer browser evidence, migration rehearsal and rollback prove the complete journey.

A successful login is an intermediate milestone. It does not close the existing production gates in [the ID release decision plan](../../../reports/answerable-id-release-decision-plan.md).

## Work packages

| ID | Work | Repository | Classification | Depends on |
| --- | --- | --- | --- | --- |
| W0 | Fork/deployment inventory and acceptance contract | All | Required before fork implementation or migration | Owner inputs |
| W1 | Administrable `client_secret_post`, secret lifecycle and contract tests | Answerable | Confirmed code change for the recommended confidential LibreChat route | Plan review |
| W2 | Browser discovery CORS and real browser proof | Answerable | Confirmed gap for direct cross-origin discovery | Plan review |
| W3 | Resource settings survive OpenCloud configuration; enforce the ID API token contract | OpenCloud server fork | Configuration gap confirmed; verifier changes depend on whole-fork proof | W0 |
| W4 | Actual LibreChat/Web/API/native-client acceptance | Consumer forks + Answerable acceptance kit | Required tests/configuration; fixes driven by failures | W0–W3 as applicable |
| W5 | Verified existing-account migration and rollback | Consumer forks; ID only if a proven missing capability requires it | Required before an existing customer's cutover | W0, W4 |
| W6 | Bounded upstream detection and downstream session invalidation | ID + consumer forks | Existing production requirement; detailed mechanism decision still required | W0, lifecycle design |
| W7 | Euro-Office WOPI integration and document permissions | OpenCloud + Euro-Office deployment/forks | Configuration and acceptance first; code only for reproduced gaps | W0, W4, W6 |
| W8 | Repeatable registration, documentation, staging rollout and promotion | Answerable + fork delivery pipelines | Required operations; automation code only where existing tools are insufficient | Applicable packages above |

## Proposed decisions

- D1: Use a confidential POST-authenticated LibreChat client plus S256 PKCE for the intended customer release. The previous public-PKCE option remains a limited pilot alternative, not the default way to avoid fixing W1.
- D2: Keep normal LibreChat sessions initially. Do not turn on token reuse or pass login-only/ID tokens to resource APIs. Complete W6 before claiming production offboarding.
- D3: Give OpenCloud a tenant-owned resource JWT with exact audience and customer enforcement. Do not use generic opaque-UserInfo mode as an app-permission bypass.
- D4: Use customer-owned clients per isolated cell/environment. Shared multi-customer clients have no organisation owner and require independent customer approvals.
- D5: Use OpenCloud as Euro-Office's identity/file-permission boundary. No separate Passport strategy, editor account system, app catalogue or public-signup system is required for this scope.
- D6: Preserve ID's immutable subjects, method binding, S256 requirement, permission model, single-use refresh and one-time secret disclosure. Do not introduce a refresh replay grace window or database rewrite to make a consumer pass.

## W0 — pin the real consumers and the release contract

Required inputs: fork URLs, branches and deployed commits; lockfiles; pinned images; public/browser/internal origins; callback paths; replica/session-store topology; identity provider per customer; existing account counts/provider formats; supported native apps; and isolated versus shared OpenCloud deployment. Obtain exports through an approved read-only process. Keep secrets and customer data outside this planning directory.

Outputs:

1. An inventory mapping customer → environment → client instance → API resource → consumer image/commit. Record which configuration path actually supplies each setting.
2. A fork patch inventory matching `Q-FORK-PATCHES`; do not assume today's upstream HEAD matches the deployed fork.
3. An agreed offboarding exposure bound within the existing 15–30 minute release requirement. Propose 15 minutes; retain five minutes as the required upstream-disable-to-new-grant-refusal bound. These are requirements to measure, not claims of current support.
4. Representative migration fixtures for every account category. Unverifiable/ambiguous mappings remain exceptions, never silently merged.
5. Explicitly supported users and clients. Company-directory members are the current admission model. Guests, public signup and the non-SSO customer cohort must be listed as unsupported until separately implemented; do not drop those customers from a fleet migration plan without recording their disposition.

W1/W2 can be specified against this checkout before fork inventory is complete. No fork patch or customer migration is implementation-ready until its actual inputs are pinned.

## W1 — complete confidential client registration

### Code surfaces

| Existing file | Planned change |
| --- | --- |
| `apps/id/src/http/admin/clients.ts` | Add POST to the client creation method vocabulary. Keep method changes out of ordinary PATCH: existing registrations remain bound to their method. |
| `apps/id/src/services/clients.ts` | Extend `CreateClientInput`; generate/hash a secret and allow secret rotation for Basic and POST clients. Preserve current transaction/audit/revocation behaviour. |
| `packages/id-admin/src/testing.ts` | Make the fake issue/rotate POST secrets consistently with the real API; update its explanatory comments. |
| `apps/id/src/http/admin/clients.integration.test.ts` and `client-replay.integration.test.ts` | Cover HTTP creation/secret lifecycle and existing receipt behaviour for both secret methods. |
| `apps/id/src/services/clients.integration.test.ts`, `client-grants.integration.test.ts`, `auth/user-oauth.integration.test.ts`, `auth/machine-provider.integration.test.ts` | Add or parameterise meaningful protocol and policy cases at the responsible layer. |
| `packages/id-admin/src/testing.test.ts` | Verify the fake's new consumer-visible behaviour. |

Native provider 1.7.2 already supports POST and hashes secrets through ID's configured function. Reuse it. Do not rewrite token authentication or make Basic registrations accept POST. The existing machine-provider test proves POST after a fixture database edit; add proof through HTTP administration instead of treating that fixture as an onboarding method.

The column is already text. **No schema migration is expected for W1.** Confirm schema constraints while implementing; never rewrite the initial/applied migrations. No new env var, dependency upgrade, public client-registration endpoint or client-ID grammar change is needed.

### Tests before implementation

- POST registration succeeds through the real administrative route, stores a digest, returns a secret only in the original successful response and reports secret presence on read. Existing public/key clients receive no shared secret.
- A real S256 code flow using the consumer library's default POST method reaches UserInfo with the permitted identity claims; refresh uses the registered method if enabled.
- Wrong/missing secret, wrong method, disallowed grant, disabled client, missing PKCE, wrong callback and foreign customer permissions retain their current refusals. Include both directions of Basic/POST mismatch.
- Rotation changes the digest, invalidates the old secret and bound grants as currently designed, increments the appropriate revision/version and permits a fresh authorised flow with the new secret.
- Same-key creation/rotation replay returns the existing receipt without revealing the secret or repeating revocation; rotation replay must not revoke grants created after the original rotation. Lost first responses require a new intentional rotation, not secret recovery from a receipt.
- Audit, command receipts and errors contain no raw secret or bearer. Audit failure rolls back creation/rotation. Preserve the existing evidence and fail-closed transaction contract.
- Since shared-secret registration also permits `client_credentials`, prove its POST HTTP path through a real registration and exact owner/resource capability. Do not accidentally widen any machine permission.

Avoid duplicating the full test matrix in every layer. Services prove persistence/effects, HTTP proves validation/authority/receipts, native grant tests prove the protocol, and a real consumer proves integration.

### Contract and documentation work

Regenerate both OpenAPI snapshots using the prescribed test in `apps/id`; do not edit generated JSON. Update the application/onboarding guides to describe the supported method and real callback. Any code example must be included from a typechecked/tested source, not pasted into MDX. Keep Markdown output and build inputs in sync.

`infra/ops/src/registrar.ts` currently supports the methods its MCP callers use. Leave it unchanged in W1 unless W8 adopts it for POST app registration; widening an unused internal union is not a requirement. `packages/id-admin` is a generic JSON client, so its real transport does not need a new bespoke registration API.

## W2 — browser discovery compatibility

`apps/id/src/app.ts` applies CORS under `/auth/*`; root discovery is outside it. The 29 October staging request with an Origin returned no allow-origin header. A direct SPA discovery fetch therefore needs a deliberate supported route.

Recommended ID change: provide credential-free public CORS for GET/HEAD and required preflights on **only** `/.well-known/openid-configuration` and `/.well-known/oauth-authorization-server`. Wildcard allow-origin is suitable for these public, caller-independent documents; do not enable credential sharing there. Keep token/UserInfo browser calls on the existing configured-origin policy, and keep admin/authorisation/consent routes out of this wildcard scope. Check JWKS from the actual browser path as well.

Tests in `apps/id/src/app.test.ts` plus a real browser must prove both discovery documents can be read cross-origin without cookies; metadata is unchanged; private endpoints gain no new cross-origin access; token/UserInfo allowlist behaviour is unchanged; and deployed ingress/cache headers preserve the result. CORS must not create an Origin-dependent response without correct cache variation.

Use [OAuth Security BCP §2.6](https://www.rfc-editor.org/rfc/rfc9700.html#section-2.6) as the public-endpoint boundary. CORS is browser compatibility, not an authorisation mechanism. If the actual fork uses a verified same-origin metadata proxy, it may avoid direct discovery, but the plan must name and test that path explicitly.

## W3 — make OpenCloud request and validate its own token

### Preserve the settings

Expected upstream surfaces, to be resolved against the actual fork:

- Server `services/web/pkg/config/config.go`: add narrowly typed configuration for the single RFC 8707 resource and the token parameter needed to carry it at exchange/renewal. Prefer explicit fields over unrestricted arbitrary pass-through.
- `services/web/pkg/command/server.go`: preserve configured values when a custom JSON file is read. The current decode targets the same narrow type; merely setting `WEB_UI_CONFIG_FILE` loses the fields.
- `services/web/pkg/service/v0/service.go`: ensure the served `/config.json` still carries the exact values after re-encoding. Preserve defaults for deployments that do not configure a resource.
- Corresponding config/command/service tests and fork documentation. If the fork exposes env settings for these fields, use its normal configuration mechanism and precedence rules.

The browser's `packages/web-runtime/src/services/auth/userManager.ts` already passes settings through to oidc-client-ts. Its locked 3.5.0 supports the necessary parameters. Start with server configuration preservation; change the browser/library only if its actual request trace fails. WebFinger owns the resolved authority, client ID and scopes and must agree with the delivered config.

Regression evidence: a realistic custom config survives decode → served JSON → browser settings; authorisation, code exchange and refresh each send **exactly one identical resource**; `resource` and token parameter values cannot drift; old configurations retain their behaviour. Use a full served-config/browser test, not only a struct serialisation test.

### Registration and API enforcement

Register a tenant-owned API resource and public PKCE Web client, with exact callback pages, login and exact-pair scopes, capability ceilings and assignments. Proposed identifiers such as `<cloud-origin>/api` and `opencloud:access` are configuration to approve, not existing constants. Add exact-pair refresh permission if requesting renewal. No `client_credentials` permission belongs on a browser client.

Configure JWT verification, exact `PROXY_OIDC_AUDIENCES`, UserInfo for profile data, write-enabled local directory provisioning and stable `sub` identity. Check actual fork support for the audience option, introduced in the inspected source as 8.1.0. Customer-owned resource issuance and the proxy's customer routing must agree.

The generic inspected verifier checks signature/issuer/audience but does not show ID-specific `typ`, user-subject and scope checks at that layer. **Prove the whole fork enforces the required API contract.** Where missing, add a narrow verification/policy adapter using the existing JWT library: accepted algorithm, required time claims, intended resource/audience, `typ: at+jwt`, `subject_type: user`, correct organisation and required granted scope. Bind UserInfo's subject to the token subject. Do not accept an ID token, a token for another app/resource or a machine identity as a user API session. Reuse tenant mapping where it exists; do not invent an email-based tenant boundary.

This verifier work is conditional on full-fork proof, but those acceptance requirements are mandatory. No weakening to `none`, disabled audience checks or unverified decoded claims is an acceptable way to pass.

## W4 — consumer acceptance, including native apps

Reuse `packages/acceptance` for real ID, a real directory stand-in and Playwright. Existing MCP journeys use a public MCP OAuth client; they do not certify Passport/OpenID login. The current manual host lane runs LibreChat with local credential login and proves neither ID login nor production session control.

Add an application-consumer journey (proposed `packages/acceptance/src/journeys/app-sign-in.journeys.test.ts`) and the smallest internal support required. Verify POST using the actual fork's locked OpenID library; if a test-only dependency is needed, pin it to that lockfile. Do not create a new production auth client or reproduce the protocol by hand just to make a test pass. Then exercise the actual pinned fork image in its integration lane; a library test is not a substitute for the app.

For every supported app: new/returning user, changed email, required claims/scopes, correct org selection, missing assignment/capability, revoked membership, PKCE/state/nonce handling, callback mismatch, token expiry, deny-by-default during ID outage, and signing-key rotation/cache refresh. Browser coverage must include the supported Safari/Firefox cookie restrictions as well as Chromium; use a top-level flow when silent iframe authentication cannot work.

For OpenCloud add file list/read/write/sharing, wrong-app/wrong-customer/ID-token/machine-token denial, missing resource at each exchange, insufficient scopes, EdDSA support and real browser discovery/token/UserInfo CORS. Verify group/role requirements against actual claims; retain local default user/admin assignment rather than assuming ID publishes product roles.

For each desktop/Android/iOS version, record client discovery, exact redirects, PKCE, resource and scopes on all grants, secure credential storage, cross-replica/tab/process refresh and logout. Configurable lowercase IDs are preferable to relaxing ID's grammar. If a supported client lacks resource configuration, implement it in that fork; otherwise declare that version unsupported. Do not infer mobile support from Web.

ID refresh is single-use with zero grace. Prove one in-flight renewal per grant and atomic replacement of the returned token. A response lost after server rotation must cause controlled reauthorisation, not blind reuse of the old token. OpenCloud's transient-error retries need this fault test. Isolated users must never share a refresh credential.

Keep acceptance lanes exclusive on this machine. Reuse the disposable acceptance database and fixed-port rules; do not run two acceptances, host lanes or kind stacks at once. No `env:up` from a worktree, no test resets against staging, and no unpinned `latest` images. Record and check additional consumer ports before using them.

## W5 — migrate identities without transferring data ownership

First create a reviewed mapping record: customer, environment, immutable old account ID, old provider/issuer/subject, verified directory evidence or independent proof of both accounts, new ID issuer/sub, intended existing app ID and review disposition. Never derive an Entra `oid` from a pairwise `sub`; changing the upstream app registration can change that subject. Email is display/review data, not proof.

Plan a dry-run-first, resumable migration tool in each data-owning fork. It must reject ambiguous, conflicting, already-rebound or cross-customer records; compare the expected old binding before updating; preserve existing app IDs and references; produce a restricted non-secret journal; and resume safely after interruption. Apply through an approved operational path, not ad hoc database edits. No automatic email merge, disabled-user reactivation or subject reassignment.

LibreChat preserves user IDs, conversations, messages, agents, files, API credential ownership and roles. OpenCloud preserves internal account IDs, files/spaces, shares and ACLs. Do not let autoprovisioning create new accounts for existing users while their mapping is pending. Plan duplicate resolution and local/legacy provider accounts before cutover.

Rehearsal: use representative restored disposable data, verify before/after counts and ownership references, inject interruption/concurrent first login, prove retry safety, test renamed/reused email, and rehearse rollback. Keep writes controlled during the real cutover or reconcile acknowledged post-snapshot writes; a blind database restore may discard new conversations/files or undo revocations. If ID itself needs an import/adoption feature, stop and design its immutable binding contract separately—the current verified-linking route is not an imported-user adoption API.

Exit: every migrated account has verified evidence, expected data ownership and an executable rollback record; unresolved exceptions cannot log into somebody else's data. First-login-only users may pilot earlier, but existing customers cannot cut over without this proof.

## W6 — offboarding and logout, with a separate design gate

This is substantial lifecycle work, not an extra login flag. Preserve the existing E4 requirements: upstream disable blocks new grants within five minutes, and remaining access ends within the selected 15–30 minute bound. No success claim until measured from independent directory/admin observations through ID, resource JWTs, app sessions, refreshes and open editors.

Budget the complete path from the corporate disable, including detector delay, remaining token lifetime, authority caches, delivery/revalidation delay and clock tolerance. If 15 minutes is selected and detection can take five minutes, an offline JWT issued just before detection cannot have a further 15-minute exposure. The plan must allocate the remaining budget or prove an earlier online invalidation path. Record the worst-case path, not only average delivery time.

### Decisions required before lifecycle coding

| Decision | Required design result |
| --- | --- |
| Upstream detection | For each supported provider choose an observable revocation signal and maximum stale-proof age; define provider-outage behaviour. Directory polling needs tenant permission and stable directory identity. Forced reauthentication must prove upstream freshness; a successful broker refresh is not evidence the corporate account is enabled. |
| Provider without a usable detector | Specify bounded delegation with actual upstream proof renewal and prove the target, or keep that provider out of production cutover. A longer browser session is not an alternative. |
| Upstream tokens | ID currently stores none. Do not request/store directory `offline_access` speculatively. Any selected probe requiring it needs explicit scope, encryption, consent, retention and rotation design first. |
| Downstream authority | Choose request-time/current-authority checks, durable event-driven invalidation, or a documented combination that meets the bound during restarts/outages. Use existing ID access/administration APIs where sufficient and least privilege; consumer apps must not receive platform-write credentials. |
| Session mapping | Map `(issuer, sub, organisation, client instance, grant/session)` to each app's real session and refresh records. Tenant removal affects only that tenant; global disable has global scope. |
| Background work | Preserve intentional delegation after ordinary sign-out, but terminate it on the defined offboarding events. Do not conflate ordinary sign-out with administrative revocation. |

If durable delivery is selected, commit an outbox fact with the authority change, dispatch only after commit, and make consumer handling idempotent. Design delivery authentication/allowlisted endpoints, ordering, retries/backoff, crash recovery and visibility of overdue delivery. A replay must not remove an unrelated/newer session; reinstatement never resurrects revoked grants. This may need new additive schema/migrations; specify those only after the mechanism is decided. An in-memory callback or best-effort HTTP request is not durable delivery.

If implementing OpenID back-channel logout, use [the standard](https://openid.net/specs/openid-connect-backchannel-1_0.html): signed issuer/client-bound logout tokens, validated event/time/replay/session semantics, and correct receiver acknowledgement. Build on supported provider primitives; do not fork Better Auth or invent JWT validation. LibreChat needs a receiver if its deployed fork lacks one; OpenCloud's existing receiver/cache invalidation must be tested against the actual ID delivery.

User-initiated “sign out everywhere” is a distinct optional UX scope. If selected, implement [RP-initiated logout](https://openid.net/specs/openid-connect-rpinitiated-1_0.html) with separately registered exact return targets, validated client/token hints, appropriate confirmation and honest discovery. Do not redirect to caller-supplied arbitrary URLs. Do not advertise end-session/back-channel support before the entire path works.

### Lifecycle acceptance

Inject: local user disable; member/group/entitlement expiry/removal; customer disable; client disable/secret rotation; provider replacement; upstream account disable; app offline during revocation; ID unavailable; consumer/dispatcher restart; key rotation; stale/replayed/out-of-order event; and an already-open file/editor. Measure the last accepted grant/request and first refusal, rather than just checking an event was logged. Preserve unaffected organisations and later independent grants.

W1/W2 can land independently after review. W6 remains a mandatory production gate; it is not removed from scope because its mechanism needs decisions. A later implementer must return with the concrete lifecycle design and test evidence before adding new persistence or provider permissions.

## W7 — Euro-Office integration

Use the existing OpenCloud WOPI/app-provider mechanism. Configure the actual fork image by digest, discovery/editor endpoints, trusted file host, TLS/WebSocket/browser policy, and integration-specific secrets. Keep ID access tokens distinct from document tokens. No additional end-user login implementation is planned for DocumentServer.

Review the published module's disabled WOPI proof checks and development TLS defaults against the selected versions. Specify the supported authenticated trust mechanism before exposing the editor. Fix reproduced incompatibilities in the responsible fork; do not assume all deployments use identical WOPI/JWT settings.

Acceptance: file type coverage promised to customers, create/open/read-only/edit/collaborate/save/version/reopen, anonymous share policy, cross-customer denial, expired/tampered document token, removal of ACL while the document is open, and recovery from editor/network failure without lost/unauthorised writes. Record which team supports this community integration.

## W8 — provisioning, docs, release and rollback

Use existing ID administrative APIs and capability/assignment model. A new client registration is operational data, not a source-code edit. Keep consent visible until permissions are verified; `skipConsent` is a reviewed first-party convenience, not access approval. Test a new customer and an already-onboarded one.

Provisioning must read state before changes, use stable per-operation idempotency keys and ETags, preview permission changes, refuse wrong customer/environment, and distinguish an existing correct registration from conflicting immutable settings. Secret creation/rotation has one-time output; write it directly into the consuming service's approved secret store without logs. After a lost response, use an intentional recoverable rotation path; never expect replay to reveal it.

Choose the operational runner after W0. Existing `infra/ops` registers MCPs; it is not already a declarative customer-app fleet registrar. If reusing it, add a narrowly scoped app command/declaration and tests for rerun, failure after secret generation/storage, drift, stale revisions and accidental permission expansion. Do not hardcode every customer's client into unrelated MCP generation. Existing staff/API operations may serve the first controlled pilot; fleet rollout requires a reviewed repeatable runner, not hand-edited databases.

Before changes to infrastructure/pipelines, read `docs/12-deployment.md`, `infra/README.md` and applicable fork instructions. Use GitHub workflows/approved Jobs, least-privilege identities and existing secret custody. No laptop Terraform apply, Helm upgrade or agent-pushed release tags. The owner ships staging and production tags on the same eligible commit; preserve digest promotion and production approval.

Update ID public guides/OpenAPI, the actual fork integration/runbooks and a durable fork-patch inventory as part of each relevant change. Keep docs truthful about unsupported signup/native versions and remote logout; honour repository include/type-table/Markdown requirements. Before authoring a public docs page, read the documentation principles linked by AGENTS.md. Add newly read source paths to web build inputs if needed. No private-workspace version bump or changelog.

Rollout: disposable local proof → real staging customer/directory → internal dogfood → one opted-in existing customer after migration/lifecycle proof → small customer waves with recorded stop criteria. Keep old credentials/configuration only for the controlled rollback window, under the same secret policy; retire them intentionally after acceptance.

Rollback triggers include identity duplication/data loss, cross-customer admission, offboarding bound exceeded, refresh replay loops, discovery/key failures or document writes after permission loss. Stop the wave, prevent new sign-ins where needed, preserve evidence, and restore the known consumer/config version without undoing ID revocations. W1 is additive: an older ID rollback cannot administratively manage POST clients, so pin a compatible image or disable those clients before downgrade. Do not rewrite a POST client into Basic in the database. New schema, if any in W6, follows expand-then-contract.

## Verification and evidence gates

| Gate | Required proof |
| --- | --- |
| G0 Plan | User reviews the report before implementation. Fork identity/contract inputs pinned before dependent work. |
| G1 ID contract | Meaningful failing tests reproduce POST administration/CORS gaps; W1/W2 tests pass without altering protocol/security invariants. |
| G2 Browser consumer | Real pinned LibreChat and OpenCloud browser journeys work through actual discovery/callbacks and refuse missing permissions. |
| G3 API/native | Target, token class, tenant, scope and key checks hold; each supported native version and refresh fault test passes. |
| G4 Migration | Dry run, interruption, verified mapping, preserved ownership and rollback pass on representative data. |
| G5 Lifecycle | Independently measured upstream/local revocation and remote access satisfy existing E4 bounds, including outages/restarts/open editor. |
| G6 Deployment | Staging real-directory/ingress/key/secret-rotation evidence, rollout and rollback runbooks; other existing ID release gates remain satisfied or explicitly open. |

Verification commands (planned before coding; actual results are recorded in the implementation report):

- After ID changes, use the existing Postgres on 47432 and reset/migrate **only the guarded ID test database**, then run targeted relevant tests and the complete `bun --filter @answerable/id test:coverage` gate (100% line/function coverage). Do not replace it with token-only smoke tests.
- In `apps/id`, run `UPDATE_SNAPSHOT=1 bun test src/openapi.integration.test.ts`, then verify the generated snapshots with the normal gate. The variable must reach the test directly, not be stripped by Turborepo.
- Run the affected `@answerable/id-admin` suite. Run `bun run mcp:test` when its fake, shared registration or ops behaviour changes; use `bun mcp check`/`mcp:check` if an actual MCP/provider changes.
- Run root typecheck, lint and build, and `bun --filter web test` for the public contract/documentation changes. Use the single exclusive `bun run mcp:test:e2e` lane for acceptance changes.
- Run the actual fork's prescribed Go/frontend/server tests and integration lane. Commands cannot be frozen before reading its AGENTS/build instructions and version.
- Infrastructure changes require `infra:check` and the relevant `infra:test` gate. Run unused-code checks if code/dependencies are removed, as AGENTS requires.

At each gate retain the tested commit/image/config fingerprint, redacted registration/assignment identifiers, successful and refused cases, timings, migration reconciliation and rollback result. Record “not run” and why where appropriate. Never include bearer tokens, secret values, customer databases or raw private traces in reports.

## Proposed change sequence

1. **ID POST registration:** W1, its fake/tests, generated contract and relevant docs.
2. **Browser discovery:** W2 plus cross-origin browser proof.
3. **OpenCloud resource integration:** W3 after W0, including configuration round trip and mandatory API-contract tests.
4. **Real consumer lanes:** W4 for the agreed app/native versions, driven by each fork's pinned build.
5. **Migration and lifecycle:** separate reviewed W5/W6 designs/changes; do not hide these inside a login PR or skip them at release.
6. **Editor and operational rollout:** W7/W8, after the applicable acceptance gates.

No calendar estimate is credible until fork scope, existing account population and lifecycle mechanism are known. The first two packages are narrow, specified ID work; the full existing-customer release is broader and remains gated by the explicitly missing inputs.
