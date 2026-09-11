# Enterprise foundation acceptance

**Local implementation and T6 acceptance are complete; production is no-go.** The [F0–F7 acceptance report](reports/id-release-acceptance.md) identifies the candidate and evidence. The [release decision](reports/answerable-id-release-decision-plan.md#external-input-and-test-checklist) contains the one finite external checklist. No production push, deployment or cutover has occurred.

## Completed sequence

- [x] T3: terminal `deletedAt`, ordinary read/eligibility denial, credential clearing/revocation and retained UUID audit/receipts.
- [x] T1: own-target-tenant current SSO, immutable verified provenance, deliberate two-proof linking and five-minute sensitive-human freshness.
- [x] T2: actual production code/refresh/machine OAuth, server-bound selection/consent, current policy and output/persistence/audit agreement.
- [x] T4: bounded operational tools, custody preflight, replay-retention maintenance, synthetic load limits and known-gap recovery rehearsal.
- [x] T5: one initial SQL migration, one generated snapshot, one journal entry; obsolete unshipped upgrade machinery removed.
- [x] T6: independent public-JWKS user-token verification, current docs/inventories, final gates, rendered docs and finite release decision.

## Verification

2,028 ID tests pass with 29,883 assertions and 100% line/function coverage. Root typecheck/lint, both uncached builds, 71 web tests, five country tests, migration failure/kill/retry/bootstrap, zero-drift OpenAPI export and synthetic fresh-cluster restore/reconciliation pass. All 114 built docs pages pass HTML/Markdown/index checks; 2,877 internal links/anchors resolve. Mobile menu/navigation and 390px layout were inspected.

## Remaining production gate

E1–E7 in the release decision require actual tenant/consumer configuration, missing external registration and remote lifecycle capabilities, key delivery/rotation, intended topology/ingress/workload budgets, backup/RTO/RPO and complete independent post-snapshot reconciliation. E8 applies only to a Circle cutover. Local green tests cannot close these conditions.

Accepted product decisions remain settled. Explicit membership reinstatement is supported for revoked, undeleted memberships, without restoring removed assignments/grants. Physical product purge and its duration are deferred; no named-identity recovery feature is required. ID has never shipped, so legacy production conversion is not a prerequisite.

## Ownership and review

T6 delivers one clean local acceptance commit from its own worktree for coordinator review/integration. Runtime defects would return to their existing owner; none was reproduced. Do not reopen an unlimited hardening loop or dispatch another implementation task from this report. Detailed history remains in the accepted T1–T5 reports and Git history.
