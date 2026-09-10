# ID completion coordination

User authorises this task to manage implementation of the six completed plans, including sequencing, review, integration and testing. Planning-only restrictions are lifted only for an explicitly dispatched implementation slice. No production deployment or push is authorised.

## Authoritative state

- Integration checkout: /Users/anthonyriera/code/answerable
- Integration branch: codex/id-foundation-completion
- Starting commit: 09badf2d52b30791955c734838d87e3f66b82e3a
- This platform has never shipped. One initial migration is required at the END.
- The prior 1,890-test result is baseline evidence, not verification of future changes.
- Do not reopen the old unlimited hardening loop. Follow the six plans and F0–F7 acceptance contract; new work requires an existing invariant and evidence.

## Existing tasks

| Owner | Exact task title | Task ID | State |
| --- | --- | --- | --- |
| T1 | Plan ID tenant authentication and authority | 01a08b80-277b-7382-be76-51e1b7c18b10 | Initiation fix accepted/integrated at 372b066; idle pending deletion handoff |
| T2 | Plan ID production OAuth and consent | 01a08b80-50b2-79e0-880a-46d1a5a33dfe | Plan complete; implementation not dispatched |
| T3 | Plan ID audit lifecycle and retention | 01a08b80-6407-7a03-9ac8-ee28ba12c4f7 | Dispatched: soft-deletion implementation; exclusive implementation/DB owner |
| T4 | Plan ID capacity operations and recovery | 01a08b80-c0dd-7793-858b-678a943deda7 | Plan complete; implementation not dispatched |
| T5 | Plan ID single initial migration cleanup | 01a08b80-d8c5-7763-99e6-e764415127f7 | Plan complete; implementation not dispatched |
| T6 | Plan ID release acceptance and documentation | 01a08b80-f14b-70d1-8265-1dd18a2fb232 | Plan complete; implementation not dispatched |

Read the final answers in those tasks before delegating or changing scope. Their proposals are not user decisions. The app list may omit these worktree tasks; the IDs above work with read_thread/send_message_to_thread/wait_threads.

## Sequence and ownership

1. T1: reproduce the sign-in-initiation/provider-change scenario; if a violation exists, implement minimal native server-state revision binding and test it. This slice is independent of the tenant-trust choice. Finish this bounded slice before expanding scope. Own-tenant SSO and verified identity binding are now approved; dependent implementation follows review/integration and the deletion-contract handoff.
2. T3: implement the reviewed deletedAt domain/eligibility contract before schema-sensitive admission work. Distinguish deleted identities from missing ones, preserve immediate credential revocation and durable audit/replay, and retain protocol consumption/expiry. No purge jobs or named-recovery feature. Freeze the OAuth event/subject handoff without redesigning replay.
3. T1: accepted tenant authentication, verified identity binding and fresh human auth using the integrated deletion contract and approved trust/binding policy; then hand off the authentication interface.
4. T2: implement production OAuth/browser consent/login-only and resource grants using T1/T3 contracts. Actual claims, persistence and successful audit must agree. Keep public grants closed until acceptance.
5. T4: complete measured operational limits, key/retention delivery and recovery using actual intended-environment inputs. Do not invent deployment facts.
6. T5: after schema-affecting changes are integrated, consolidate to one initial migration and remove obsolete upgrade-only code. Fresh install, catalog, roles and restore must pass.
7. T6: final cross-contract/consumer acceptance and documentation reconciliation. Runtime defects return to their owner. No release certification from local tests alone.

T3 contract work may precede T1 completion only if dispatched read-only; implementation is serial by default. T4 measurement can be designed earlier, but shared database execution is exclusive. T6 acceptance planning already exists; do not re-plan it indefinitely.

## Integration protocol

- Exactly one implementation writer and one shared-database test owner at a time. Other tasks remain idle unless explicitly dispatched.
- Workers use their own checkout and a codex/ branch. They must not modify the original integration checkout.
- Rebase each worker onto the latest accepted integration commit before starting a new slice. Never reset user changes or assume a stale worktree contains prior handoffs.
- Worker delivers changed files, behavioural tests and logs, documentation, first-principles review, limitations and local commit ID. Commits are allowed; pushes/deployments are not.
- Coordinator inspects the actual diff, tests and scope, requests corrections in the same task if needed, then cherry-picks accepted commits onto the integration branch.
- Run the appropriate repository gates after each integrated sequence. DB coverage, restore and workload suites must not overlap. Do not rerun an unchanged full suite just because another monitoring turn occurred.
- At final schema freeze perform T5 before T6's final gates. Exactly one initial migration is an explicit completion condition.
- Each sequence asks: what is unnecessary or weakly assumed, what can be deleted, what can be simplified? Do not force cosmetic changes or introduce generic infrastructure.

## Accepted product decisions

The user explicitly accepted both recommendations and specified soft deletion:

- **Tenant trust:** require each target tenant's own current SSO. Support deliberate verified identity binding so one person can keep the same global user UUID across providers. No implicit cross-tenant trust or email-based merging.
- **Historical attribution:** UUID-based audit history; no separate named-identity recovery feature is required for this release.
- **Deletion:** use `deletedAt` for soft deletion in the database. Existing physical-erasure plans are superseded for product deletion. Retained soft-deleted records can still contain identifying data; UUID-only audit does not imply that those database fields were erased or anonymised.
- **Immediate effect:** deletion removes eligibility for authentication, authorisation and ordinary discovery/read paths. Preserve revocation barriers, tenant isolation, immutable identifier reservations, audit facts and same-key command recovery. Offline JWT/downstream-session exposure still follows the explicit revocation contract, not an invented immediate logout promise.
- **Cleanup later:** physical purge jobs and the X-days/years retention decision are deferred by the user. Do not implement these jobs, invent a duration, or keep named-history/purge-duration approval as a first-release blocker. Existing operational replay-cipher expiry is a separate contract; do not silently remove it.
- T3 owns a precise mapping of domain deletion commands, their affected relations, retained data and ordinary-read filters. Distinguish product deletion from protocol expiry/replay consumption and credential revocation; do not mechanically add deletedAt to every table or retain active credentials. No automatic resurrection/relinking, identifier adoption or implicit restore is authorised by soft deletion.

## Pending inputs

- Consent frequency and human freshness defaults in the plans are proposals. Keep configuration/behaviour explicit and resolve materially different product outcomes before dependent implementation.
- Intended topology/traffic, recovery objectives, key/backup service and real first-consumer/test-tenant references remain needed for production evidence. T4/T6 should request non-secret facts once, with concrete gaps.

## Next coordinator action

T1's local commit 9bb7c625a465759d9cc4b52bbe87ea3e138179bd was reviewed and integrated as 372b0660b8fb92e4062c657035b3b1468e1e0875. T1 is idle. T3 now owns implementation and shared database tests for the approved soft-deletion work. Wait for T3 completion/attention, review its actual code/tests/deletion semantics and integrate accepted local commits. Do not dispatch T1 admission or T2 OAuth until the required deletion interfaces are integrated. Other tasks remain idle.

Review adjustment to T3's proposal: do not accidentally remove the existing explicit membership reinstatement feature. Distinguish reversible membership revocation from product/entity deletion. No automatic SSO resurrection is allowed, but explicit reinstatement of a revoked membership remains a supported command unless the user changes that contract. If a genuine conflict requires changing public semantics, bring that concrete conflict to the coordinator rather than silently making reinstatement unreachable.

## Follow-up automation

Thread heartbeat `coordinate-id-foundation-completion` is active every ten minutes. It checks the current owner and advances only after review/integration. It stays quiet on unchanged status and pauses after actual completion. It cannot supply missing user decisions. The coordinator retains responsibility for the integration branch; no other task may dispatch peers.

## Latest review checkpoint

- T1 remains active; focused SSO/routing tests, typecheck, lint and build are reported passing, with final full ID coverage running. No commit integrated yet. Preliminary production diff review confirms reuse of native server-only OAuth context and existing callback revision observation; no new schema/table/provider selector.
- T3 completed read-only plan turn 01a08b97-52df-7df3-b6cf-3909f3ca30e1. Read its final answer for the exact domain deletion mapping and SQL/eligibility contract. It must run before subsequent admission/linking work because deleted and absent identity matches have different security meanings.
- T3's implementation should cover markers, live-row reads/uniqueness, preserved reservations, guarded parent relationships, immediate credential retirement, exact soft-deletion audit effects and terminal deletion. Deferred purge/retention jobs remain excluded. Preserve session/code/assertion native lifecycles rather than blindly adding markers.
- Updated AGENTS supplied by the user includes packages/ui and packages/countries, with countries tests in the required gates. Workers must use that current instruction; existing T1 verification already includes countries tests.
- Do not dispatch T3 implementation until T1 is terminal and its accepted commit is integrated. No unchanged gates rerun in this checkpoint.

## Integrated SSO initiation slice

- Accepted implementation: 372b0660b8fb92e4062c657035b3b1468e1e0875 (source worker commit 9bb7c625a465759d9cc4b52bbe87ea3e138179bd).
- Reviewed native-state binding, awaited provider-list/single-read observer, cross-instance callback tests, altered/missing/forged state, secret-only rotation and change-and-revert; native selection and existing callback checks preserved. No schema or grant allowlist change.
- Verified raw full log: 1,904 pass, zero failures, 25,455 assertions, 100% line/function coverage, 445.02s. Typecheck/lint/build/web71/countries5 pass as recorded in reports/id-sso-initiation-revision.md. Application trees after cherry-pick exactly match the tested worker commit, so no unchanged full-suite rerun is warranted.
- T3 starts from the latest integration branch commit; all accepted product decisions in this document govern its work. No purge jobs, named-recovery feature or migration squash in T3.
