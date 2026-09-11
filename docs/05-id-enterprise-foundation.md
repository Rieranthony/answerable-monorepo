# Enterprise ID foundation

The F0–F7 contract governs the first Answerable ID release. T1–T5 implementation is integrated. [Final local acceptance](../reports/id-release-acceptance.md) records the candidate, checks and limits. The [release decision](../reports/answerable-id-release-decision-plan.md) remains **no-go for production** until the finite consumer/deployment requirements pass. No production deployment has occurred.

## 1. Scope and design rules

Use the existing native provider, policy evaluator, transaction journal and audit store. No second authorisation framework, generic workflow engine, speculative outbox or billing ledger is required. Reproduce a violation of an existing invariant before adding runtime changes. Physical product purge jobs and their duration are deferred.

The implemented foundation includes own-tenant SSO, verified identity linking, five-minute sensitive-human freshness, production code/refresh/consent, terminal product deletion, operational tooling and one initial migration. Wider product plans are labelled **Not yet** in [the build order](02-plan.md).

## 2. Tenant and identity boundaries

### Ownership model

Users are global; memberships, groups and assignments are tenant-owned. Clients/resources retain immutable instance identities and applicable ownership/classification. Platform authority comes from persisted system binding and explicit grants, not names. Display names can duplicate without joining security identities.

### Tenant administration and the global browser session

Human tenant authority requires the target tenant's own current SSO. A+B membership does not make A's authentication valid for B. Platform staff use their own platform SSO plus explicit platform authority for foreign administration; this grants no general OAuth resource-data bypass.

Browser sessions are global. Tenant APIs cannot enumerate/revoke them across organisations. Ordinary browser expiry/sign-out and administrative revocation are different actions; pre-existing refresh delegation can outlive sign-out.

### Membership lifecycle and admission

Admission requires a live user, current provider/account binding, effective membership and current policy. Explicit linking verifies fresh source and independent target proofs; no email merge, binding transfer or imported-identity adoption. Revoked membership is never silently restored by SSO.

Removal revokes the membership/grants and removes direct assignments in that tenant. Explicit reinstatement remains supported for an eligible revoked membership but restores neither assignments nor revoked grants. Product `deletedAt` is terminal, including for memberships.

### Database isolation

Service contexts and database predicates restrict administrative queries. Transaction-local RLS protects eleven tables, including memberships, invitations, routing configuration and audit history. Native broker transactions use protocol scope. Routing reads and audit inserts remain available without scope; audit-subject inserts remain trigger-owned. Scopes restore through savepoints, rollback and pool reuse. See the [current isolation inventory](../reports/answerable-id-isolation-inventory.md).

## 3. Immutable credentials and token policy

Public identifiers remain reserved after deletion; owner/configuration changes cannot adopt old credentials. Tokens bind immutable subject, tenant/client/resource instances and authorisation versions. User grant authentication provenance is immutable. Missing provenance cannot be inferred from a later session.

### One policy, explicit intersections

User permission intersects live identity/authentication, effective membership, registration and links, platform capability ceiling, matching assignments and requested scopes. Login requires a client-only approval; a resource grant requires its exact client/resource pair. Refresh requires a matching refresh ceiling. Machine permission uses its owner and machine ceiling; registration alone grants nothing.

Required truth table: A allows OmniChat→M365 and denies OpenCode→M365; B may independently approve OpenCode. Unrelated assignments cannot combine across tenant, principal or target. Scope narrowing cannot regain a removed scope or change tenant/audience. Access explanations describe current policy, not credential issuance.

### Provider integration proof

The actual `createAuth` composition exposes authorisation code, refresh and machine grants. A server-bound flow retains canonical request, selected membership, one grant and terminal consent state. Consent is explicit on each new flow unless configured first-party bypass applies. Native code/refresh consumption and cached replay recheck current policy.

Actual signed/opaque token outputs, persisted token/grant state and mandatory user outcome facts must agree before commit. Restricted-role production HTTP tests cover nonce/PKCE, flows, consent, policy changes, refresh, failures and concurrency. The separate public-JWKS acceptance test verifies signatures without using the issuer's claim-building helper as its oracle. Real consumer-library proof remains external.

## 4. Idempotency and concurrency contract

All 49 mutations require idempotency keys and expose operation/replay headers. Seven PATCH routes require If-Match; SSO and assignment replacement PUTs require current revision or expected absence. Keep actor, tenant, command, target and normalised input fixed when retrying.

- Before commit, interruption leaves no successful effect, fact or completed receipt.
- After commit, a lost response is recovered with the same key/input and current authority.
- Mismatched input conflicts; stale/missing revision fails without overwrite.
- A matching key never repeats later effects, even after enable/delete/replacement.
- Permanent reservations outlive response recovery. Expired secret ciphertext cannot rerun the command.
- Replays recheck current authority and required human freshness, including after lock waits.

Native client assertions remain consumed even when later issuance rolls back. Grant/security changes share deterministic lock ordering; revocation-first denies, while issuance-first retains the documented offline-token exposure. See [mutation inventory](../reports/answerable-id-mutation-inventory.md).

## 5. Durable audit evidence

Successful effects, audit events, durable subjects and command receipts share the transaction. Runtime cannot alter facts. Typed payloads retain allowlisted before/after policy and actual affected UUIDs. Observation is not an isolated causal delta or proof of remote delivery. A failed audit/subject write rolls back success; rejection-audit failure preserves denial and emits an operational signal.

Production user outcomes use version 4; machine issuance uses version 2. Unauthenticated attempt facts do not infer tenant/client identity from claims. Tenant client lifecycle history contains counts and a link to the restricted cross-tenant effect manifest.

### Erasure and identifying a person

Product deletion uses terminal `deletedAt` on 15 tables, ordinary read/eligibility denial and credential clearing/revocation. Retained rows may contain identifying fields: this is not anonymisation. UUID audit remains queryable with current authority. No named-identity recovery feature is required. Domain purge jobs and their retention duration are deferred; native protocol expiry and operational replay-cipher expiry remain active separate contracts.

Current user/organisation/group/client deletion facts use version 3; smaller product deletion facts and relationship/member removals use their documented versions. [T3's report](../reports/id-soft-deletion.md) defines exact manifests and reader compatibility.

## 6. Interruption, external effects and money

The local journal proves committed local commands. It does not prove downstream session termination, payment settlement or remote provisioning. No such subsystem is introduced here. When a required remote effect is implemented, its acknowledgement/retry semantics need their own concrete contract.

Recovery must preserve retained keys, reservations, receipts and revocation barriers. A snapshot can predate acknowledged changes. The bounded verifier checks only supplied facts; it cannot discover every missing acknowledgement or reconstruct source loss.

## 7. Enterprise and adversarial operation

The service must be reachable only through the ingress proxies listed in `TRUSTED_PROXY_CIDRS` (comma-separated IPv4/IPv6 networks). Network rules must refuse traffic that does not arrive through those proxies. The ingress supplies `x-forwarded-for`; Better Auth walks it from the right, skips listed proxies and selects the first untrusted address. The same resolver supplies rate-limit keys, session IPs and administrative/sign-in audit IPs. In production, unresolved addresses on `/auth/*` and `/api/admin/*` receive `403 {"error":"untrusted_ingress"}`, `Cache-Control: no-store` and a request ID before authentication, with no audit event. Health and readiness remain reachable. The header resolver cannot verify the socket peer; the network restriction is required.

Request/body, application admission, auth admission, pool and statement limits fail with documented retryable responses. Sensitive human changes/linking need verified upstream authentication within five minutes; broker time is not an acceptable substitute. Machine/root authority remains explicit.

Custody preflight, bounded replay-retention maintenance, fixed-cardinality process summaries and synthetic recovery are implemented. [T4 evidence](../reports/id-operations.md) discloses B OAuth refusal during shared saturation and one B read refusal during dense global deletion. No production capacity, tenant fairness, percentile latency, ingress or RTO/RPO is certified.

Upstream-disable detection, downstream logout and actual consumer cache/session behaviour remain release requirements. Their wider mechanisms are **Not yet**, rather than hidden behind a green local suite.

## 8. Implementation sequence and proof

| ID  | Current local contract                                                                    | Evidence and remaining condition                                                      |
| --- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| F0  | Actual native production flows and meaningful regression/fault proofs                     | T1/T2 reports and user OAuth suite; real provider/consumer journey outstanding.       |
| F1  | Immutable identity, reservations, system binding and token versions                       | Schema/HTTP identity tests; actual consumer interpretation outstanding.               |
| F2  | Durable UUID subjects, audit/effect/receipt atomicity, product tombstones                 | T3 restricted lifecycle/fault tests; external key custody/recovery remains.           |
| F3  | All 49 mutations, current-authority replay, revisions and crash proof                     | Route inventory and command/process tests; intended-environment recovery remains.     |
| F4  | Own-tenant SSO, deliberate linking, tenant-local lifecycle and eleven-table RLS           | T1/T2/T3 restricted A/B tests; real multi-provider acceptance remains.                |
| F5  | Shared exact-pair evaluator, scope narrowing and actual claim/audit binding               | Production code/refresh/machine and access tests; consumer denial matrix remains.     |
| F6  | Fresh sensitive authority, local revocation, bounded admission, custody/retention tooling | T1–T4 tests and measured limits; remote offboarding, capacity/ingress/custody remain. |
| F7  | Exactly one migration, installation/restore proof, reconciled docs and local gates        | Final report; production remains no-go until the external checklist closes.           |

Mandatory fixtures remain two unrelated tenants, shared A+B user, platform staff, private/shared resources, shared login client, separate machine clients, unowned external registration, disabled/revoked/expired rows and duplicate display names with distinct IDs. Apply each where relevant; do not generate a redundant Cartesian product. Include duplicate commands, both grant/revocation orders, process death, pool reuse and restored state.

## 9. Initial migration and recovery

ID has never shipped. Exactly one SQL migration, generated snapshot and journal entry replace the unshipped development chain. No legacy production conversion, backfill or mixed-version cutover is required. After first deployment, use ordinary forward migrations.

Empty/repeat/interrupted install, catalogue, bootstrap, runtime roles and synthetic fresh-cluster restore have proof in [T5](../reports/id-initial-migration.md). Intended-environment restoration and independent post-snapshot reconciliation remain necessary before traffic.

## 10. Documentation is part of completion

Design/schema, plan, READMEs, public guides, generated OpenAPI and inventories must describe the same candidate. Keep static HTML, Markdown URLs/content negotiation, llms indexes, navigation, anchors and guide/API links working. Public pages need titles, descriptions, British spelling and concise examples. Historical reports are evidence, not current installation instructions.

## 11. Decisions remaining before implementation release

Accepted: own-tenant trust, explicit verified linking, five-minute sensitive-human freshness, terminal product deletion, UUID attribution and deferred physical purge. Do not reopen these decisions or require a named-history feature.

The [single external checklist](../reports/answerable-id-release-decision-plan.md#external-input-and-test-checklist) identifies exact configuration, missing capabilities and proof needed for release. Passing local gates completes this repository acceptance slice, not the full production gate.
