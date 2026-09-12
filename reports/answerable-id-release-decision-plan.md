# ID foundation: release decision

**Decision: no-go for production.** The local foundation and migration work are implemented. The [acceptance report](id-release-acceptance.md) identifies the candidate and repository evidence. Missing real consumer/deployment inputs and unimplemented remote lifecycle/registration capabilities prevent the wider release gate from closing. No push, deployment or cutover is authorised.

## Current completion plan

T1 tenant authentication/linking/freshness, T2 production OAuth, T3 terminal soft deletion, T4 operational/recovery tools and T5 single-migration consolidation are integrated. T6 owns final local acceptance and documentation. The [task checklist](../task_plan.md) is the current execution state; earlier implementation reports preserve history.

There is no further speculative hardening campaign. A reproduced violation of an existing invariant returns to its implementation owner. Missing external facts do not block finishing local acceptance.

### Contracts to settle first

These are settled: target-tenant own SSO; two independent proofs for explicit linking; five-minute verified upstream freshness for sensitive human commands; terminal `deletedAt` with immediate local credential/authority removal; retained UUID history. Membership revocation remains explicitly reversible without restoring removed assignments or revoked grants. No named-identity recovery or product purge-duration approval is required.

### Idempotency: the public promise

Same actor/tenant/key/normalised command plus current authority recovers the committed result without repeating effects. Permanent reservations prevent re-execution after response expiry. Fresh authentication applies to replay as well as a new sensitive human command. Native OAuth replay follows its separate code/refresh consumption contract and current-policy checks.

### Production boundary found in the current review

The actual `createAuth` now supports code, refresh and machine grants, plus server-bound selection/consent. Discovery describes reachable endpoints. Registration/DCR/CIMD, introspection, PAR, device and OIDC logout remain closed. The former machine-only boundary is historical.

### Interactive consent contract for the next integration

Implemented: one server-owned flow reference and canonical request, one selected immutable grant, terminal consent and expiry. Every new flow requests consent unless explicitly configured first-party bypass applies. Two tabs, deny, duplicate acceptance, narrowed scope and cached refresh retain their own validated context. The [production report](id-production-oauth.md) includes actual handler and browser evidence.

### Native scope contract for the next integration

Login and resource permission are distinct; resource access requires the exact client/resource pair. Refresh needs its matching ceiling and cannot recover removed scope or move tenant/resource. Actual output, persistence and mandatory version-four user facts are checked inside the native transaction. Resource JWT audiences may be arrays; consumers check membership in the expected audience set.

## External input and test checklist

This is the one outstanding checklist. Inputs are non-secret references/configuration identifiers; key values and bearer tokens must not enter reports. Each row needs a candidate/configuration identity, redacted results, explicit pass/fail and observed bounds. Missing capabilities require an explicit implementation handoff or a product decision changing the gate; supplying configuration alone cannot close them.

| ID  | Input or missing capability                                                                                                             | Exact acceptance before release                                                                                                                                                                                                                                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | Entra test tenant/app references, publisher/admin-consent state, configured issuer/domain and second independent provider               | Real own-tenant login succeeds; foreign/guest/unverified identities fail; repeat login preserves UUID; verified linking cannot transfer/adopt identity; stale sensitive command denies, real reauthentication recovers the same command.                                                                                                                                                                  |
| E2  | Actual OmniChat fork commit/config path, test cell, issuer/public/tailnet URLs, redirect/auth method, session/token-storage settings    | OIDC login/routing/another-email flow; state/nonce/PKCE and `private_key_jwt` where configured; per-user MCP `resource`, separate encrypted credentials, silent configured first-party bounce, refresh rotation; A/B exact-pair denials at code/refresh; tested cell rollback.                                                                                                                            |
| E3  | Actual Claude Code version/config and MCP resource metadata/verifier; supported registration path                                       | External discovery, registration or explicitly supported pre-registration, truthful consent, bound token and resource call. DCR/CIMD and resource-server integration are **Not yet** here; a client requiring them remains blocked.                                                                                                                                                                       |
| E4  | Upstream-disable detector and downstream logout delivery are **Not yet**; actual background/session settings and chosen exposure target | Independently test ID admin revocation and upstream IdP disable. Record last successful grant, first refusal, last offline JWT accepted and last downstream session. New-grant refusal within five minutes; selected access bound 15–30 minutes; background grant survives ordinary browser expiry but stops on offboarding. Current local revocation does not meet this remote-detection gate by itself. |
| E5  | Secret-store/operator, versioned key delivery/backup retention, signing lifecycle/runbook and actual consumer JWKS cache settings       | Preflight decrypts retained material; normal overlapping and emergency rotation, unknown/retired key, wrong issuer/audience/type/tenant, invalid signature, expired/future token and JWKS outage tested with each real verifier; restore retained keys without regeneration. No KMS/operator choice is invented.                                                                                          |
| E6  | Intended hosting/replicas/pools, ingress/listener/ACL policy, traffic/cardinality/concurrency and latency/error budgets                 | Intended-deployment A saturation leaves B within agreed budgets; body/slow/disconnect/audit/DB failures are bounded and visible; exact lifecycle manifests remain complete. T4's B OAuth 503 and dense-deletion B read 503 must be assessed against these budgets.                                                                                                                                        |
| E7  | Actual backup/restore system, RTO/RPO, key access and independent source of all acknowledged post-snapshot security changes             | Restore while listener is closed; reconcile every acknowledged receipt/revocation/tombstone/reservation before traffic; retries return original results, revoked access stays denied, consumer probes pass. The bounded negative verifier is not an acknowledgement ledger and cannot prove completeness/source-loss recovery.                                                                            |
| E8  | Circle matching/configuration only if Circle is selected for cutover                                                                    | Existing members map by supported immutable identity without duplication; rollback succeeds. Not a blocker for an unrelated first consumer.                                                                                                                                                                                                                                                               |

## What the evidence establishes

[Local acceptance](id-release-acceptance.md) covers F0–F7 repository requirements, restricted roles, native production flows, independent public-JWKS verification, migration and synthetic recovery. It reuses unchanged T1–T5 evidence at the identical implementation tree and records final tests for this candidate.

The recovery drill reconciles a known gap using a later live-source dump. It does not prove source-loss recovery or complete acknowledged-history discovery. Process summaries are interval counts/totals/maxima and instantaneous pool counts; they are not durable per-tenant telemetry or latency percentiles.

## What to defer deliberately

Physical product purge jobs/duration, a named-identity recovery feature, billing/provisioning frameworks, broad RLS expansion and speculative optimisation are not prerequisites. Keep active replay-cipher expiry, immutable reservations, retained-key custody, lifecycle denial and mandatory consumer kill gates. See [F0–F7](../docs/05-id-enterprise-foundation.md) and [the build plan](../docs/02-plan.md).
