# Enterprise foundation execution

**Goal:** implement [F0–F7](docs/05-id-enterprise-foundation.md#8-implementation-sequence-and-proof) in full, with clean tested code and current documentation. Execution is coordinated through [the six-task handoff](reports/id-completion-coordination.md); tenant-trust and deletion decisions are now settled, while deployment evidence remains outstanding; the full F0–F7 objective is unchanged and unfinished. No production cutover or complete release readiness is claimed.

This is the current checklist. Detailed requirements remain in the foundation specification; the [release sequence](reports/answerable-id-release-decision-plan.md#current-completion-plan) orders the remaining work. Completed experiments, failed runs and limits belong in the [execution evidence](reports/answerable-id-foundation-execution-plan.md) and [progress log](progress.md). Previous task notes are preserved in [history](reports/answerable-id-task-history.md), including their superseded status claims.

## Current sequence

1. Administrative denial-audit fix verified: all repository gates and the synthetic restore pass. This slice is closed; proceed to the existing production-flow requirements below.
2. The approved policy requires own-tenant SSO and explicit verified identity binding. The native consent probe also requires one stable server-bound flow reference; see [the integration contract](reports/answerable-id-release-decision-plan.md#interactive-consent-contract-for-the-next-integration). Complete tenant authentication and production user OAuth against the existing acceptance contract. The production allowlist still accepts only `client_credentials`; the native user-grant fixture is not production integration. Consume the approved authentication and soft-deletion contracts before integrating grant admission.
3. Implement deletedAt-based product deletion, exclusion from ordinary reads/authority, and remaining audit/lifecycle requirements. Audit attribution is UUID-based; physical cleanup jobs and their retention duration are deferred. Preserve local transactional audit and replay guarantees.
4. Establish supported deployment capacity and complete fresh-install, recovery and first-consumer evidence. Local synthetic tests do not certify production limits or recovery.
5. **Final cleanup requested by the user:** this platform has never shipped to production. Once implementation is finished, replace the entire development migration chain with exactly one initial migration and matching Drizzle snapshot/journal. Preserve all final constraints, indexes, triggers, functions, RLS and privileges. Remove obsolete upgrade-only code/tests and update documentation. Verify an empty-database install, repeated migration/startup, schema consistency, runtime permissions, restore and all repository gates before calling the cleanup complete.

Do not add opportunistic hardening to the release scope. Record new findings in the backlog unless they reproduce a violation of an existing release invariant. Each completed sequence requires applicable repository gates and first-principles review: delete unnecessary pieces, simplify what remains, optimise only demonstrated problems. If no change improves the implementation, leave it alone.

## Acceptance status

No F0–F7 item is marked complete solely from green coverage or a native test fixture.

| Contract | Implemented evidence | Required completion evidence still open |
| --- | --- | --- |
| F0: regression and provider proof | Native code/refresh, revocation, restricted-role and process-interruption proofs | Complete production journeys and the mandatory scenario matrix |
| F1: stable identity | Immutable identities, reserved identifiers, system bindings and machine claim/version checks | Fresh-install migration and consumer compatibility |
| F2: durable audit and journal | UUID subjects, append-only runtime permissions, atomic local effects/audit/receipts | Complete required effect coverage and chosen identity retention/key custody |
| F3: repeat-safe administration | All 49 administrative mutations journalled; replay, revision, concurrency and crash proofs | Preserve the reconciled route/effect inventory; first-release replay and recovery remain to prove |
| F4: tenant boundaries | Scoped contexts, revoked memberships, grant contexts and five-table RLS, including restricted native grant proof | Accepted SSO origin, production grant admission and remaining broker boundary acceptance |
| F5: shared permission decisions | Capabilities, exact pairs, common calculations and machine issuance decision binding | Production user decision/claim/audit binding and remaining acceptance scenarios |
| F6: operational security | Machine outcome auditing, local lifecycle manifests, request/database/admission bounds, upstream token custody | Production user outcomes, fresh human authentication, supported capacity/ingress, complete lifecycle and operational evidence |
| F7: release gate | Local repository gates and synthetic fresh-cluster restore | One consolidated initial migration, representative recovery, post-snapshot reconciliation, production key/retention readiness and real tenant/consumer validation |

## Explicit dependencies

- **Tenant trust — decided:** require the selected tenant's own current SSO, with deliberate verified binding of multiple upstream identities to one global user. Membership alone does not confer authentication trust.
- **Deletion/history — decided:** soft deletion through `deletedAt`, UUID-based audit attribution, and physical cleanup jobs later at a separately chosen age. Retained rows are not anonymised; they must be inaccessible through ordinary reads and must confer no authority. No named-recovery feature or purge-duration approval is needed to complete this release.
- **Deployment evidence:** actual topology, budgets, key custody, consumer behaviour and recovery requirements must be verified against the intended environment. No production database changes are authorised by a passing local rehearsal alone.

## Current verification

The current full ID run passes 1,890 tests with zero failures, 25,378 assertions and 100% line/function coverage (`/private/tmp/id-denial-audit-full.log`). Typecheck, lint, 62 web tests, both uncached builds and the synthetic restore pass. See [the execution evidence](reports/answerable-id-foundation-execution-plan.md#administrative-denial-audit-outage-behaviour) for logs and scope. These results prove the scenarios they exercise, not completion of the table above.

The user confirms that ID has never shipped to production. The development migration chain through 0046 is temporary and will be consolidated at the end; deployed legacy-data conversion and a production maintenance cutover are not prerequisites for this first release. Public user OAuth remains closed.
