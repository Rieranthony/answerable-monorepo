import { sql } from "drizzle-orm"
import type { Executor } from "./connect"
import { mcpRoles } from "./names"

type Standing = {
  role: string
  rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean; rolreplication: boolean; rolbypassrls: boolean
  memberships: { role: string; inherit: boolean; set: boolean; admin: boolean }[]
  owned: string[]
  privileges: string[]
}

/**
 * Refuse to serve MCPs as a login that is more than a switch between their runtime roles: one with `SUPERUSER`, `CREATEDB`, `CREATEROLE`,
 * `REPLICATION` or `BYPASSRLS`; a member of any role but `<prefix>_<name>` for `names` (`prefix` is `mcp` unless given), or of one of those
 * that it inherits, holds with `ADMIN OPTION` or may not `SET ROLE` to; missing one of them; the owner of anything; or holding a privilege of
 * its own on a schema or relation, or `CREATE` or `TEMPORARY` on the database. The error names each. Await it before a server listens, on the
 * pool its MCPs' databases borrow from.
 */
export async function assertServingLogin(db: Executor, { prefix = "mcp", names }: { prefix?: string; names: readonly string[] }): Promise<void> {
  const allowed = names.map(name => mcpRoles(prefix, name).runtime)
  const { rows: [standing] } = await db.execute<Standing>(sql`select r.rolname::text as role, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls,
      coalesce((select json_agg(json_build_object('role', m.rolname, 'inherit', a.inherit_option, 'set', a.set_option, 'admin', a.admin_option) order by m.rolname)
        from pg_auth_members a join pg_roles m on m.oid = a.roleid where a.member = r.oid), '[]') as memberships,
      array(select case when d.dbid in (0, (select oid from pg_database where datname = current_database())) then pg_describe_object(d.classid, d.objid, d.objsubid)
          else 'objects in database ' || (select datname from pg_database where oid = d.dbid) end
        from pg_shdepend d where d.refobjid = r.oid and d.deptype = 'o' order by 1) as owned,
      array(select distinct privilege from (
          select format('%s on schema %I', acl.privilege_type, n.nspname) as privilege from pg_namespace n, aclexplode(n.nspacl) acl where acl.grantee = r.oid
          union all select format('%s on %I.%I', acl.privilege_type, n.nspname, c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace, aclexplode(c.relacl) acl where acl.grantee = r.oid
          union all select format('%s on database %I', p.privilege, current_database()) from unnest(array['CREATE', 'TEMPORARY']) p (privilege) where has_database_privilege(r.oid, current_database(), p.privilege)
        ) held order by 1) as privileges
    from pg_roles r where r.rolname = session_user`)
  const { role, memberships, owned, privileges } = standing!
  const problems = [
    ...([["rolsuper", "SUPERUSER"], ["rolcreatedb", "CREATEDB"], ["rolcreaterole", "CREATEROLE"], ["rolreplication", "REPLICATION"], ["rolbypassrls", "BYPASSRLS"]] as const)
      .filter(([column]) => standing![column]).map(([, attribute]) => `has ${attribute}`),
    ...memberships.filter(membership => !allowed.includes(membership.role)).map(membership => `is a member of ${membership.role}`),
    ...memberships.filter(membership => allowed.includes(membership.role) && membership.inherit).map(membership => `inherits ${membership.role}`),
    ...memberships.filter(membership => allowed.includes(membership.role) && membership.admin).map(membership => `holds ${membership.role} with ADMIN OPTION`),
    ...memberships.filter(membership => allowed.includes(membership.role) && !membership.set).map(membership => `may not SET ROLE ${membership.role}`),
    ...allowed.filter(runtime => !memberships.some(membership => membership.role === runtime)).map(runtime => `is not a member of ${runtime}`),
    ...owned.map(object => `owns ${object}`),
    ...privileges.map(privilege => `holds ${privilege}`),
  ]
  if (problems.length) throw new Error(`Database role ${role} may not serve MCPs: ${problems.join("; ")}. Serve as the serving login provisioning made, which holds only its MCPs' runtime roles`)
}
