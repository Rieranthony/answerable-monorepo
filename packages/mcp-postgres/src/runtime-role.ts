import { sql } from "drizzle-orm"
import type { Executor } from "./connect"

/** A privilege a runtime role may hold on a table. TRUNCATE, TRIGGER and REFERENCES are never granted. */
export type Privilege = "select" | "insert" | "update" | "delete"
/** A table of schema `public` and what a server's runtime role may do to its rows. A table no grant names is out of the role's reach. */
export type Grant = { table: string; privileges: readonly Privilege[] }

/**
 * What this package's tables need at run time: the evidence is appended and read, a payload's body is erased, and intents move and are swept.
 * Nothing on schema `drizzle`, where the migration receipts are. A server passes these to `configureRuntimeRole` with a grant for each of its own tables.
 */
export const runtimeGrants: readonly Grant[] = [
  { table: "evidence_events", privileges: ["select", "insert"] },
  { table: "evidence_payloads", privileges: ["select", "insert", "update"] },
  { table: "intents", privileges: ["select", "insert", "update", "delete"] },
]

const identifier = /^[a-z_][a-z0-9_]{0,62}$/
const privileges = new Set<string>(["select", "insert", "update", "delete"])
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`
const rows = async <T extends Record<string, unknown>>(db: Executor, query: ReturnType<typeof sql>) => (await db.execute<T>(query)).rows

// What makes `role` unfit to run a server whatever it is granted: an attribute beyond login, a role it belongs to, or an object it owns.
async function standing(db: Executor, role: string) {
  const [row] = await rows<{
    rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean; rolreplication: boolean; rolbypassrls: boolean
    memberships: string[]; owned: string[]; owns_schema: boolean; owns_database: boolean; database: string
  }>(db, sql`select r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls,
      array(select m.rolname::text from pg_auth_members a join pg_roles m on m.oid = a.roleid where a.member = r.oid) as memberships,
      array(select c.relname::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f') and c.relowner = r.oid
        union all select p.proname || '()' from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proowner = r.oid) as owned,
      exists(select 1 from pg_namespace where nspname = 'public' and nspowner = r.oid) as owns_schema,
      exists(select 1 from pg_database where datname = current_database() and datdba = r.oid) as owns_database,
      current_database() as database
    from pg_roles r where r.rolname = ${role}`)
  const sorted = (names: string[]) => names.toSorted((a, b) => (a < b ? -1 : 1)).join(", ")
  return [
    ...([["rolsuper", "SUPERUSER"], ["rolcreatedb", "CREATEDB"], ["rolcreaterole", "CREATEROLE"], ["rolreplication", "REPLICATION"], ["rolbypassrls", "BYPASSRLS"]] as const)
      .filter(([column]) => row![column]).map(([, attribute]) => `has ${attribute}`),
    ...(row!.memberships.length ? [`is a member of ${sorted(row!.memberships)}`] : []),
    ...(row!.owned.length ? [`owns ${sorted(row!.owned)} in schema public`] : []),
    ...(row!.owns_schema ? ["owns schema public"] : []),
    ...(row!.owns_database ? [`owns database ${row!.database}`] : []),
  ]
}

// What `role` may do that a runtime role never may: create in the schema, create temporary tables, rewrite the evidence, reach the migration receipts
// in schema `drizzle`, or truncate or add a trigger to any table.
async function reach(db: Executor, role: string) {
  const [row] = await rows<{ create: boolean; temp: boolean; drizzle: boolean; database: string }>(db, sql`select has_schema_privilege(${role}::name, 'public', 'CREATE') as create,
    has_database_privilege(${role}::name, current_database(), 'TEMP') as temp,
    case when to_regnamespace('drizzle') is null then false else has_schema_privilege(${role}::name, 'drizzle', 'USAGE') end as drizzle,
    current_database() as database`)
  const held = await rows<{ privilege: string; tables: string[] }>(db, sql`select forbidden.privilege, array_agg(relation.name order by relation.name collate "C") as tables
    from (select c.oid, case when n.nspname = 'public' then c.relname::text else n.nspname || '.' || c.relname end as name
        from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'drizzle') and c.relkind in ('r', 'p')) as relation
      join (values ('UPDATE', 1, 'evidence_events'), ('UPDATE', 1, 'drizzle.__drizzle_migrations'), ('DELETE', 2, 'evidence_events'), ('DELETE', 2, 'evidence_payloads'),
        ('DELETE', 2, 'drizzle.__drizzle_migrations'), ('INSERT', 3, 'drizzle.__drizzle_migrations'), ('TRUNCATE', 4, null), ('TRIGGER', 5, null)) as forbidden (privilege, rank, relation)
        on forbidden.relation is null or forbidden.relation = relation.name
    where has_table_privilege(${role}::name, relation.oid, forbidden.privilege)
    group by forbidden.privilege, forbidden.rank order by forbidden.rank`)
  return [
    ...(row!.create ? ["holds CREATE on schema public"] : []),
    ...(row!.temp ? [`holds TEMP on database ${row!.database}`] : []),
    ...(row!.drizzle ? ["holds USAGE on schema drizzle"] : []),
    ...held.map(grant => `holds ${grant.privilege} on ${grant.tables.join(", ")}`),
  ]
}

/**
 * Make `role` a server's runtime role on the connected database, and give it exactly `grants`: the role is created without login when it does
 * not exist (its login and password belong to deployment tooling), and refused when it has an attribute beyond login, belongs to another role or
 * owns anything there. Every privilege it held on schema `public`, its tables, sequences and functions is revoked first, together with `CREATE`
 * on the schema and `TEMP` on the database for everyone, and default privileges grant it nothing, so a table a later migration adds stays out of
 * its reach until a grant names it; schema `drizzle`, where the migration receipts are, is revoked too. Run by the owner after every `migrate`;
 * a second run changes nothing.
 */
export async function configureRuntimeRole(db: Executor, role: string, grants: readonly Grant[]): Promise<void> {
  if (!identifier.test(role)) throw new Error(`Invalid runtime role name "${role}"`)
  for (const grant of grants) {
    if (!identifier.test(grant.table)) throw new Error(`Invalid table name "${grant.table}"`)
    const unknown = grant.privileges.find(privilege => !privileges.has(privilege))
    if (unknown) throw new Error(`Invalid privilege "${unknown}" on ${grant.table}`)
  }
  // Quoted, so that a valid name that is also a keyword, such as "user", stays a name.
  const quoted = quote(role)
  await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('answerable:mcp-runtime-role'))`)
    if (!(await rows(tx, sql`select 1 from pg_roles where rolname = ${role}`)).length) {
      await tx.execute(sql.raw(`create role ${quoted} nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls`))
    }
    const problems = await standing(tx, role)
    if (problems.length) throw new Error(`Refusing to provision ${role} as a runtime role: ${problems.join("; ")}`)
    const [{ database, drizzle }] = await rows<{ database: string; drizzle: boolean }>(tx, sql`select current_database() as database, to_regnamespace('drizzle') is not null as drizzle`)
    await tx.execute(sql.raw(`
      revoke create on schema public from public;
      revoke temporary on database ${quote(database)} from public, ${quoted};
      revoke all on schema public from ${quoted};
      grant usage on schema public to ${quoted};
      revoke all on all tables in schema public from public, ${quoted};
      revoke all on all sequences in schema public from public, ${quoted};
      alter default privileges revoke all on tables from public, ${quoted};
      alter default privileges revoke all on sequences from public, ${quoted};
      alter default privileges in schema public revoke all on tables from public, ${quoted};
      alter default privileges in schema public revoke all on sequences from public, ${quoted};
      ${drizzle ? `revoke all on schema drizzle from public, ${quoted};
      revoke all on all tables in schema drizzle from public, ${quoted};
      revoke all on all sequences in schema drizzle from public, ${quoted};` : ""}
      ${grants.filter(grant => grant.privileges.length).map(grant => `grant ${grant.privileges.join(", ")} on public.${quote(grant.table)} to ${quoted};`).join("\n")}
    `))
    // Only the routines the owner holds: a managed Postgres keeps extension routines in public under another owner (Civo's
    // pg_stat_monitor), and a revoke on those is refused, not skipped.
    const routines = await rows<{ signature: string }>(tx, sql`select format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) as signature
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and pg_get_userbyid(p.proowner) = current_user`)
    for (const routine of routines) await tx.execute(sql.raw(`revoke all on routine ${routine.signature} from ${quoted}`))
  })
}

/**
 * Refuse to serve as a login that could change the evidence behind the server's back: one with an attribute beyond login, a member of another
 * role, an owner of the database, of schema `public` or of anything in it (the migration's owner above all), or one that may create in the
 * schema, create temporary tables, update or delete events, delete payloads, reach the migration receipts in schema `drizzle`, or truncate or add
 * a trigger to any table. The error names each of these the connected role has. A server awaits it before it listens.
 */
export async function assertRuntimeRole(db: Executor): Promise<void> {
  const [{ role }] = await rows<{ role: string }>(db, sql`select current_user::text as role`)
  const problems = [...await standing(db, role), ...await reach(db, role)]
  if (problems.length) {
    throw new Error(`Database role ${role} is not a restricted runtime role: ${problems.join("; ")}. Serve as the runtime login that the migration provisions, never as the owner`)
  }
}
