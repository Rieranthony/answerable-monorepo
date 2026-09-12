# Answerable ID database isolation inventory

The single initial migration protects eleven tables: `groups`, `group_members`, `entitlements`, `organization_capabilities`, `grant_contexts`, `members`, `invitations`, `organization_domains`, `sso_providers`, `audit_events` and `audit_event_subjects`. Runtime startup checks protection/privileges. Service contexts, database predicates, native broker verification and parent locks remain necessary; this is not universal RLS.

## Current query boundary review

Query functions use typed contexts, with explicit broker/health/audit and pure-helper exceptions:

| Function                                                             | Boundary                                                                                                                |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `recordAuditEvent`                                                   | Transaction-owned insertion; trusted caller supplies attribution, owner trigger supplies subjects.                      |
| `findMachineCapability`                                              | Broker query after authenticated ownership and scoped policy preparation.                                               |
| `effectiveGrants`                                                    | Authenticated user policy read, own-tenant SSO, locks and post-wait current checks. A UUID alone is not authentication. |
| `hasPlatformWriter`                                                  | Explicit policy-root read for immutable platform bootstrap/root locking and global user deletion.                       |
| `checkDatabase`                                                      | `select 1`; no tenant data.                                                                                             |
| `matchingEntitlements`, `isEffective`                                | Query/SQL construction; executing callers supply trusted authority and scope.                                           |
| `serializeSsoProviderConfig`, `redactSsoProvider`, `retiredEmailFor` | Pure transformations, not independent readers.                                                                          |

The query boundary does not cover every native adapter or broker query. See [tenant authentication](id-tenant-authentication.md), [verified linking/freshness](id-verified-linking-and-freshness.md) and [production OAuth](id-production-oauth.md) for those boundaries.

## Protected tables

| Table          | Constraint beyond scope                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Groups         | Tenant UUID, live slug/external-ID uniqueness, terminal deletion.                                                        |
| Group members  | UUID primary key/revision, same-tenant member/group foreign keys, effective window/live uniqueness.                      |
| Entitlements   | Same-tenant principal, explicit target pair, partial NULLS NOT DISTINCT uniqueness, scopes/window and terminal deletion. |
| Capabilities   | Platform-only approval, exact tenant/target/grant-kind, registration ceilings, effective window and terminal deletion.   |
| Grant contexts | Immutable authentication/user/member/tenant/client/resource binding, native code binding and retained revocation.        |

| Members | Tenant-owned membership, terminal revocation/deletion and effective windows. |
| Invitations | Tenant-owned invitation and user references. |
| Organisation domains | Unrestricted routing reads; scoped writes. |
| SSO providers | Unrestricted routing reads; scoped writes, including protocol writes. |
| Audit events | Unrestricted INSERT policy; administrative SELECT only, append-only runtime grants. |
| Audit event subjects | Unrestricted INSERT policy; administrative SELECT only; runtime INSERT is revoked and subjects are trigger-owned. |

## Database scopes

Assignment/group reads use selected tenant, explicit platform or authenticated policy-user scope; policy-root reads only the bound platform. Missing/unknown scope denies assignment/group rows. Tenant writes stay in their tenant; capabilities require platform write. The actual policies remain in [the baseline SQL](../apps/id/drizzle/0000_initial.sql), with catalogue/role tests.

Every Better Auth adapter transaction starts in `protocol` scope. Standalone member/invitation adapter operations also run in their own protocol-scoped transaction; see [database-adapter.ts](../apps/id/src/auth/database-adapter.ts). This is trusted broker access, not per-tenant isolation for protocol work.

Membership and invitation writes allow `platform-write`, `protocol`, or `tenant-write` for the selected organisation. Their SELECT policies additionally allow `platform-read`, `platform-users`, selected `tenant-read` and `policy-root` for the bound platform organisation. Members also allow `policy-user` and `grant-admission` SELECT for the supplied subject; invitations do not have that subject exception. These membership predicates do not themselves filter status or deletion.

Routing SELECT is unrestricted. Domain/provider writes require `platform-write` or selected `tenant-write`; SSO providers additionally permit `protocol` writes. Domain writes do not permit protocol scope. Audit SELECT allows `platform-read`, `platform-write`, `platform-users`, or matching-organisation `tenant-read`/`tenant-write`. Audit INSERT policies have `WITH CHECK (true)`, independently of scope; runtime grants still prohibit direct subject insertion. Audit policies do not grant UPDATE or DELETE.

`protect_grant_context` and `validate_grant_authentication` run as `SECURITY DEFINER` with fixed `pg_catalog, public` search paths. They validate grant provenance and lock parents as the owner; direct execution is revoked from PUBLIC. They do not grant callers unrestricted access to those parents.

## Grant-context database scopes

| Scope                        | Visibility                           | Direct capability                                                                     |
| ---------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------- |
| Missing/unknown, policy-root | None                                 | None                                                                                  |
| Tenant read/write            | Selected tenant                      | Write scope updates its rows; no insert/delete.                                       |
| Platform read                | All                                  | Read.                                                                                 |
| Platform write               | All                                  | Insert/update/delete permitted by policy; service lifecycle retains revoked contexts. |
| Platform users               | All for explicit global lifecycle    | Update; no insert/delete.                                                             |
| Policy user                  | Supplied authenticated user's grants | Read.                                                                                 |
| Grant admission              | Authenticated user and session       | Insert matching provenance; no update/delete.                                         |
| Grant client                 | Authenticated client's grants        | Update/bind/revoke; no insert/delete.                                                 |

Column immutability and parent guards remain independent. Scope is installed only by trusted code, not by accepting a client-supplied tenant/user UUID. Runtime permissions can be narrower than a policy's theoretical capability.

## Grant-context isolation integration requirements

Implemented in actual `createAuth`: current own-tenant admission, one immutable flow/grant, scoped code binding, code/refresh replay and family revocation, exact-pair policy, native savepoints and mandatory audit. Platform-users revocation has explicit scope; tenant membership removal preserves B; product deletion retains revocation instead of deleting grant history.

Restricted tests cover missing/wrong scope, foreign IDs, code/refresh, current provenance, concurrent revocation/issuance, pooled scope reset, audit-failure rollback, runtime startup. Global user/session/client tables remain trusted broker exceptions. No extra generic query wrapper would establish real consumer or ingress isolation.

## Evidence and limits

The [acceptance report](id-release-acceptance.md) maps F0–F7 tests and final gates. T4's synthetic workload is not a tenant-fairness guarantee; the [external checklist](answerable-id-release-decision-plan.md#external-input-and-test-checklist) retains actual deployment, workload and consumer requirements. Historical migration-specific slice notes remain in the execution reports and Git history; they are not installation instructions.
