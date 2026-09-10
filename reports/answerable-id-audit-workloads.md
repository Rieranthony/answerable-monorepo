# Audit workload measurements

## Global user erasure density

The `user-erasure` mode exercises eight concurrent global-user erasures through actual loopback HTTP and a restricted four-connection pool. Each user has two tenant memberships, each with 10, 100 or 1,000 group assignments and distinct direct resource entitlements. Global commands remain outside the tenant command-admission bound. Reads probe the second tenant while unrelated members and groups there must survive.

Both runs complete all 24 erasures and their same-key replays. Each successful event retains exactly two removed memberships, `2 × size` removed assignments and `2 × size` removed entitlements, with one durable target-user reference. Every erased user has zero remaining memberships/assignments/direct grants and one `user.erased` event. Each artifact retains 30 observations and 27 final checks (24 users plus three unrelated-member/group preservation checks).

| Rows of each kind per membership | Eight-command burst, runs 1 / 2 | Maximum other-tenant read, runs 1 / 2 | Audit JSON bytes per user |
| --- | --- | --- | --- |
| 10 | 109 / 100 ms | 53 / 46 ms | 13,685 |
| 100 | 895 / 157 ms | 722 / 87 ms | 127,627 |
| 1,000 | 506 / 486 ms | 380 / 416 ms | 1,268,829 |

No other-tenant probe returns a failure in these runs. Sampled pool waiting reaches five; the substantial timing variation is retained rather than converted into a percentile or supported limit. This establishes successful complete local erasure for this shape, not deployment-wide fairness. It does not exercise owned-client/token cascades, many tenants per identity, signing/authentication load, production storage or peak database memory. No crash is injected by this harness; separate process-interruption tests cover that property. No request needed recovery in these runs, so their evidence establishes replay after success rather than recovery after refusal.

Raw evidence: [first run](id-user-erasure-density.json), [repeat](id-user-erasure-density-repeat.json). Logs: `/private/tmp/id-user-erasure-density.log` and `/private/tmp/id-user-erasure-density-repeat.log`. Initial fixture-development attempts were rejected by the existing duplicate-entitlement constraint and by an incorrect affected-versus-target subject assertion; neither is a production-capacity finding. Corrected seeds use distinct targets, and the metadata explicitly identifies the counted user relationship.

```bash
bun --filter @answerable/id measure:audit ../../reports/id-user-erasure-density-new.json user-erasure
```

Run serially against the guarded disposable test database. First-principles review leaves production unchanged: these results do not justify a cleanup workflow engine, evidence truncation or higher deadlines. The next measurements need independent tenant-count and owned-client cascade dimensions plus an agreed deployment budget.

## Dense member access evidence

A separate dimension now measures **effective group assignments per member**, with eight members sharing 10, 100 or 1,000 groups and one admin resource. These are actual restricted-role HTTP membership-window commands, each producing before/after access evidence. Root authentication, a four-connection runtime pool and the existing two-command tenant admission bound remain unchanged. Tenant B is probed throughout; each failed A command is retried once with its original key, revision and input.

The original query returned the full policy-source arrays for every matching entitlement, although the public result groups entitlements by target. At 1,000 assignments the eight-command burst returned only 503s: six immediate admission refusals and two further refusals at roughly two and ten seconds. Those durations are consistent with the configured lock/statement deadlines; the HTTP error code alone does not distinguish them. All eight isolated recovery attempts also returned 503 at approximately ten seconds. Each retained its original revision and had no committed member event. This is a reproducible operation failure, not an established supported limit.

`memberAccess` now groups matching assignments by `(client_id, resource)` in a lateral subquery before projecting permission facts. It preserves all assignments, scope unions, target ordering and the existing evaluator; the JavaScript target-deduplication map is removed. No cache, new policy implementation, truncation, schema change or limit increase.

| Assignments per member | Before: isolated recovery HTTP | After: isolated recovery HTTP across two runs | Final outcome after correction |
| --- | --- | --- | --- |
| 10 | 28–33 ms | 21–37 ms | All eight members complete and replay |
| 100 | 207–239 ms | 27–53 ms | All eight members complete and replay |
| 1,000 | All eight fail with 503 at 10,026–10,041 ms | 98–122 ms | All eight members complete and replay |

After correction, the initial burst admits two commands and refuses six; those six recover with the same keys. No B probe failed in any of the three runs. At 1,000 assignments, maximum B latency was 236 ms before, 18 ms in the first corrected run and 104 ms in the repeat. These are individual local observations, not percentiles or a latency promise. The combined server/harness RSS sampler does not measure PostgreSQL memory.

The verified repeat retains **24 per-member checks**: exactly one successful event, one membership revision increment, every expected assignment in both `via` and approved decision evidence, and no remaining target in the expired membership's after snapshot. Each 1,000-source event is about 518 kB of JSON text; evidence size remains linear in retained sources. Replay inspects the original event and does not create another one. Assignment density, target count, scopes per source, tenant count and authentication load are independent dimensions: this one-resource shape does not establish general production capacity or cover 10,000 assignments per member.

Raw evidence: [before](id-member-access-workload-before.json), [first correction](id-member-access-workload-after.json), [verified repeat](id-member-access-workload-verified.json). Logs: `/private/tmp/id-member-load-{before,after,verified}.log`. The first two artifacts predate persisted per-member checks; their successful exits include those assertions. The third includes the checks explicitly.

```bash
bun --filter @answerable/id measure:audit ../../reports/id-member-access-new.json member-assignments
```

The same disposable-database and serial-execution restrictions below apply. The default mode continues to measure tenant audiences; do not compare its `size` directly with this mode's assignment count.


**Before-change finding: shared-pool capacity isolation was not established.** Three local runs reproduce a `503` read refusal in tenant B during eight concurrent administrative commands targeting a 10,000-member tenant A. The two runs that record refusal codes identify `database_busy`; the first records status/latency only. This is a release gap in the measured topology, not evidence that all deployments fail at this size.

## Command admission follow-up

The current patch admits two journalled HTTP commands per target organisation per runtime pool before journal checkout. It applies only to routes carrying `organizationId`, after authentication/validation. The pool is the identity of the bound, including different Drizzle wrappers over that pool. Excess commands receive existing retryable `503 database_busy`; no queue or persistent state is added. Authentication, root-request auditing, global commands, reads and other tenants remain outside this bound.

[The follow-up dataset](id-audit-workload-admission-evidence.json) retains 39 observations from the same guarded harness. Each eight-command burst admitted two commands and refused six; all refused commands recovered individually with their original keys. Every successful effect retained its full affected-user evidence. There were zero B failures across this run.

| Members in A | Burst duration | Maximum observed B read | Maximum sampled queued checkouts |
| --- | --- | --- | --- |
| 100 | 60.83 ms | 12.41 ms | 1 |
| 1,000 | 116.84 ms | 9.67 ms | 0 |
| 10,000 | 1,483.92 ms | 40.30 ms | 5 |

The implementation passes all repository gates and the complete restore rehearsal: 1,827 ID tests, 23,123 assertions, 100% line/function coverage, typecheck/lint, 62 web tests and both uncached builds. Full logs and scope are in the execution report.

The earlier three datasets remain the before-change evidence. This follow-up supports the selected workload correction, not a production latency budget or full tenant fairness. Queued checkouts still occur: the limit starts after authentication, and sampling observes those earlier phases too. Multiple pools each admit two; a pool of two connections or fewer cannot reserve spare capacity through this bound. More representative sizes, history, authentication paths and deployment topology remain release work.

The deterministic restricted-role regression holds A's organisation lock and observes its actual PostgreSQL blocking graph while B makes root and authenticated tenant-local reads. Both single- and two-pool cases originally failed with B's 503. The final regression additionally covers pool aliases, UUID casing, forbidden foreign writes and same-key recovery after commit/rollback. See the [execution evidence](answerable-id-foundation-execution-plan.md#tenant-command-admission-before-journal-checkout) for gate status and failed runs.

## Organisation erasure follow-up

[The organisation-erasure dataset](id-org-erasure-workload-evidence.json) retains 45 observations from the extended guarded harness, including erasure and original-key replay after the existing workloads. All B probes succeeded in this run. Each erasure recorded exactly N affected-user references and one successful event; replay recovered the same operation without repeating the effect.

| Members | Erasure HTTP time | Replay HTTP time | Erasure event JSON | Maximum B read during erasure |
| --- | --- | --- | --- | --- |
| 100 | 34.81 ms | 6.92 ms | 28,179 bytes | 9.53 ms |
| 1,000 | 82.67 ms | 6.18 ms | 252,288 bytes | 6.43 ms |
| 10,000 | 693.36 ms | 7.72 ms | 2,493,297 bytes | 23.60 ms |

These are single local observations, not percentiles or supported production limits. The erasure phase runs after group erasure and the eight entitlement disables: its population is N memberships plus the remaining organisation entitlements. It does not exercise N groups, dense assignment/ceiling combinations, provider/invitation volume, real session density or a large retained audit history. Those dimensions still need representative lifecycle measurements. The restricted-role correctness suite separately exercises all newly captured configuration families and session selection clearing. Replay rows above inspect the already committed event; they do not represent additional audit events.

The original audience-mode regression also passes after the harness extension: [45 observations](id-member-access-audience-regression.json), no B refusals, complete recorded audiences and same-key recovery/replay (`/private/tmp/id-member-load-audience.log`). This run verifies the existing mode; it does not add new production capacity claims.

## Reproduce

From the repository root, after migrating the disposable test database:

```bash
bun --filter @answerable/id measure:audit ../../reports/id-audit-workload-new-evidence.json
```

The [measurement script](/Users/anthonyriera/code/answerable/apps/id/scripts/measure-audit-workloads.ts) refuses a database name other than `answerable_id_test`, a non-loopback host or a port other than 47432. It resets synthetic fixtures: run it serially, without tests, builds or restore work. It removes its temporary HTTP listener and database login on completion. Synthetic database records remain until the next fixture/schema reset. Keep earlier evidence files when rerunning.

The script issues actual loopback HTTP requests through `createApp`/`createAuth` and a restricted, non-owner runtime login. Owner access is used only for synthetic seeding, statistics and evidence inspection. It measures organisation/group entitlement creation, group disable/enable/erasure, and a burst of eight independent organisation-wide entitlement disables. A small second tenant is probed through its group-list endpoint throughout each phase. Failed A commands retry their original keys individually; each final target must be disabled with exactly one successful audit fact. The final harness also asserts one successful domain fact per returned operation and exactly N recorded affected users: truncation is not an accepted performance improvement.

## Measured setup and limits

- Bun 1.3.1; Apple M1 Pro, 10 logical CPUs, 32 GiB RAM; macOS arm64. The repository configures local PostgreSQL 16 Alpine.
- One HTTP application instance and one runtime pool, maximum four connections; one-second checkout timeout and ten-second statement deadline. Existing command lock waits remain two seconds.
- All measured requests use the authorised root break-glass fixture. This is contention between administrative workloads **targeting** A and B; it does not prove an attack through currently closed tenant-self-service writes. Human/machine authentication costs remain unmeasured.
- Each population has N synthetic active users/members, one N-member group and one group entitlement. Audience size, entitlement count, scope density, retained-history volume and real identity traffic are independent dimensions; only this fixture shape was exercised.
- Three runs, each with one observation per phase/size. These are observed ranges, not percentiles, throughput guarantees or production sizing. Connection/heap warm-up and local host load affect results. No multi-replica, proxy or remote database was tested.
- RSS is sampled every 10 ms in the process containing both server and harness. Deltas include unrelated allocations/GC and can miss transient peaks. Timer gaps are raw intervals for a 10 ms timer, not a measured CPU-only pause.

## Results

HTTP duration in milliseconds, across the three observations (group status combines disable and enable):

| Members | Organisation entitlement create | Group entitlement create | Group status change | Group erasure |
| --- | --- | --- | --- | --- |
| 100 | 23–31 | 22–30 | 19–25 | 17–22 |
| 1,000 | 54–66 | 66–73 | 55–70 | 57–71 |
| 10,000 | 458–608 | 585–862 | 481–710 | 467–660 |

At 10,000 members, the recorded event data is approximately 2.49 MiB for organisation entitlement creation, 3.89 MiB for group entitlement creation and 2.99 MiB for group status/erasure. These are uncompressed JSON-text lengths measured in PostgreSQL, not on-disk table/index size or response size. Successful events retain exactly 10,000 affected-user references. Group-entitlement creation's largest observed RSS delta in the first run was about 39 MiB; this cannot be treated as a per-request memory budget.

| 10,000-member burst | A successes / initial refusals | B read refusals | Recovery |
| --- | --- | --- | --- |
| First run | 6 / 2 | One 503 at 1,002 ms; code not captured | Both original keys succeed |
| Repeat with codes | 5 / 3 | One `database_busy` at 1,003 ms | All three original keys succeed |
| Repeat with pool sampling | 6 / 2 | One `database_busy` at 1,002 ms | Both original keys succeed |

All A refusals were `database_busy`. In the final run, the pool reached four busy connections, up to five waiting checkouts, and 135 sampled instants with no idle runtime connection. The eight-command phase lasted about 2.81 seconds including the final B probe/drain. Individual successful A requests took up to 2.79 seconds. The 100- and 1,000-member bursts had no B refusal in these runs; that is not a guaranteed safe threshold.

Raw evidence: [initial](/Users/anthonyriera/code/answerable/reports/id-audit-workload-evidence.json), [repeat with error codes](/Users/anthonyriera/code/answerable/reports/id-audit-workload-repeat-evidence.json), [repeat with pool sampling](/Users/anthonyriera/code/answerable/reports/id-audit-workload-pool-evidence.json). Logs: `/private/tmp/id-audit-load-measure.log`, `/private/tmp/id-audit-load-repeat.log`, `/private/tmp/id-audit-load-pool.log`.

## Source explanation and next implementation

The [runtime pool](/Users/anthonyriera/code/answerable/apps/id/src/db/client.ts:15) is shared. [Operation execution](/Users/anthonyriera/code/answerable/apps/id/src/services/operations.ts:70) checks out a transaction before authorisation/mutation. Tenant mutations take the [organisation row lock](/Users/anthonyriera/code/answerable/apps/id/src/db/organization-lock.ts:10), so same-organisation writers serialise while retaining checked-out connections. [HTTP admission](/Users/anthonyriera/code/answerable/apps/id/src/http/admission.ts:4) counts handlers per instance; it neither reserves database capacity for another tenant nor limits queued writers by target tenant. [Error mapping](/Users/anthonyriera/code/answerable/apps/id/src/http/problem.ts:106) classifies checkout timeout as `database_busy`.

**Inference:** queued same-tenant command work exhausting the shared pool explains the observed refusal and its one-second timing. Pool occupancy/queued checkout is measured; a PostgreSQL blocker graph was not captured here, so time spent in each individual lock is not claimed as measured.

The next change must prevent one tenant's queued work from occupying all useful shared capacity. Start with a deterministic restricted-role regression that observes the actual blockers and requires B to progress. Compare the smallest compatible admission change against the existing retry, authority, replay and grant-versus-revocation contracts. Preserve current authority before admitting effects, give rejected commands the existing safe retry contract, and test independent application pools before making a deployment-wide claim. Cover authentication/checkout and failure-audit work explicitly; a limit acquired only after checkout does not establish complete protection.

Separately establish supported audience, group-entitlement and lifecycle sizes using the intended deployment and service budgets. A synchronous bound must reject or route an oversized operation without losing evidence or pretending cleanup is complete. If a required lifecycle operation exceeds that bound, commit its denial barrier and use narrowly scoped resumable work with durable progress. Do not add a workflow engine until the actual operation requires it.

## First-principles review

No production timeout, pool size, membership limit or admission policy was changed. Raising a timeout would retain contested capacity longer; a larger pool would move the threshold without proving tenant isolation. Truncating the audience would violate the audit requirement. Conversely, three local observations do not justify a permanent 10,000-member product limit or a general workflow system. Keep the guarded, repeatable measurement and use the demonstrated failure to choose the next regression and implementation.

The initial harness typecheck inferred an overly narrow UUID-template type for a default key argument; explicit `string` fixes the script signature. The initial measurement omitted B's error code; later runs preserve it and add exact evidence counts/pool sampling without rewriting the first dataset. Repository gates pass: 1,824 ID tests/22,961 assertions with 100% line/function coverage, typecheck, lint, 62 web tests, both uncached builds and complete fresh-cluster restore. Measurement roles and restore containers are cleaned up. See the current verification in [the execution report](answerable-id-foundation-execution-plan.md). The overall F0–F7 release gate remains open.


## Global user parent-lock regression

The [parent-ordering correction](answerable-id-foundation-execution-plan.md#global-user-erasure-parent-ordering) was exercised through the existing user-erasure dimension. [Raw evidence](id-user-erasure-parent-lock-density.json): 30 observations, 27 checks; 24 erasures and all replays succeed, with no B-probe failures. Eight-user bursts at 10/100/1,000 sources per membership took 267/141/546ms; B-probe maxima were 188/88/403ms. The largest complete audit remains 1,268,829 bytes. One local restricted pool of four connections; maximum observed pool waiting was five. This is a regression run, not a production limit, percentile, memory ceiling, large-membership-count test or token fan-out measurement. No timeout recovery branch was exercised.


## Public-authentication contention regression

[The deterministic restricted-role test](/Users/anthonyriera/code/answerable/apps/id/src/http/admin/auth-admission.integration.test.ts) holds token-rejection audit storage while four unauthenticated requests per four-connection pool run through alternating app aliases. Before admission, the other tenant's real read returns 503 in both one-pool and two-pool cases (`/private/tmp/id-auth-admission-before.log`). With the shared handler bound, three requests per pool remain admitted, one receives an early retryable 503, and both root and authenticated B reads succeed while the audit lock is held. After release, admitted requests return their original 401 and retain version-three unattributed rejection events. Refused requests retry successfully to the expected authentication denial.

This proves the selected contention correction, not throughput, percentiles, dedicated connection reservation, overall tenant fairness, admin-route authentication isolation or cluster-wide rates. The gate counts handlers and a single-connection pool cannot preserve a spare connection. The native per-owner issuance and per-tenant administrative-command gates remain separate, later boundaries.
