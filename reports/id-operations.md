# ID operations evidence

T4 repository-owned implementation on `codex/id-operations-foundation`, based on
`31c3f46c8e835bbcc94e33460850564351e8d372`. Measurements: 11 September 2026.
The original integration checkout was read-only. Workloads, coverage and restore
used exclusive serial ownership of the guarded `answerable_id_test` database.

## Implemented slice

- [Runtime summaries](../apps/id/src/operations/metrics.ts) aggregate completed
  handler counts, total/max elapsed time, active/high-water counts and instantaneous
  pool counts. Fixed route/status dimensions, no request labels or event buffer.
  The interval defaults to 30 seconds and is disabled explicitly with zero.
- [Custody preflight](../apps/id/src/operations/preflight.ts) uses the supported
  provider secret configuration, upstream transform and operation cipher. Read-only
  scans verify retained signing pairs, upstream fields and live replay ciphertext.
  Incorrect/missing material refuses without replacement keys or secret-bearing errors.
- [Recovery evidence](../apps/id/src/operations/recovery.ts) captures explicitly
  listed immutable receipts and audit/subject digests, membership revocations and
  client tombstones/reservations. Verification refuses absent or changed listed
  facts. Three operator CLIs support custody checking and evidence capture/verification.
- [Mixed workload](../apps/id/src/__tests__/capacity-workload.ts) runs separate
  production-mode processes and actual HTTP/native OAuth. Existing limits are measured,
  with no new admission quotas, forwarding trust, policy or token changes.
- [Restore rehearsal](../apps/id/scripts/test-upstream-restore.ts) now starts from a
  complete synthetic key inventory and tests acknowledged post-snapshot changes,
  traffic closure on a known gap, and reconciliation from a later complete dump.
- [Operator runbook](../apps/id/OPERATIONS.md) documents delivery, rotation boundaries,
  recovery, reporting and the finite external-input handoff. Product physical purge
  jobs and durations remain deferred; existing replay-ciphertext expiry is separate.

No schema/migration, public HTTP contract, T1 authority/freshness, T2 OAuth policy or
T3 soft-deletion semantics changed. T5 still owns migration consolidation.

## Synthetic capacity observations

Two Bun 1.3.1 production-mode processes, each with a restricted four-connection pool,
ran on an Apple M1 Pro host (10 logical CPUs, 32 GiB host memory) with local PostgreSQL
and loopback HTTP. Checkout timeout was 1 second and statement timeout 10 seconds.
Native fixture SSO supplied two tenant sessions. This differs from the repository's
five-connection/5-second checkout defaults. There was no production ingress.

Each phase offered four A requests per process. A controlled database barrier held
their work; actual PostgreSQL blockers established occupancy. B issued one admin
read per process while the barrier remained held. These are finite probes, not
independently scheduled sustained demand or latency percentiles.

| Phase, eight A requests             | Initial results in both runs               | B admin reads | Retry result                                          |
| ----------------------------------- | ------------------------------------------ | ------------- | ----------------------------------------------------- |
| Resource-bearing user code issuance | Six 200, two 503; six database blockers    | Both 200      | Refused codes exchange successfully after release     |
| Tenant commands                     | Four 201, four 503; four database blockers | Both 200      | Original keys succeed and replay one committed effect |
| Unknown-client token rejection      | Six 401, two 503; six database blockers    | Both 200      | Admitted retries return 401                           |

The largest B read observation in the two mixed runs was about 162 ms. This is not
an agreed latency budget. B OAuth attempted during full authentication occupancy
received 503, then 200 with the same unused code after release. Cached refresh replay
across processes preserved credentials and absolute expiry; native `expires_in`
decreased with elapsed time. All early refusals carried `Retry-After: 1`.

Raw evidence: [first mixed run](id-operations-capacity.json),
[repeat](id-operations-capacity-repeat.json).

**Global lifecycle limit remains observable.** The updated
[soft-deletion density run](id-operations-soft-deletion-density.json) used the
existing one-process harness with eight global users, two memberships per user and
10, 100, then 1000 assignments plus direct grants per membership. All 24 deletions
and same-key replays completed. Exact live-row, retained-row and audit-effect counts
passed; unaffected membership UUIDs remained intact. At density 1000, one B read
received `503 database_busy` after about 1040 ms, then subsequent probes recovered.
Global commands bypass tenant admission. This is a reproduced limit of that
synthetic envelope; it is not evidence of unconditional B progress. No deployment
traffic/latency objective was provided against which to choose a new global quota.
The eight-delete phase took about 1631 ms, and each audit payload was 1,437,201 bytes.
Historical density reports retain their original hard-deletion meaning; they were
not overwritten or relabelled as current evidence.

## Recovery and custody evidence

[Recovery timings](id-operations-recovery.json) record a local two-snapshot exercise:

1. Seed complete synthetic state, retained keys and native sessions; take the first dump.
2. Acknowledge four real commands: revoke A membership, create a client, rotate its
   secret, then terminally soft-delete it. Retain operation IDs, exact response bodies
   and versioned evidence separately in memory/private temporary files.
3. Restore the first dump into a fresh temporary PostgreSQL cluster. A is still
   active and the new client is absent. Verification fails, the closed listener
   returns 503 for the original keyed create request, and no replacement receipt appears.
4. Restore a later complete dump of the still-available synthetic source into another
   fresh cluster. Rebuild restricted roles with new login credentials. Custody passes;
   all four original operation IDs and bodies replay without repeating effects.
   A remains revoked, B remains active with the same global user UUID, and client
   tombstone/credential clearing/permanent identifier reservation remain present.

The existing restore contracts also pass: native SSO authority, signing continuity
and missing-key refusal, production startup role checks, retained migration receipts,
soft-deleted product identities, replay expiry and the restricted ciphertext purge.
The final local run took about 9.5 seconds across recorded phases, including the
capture CLI, overwrite refusal, verification refusal on the stale snapshot and both
verification/preflight CLIs on the reconciled snapshot. Phase boundaries
are explicit in the JSON. No archive retrieval delay, secret-store propagation,
production scale, source-loss recovery, consumer cache or reopening objective is measured.

The recovery manifest is deliberately a **negative check of listed facts**. It is
not a complete independently durable acknowledgement ledger. It neither reconstructs
missing commands nor proves no unlisted authority change was lost. Completeness of
the recovery source is an operator release prerequisite. `/readyz` cannot replace it.

## Verification and corrections

Focused checks: 28 tests passed, including 100% line/function coverage of all three
new operations modules. Wrong/absent custody, missing keys without regeneration,
read-only behaviour, changed/missing audit/receipt facts, lost tombstones/reservations,
bounded dimensions, retained in-flight metrics and reporter shutdown are exercised.

Initial rehearsal failures were corrected rather than counted as successful evidence:

- Unrelated tests intentionally retained encrypted command results under discarded
  keys. The restore rehearsal now resets its guarded disposable schema before seeding;
  the custody test resets only synthetic operation history before creating its inventory.
- The first mixed-run assertion compared whole cached responses. The provider
  recalculates `expires_in`; the corrected check compares stable credential/expiry
  fields without printing their values on assertion failure.
- The old density selector depended on email remaining intact after deletion. The
  updated harness checks immutable UUIDs, retained rows and `softDeleted*` audit effects.
- A focused invocation omitted the repository's 15-second test timeout; the normal
  timeout passes the existing slow-body test. Next.js build required local socket
  access denied by the initial sandbox run; the authorised rerun passed.

Final gates passed:

| Gate | Result | Local log |
| --- | --- | --- |
| Root build | Both apps built | `/private/tmp/id-ops-build-permitted.log` |
| Root typecheck | Four packages passed | `/private/tmp/id-ops-typecheck-final.log` |
| Root lint | Four packages passed | `/private/tmp/id-ops-lint-final-2.log` |
| Web tests | 71 passed, zero failed | `/private/tmp/id-ops-web-tests.log` |
| Country-data tests | Five passed, zero failed | `/private/tmp/id-ops-countries-tests.log` |
| Full ID coverage | 2037 passed, zero failed; 100% lines/functions; 561.07 seconds | `/private/tmp/id-ops-coverage.log` |
| Restore and operator CLIs | Passed after full coverage | `/private/tmp/id-ops-restore-final.log` |

The full suite includes provider/application-secret rotation, retained replay-key
rotation, body/disconnect, admission, database failure/rollback, runtime/retention
permissions, production OAuth and terminal deletion regressions. No OpenAPI change
was needed; existing generated-contract checks passed. `git diff --check` and report
file-link/JSON validation passed.

All T4 test/worker processes finished and temporary restore containers were removed.
The final query found **zero** other test-database sessions and **zero** `id_test_*`
roles (`/private/tmp/id-ops-db-release.json`). T4 has released the shared disposable
database slot. The shared local PostgreSQL service remains available for T5.

## T5/T6 handoff

T5 can consolidate migrations without a new schema or database-function requirement
from this slice. Preserve operator scripts, runtime role verification and serial
restore execution; rerun restore against the consolidated initial migration.

T6 must carry these five external inputs, without treating local success as production acceptance:

1. Replica/rollout topology, database resources/aggregate connection budget, ingress
   limits and any trusted proxy boundary. Forwarded-IP trust remains disabled.
2. Representative traffic, skew, burst/density assumptions and latency/refusal budgets,
   including B OAuth during shared authentication saturation and B reads during global deletions.
3. Secret-store/operator ownership, actual delivery/promotion/rollback, inventory of
   retained versions/backups and a rehearsed signing-key emergency lifecycle with consumers.
4. Backup/key retention, RTO/RPO, complete post-snapshot reconciliation source,
   independent evidence and authority to release traffic after a recovery gap.
5. Log/alert destination and incident ownership; operational scheduling for existing
   replay-ciphertext expiry. Domain-data physical purge policy remains deferred.

No production deployment, push, non-test reset, generic queue, key store, scheduler,
named identity recovery feature or public endpoint was added.
