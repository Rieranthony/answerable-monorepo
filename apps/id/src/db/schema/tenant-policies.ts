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
      select organization_id from members where user_id = nullif(current_setting('answerable.subject', true), '')::uuid
    ))
    or (${mode} = 'policy-root' and ${organizationId} in (select organization_id from system_bindings)))`;
  return [
    pgPolicy("tenant_write", { for: "all", using: write, withCheck: write }),
    pgPolicy("tenant_read", { for: "select", using: read }),
  ];
}
