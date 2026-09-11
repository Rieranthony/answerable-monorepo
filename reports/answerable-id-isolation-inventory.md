# Answerable ID database isolation inventory

The single initial migration protects five tables with 12 policies: `groups`, `group_members`, `entitlements`, `organization_capabilities`, `grant_contexts`. Runtime startup checks protection/privileges. Service contexts, database predicates, native broker verification and parent locks remain necessary; this is not universal RLS.

## Current query boundary review

The TypeScript-AST [candidate inventory](id-release-contracts.json) finds 120 exported function declarations in non-test `db/queries` files. 110 accept a typed context first. The remaining ten are explicit broker/health/audit or pure helpers:

| Function                                                             | Boundary                                                                                                                |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `recordAuditEvent`                                                   | Transaction-owned insertion; trusted caller supplies attribution, owner trigger supplies subjects.                      |
| `findMachineCapability`                                              | Broker query after authenticated ownership and scoped policy preparation.                                               |
| `effectiveGrants`                                                    | Authenticated user policy read, own-tenant SSO, locks and post-wait current checks. A UUID alone is not authentication. |
| `hasPlatformWriter`                                                  | Explicit policy-root read for immutable platform bootstrap/last-writer protection.                                      |
| `checkDatabase`                                                      | `select 1`; no tenant data.                                                                                             |
| `matchingEntitlements`, `isEffective`                                | Query/SQL construction; executing callers supply trusted authority and scope.                                           |
| `serializeSsoProviderConfig`, `redactSsoProvider`, `retiredEmailFor` | Pure transformations, not independent readers.                                                                          |

This count covers exported declarations, not every arrow function, native adapter or broker query. See [tenant authentication](id-tenant-authentication.md), [verified linking/freshness](id-verified-linking-and-freshness.md) and [production OAuth](id-production-oauth.md) for those boundaries.

## Protected tables

| Table          | Constraint beyond scope                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Groups         | Tenant UUID, live slug/external-ID uniqueness, terminal deletion.                                                        |
| Group members  | UUID primary key/revision, same-tenant member/group foreign keys, effective window/live uniqueness.                      |
| Entitlements   | Same-tenant principal, explicit target pair, partial NULLS NOT DISTINCT uniqueness, scopes/window and terminal deletion. |
| Capabilities   | Platform-only approval, exact tenant/target/grant-kind, registration ceilings, effective window and terminal deletion.   |
| Grant contexts | Immutable authentication/user/member/tenant/client/resource binding, native code binding and retained revocation.        |

## Database scopes

Assignment/group reads use selected tenant, explicit platform or authenticated policy-user scope; policy-root reads only the bound platform. Missing/unknown scope denies rows. Tenant writes stay in their tenant; capabilities require platform write. The actual policies remain in [the baseline SQL](../apps/id/drizzle/0000_initial.sql), with catalogue/role tests.

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

Restricted tests cover missing/wrong scope, foreign IDs, code/refresh, current provenance, concurrent revocation/issuance, pooled scope reset, audit-failure rollback, runtime startup and restored state. Parent identity/session/client tables remain trusted broker exceptions. No extra generic query wrapper would establish real consumer or ingress isolation.

## Evidence and limits

The [acceptance report](id-release-acceptance.md) maps F0–F7 tests and final gates. T4's synthetic workload is not a tenant-fairness guarantee; the [external checklist](answerable-id-release-decision-plan.md#external-input-and-test-checklist) retains actual deployment, workload and consumer requirements. Historical migration-specific slice notes remain in the execution reports and Git history; they are not installation instructions.
