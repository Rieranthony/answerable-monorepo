---
title: Enterprise ID foundation
description: Proposed tenant isolation, token identity, idempotency and audit contracts, with implementation and release gates.
---

# Enterprise ID foundation

> **TL;DR**
> - **Decides:** the proposed foundation changes before tenant self-service and user OAuth expansion.
> - **Rule:** authority is tenant-bound, identity is immutable, changes are repeat-safe, and audit evidence survives the live records it describes.
> - **Not here:** implemented behaviour, billing implementation, a general workflow engine or the rest of the fleet migration.

**Status: proposed implementation specification. Not yet implemented.** This supplements [the design](03-answerable-id.md) and adds a foundation gate to [the build order](02-plan.md). The [code review](../reports/answerable-id-feedback-review.md) and [executed probes](../reports/answerable-id-feedback-evidence.json) establish the initial defects. Proposed acceptance tests below are not claimed to pass today.

## 1. Scope and design rules

Keep one Bun/Hono service, Better Auth and PostgreSQL. Keep a shared schema and global user IDs. Add ordinary typed services, database constraints and a small operation journal. No separate policy service, event-sourced domain model, database per customer or workflow engine.

The foundation must establish these invariants:

1. A credential cannot gain authority because a name, owner or live database row changes.
2. Every tenant operation has one validated target tenant. Global/platform operations are explicitly different operations.
3. Removing access to A cannot reveal or revoke B's sessions, identity or permissions.
4. Successful upstream authentication cannot restore explicitly revoked tenant membership.
5. Tenant administrators assign only platform-approved capabilities. Registration never grants authority.
6. One logical administrative command has at most one committed effect. Retrying can recover its outcome.
7. A committed security change has a committed audit fact, including relevant prior state and actual local effects.
8. Person and tenant history do not depend on joins to rows that may be erased.
9. User grants remain evidence of that user's authentication; machine grants never impersonate a person.
10. Remote revocation has an explicit time bound. Local database deletion is never represented as proof that all remote access stopped.

**Evidence map:** the reviewed code already has transactions, route allowlists, composite membership/group foreign keys and effective windows. It lacks pair targets and operation replay. The probes reproduce client-token reassignment/revival, lost person-history retrieval, repeated rotation and missing token audit. Preserve the existing protections while addressing those gaps. See [schema](../apps/id/src/db/schema/authorization.ts), [principal resolution](../apps/id/src/http/principal.ts), [client services](../apps/id/src/services/clients.ts), [audit query](../apps/id/src/db/queries/audit.ts).

## 2. Tenant and identity boundaries

### Ownership model

| Record | Proposed boundary | Rule |
| --- | --- | --- |
| User and verified upstream account | Global identity, broker-managed | Stable user UUID; no email/name linking; no tenant-wide global directory search |
| Membership | Exactly one organisation and user | Stable membership UUID; explicit active/revoked state; effective window; no implicit reinstatement |
| Group, assignment and access ceiling | Exactly one organisation | Composite tenant foreign keys; tenant-prefixed indexes/uniqueness where relevant |
| OAuth client | Immutable owner organisation when owned; explicitly unowned public registrations allowed | Machine credentials require an owner; shared user-login clients remain usable only through tenant policy |
| Resource | Explicit platform-shared or tenant-owned classification | Ownership is distinct from permission to use; cross-tenant use of a private resource denied |
| Authorization/refresh context | Exactly one organisation, client and subject kind | Never infer tenant from mutable browser state at refresh |
| Audit and operation record | Durable tenant or explicit platform scope | No cascading deletion of evidence; no cross-tenant response replay |

A globally shared Circle client or public external tool does not make all its users part of the client's owner organisation. **Machine tenant comes from immutable ownership; user tenant comes from verified authentication plus an effective membership selected for that grant.** Each token carries exactly one tenant. A user's memberships are never merged into a multi-tenant token.

Use organisation UUIDs for authority, not slugs. The platform organisation is anchored by a persisted immutable system binding established at initial bootstrap. Changing its display name or configuration cannot designate another organisation as the platform. Reserve system resource/group identities. Bootstrap repairs only records whose immutable binding and expected owner match; otherwise fail with a specific conflict. Do not adopt an arbitrary existing record with the expected name.

### Tenant administration and the global browser session

Introduce a typed `TenantContext` created only after authentication and authorization. Tenant services and queries require it; accepting an optional organisation filter is not a tenant boundary. Platform-wide queries have separate names and require `PlatformContext`. Root is an explicit principal, never a missing-context fallback.

Tenant reads expose a member projection, not the complete global user/account record. Tenant administrators cannot erase the global user, enumerate other memberships or operate on another tenant's credentials. Platform authority remains separately scoped and audited; an `answerable` organisation claim is not a universal bypass in resource servers. Staff access to tenant data must pass an explicit support/platform rule for that target tenant.

**Fix existing session routes first.** `listMemberSessions` currently returns the user's global sessions, and `revokeMemberSessions` calls global revocation. Organisation disable also revokes by global user ID. Replace tenant session views with tenant authorization/delegation views. A global browser login can remain valid for B after A is revoked. Global sign-out/disable remains an explicit platform or user-owned operation. Do not use `sessions.active_organization_id` as proof that a global session belongs to A. [Current session services](../apps/id/src/services/sessions.ts), [organisation disable](../apps/id/src/services/organizations.ts).

Introduce durable tenant binding on authorization/refresh state before opening user grants: organisation ID, membership ID for users, immutable client ID, authentication evidence reference, grant purpose, resource and scopes. Prefer provider-owned state with declared server-only fields if it supports the required invariant; otherwise one Answerable `grant_contexts` table keyed by the provider's immutable grant/reference ID. Do not maintain two independently authoritative copies. Background delegation remains distinct from the browser session.

### Membership lifecycle and admission

Change tenant removal to revoke membership, preserving its identity and recording the actor/reason/time. Strip tenant-local group assignments and direct grants as specified by the command, and revoke A's authorization/refresh contexts. Reinstatement is explicit and does not restore old credentials or silently restore removed assignments.

Check revoked membership in federation resolution before the SSO plugin can provision it. Preserve a denial marker when erasing a membership while its user remains. Full global erasure removes identity linkage; a later upstream login is a new enrolment unless an explicitly retained admission block says otherwise. Document that distinction rather than promising erasure and indefinite identity recognition simultaneously.

Source-derived risk requiring a regression test: the installed SSO plugin creates a member when no row exists, while the current remove service deletes the row. Test valid SSO immediately after revocation/removal. [Federation resolver](../apps/id/src/services/federation.ts), [member removal](../apps/id/src/services/members.ts), installed `@better-auth/sso` 1.7.2 `assignOrganization`.

Preserve `(issuer, sub)` / `(tid, oid)` bindings and current fail-closed email collisions. A person can have multiple memberships without automatic linking of different upstream accounts. Explicit cross-provider linking would require proof of both identities and its own future design; this change does not introduce it.

### Database isolation

Retain shared PostgreSQL tables. Inventory every tenant table, query, unique key, foreign key and cascade. Enforce same-tenant relationships at the database and service layers; test reads, aggregates, exports and error responses as well as writes. Normalise inaccessible foreign references to non-disclosing errors. Global uniqueness checks must not reveal another tenant's record details.

Use separate migration and runtime database roles. The runtime role is not a superuser/table owner and cannot alter schema or update/delete audit facts. Add targeted row-level security to Answerable-owned tenant configuration tables (`groups`, `group_members`, entitlements and new access ceilings), using transaction-local validated tenant/platform context. Missing context denies access; no session-level context that can leak through a pooled connection. Test broker/policy reads and bootstrap with explicit narrow context, including pool reuse, rollback and concurrent tenants.

Do not blanket-enable RLS on Better Auth's global/session/federation tables and hope its queries work. Their broker access remains an explicit reviewed boundary. Initial implementation must prove the targeted coverage against the installed adapter; any table excluded must be named with its service/constraint isolation tests. RLS guards missing filters, not compromised application code capable of choosing trusted context. PostgreSQL owners and `BYPASSRLS` roles have special bypass behaviour, so tests must use the production runtime role. [PostgreSQL 16 RLS](https://www.postgresql.org/docs/16/ddl-rowsecurity.html).

## 3. Immutable credentials and token policy

**Decision: remove in-place client ownership transfer.** A move creates a new client/credential under the new owner and retires the old client. Public `client_id` values and security-sensitive resource identifiers are permanently reserved after retirement. Use a small identifier-reservation table if hard deletion is retained; do not preserve secret-bearing client rows merely to reserve a name. Existing mutable-owner API becomes a documented conflict/deprecated operation, not an alias that silently transfers authority.

Every access token must bind issuer, audience, token type, expiry, public client ID, immutable client instance ID, organisation UUID and subject kind. User tokens also bind the user/membership and authenticated grant context. Define claim names once in the shared verifier contract. Machine tokens have no user subject. Treat slugs and display fields as descriptive.

Add a client authorization version. Increment it for retirement, disable and explicit revoke-all; secret rotation revokes the previous version by default. Re-enable never revives old tokens. The admin API checks current owner, immutable instance, version, client-resource compatibility, active organisation and current scope ceiling. **Requiring the new claims is intentional:** reject pre-foundation tokens and reissue machine credentials/tokens during cutover. Do not provide a legacy acceptance path that preserves the reproduced defect.

The shared resource verifier checks signed tenant identity and local tenant routing, including resources shared across tenants. A shared audience is not a shared data namespace. Local offline verification cannot observe version changes immediately: short lifetimes bound remote access, while the admin API performs online current-state checks. Any resource requiring immediate revocation must use a defined online check or acknowledged invalidation mechanism. State this limitation explicitly. JWT validation follows the established issuer/audience/type rules. [RFC 9068](https://www.rfc-editor.org/rfc/rfc9068.html).

### One policy, explicit intersections

Introduce a platform-managed `organization_capabilities` table: the maximum targets, grant types and scopes available to an organisation. Entitlements become assignments beneath that ceiling. Tenant admins may narrow/add assignments only within it; they cannot alter the ceiling, global catalog, client ownership or platform scopes. Removing a ceiling immediately makes dependent assignments ineffective, even if they remain as historical/configuration rows.

Support three target shapes:

| Shape | Meaning | Required fields |
| --- | --- | --- |
| Client only | User may sign into/use this application | `clientId`, no resource |
| Client + resource | User may obtain a token for this resource through this client | Both fields; exact pair, no wildcard |
| Resource only | Direct session administration of the reserved ID admin resource | Reserved admin resource only; cannot mean unrestricted OAuth resource access |

Resource-only grants outside the reserved admin surface must be explicitly converted to approved pairs before user OAuth opens. They are not silently expanded to every linked client. A resource-only administration permission must never satisfy a user OAuth resource request.

Within one exact target and tenant, assignments from organisation/group/member are additive, with effective windows. Across different targets/tenants, scopes never combine. No deny-precedence language. Tenant restrictions are represented by the available exact pairs and assignment removal. This solves “OmniChat → Microsoft 365 allowed; OpenCode → Microsoft 365 denied” without modelling arbitrary graphs.

Client-only scopes describe application login; they are not resource scopes. The client-login assignment is an admission check when evaluating a resource request, not another unrelated scope set to union into that token. Resource scope ceilings and pair assignments decide the resource token's scopes.

For user resource requests require: active user + effective member + allowed client-login assignment + compatible client/resource + platform tenant ceiling + matching pair assignment + consent/protocol evidence. Effective scopes are the intersection of requested scopes, client ceiling, resource scope vocabulary, tenant capability scopes and applicable assignment scopes. For machine grants substitute immutable owner/client credentials and the machine-specific tenant capability for user membership/assignment. Grant types are explicitly allowed by the capability; refresh re-evaluates the original tenant/pair and cannot switch tenants or widen authority.

For direct admin sessions preserve the six current scopes through reserved admin capabilities. Platform-only scopes can only be delegated from platform-managed ceilings/bindings; tenant assignment APIs cannot bootstrap their own privilege. Define whether a caller may delegate each admin scope and protect the last effective platform administrator.

Return a structured internal policy decision: allowed/denied, reason, tenant, client, resource, granted scopes, contributing capability/entitlement IDs and policy version. Reuse it for issuance, access views and audit evidence. Keep public denial information deliberately limited.

### Provider integration proof

Before depending on hooks, write a focused integration test proving that the installed Better Auth plugin exposes the **authenticated** client and grant context, supports rejection before usable token release, and allows grant state/audit to commit consistently. Its `customAccessTokenClaims` signature alone is insufficient: it exposes user/reference/scopes/resources/metadata, not a verified client and transaction handle. Client-supplied metadata is never an authority source.

Use supported custom plugin hooks and the transaction-bound adapter; never edit `node_modules` or hand-roll OAuth cryptography. If the seam cannot provide the guarantees, keep the affected grant closed and specify the smallest supported adapter/upstream extension. This is an implementation gate with a concrete proof, not a reason to redesign the entire provider.

## 4. Idempotency and concurrency contract

**Decision: a PostgreSQL operation journal for administrative mutations.** `x-request-id` stays per-attempt correlation. `Idempotency-Key` identifies the logical command. Require it on supported write/erase routes after a documented API transition; do not apply generic response replay to OAuth authorization codes or refresh rotation.

An `admin_operations` row holds immutable operation ID, actor instance, tenant/platform scope, operation name, key digest, canonical request fingerprint, outcome/status, result reference, timestamps and replay expiry. A unique constraint on actor instance + authority scope + operation name + key digest arbitrates concurrent duplicates. Target IDs and all semantic fields belong in the fingerprint, so reusing the same key for a different target conflicts. Canonicalise validated values, including default values, dates, scope-set order, and omitted versus explicit-null semantics; exclude request ID and transport noise.

Provide an operation-status read by immutable operation ID, scoped to the same actor/tenant or explicit platform audit authority. It reports committed/no-op/failed status, result references and replay availability without exposing secret values. Errors have stable codes and an explicit retry classification; clients do not guess from HTTP 409 alone.

The transaction reserves the key, locks relevant state, rechecks current authority, performs the mutation, inserts audit facts, stores the result and commits. No network call occurs inside that transaction. A competing duplicate waits only to a bounded lock timeout and then receives a documented retryable response; a crashed uncommitted request rolls back its reservation and changes together. A committed request whose HTTP response was lost is replayed from the journal. Do not leave a permanently committed `running` row for a single-transaction operation.

| Situation | Proposed response |
| --- | --- |
| Same key, same validated input, still authorised | Original status/body or documented result representation; replay indicator; no second domain effect |
| Same key, different input/target | 409 `idempotency_key_reused` |
| Concurrent original still executing | 409 `operation_in_progress` with retry guidance |
| Desired state already reached under a new key | 200/204 with a recorded no-op outcome, rather than an “already disabled” error |
| Existing entity has a different owner/identity | 409 `ownership_conflict`; never adopt it |
| Stale revision on a configuration patch | 412 `revision_mismatch` |
| Replay payload expired | 410 `operation_result_expired`; result reference where permitted; never rerun the effect |
| Database/dependency failure before commit | Retryable 503; no successful operation/audit fact |

Authorize before replay and scope errors so other actors/tenants cannot discover stored outcomes. Revoked callers cannot recover secrets. For deletion replay, use retained operation/subject identity rather than requiring the deleted live row. Record HTTP attempts separately from the single domain operation; an `admin.root_request` remains an admission event, not proof that the mutation succeeded.

**Replay retention proposal:** ordinary response payloads seven days; secret-bearing payloads at most 24 hours, encrypted using a dedicated versioned key outside PostgreSQL. Retain a minimal completed-key/fingerprint/result-ID reservation after payload purge so an old key never executes again. No token, password or plaintext secret in audit JSON. A lost secret after its recovery window requires a new deliberate rotation, not replay of the original command. Purging operation reservations is a contract change and must not happen in a generic cleanup job. Volumes are administrative, not one operation row per API read or inference token.

Add numeric revisions to mutable configuration. Require `If-Match` for patch/replace operations where stale writes can silently overwrite newer configuration; evaluate replay before stale-revision checks for an already committed identical request. Row locks serialize local mutations but do not replace client-visible concurrency preconditions.

Use a consistent lock order for global user, organisation, client/resource, membership and assignment rows. Recheck authorization inside the transaction that mutates security state; a middleware decision from before revocation is insufficient. Start with organisation-level serialization of tenant security changes, short bounded transactions and indexed queries. Do not hold an organisation lock over all token signing work without measuring it; use a common shared/exclusive locking or revision-validation protocol so issuance and revocation have a tested commit order.

Exactly-once HTTP delivery is not promised. The contract is **one committed local effect per retained logical operation key, recoverable results, and explicit retry rules**. HTTP method idempotence alone does not provide this result-recovery contract. [HTTP semantics](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2).

## 5. Durable audit evidence

Keep mutable domain tables and append-only audit facts; do not rebuild the product from an event stream.

Extend `audit_events` with a versioned envelope: operation ID, actor kind and immutable ID, durable tenant/platform scope, action, target type/ID, outcome/reason, trusted occurrence time, request correlation and policy version. Remove the tenant FK behaviour that nulls historical attribution. Store a durable tenant UUID independent of live organisation existence; the writer validates it at event creation.

Add `audit_event_subjects(event_id, entity_type, entity_id, relationship, organisation_id)` for related users, members, clients and affected entities. These references do not cascade with live records. Index by tenant/entity/time. A person-history query uses those references, never current membership joins. An erased UUID with retained events is queryable by an authorised auditor; an unknown UUID returns an empty history or the documented historical-subject response.

Use typed event payloads with allowlisted before/after values, actor intent and actual effects. Capture effective access before revocation: target pairs, scopes, grant source IDs, membership/group windows and the policy version used. Include actual revoked grant/session IDs and counts. Large manifests become multiple bounded audit effect records linked to the same operation, inserted in the same transaction; never silently truncate evidence. Secrets, bearer tokens, upstream refresh tokens and raw provider configuration are excluded.

Distinguish `applied`, `noop`, `denied`, `failed` and `pending external delivery` meanings rather than labelling every request successful. A no-op has its own operation outcome but no fabricated change. If audit insertion fails, a local security mutation and any token/grant state must not commit or become usable. Authentication/provider hooks require their own transaction/failure tests; current service transaction tests do not prove hook atomicity.

Log every reachable token grant outcome with immutable client/tenant/subject/resource/scopes and decision reason. Store token identifier/digest only if necessary for correlation, never the token. A successful audit record means the grant committed, not that the network response reached the caller. A crash after commit remains explainable. Failed-attempt audit outages emit an operational failure signal while authorization remains denied; do not allow an audit outage to turn a denial into success.

### Erasure and identifying a person

Permanent UUID correlation is mandatory. A restricted encrypted identity record is the recommended additional capability if auditors must recover a person's name/upstream identity after operational erasure. Keep it separate from ordinary audit facts and tenant-visible projections, with separate read permission, audited access, an explicit retention period and actual deletion/key lifecycle. Do not copy identifying fields into every immutable event.

**Product decision before real erasure:** choose UUID-only history or the restricted identity record, and set its retention duration. The user has been asked; planning does not assume an answer. Until configured, the erase API must not promise both full identity removal and indefinite named attribution. Tenant erasure affects tenant-local identity evidence; global identity erasure remains platform-controlled and accounts for other memberships.

Enforce append-only application permissions through the runtime DB role. Retention maintenance uses a separate narrowly privileged path and is audited. Backups and a restore rehearsal belong to release readiness. External immutable audit export can be added when an operational/compliance consumer requires it; application append-only permissions alone are not a tamper-proof archive.

## 6. Interruption, external effects and money

Single-database commands use the journal and transaction above. Restarting requires no checkpoint engine because either the command committed or it did not.

For a large offboarding operation, first commit the authoritative tenant/user denial barrier, operation identity and bounded access-evidence snapshot using a consistent revision/locking strategy. Cleanup cannot re-enable access. If its size requires batching, persist one operation-specific cursor, deterministic item keys and completion state; restart from that cursor. Only report completion after every required local effect and evidence item is reconciled. Set explicit size/timeout limits in the first implementation; never silently process only the first page.

At the first implemented external effect (for example back-channel logout), add one transactional outbox table and a small PostgreSQL worker. Commit intent with the domain operation; deliver at least once with a stable effect ID, bounded retries, lease expiry and redelivery after crashes. Consumers deduplicate that ID. “Delivered” and “acknowledged” are distinct; an outbox does not provide exactly-once remote execution. No DBOS/BullMQ/Kafka dependency is required for this foundation.

No money ledger is built in ID now. The architecture rule is that money-bearing operations live with the owning product's ledger and use a unique business-operation key atomically with local balance/access changes. Remote charges need provider idempotency and reconciliation; never hold a database transaction around a payment request. ID grants identity/access, not financial truth. A future billing-to-access integration must use durable idempotent events, not a naked HTTP callback that retries a grant blindly.

## 7. Enterprise and adversarial operation

Address concrete surfaces before public tenant writes:

- Keep the Better Auth allowlist and generated per-route negative tests. Extend route metadata with tenant/platform authority, replay policy, concurrency precondition and expected audit outcome; fail inventory tests when a mutation omits them.
- Domain claims remain platform-managed until proof-of-control verification exists. Bind challenges to tenant/domain/operation with expiry and single-use consumption; prevent races and same-name adoption. Prove SSO issuer/domain ownership before activation. Provider changes invalidate affected authentication/grant contexts.
- Implement bounded request sizes, pagination, execution/lock timeouts and tenant/client/IP rate limits for relevant public routes. Use trusted ingress-derived IPs; caller-supplied forwarding/request headers are not trusted audit identity. Tenant quotas must prevent a noisy tenant exhausting the shared pool. Rate-limit storage must match the number of replicas; do not claim cluster limits from process memory.
- Encrypt persisted upstream OAuth tokens before real logins, as already required by the schema document. Cover encryption key rotation, backup restore and secret replay custody; retain the separate signing-key milestone.
- Audit privilege, SSO, credential and erasure changes. Require fresh authentication for human high-impact operations with a documented freshness bound; machines require explicit scopes. Confirmation text is an intent check, not authentication or authorization.
- Publish metrics for failed audit writes, rejected grants after revocation, tenant denial spikes, operation conflicts/timeouts, pool saturation and unfinished external effects. Test failure recovery and restore, not only happy-path uptime.

No claim of resisting every AI-driven attack follows from these controls. Automated callers and attackers exercise the same bounded interfaces; authorization, tenant isolation and replay rules must hold regardless of who generates requests. OAuth protections remain grounded in [the OAuth security BCP](https://www.rfc-editor.org/rfc/rfc9700.html).

## 8. Implementation sequence and proof

Deliver reviewable slices. Start each behaviour change with a failing test; update its documentation in the same slice. Do not open another grant type or tenant mutation surface midway through the foundation.

| Slice | Work and main files | Required evidence |
| --- | --- | --- |
| F0 | Promote report probes to regression tests; add tenant session/offboarding/SSO rejoin tests; provider integration proof in `auth/*` | Reproduce each defect; demonstrate authenticated grant context and transaction boundary using the installed provider |
| F1 | Immutable client/system bindings, reserved identifiers, token claim/version verification; `bootstrap`, client services/schema, principal middleware | Old tokens fail after disable/re-enable, retirement, attempted transfer and client-ID reuse; wrong instance/owner/version/resource denied |
| F2 | Durable audit envelope/subjects and operation journal primitives; DB roles and migrations | Audit survives erasure; local effect+audit+journal rollback/commit together; runtime role cannot alter audit facts |
| F3 | Apply replay/revisions to every admin mutation; first client creation/rotation, then all route families | Concurrent duplicate, mismatched payload, stale revision, response loss, expired secret recovery, actor/tenant isolation, deletion replay |
| F4 | Tenant contexts, revoked memberships, tenant grant contexts, scoped session APIs, targeted RLS | A/B shared-user tests; A cannot read/revoke B; SSO cannot restore revoked A; pool context cannot leak; global disable remains explicit |
| F5 | Capability ceiling, paired assignments, grant evaluator and truthful access views | Pair truth table; scope/tenant intersections; tenant self-escalation denied; policy and audit match; removed ceiling denies renewal |
| F6 | Complete token/auth audit hooks, bounded offboarding, public-route limits and key/retention readiness | No usable token without committed decision evidence; grant-vs-revocation races; interrupted cleanup resumes; audit/DB outages fail closed |
| F7 | Migration rehearsal, public contract/docs, production-role tests, review and release gate | All foundation acceptance tests and repository gates pass; no unresolved data conversion/retention/integration blocker |

F1 has its necessary minimal audit assertions; F2 standardises the full envelope. F0 must prove the integration seam before F1 relies on it. F4/F5 are completed before tenant self-service or user OAuth is enabled. Outbox delivery and ledger rules become implementation gates when their first consumers ship, not speculative infrastructure in F2.

**Mandatory scenario matrix:** two unrelated tenants; one shared user with A+B memberships; staff with platform authority; tenant-owned and shared resources; a shared user-login client; separate machine clients; unowned external registration; disabled/revoked/expired entities; same display name with different immutable IDs. Run each against service and HTTP boundaries, with raw SQL constraint tests where applicable. Include concurrent grant/revoke, duplicate commands, process termination before/after commit, pool reuse and restored database state.

Run the repository gates: root `bun run typecheck`, `bun run lint`, `bun run build`, `bun --filter web test`, `bun --filter @answerable/id test:coverage` after disposable test migrations. Update the catalog/migration snapshots deliberately. Coverage remains required, but the above invariants and fault tests define correctness.

## 9. Migration and rollback

Use additive migrations first: durable audit tenant/subject fields, operation journal, immutable system/identifier bindings, membership status, configuration revisions, capability ceilings and tenant grant context. Add appropriate tenant indexes and composite constraints. New required token claims are a deliberate token compatibility boundary.

Before backfill, inventory actual deployed data and consumers; do not infer production emptiness from this repository. Build a report of ambiguous system bindings, client owners, resource classification, unknown grant tenants and resource-only entitlements. Fail closed on ambiguity; never guess a tenant from email, slug, active session or another tenant's data.

Backfill only provable historical audit references, marking legacy incomplete records explicitly. Lost old values cannot be invented. Preserve source event IDs. Existing admin grants get explicit equivalent platform ceilings/assignments. Other resource-only rows require a reviewed pair mapping; legacy unbound user grant state is revoked/re-authenticated rather than guessed.

Use a maintenance window for the first authority-model cutover if production traffic exists; complexity of mixed-version authorization is unnecessary here. Take a backup and rehearse restore first. Drain old issuers, expire/revoke old tokens, deploy schema/backfill and strict consumers, then reopen grants. Client-ID retirement reservations, operation keys and revocation barriers must survive rollback/restore. A rollback must never resume acceptance of an unsafe old token or erase a committed command receipt. If a restored backup predates revocation/operation evidence, rotate signing/credential epochs and reconcile commands before resuming writes; prefer roll-forward over blind replay.

Do not drop old columns until migration evidence and consumer compatibility are checked. Do not promise a zero-downtime rollback across an intentionally incompatible credential boundary.

## 10. Documentation is part of completion

Each slice updates facts only when implemented. Until then use “Not yet.” and link this specification. The report remains historical evidence, not the current reference.

| Document | Required update |
| --- | --- |
| `docs/03-answerable-id.md` | Token/tenant ownership, immutable client moves, paired policy, operation/audit guarantees, global versus tenant lifecycle; reconcile inherited Node/CDN wording with existing Bun/no-CDN decisions |
| `docs/04-answerable-id-schema.md` | Actual tables, ownership, constraints, cascade changes, audit subject references, revisions and operation retention; implemented/deferred distinction |
| `docs/02-plan.md` | Foundation slice status, release gates, resolved decisions; do not mark a slice complete before tests/docs land |
| Root and `apps/id/README.md` | Actual shipped capability, bootstrap binding, runtime roles/keys, reset/recovery commands and compatibility changes |
| `apps/web/content/docs/id/manage.mdx`, `onboard.mdx`, `sign-in.mdx`, `index.mdx` | Tenant-local lifecycle, verified enrolment, replay/error semantics and shipped boundaries |
| New public guides when implemented | Idempotent administration, access policy, audit/erasure and tenant lifecycle; cURL examples first, error/action tables, migration and recovery examples |
| Generated OpenAPI | Header requirements, stable problem codes, response replay/revision semantics, route metadata; regenerate with `openapi:export`, never hand-edit snapshots |
| Runbooks | Failed/unknown operation recovery, lost secret, key rotation, tenant offboarding, audit outage, backup restore and compatibility cutover |

For public documentation, read [the repository documentation principles](../AGENTS.md) and [Lee Robinson's guidance](https://leerob.com/docs). Preserve existing anchors and check inbound links. Add title/description, British spelling and bidirectional guide/API links. Keep static rendering, Markdown URLs/content negotiation, `/llms.txt`, `/llms-full.txt`, navigation and mobile accessibility working. A slice is incomplete when code and published behaviour disagree.

## 11. Decisions remaining before implementation release

The architectural defaults above are concrete proposals, not a menu of competing stacks. Remaining checks are bounded:

- **Product:** UUID-only erasure history versus restricted identifying evidence, and its retention duration. This gates real erasure, not writing the plan.
- **Integration:** prove verified provider context and atomic grant/audit behaviour with the installed version; prove targeted RLS adapter boundaries. A failed proof keeps the affected capability closed.
- **Deployment:** inventory actual production state/consumers; choose concrete limiter capacity, transaction/operation size limits, retention maintenance and recovery objectives from that deployment. Rehearse them before cutover.

The foundation is complete when the invariants have executable evidence and the relevant documentation matches the implementation. It is not complete merely because new tables exist or line coverage is 100%.
