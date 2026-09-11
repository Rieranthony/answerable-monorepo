# Enterprise foundation execution

**Goal:** implement [F0–F7](docs/05-id-enterprise-foundation.md#8-implementation-sequence-and-proof) in full, with clean tested code and current documentation. Execution is coordinated through [the six-task handoff](reports/id-completion-coordination.md); tenant-trust and deletion decisions are now settled, while deployment evidence remains outstanding; the full F0–F7 objective is unchanged and unfinished. No production cutover or complete release readiness is claimed.

This is the current checklist. Detailed requirements remain in the foundation specification; the [release sequence](reports/answerable-id-release-decision-plan.md#current-completion-plan) orders the remaining work. Completed experiments, failed runs and limits belong in the [execution evidence](reports/answerable-id-foundation-execution-plan.md) and [progress log](progress.md). Previous task notes are preserved in [history](reports/answerable-id-task-history.md), including their superseded status claims.

## Current sequence

1. Administrative denial-audit fix verified: all repository gates and the synthetic restore pass. This slice is closed; proceed to the existing production-flow requirements below.
2. The approved policy requires own-tenant SSO and explicit verified identity binding. The native consent probe also requires one stable server-bound flow reference; see [the integration contract](reports/answerable-id-release-decision-plan.md#interactive-consent-contract-for-the-next-integration). Complete tenant authentication and production user OAuth against the existing acceptance contract. The production allowlist still accepts only `client_credentials`; the native user-grant fixture is not production integration. Consume the approved authentication and soft-deletion contracts before integrating grant admission.
3. Implement deletedAt-based product deletion, exclusion from ordinary reads/authority, and remaining audit/lifecycle requirements. Audit attribution is UUID-based; physical cleanup jobs and their retention duration are deferred. Preserve local transactional audit and replay guarantees.
4. Establish supported deployment capacity and complete fresh-install, recovery and first-consumer evidence. Local synthetic tests do not certify production limits or recovery.
5. **Initial migration cleanup complete:** the frozen T1–T4 schema now has exactly one initial migration, generated snapshot and journal entry. Custom database objects match the old final catalogue; upgrade-only code/tests are removed. Empty-install/interruption/retry/bootstrap proofs, all repository gates and the T4 restore pass. See [the consolidation evidence](reports/id-initial-migration.md).

Do not add opportunistic hardening to the release scope. Record new findings in the backlog unless they reproduce a violation of an existing release invariant. Each completed sequence requires applicable repository gates and first-principles review: delete unnecessary pieces, simplify what remains, optimise only demonstrated problems. If no change improves the implementation, leave it alone.

## Acceptance status

No F0–F7 item is marked complete solely from green coverage or a native test fixture.

| Contract                          | Implemented evidence                                                                                             | Required completion evidence still open                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| F0: regression and provider proof | Native code/refresh, revocation, restricted-role and process-interruption proofs                                 | Complete production journeys and the mandatory scenario matrix                                                                |
| F1: stable identity               | Immutable identities, reserved identifiers, system bindings and machine claim/version checks                     | Consumer compatibility                                                                                                        |
| F2: durable audit and journal     | UUID subjects, append-only runtime permissions, atomic local effects/audit/receipts                              | Complete required effect coverage and chosen identity retention/key custody                                                   |
| F3: repeat-safe administration    | All 49 administrative mutations journalled; replay, revision, concurrency and crash proofs                       | Preserve the reconciled route/effect inventory; first-release replay and recovery remain to prove                             |
| F4: tenant boundaries             | Scoped contexts, revoked memberships, grant contexts and five-table RLS, including restricted native grant proof | Accepted SSO origin, production grant admission and remaining broker boundary acceptance                                      |
| F5: shared permission decisions   | Capabilities, exact pairs, common calculations and machine issuance decision binding                             | Production user decision/claim/audit binding and remaining acceptance scenarios                                               |
| F6: operational security          | Machine outcome auditing, local lifecycle manifests, request/database/admission bounds, upstream token custody   | Production user outcomes, fresh human authentication, supported capacity/ingress, complete lifecycle and operational evidence |
| F7: release gate                  | One initial migration, repository gates and synthetic fresh-cluster restore/reconciliation                       | Representative recovery, post-snapshot reconciliation, production key/retention readiness and real tenant/consumer validation |

## Explicit dependencies

- **Tenant trust — decided:** require the selected tenant's own current SSO, with deliberate verified binding of multiple upstream identities to one global user. Membership alone does not confer authentication trust.
- **Deletion/history — decided:** soft deletion through `deletedAt`, UUID-based audit attribution, and physical cleanup jobs later at a separately chosen age. Retained rows are not anonymised; they must be inaccessible through ordinary reads and must confer no authority. No named-recovery feature or purge-duration approval is needed to complete this release.
- **Deployment evidence:** actual topology, budgets, key custody, consumer behaviour and recovery requirements must be verified against the intended environment. No production database changes are authorised by a passing local rehearsal alone.

## Current verification

The frozen T1–T4 integration and migration consolidation pass 2,027 ID tests with zero failures, 29,829 assertions and 100% line/function coverage. Root typecheck, lint, both uncached builds, 71 web tests, five country tests, migration interruption/retry and T4 synthetic fresh-cluster restore/reconciliation pass. See [the consolidation record](reports/id-initial-migration.md) for raw logs and limits. T6 owns final cross-contract documentation and release reconciliation; the older implementation-status rows above must be read with the integrated T1–T4 reports.

ID has never shipped to production. New installations use the single initial baseline. Legacy production conversion and maintenance cutover are not first-release prerequisites. The remaining deployment, consumer and operational inputs do not become complete from local green tests.
