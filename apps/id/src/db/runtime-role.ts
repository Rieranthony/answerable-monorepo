import { sql } from "drizzle-orm";
import type { Database } from "./client.ts";

const elevatedRole = sql`r.rolsuper or r.rolcreatedb or r.rolcreaterole or r.rolreplication or r.rolbypassrls or exists(select 1 from pg_auth_members where member = r.oid)`;
const ownsObjects = sql`
  exists(select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relowner = r.oid)
  or exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proowner = r.oid)
  or exists(select 1 from pg_namespace where nspname = 'public' and nspowner = r.oid)
  or exists(select 1 from pg_database where datname = current_database() and datdba = r.oid)
`;

/** Provision permissions only; login credentials belong to deployment tooling. */
export function configureRuntimeRole(db: Database, roleName: string) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(roleName))
    throw new Error("Invalid runtime role name");
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('answerable:runtime-role'))`,
    );
    const role = sql.identifier(roleName);
    const existing = await tx.execute(
      sql`select 1 from pg_roles where rolname = ${roleName}`,
    );
    if (!existing.rows.length)
      await tx.execute(
        sql`create role ${role} nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls`,
      );
    const unsafe = await tx.execute(
      sql`select 1 from pg_roles r where rolname = ${roleName} and (${elevatedRole})`,
    );
    if (unsafe.rows.length)
      throw new Error(
        "Runtime role has privileged attributes or role memberships",
      );
    const owner = await tx.execute(
      sql`select 1 from pg_roles r where rolname = ${roleName} and (${ownsObjects})`,
    );
    if (owner.rows.length)
      throw new Error("Runtime role must not own database or schema objects");
    await tx.execute(sql`revoke create on schema public from public`);
    await tx.execute(sql`revoke all on schema public from ${role}`);
    await tx.execute(sql`grant usage on schema public to ${role}`);
    await tx.execute(
      sql`revoke all on all tables in schema public from public, ${role}`,
    );
    await tx.execute(
      sql`revoke execute on all functions in schema public from ${role}`,
    );
    await tx.execute(
      sql`grant select, insert, update, delete on all tables in schema public to ${role}`,
    );
    await tx.execute(
      sql`revoke delete on users, organizations, accounts, members, invitations, organization_domains, groups, group_members, entitlements, oauth_clients, oauth_resources, oauth_client_resources, oauth_consents, sso_providers, organization_capabilities from ${role}`,
    );
    await tx.execute(sql`revoke update, delete on audit_events from ${role}`);
    await tx.execute(
      sql`revoke insert, update, delete on audit_event_subjects from ${role}`,
    );
    await tx.execute(
      sql`revoke update, delete on system_bindings, admin_operations from ${role}`,
    );
    // Trigger invocation needs no direct EXECUTE grant. Block calls that could forge subjects.
    await tx.execute(
      sql`revoke execute on function capture_audit_subjects(audit_events, text), record_audit_subjects() from public, ${role}`,
    );
  });
}

/** Refuse an owner or a writer capable of changing the retained evidence. */
export async function assertRuntimeRole(db: Database) {
  const result = await db.execute(sql`
    select
      (${elevatedRole}) or (${ownsObjects})
      or (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname in ('groups', 'group_members', 'entitlements', 'organization_capabilities', 'grant_contexts', 'members', 'invitations', 'organization_domains', 'sso_providers', 'audit_events', 'audit_event_subjects') and c.relrowsecurity) <> 11
      or exists(select 1 from unnest(array['users','organizations','accounts','members','invitations','organization_domains','groups','group_members','entitlements','oauth_clients','oauth_resources','oauth_client_resources','oauth_consents','sso_providers','organization_capabilities']) as product(table_name) where has_table_privilege(current_user, product.table_name, 'DELETE,TRUNCATE,TRIGGER'))
      or has_schema_privilege(current_user, 'public', 'CREATE')
      or has_table_privilege(current_user, 'audit_events', 'UPDATE,DELETE,TRUNCATE,TRIGGER')
      or has_table_privilege(current_user, 'audit_event_subjects', 'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
      or has_table_privilege(current_user, 'system_bindings', 'UPDATE,DELETE,TRUNCATE,TRIGGER')
      or has_table_privilege(current_user, 'admin_operations', 'UPDATE,DELETE,TRUNCATE,TRIGGER')
      or has_function_privilege(current_user, 'capture_audit_subjects(audit_events,text)', 'EXECUTE')
      as unsafe
    from pg_roles r where rolname = current_user
  `);
  if (result.rows[0]!.unsafe)
    throw new Error(
      "Unsafe database runtime role: use a non-owner role with protected audit permissions",
    );
}
