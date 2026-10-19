# Answerable ID database isolation inventory

The migrations protect ten tables: `groups`, `group_members`, `entitlements`, `organization_capabilities`, `grant_contexts`, `members`, `organization_domains`, `sso_providers`, `audit_events` and `audit_event_users`. Runtime startup checks protection/privileges. Service contexts, database predicates, native broker verification and parent locks remain necessary; this is not universal RLS.

## Current query boundary review

Query functions use typed contexts, with explicit broker/health/audit and pure-helper exceptions:

| Function                                                             | Boundary                                                                                                                |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `recordAuditEvent`                                                   | Transaction-owned insertion; trusted caller supplies attribution, owner triggers record the users it concerns.          |
| `findMachineCapability`                                              | Broker query after authenticated ownership and scoped policy preparation.                                               |
| `effectiveGrants`                                                    | Authenticated user policy read, own-tenant SSO, locks and post-wait current checks. A UUID alone is not authentication. |
| `hasPlatformWriter`                                                  | Platform-read of the bound platform organisation, the only one that can hold `platform:*`, for root locking and global user deletion. |
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
| Organisation domains | Routing reads without scope, bound to the selected tenant under tenant scopes; scoped writes. |
| SSO providers | Routing reads without scope, bound to the selected tenant under tenant scopes; scoped writes, including protocol writes. |
| Audit events | Unrestricted INSERT policy; administrative SELECT only, append-only runtime grants. |
| Audit event users | Platform SELECT only; no INSERT policy, runtime INSERT is revoked and the triggers fill it as the owner. |

## Database scopes

Seven scopes exist: `protocol`, `platform-read`, `platform-write`, `tenant-read`, `tenant-write`, `policy-user` (bound to a session for grant admission) and `grant-client`. `platform:users` commands are authorised separately and run under `platform-write`.

Assignment/group reads use selected tenant, explicit platform or authenticated policy-user scope. Missing/unknown scope denies assignment/group rows. Tenant writes stay in their tenant; capabilities require platform write. The actual policies remain in [the baseline SQL](../apps/id/drizzle/0000_initial.sql), with catalogue/role tests.

Every Better Auth adapter transaction starts in `protocol` scope; see [database-adapter.ts](../apps/id/src/auth/database-adapter.ts). ID inserts the membership itself in the sign-in callback's transaction. This is trusted broker access, not per-tenant isolation for protocol work.

Membership writes allow `platform-write`, `protocol`, or `tenant-write` for the selected organisation. Their SELECT policies additionally allow `platform-read`, selected `tenant-read`, and `policy-user` SELECT for the supplied subject. These membership predicates do not themselves filter status or deletion.

Routing SELECT needs no scope, but `tenant-read` and `tenant-write` see only the selected organisation's domains and providers. Domain/provider writes require `platform-write` or selected `tenant-write`; SSO providers additionally permit `protocol` writes. Domain writes do not permit protocol scope. Audit SELECT allows `platform-read`, `platform-write`, or matching-organisation `tenant-read`/`tenant-write`. The audit event INSERT policy has `WITH CHECK (true)`, independently of scope; runtime grants prohibit inserting audit users. Audit policies do not grant UPDATE or DELETE.

`protect_grant_context` runs as `SECURITY DEFINER` with a fixed `pg_catalog, public` search path. It validates grant provenance and locks the member and session as the owner; direct execution is revoked from PUBLIC. It does not grant callers unrestricted access to those parents.

## Grant-context database scopes

| Scope                        | Visibility                           | Direct capability                                                                     |
| ---------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------- |
| Missing/unknown              | None                                 | None                                                                                  |
| Tenant read/write            | Selected tenant                      | Write scope updates its rows; no insert/delete.                                       |
| Platform read                | All                                  | Read.                                                                                 |
| Platform write               | All                                  | Insert/update, including global user lifecycle; no delete: runtime has no DELETE and grants are permanent. |
| Policy user                  | Supplied authenticated user's grants | Read; with a bound session, insert that session's grant; no update/delete.            |
| Grant client                 | Authenticated client's grants        | Update/bind/revoke; no insert/delete.                                                 |

Column immutability and the live foreign keys remain independent of scope; trigger functions schema-qualify their relations, and the runtime role cannot create temporary tables to shadow them. Scope is installed only by trusted code, not by accepting a client-supplied tenant/user UUID. Runtime permissions can be narrower than a policy's theoretical capability.

## Grant-context isolation integration requirements

Implemented in actual `createAuth`: current own-tenant admission, one immutable flow/grant, scoped code binding, code/refresh replay and family revocation, exact-pair policy, native savepoints and mandatory audit. Global user revocation runs under platform write after `platform:users` authority; tenant membership removal preserves B; product deletion retains revocation instead of deleting grant history.

Restricted tests cover missing/wrong scope, foreign IDs, code/refresh, current provenance, concurrent revocation/issuance, pooled scope reset, audit-failure rollback, runtime startup. Global user/session/client tables remain trusted broker exceptions. No extra generic query wrapper would establish real consumer or ingress isolation.

## Evidence and limits

The [acceptance report](id-release-acceptance.md) maps F0–F7 tests and final gates. T4's synthetic workload is not a tenant-fairness guarantee; the [external checklist](answerable-id-release-decision-plan.md#external-input-and-test-checklist) retains actual deployment, workload and consumer requirements. Historical migration-specific slice notes remain in the execution reports and Git history; they are not installation instructions.
