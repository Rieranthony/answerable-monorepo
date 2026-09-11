# Initial migration consolidation

**Status:** implemented from the frozen T1–T4 integration at `fcea29774a69c888e97d17da774619fd7a3e9dcf`, on `codex/id-initial-migration`. All required repository gates and the T4 restore rehearsal pass. This is first-release installation work; ID has never shipped to production. No production database or original source checkout was changed.

## Baseline

The 53 development migrations (`0000`–`0052`) are replaced by exactly one [initial SQL migration](../apps/id/drizzle/0000_initial.sql), one [generated snapshot](../apps/id/drizzle/meta/0000_snapshot.json) and one [journal entry](../apps/id/drizzle/meta/_journal.json). The snapshot has a new ID and an all-zero `prevId`; it is not the final development snapshot renamed. Excluding the generated IDs, it is semantically identical to the frozen final development snapshot. Future migrations remain supported.

Bun 1.3.1 and pinned Drizzle Kit 0.31.10 generated the baseline from `src/db/schema/index.ts`. Required custom SQL was then incorporated once per final object, rather than replaying the sequence of creates, replacements, alters and historical conversions. The final schema contains 28 tables, 26 functions, 61 triggers, 12 policies and five tables with RLS. Product `deletedAt` fields and terminal/parent guards, native OAuth provenance and claim validation, immutable identifiers, audit subjects, operation reservations, encrypted recovery, key custody and role restrictions retain their integrated contracts.

The generated SQL required two deliberate additions beyond functions/triggers and privileges:

- The audit-to-operation foreign key remains `DEFERRABLE INITIALLY DEFERRED` so an event and its later journal insertion commit atomically.
- The partial unique indexes `entitlements_principal_target_unique` and `organization_capabilities_target_kind_unique` retain `NULLS NOT DISTINCT`. Pinned generation omits it for partial indexes. The unchanged constraint/index regression exposed duplicate nullable targets; the SQL was corrected, without weakening that assertion or changing the schema.

The [custom catalogue](../apps/id/src/__tests__/migration-catalog.json) was captured from a clean installation of the complete pre-consolidation chain. It freezes normalised function definition hashes, security-definer/search-path settings, PUBLIC execution privileges, trigger definitions/enabled state, policy definitions, table RLS flags and FK deferral. The new install matches it exactly. The existing schema tests still freeze column definitions, defaults, constraints and indexes; only physical column order is ignored because initial generation changes ordinal positions without changing the contract.

## Removed development compatibility

Removed the binding-import command/service and its bootstrap import test, all intermediate SQL/snapshots, the one-time upstream credential-retirement migration and its cutover fixture/worker/tests, and upgrade-only populated-row tests for assignment IDs, operation audit versions and affected-user subject backfills.

Encrypted-response replay no longer accepts obsolete unkeyed SHA-256 fingerprints. Reference-only internal operations still use SHA-256; they contain no encrypted response and remain an active contract. Resource creation fingerprints the complete normalised current input, including ownership defaults. A real HTTP regression verifies that omitted and explicit shared defaults replay the same operation and changed ownership conflicts.

The native SSO replacement regression proves that repeated migration preserves account identity, browser sessions and all encrypted upstream credentials, and that subsequent SSO uses the same account. The audit replacement regression proves that ordinary subject capture cannot invent a missing membership's user. Plaintext/corrupt credential refusal, key rotation, deletion, replay and role tests remain.

Retained audit envelope versions and the `legacy_derived` schema value were not redesigned: they belong to the frozen event/subject contract. No initial backfill or conversion produces them. Immutable bootstrap bindings, current claim rejection, anonymous authentication provenance refusal and reference-only operation receipts are ongoing security/runtime behaviour. No new migration runner, lease table, import mode or production conversion workflow was introduced.

Operator, public onboarding, schema and design docs now use the initial baseline and remove development deployment prerequisites. Historical reports retain their original evidence under an explicit supersession note; old migration links point to their immutable source commit. Broader cross-contract documentation reconciliation remains T6 work.

## Installation and interruption proof

Run from the repository root with the local disposable PostgreSQL service available:

```bash
bun --filter @answerable/id test:migrations
```

The script refuses any database name other than `answerable_id_test`. It runs separately from database tests and restore, and leaves a clean migrated test schema. CI runs it before coverage.

The script uses the existing Drizzle runner and private temporary migration copies to prove:

1. An injected final-statement failure leaves no application schema objects or committed migration receipt.
2. SIGKILL while the final transaction waits at a database barrier rolls back; retrying the committed migration installs the complete catalogue with no manufactured audit, operation or bootstrap records.
3. SIGKILL after commit preserves the expected SQL hash/time receipt. Two concurrent bootstrap calls establish the same platform identity. Repeated migration preserves real bindings, audit facts and permanent identifier reservations.

A separate temporary copy proves unchanged generation reports no migration and an added probe table generates only `0001_future_probe.sql`, with snapshot `prevId` pointing at the initial snapshot. The temporary probe directory and schema files were discarded after evidence capture; neither successor nor probe table is committed.

## Verification and raw evidence

Local logs are under `/private/tmp/` with prefix `id-initial-`. They contain test fixtures and diagnostics, not deployment credentials.

| Check                                      | Result                                                                            | Evidence                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Original chain install/catalogue           | Passed                                                                            | `before-migrate-permitted.log`, `before-catalog.json`              |
| Consolidated catalogue equality            | Exact match                                                                       | `after-catalog.json`, empty `catalog.diff`                         |
| Failure/SIGKILL/retry/concurrent bootstrap | Passed                                                                            | `install-proof-corrected.log`                                      |
| Unchanged/future generation                | Passed, normal linked successor                                                   | `future-unchanged.log`, `future-addition.log`, `future-proof.json` |
| Focused migration/security/replay          | 162 passed, zero failed; partial coverage deliberately below full-suite threshold | `focused-corrected.log`                                            |
| Full ID coverage                           | 2,027 passed, zero failed; 29,829 assertions; 100% lines/functions (560.43s)      | `coverage.log`                                                     |
| Fresh-cluster T4 restore/reconciliation    | Passed, including known-gap traffic refusal and complete synthetic reconciliation | `restore.log`, `reports/id-initial-recovery.json`                  |
| Root typecheck                             | Passed after build generated Next.js route types                                  | `typecheck-final.log`                                              |
| Root lint                                  | Passed                                                                            | `lint-final.log`                                                   |
| Root production build                      | Passed, two uncached builds                                                       | `build.log` (two uncached), `build-final.log` (final docs)                                                  |
| Web / countries                            | 71 / 5 passed                                                                     | `web-tests-final.log`, `countries-tests.log`                       |

Earlier failures are retained: `before-test.log` expected the new initial tag before it existed; `focused-first.log` caught nullable-target uniqueness and physical column order; `install-proof.log` exposed the test barrier needing release before PostgreSQL could observe a killed client's closed socket. Initial root typecheck lacked generated Next.js route types (`typecheck.log`); build then typecheck passed. The first future-generation command used an absolute output path that pinned Drizzle mishandled despite exiting zero; the corrected relative-path probe was verified from its actual SQL, journal and snapshots. No product assertion was weakened to mask these failures.

## Boundaries and handoff

This proves the local initial baseline and the exercised recovery/security contracts. Production topology, ingress attribution, capacity budgets, key delivery/rotation ownership, backup RTO/RPO, complete post-snapshot reconciliation and maintenance/monitoring scheduling remain external T4/T6 release inputs. A successful synthetic restore does not certify those inputs. Physical cleanup jobs and retention duration remain deferred by the accepted deletion contract.

Only the expressly disposable `answerable_id_test` database was reset. Restore uses a temporary local cluster and separately supplied synthetic keys. Final read-only cleanup verification found zero other test database connections and no `id_test_*` roles; the temporary restore cluster was removed. The single restored migration receipt matches SQL SHA-256 `12ca325eb13bc4d57007c1cacaf71842a9aa867debb40937d902c2a2909920a3`. Raw evidence: `/private/tmp/id-initial-cleanup.json`, `/private/tmp/id-initial-containers.log` and `/private/tmp/id-initial-manifest.json`. Database work is finished; the exclusive slot is released with the coordinator handoff.
