import { sql } from "drizzle-orm"
import type { Executor } from "./connect"

type Standing = {
  role: string
  rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean; rolreplication: boolean; rolbypassrls: boolean
  memberships: string[]
  owned: string[]
  privileges: string[]
}

// The session login's attributes, the roles it is a member of, what it owns, and the privileges it holds itself on schemas and on the database.
async function standingOf(db: Executor): Promise<Standing> {
  const { rows: [standing] } = await db.execute<Standing>(sql`select r.rolname::text as role, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls,
      array(select m.rolname::text from pg_auth_members a join pg_roles m on m.oid = a.roleid where a.member = r.oid order by 1) as memberships,
      array(select case when d.dbid in (0, (select oid from pg_database where datname = current_database())) then pg_describe_object(d.classid, d.objid, d.objsubid)
          else 'objects in database ' || (select datname from pg_database where oid = d.dbid) end
        from pg_shdepend d where d.refobjid = r.oid and d.deptype = 'o' order by 1) as owned,
      array(select distinct privilege from (
          select format('%s on schema %I', acl.privilege_type, n.nspname) as privilege from pg_namespace n, aclexplode(n.nspacl) acl where acl.grantee = r.oid
          union all select format('%s on database %I', p.privilege, current_database()) from unnest(array['CREATE', 'TEMPORARY']) p (privilege) where has_database_privilege(r.oid, current_database(), p.privilege)
        ) held order by 1) as privileges
    from pg_roles r where r.rolname = session_user`)
  return standing!
}

const attributes = [["rolsuper", "SUPERUSER"], ["rolcreatedb", "CREATEDB"], ["rolcreaterole", "CREATEROLE"], ["rolreplication", "REPLICATION"], ["rolbypassrls", "BYPASSRLS"]] as const

/**
 * Refuse to serve the MCPs `names` as a login that is more than the one provisioning made to serve them: one with `SUPERUSER`, `CREATEDB`,
 * `CREATEROLE`, `REPLICATION` or `BYPASSRLS`; a member of any role; the owner of anything; holding `CREATE` or `TEMPORARY` on the database or
 * `CREATE` on a schema; or lacking `USAGE` on the schema of one of `names`. Its table privileges are the migrations' grants. The error names each
 * problem. Await it before a server listens, on each pool its MCPs' databases borrow from: the shared database's, for its shared MCPs, and each
 * own MCP's, for that MCP.
 */
export async function assertServingLogin(db: Executor, { names }: { names: readonly string[] }): Promise<void> {
  const standing = await standingOf(db)
  const problems = [
    ...attributes.filter(([column]) => standing[column]).map(([, attribute]) => `has ${attribute}`),
    ...standing.memberships.map(role => `is a member of ${role}`),
    ...standing.owned.map(object => `owns ${object}`),
    ...standing.privileges.filter(privilege => !privilege.startsWith("USAGE ")).map(privilege => `holds ${privilege}`),
    ...names.filter(name => !standing.privileges.includes(`USAGE on schema ${name}`)).map(name => `lacks USAGE on schema ${name}`),
  ]
  if (problems.length) throw new Error(`Database role ${standing.role} may not serve MCPs: ${problems.join("; ")}. Serve as the login provisioning made to serve them`)
}
