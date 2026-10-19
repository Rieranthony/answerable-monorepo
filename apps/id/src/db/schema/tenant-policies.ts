import { sql } from "drizzle-orm";
import { pgPolicy, type PgColumn } from "drizzle-orm/pg-core";

/** Only Answerable-owned access tables use these policies. Broker tables remain explicit exceptions. */
export function tenantPolicies(organizationId: PgColumn) {
  const mode = sql`current_setting('answerable.scope', true)`;
  const tenant = sql`${organizationId} = nullif(current_setting('answerable.tenant', true), '')::uuid`;
  const write = sql`(${mode} = 'platform-write' or (${mode} = 'tenant-write' and ${tenant}))`;
  // Permissive policies combine with OR: the write policy already admits writers to SELECT.
  const read = sql`(${mode} = 'platform-read'
    or (${mode} = 'tenant-read' and ${tenant})
    or (${mode} = 'policy-user' and ${organizationId} in (
      select organization_id from members where user_id = nullif(current_setting('answerable.subject', true), '')::uuid and deleted_at is null and status = 'active' and (valid_from is null or valid_from <= statement_timestamp()) and (valid_until is null or valid_until > statement_timestamp())
    )))`;
  return [
    pgPolicy("tenant_write", { for: "all", using: write, withCheck: write }),
    pgPolicy("tenant_read", { for: "select", using: read }),
  ];
}

/** Sign-in provisions memberships in the callback's protocol transaction. */
export function membershipPolicies(organizationId: PgColumn, userId: PgColumn) {
  const mode = sql`current_setting('answerable.scope', true)`;
  const tenant = sql`${organizationId} = nullif(current_setting('answerable.tenant', true), '')::uuid`;
  const write = sql`(${mode} in ('platform-write', 'protocol') or (${mode} = 'tenant-write' and ${tenant}))`;
  const subject = sql` or (${mode} = 'policy-user' and ${userId} = nullif(current_setting('answerable.subject', true), '')::uuid)`;
  return [
    pgPolicy("tenant_write", { for: "all", using: write, withCheck: write }),
    pgPolicy("tenant_read", {
      for: "select",
      using: sql`${mode} = 'platform-read'
      or (${mode} = 'tenant-read' and ${tenant})${subject}`,
    }),
  ];
}

/** Sign-in routing is readable before authentication, except that a tenant scope reads
 * only its own organisation's rows; writes still require authority. */
export function routingPolicies(
  organizationId: PgColumn,
  protocolWrite = false,
) {
  const mode = sql`current_setting('answerable.scope', true)`;
  const tenant = sql`${organizationId} = nullif(current_setting('answerable.tenant', true), '')::uuid`;
  const protocol = protocolWrite ? sql` or ${mode} = 'protocol'` : sql``;
  const write = sql`(${mode} = 'platform-write'
    or (${mode} = 'tenant-write' and ${tenant})${protocol})`;
  return [
    pgPolicy("routing_read", {
      for: "select",
      using: sql`coalesce(${mode}, '') not in ('tenant-read', 'tenant-write') or ${tenant}`,
    }),
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
      using: sql`${mode} in ('platform-read', 'platform-write')
      or (${mode} in ('tenant-read', 'tenant-write') and ${organizationId} = nullif(current_setting('answerable.tenant', true), '')::uuid)`,
    }),
  ];
}
