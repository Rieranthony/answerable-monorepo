import { sql } from "drizzle-orm";
import { pgPolicy, type PgColumn } from "drizzle-orm/pg-core";

/** Only Answerable-owned access tables use these policies. Broker tables remain explicit exceptions. */
export function tenantPolicies(organizationId: PgColumn) {
  const mode = sql`current_setting('answerable.scope', true)`;
  const tenant = sql`${organizationId} = nullif(current_setting('answerable.tenant', true), '')::uuid`;
  const write = sql`(${mode} = 'platform-write' or (${mode} = 'tenant-write' and ${tenant}))`;
  const read = sql`(${write}
    or ${mode} = 'platform-read'
    or (${mode} = 'tenant-read' and ${tenant})
    or (${mode} = 'policy-user' and ${organizationId} in (
      select organization_id from members where user_id = nullif(current_setting('answerable.subject', true), '')::uuid and deleted_at is null and status = 'active' and (valid_from is null or valid_from <= statement_timestamp()) and (valid_until is null or valid_until > statement_timestamp())
    ))
    or (${mode} = 'policy-root' and ${organizationId} in (select organization_id from system_bindings)))`;
  return [
    pgPolicy("tenant_write", { for: "all", using: write, withCheck: write }),
    pgPolicy("tenant_read", { for: "select", using: read }),
  ];
}

/** Native membership provisioning uses an explicit trusted protocol transaction. */
export function membershipPolicies(
  organizationId: PgColumn,
  userId?: PgColumn,
) {
  const mode = sql`current_setting('answerable.scope', true)`;
  const tenant = sql`${organizationId} = nullif(current_setting('answerable.tenant', true), '')::uuid`;
  const write = sql`(${mode} in ('platform-write', 'protocol') or (${mode} = 'tenant-write' and ${tenant}))`;
  const subject = userId
    ? sql`(${mode} in ('policy-user', 'grant-admission') and ${userId} = nullif(current_setting('answerable.subject', true), '')::uuid)`
    : sql`false`;
  return [
    pgPolicy("tenant_write", { for: "all", using: write, withCheck: write }),
    pgPolicy("tenant_read", {
      for: "select",
      using: sql`${write}
      or ${mode} in ('platform-read', 'platform-users')
      or (${mode} = 'tenant-read' and ${tenant})
      or ${subject}
      or (${mode} = 'policy-root' and ${organizationId} in (select organization_id from system_bindings))`,
    }),
  ];
}

/** Sign-in routing is readable before authentication; writes still require authority. */
export function routingPolicies(
  organizationId: PgColumn,
  protocolWrite = false,
) {
  const mode = sql`current_setting('answerable.scope', true)`;
  const write = sql`(${mode} = 'platform-write'
    or (${mode} = 'tenant-write' and ${organizationId} = nullif(current_setting('answerable.tenant', true), '')::uuid)
    or (${protocolWrite ? sql`true` : sql`false`} and ${mode} = 'protocol'))`;
  return [
    pgPolicy("routing_read", { for: "select", using: sql`true` }),
    pgPolicy("routing_write", { for: "all", using: write, withCheck: write }),
  ];
}

/** Audit insertion is independent of scope; retained evidence has administrative readers. */
export function auditPolicies(organizationId: PgColumn) {
  const mode = sql`current_setting('answerable.scope', true)`;
  return [
    pgPolicy("audit_insert", { for: "insert", withCheck: sql`true` }),
    pgPolicy("audit_read", {
      for: "select",
      using: sql`${mode} in ('platform-read', 'platform-write', 'platform-users')
      or (${mode} in ('tenant-read', 'tenant-write') and ${organizationId} = nullif(current_setting('answerable.tenant', true), '')::uuid)`,
    }),
  ];
}
