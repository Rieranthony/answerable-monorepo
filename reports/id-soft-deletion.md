# ID soft deletion implementation

**Migration baseline:** the development chain and its upgrade/cutover procedures below are historical. First installation now uses one initial migration; see the [consolidation record](id-initial-migration.md). Retained-key custody, native OAuth, deletion and recovery contracts still apply.

Status: implementation and verification complete; ready for coordinator review and local integration. Local integration handoff only. No production deployment, push, retention-duration decision or release certification.

Base: `7d48cf5c5ede3aca0773f7166309a2c6aedf4dda`, including the accepted SSO initiation fix. Branch: `codex/id-soft-deletion`. Only this worktree and the assigned disposable `answerable_id_test` database were modified.

## Product contract

Migration `0047_soft_deletion` adds nullable `deletedAt` to 15 product tables: users, organisations, accounts, memberships, invitations, groups, group assignments, entitlements, organisation domains, SSO providers, clients, resources, client-resource links, consents and organisation capabilities. Existing rows remain undeleted. Apply the migration with writers stopped and reconfigure runtime permissions before starting the new code; old writers/roles must not run against this contract. The marker is terminal; enable, update, SSO and explicit membership reinstatement cannot remove it.

| Command | Retained product records | Immediate local effect |
| --- | --- | --- |
| Delete user | Profile, account bindings, memberships, direct entitlements/group assignments, owned clients and their links/consents, sent invitations | Disable user, preserve the original email in `retiredEmail`, use the existing UUID retired address, clear account/password/client secrets, revoke user and owned-client grant contexts, delete affected session/token rows, clear surviving token session references and provider attribution |
| Delete organisation | Organisation, memberships, groups/assignments, entitlements, capabilities, domains, provider and invitations | Disable/revoke tenant rows, clear provider credentials, revoke tenant grant contexts and clear browser-session selections; preserve global profiles and sessions |
| Delete group | Group, group assignments and group entitlements | Disable group/entitlements and retire assignments |
| Delete client | Registration, client-resource links and consents | Disable client, clear secret, revoke contexts and delete affected token rows, including access rows linked through deleted refresh tokens |
| Delete resource | Resource registration | Disable resource and revoke its contexts; undeleted links, entitlements and capabilities must first be removed |
| Remove entitlement, group assignment, capability or domain; delete provider; unlink resource | Relationship/configuration row | Set terminal marker; disable applicable policy/domain state and clear provider credentials |
| Remove member | Same membership UUID, without terminal deletion | Revoke membership and its contexts; soft-delete direct grants and group assignments. Explicit reinstatement remains supported and restores no assignments |

Organisation deletion requires removing undeleted owned clients/resources first. Client/resource reference guards include disabled and future-dated policy. Bound platform identities and the reserved admin-session ceiling remain protected.

Deleted profiles and other product rows can still identify people. This is not anonymisation. Physical cleanup, a retention duration and named-person recovery are outside this slice. Existing replay-cipher expiry remains intact.

## Identity, relationship and read rules

- Account issuer/account and directory bindings remain reserved. Federation receives retained identity matches and rejects deleted accounts/users/members rather than treating them as missing, merging by email or reviving them. The existing user email-retirement rule still releases the email for an independent identity.
- Organisation/group slugs and external identifiers retain their existing uniqueness. Client/resource identifiers retain permanent security reservations. A replacement SSO configuration gets a new UUID and provider ID; an existing provider ID from another organisation cannot be adopted.
- Live-only partial unique indexes permit explicit replacement of removed group assignments, entitlements, capabilities, domains, providers and client-resource links. Null principal/target components remain equal for entitlement/capability uniqueness. Group assignments use their UUID as primary key. Repeated retire/recreate cycles in one transaction do not depend on timestamp differences.
- Ordinary administration, summaries, permission evaluation and grant policy exclude deleted rows. Native adapter discovery filters cover provider/domain/client/resource/link/consent/invitation reads, lists and counts on both root and transaction-bound adapters. Identity lookups deliberately retain tombstone visibility for admission rejection.
- SQL parent guards share-lock live parents and deny new active relationships to deleted parents after lock waits. Existing identity/revision guards run first. Deleted authority rows must remain inactive and credential-free. Runtime roles cannot DELETE, TRUNCATE or disable triggers on product tables; startup rejects those privileges.
- Sessions, OAuth tokens, codes/assertions/verifications and operation results retain their native expiry, consumption and credential-revocation lifecycle. No blanket marker was added to protocol tables. Grant contexts are retained with irreversible revocation.

## Audit and replay handoff

Deletion effects come from actual changed rows in the command transaction. New effects exclude already-deleted rows. Child and refresh-parent locks preserve concurrent-creation ordering; audit/subject/receipt failures roll the entire mutation back. Authorised same-key replay returns the original receipt without another transition; a new key against a deleted target returns 404 under the existing command rules. No recovery framework was added.

| Event | New version | Contract |
| --- | --- | --- |
| `user.erased`, `organization.erased`, `group.erased`, `client.erased` | 3 | `deletionMode: soft`, retained before/after state including terminal marker; actual `softDeleted*` relationship manifests and existing owner-safe counts |
| `client.grants_erased` | 3 | Platform-only exact token/relationship/context effects, linked by owner-safe lifecycle event |
| Resource/domain/provider/capability deletion | 2 | Retained after-state, terminal marker and actual local effects |
| Entitlement/group-assignment/member removal | 3 | Actual retired relationship state/effects; membership itself remains reversible unless its parent is deleted |
| Client-resource link/unlink/no-op | 3 | Existing immutable resource visibility metadata plus changed `relationship: {id, deletedAt}`; null relationship means no relationship effect |

Physically removed credentials keep `deleted*` array names. Context revocation uses `revokedGrantContexts` (client grant-effect envelopes retain their existing `grantContexts` key). Membership-removal effects preserve the `removedGrants` key for retired direct entitlements and use `softDeletedGroups` for retired group assignments. Retained older event versions keep their original payload and subject rules. Organisation link history accepts versions 2 and 3; foreign private targets remain platform-only. New deletion subject rules validate explicit versions, actions, outcome, target/tenant identity, marker and array envelopes; they never recursively infer UUIDs from arbitrary JSON.

T1 should consume `deletedAt` from internal user/account/member/organisation lookups, preserve the deleted-versus-absent distinction and existing initiation-provider revision evidence, and never reinstate a terminal membership. T2 should use the current client/resource/link/consent eligibility filters and revocation helpers; removed relationships require a fresh UUID. `delete*GrantContexts` wrappers were removed in favour of existing revoke helpers, plus `revokeUserAndOwnedClientGrantContexts`.

The OAuth event/subject interface remains `recordAuditEvent` in the issuing transaction, with stable actor/target types and UUIDs plus the real tenant ID. The durable subject index captures actor/target at insertion and does not require live parent rows afterwards. Existing machine `oauth.token.issued` version 2 and rejected-attempt versions remain unchanged. Production user issuance/consent event writers, actual claim/persistence/audit agreement and any new explicit subject fields belong to T2; this slice does not claim those deferred writers exist or open public user grants. Do not reuse deletion event versions as a generic OAuth payload version.

## Verification and review

Before implementation, the two lifecycle regressions failed because product rows were physically removed (`/private/tmp/id-soft-delete-before-permitted.log`). Existing race tests also exposed missing live-link checks in native discovery and raw SQL grant creation; both paths are corrected. The final grant-creation matrix passed 30/30 with 958 assertions, including both lock orderings.

| Required check | Final result | Log |
| --- | --- | --- |
| `bun --filter @answerable/id db:test:migrate` | Passed; catalogue and schema-drift assertions also pass in the full suite | `/private/tmp/id-soft-delete-migrate.log` |
| `bun --filter @answerable/id test:coverage` | **1,915 pass, 0 fail, 25,789 assertions; 100% line/function coverage; 485.14s; exit 0** | `/private/tmp/id-soft-delete-verified.log` |
| `bun run typecheck` | Passed | `/private/tmp/id-soft-delete-root-types-final.log` |
| `bun run lint` | Passed | `/private/tmp/id-soft-delete-root-lint-final.log` |
| `bun run build` | Passed, including static docs and generated API pages | `/private/tmp/id-soft-delete-build-final.log` |
| `bun --filter web test` | 71 pass, 0 fail | `/private/tmp/id-soft-delete-web-tests.log` |
| `bun --filter @answerable/countries test` | 5 pass, 0 fail | `/private/tmp/id-soft-delete-countries-tests.log` |
| `bun --filter @answerable/id test:restore` | Passed in a fresh temporary PostgreSQL cluster; exit 0 | `/private/tmp/id-soft-delete-restore.log` |

Behavioural verification includes restricted native SSO tombstone rejection; root and transaction-bound adapter visibility; unlink blocking grant creation and OAuth issuance; cleared credentials and retained identities; explicit membership reinstatement; both parent/child race orders; same-timestamp replacement and null uniqueness; terminal SQL markers; runtime role enforcement; exact new/historical audit subject contracts; tenant visibility; rollback; crash and same-key replay. OpenAPI documents were regenerated by the export script and verified by snapshot tests.

The serial restore rehearsal seeds a deleted client/link/consent through a real command before the dump, then verifies retained inactive state, cleared credentials, native/read invisibility, UUID subjects, identifier reservation and unchanged same-key recovery in the replacement cluster. Existing signing-key, upstream-key, session, runtime-role, bootstrap, tenant-isolation and replay-cipher-expiry restore checks also pass. Source fixture rows and the replacement container were cleaned up by the guarded rehearsal.

First-principles review: retained rows require both write guards and live-read checks; a disabled flag alone cannot distinguish reversible suspension from terminal deletion. Partial live indexes preserve historical UUIDs without using timestamps as uniqueness keys. Existing transaction, authority, audit and replay machinery is reused. Obsolete grant-deletion wrappers were removed. Native protocol cleanup and the accepted SSO initiation boundary are preserved. No background purge, restore endpoint, email identity merge, new consent flow or migration squash was introduced.

The single-initial-migration consolidation remains T5's later responsibility. Capacity limits, operational topology, key/backup delivery and actual consumer acceptance are not proven by local correctness tests. Physical cleanup and its duration are deferred and are not treated as first-release blockers.
