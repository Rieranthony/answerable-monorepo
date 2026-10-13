import type { SQL } from "bun"

/** A privilege a runtime role may hold on a table. TRUNCATE, TRIGGER and REFERENCES are never granted. */
export type Privilege = "select" | "insert" | "update" | "delete"
/** A table of schema `public` and what a server's runtime role may do to its rows. A table no grant names is out of the role's reach. */
export type Grant = { table: string; privileges: readonly Privilege[] }

/**
 * What this package's tables need at run time: the evidence is appended and read, a payload's body is erased, and intents move and are swept.
 * Nothing on `schema_migrations`. A server passes these to `configureRuntimeRole` with a grant for each of its own tables.
 */
export const runtimeGrants: readonly Grant[] = [
  { table: "evidence_events", privileges: ["select", "insert"] },
  { table: "evidence_payloads", privileges: ["select", "insert", "update"] },
  { table: "intents", privileges: ["select", "insert", "update", "delete"] },
]

const identifier = /^[a-z_][a-z0-9_]{0,62}$/
const privileges = new Set<string>(["select", "insert", "update", "delete"])
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

// What makes `role` unfit to run a server whatever it is granted: an attribute beyond login, a role it belongs to, or an object it owns.
async function standing(db: SQL, role: string) {
  const [row] = await db`select r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls,
      array(select m.rolname::text from pg_auth_members a join pg_roles m on m.oid = a.roleid where a.member = r.oid) as memberships,
      array(select c.relname::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f') and c.relowner = r.oid
        union all select p.proname || '()' from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proowner = r.oid) as owned,
      exists(select 1 from pg_namespace where nspname = 'public' and nspowner = r.oid) as owns_schema,
      exists(select 1 from pg_database where datname = current_database() and datdba = r.oid) as owns_database,
      current_database() as database
    from pg_roles r where r.rolname = ${role}`
  const sorted = (names: string[]) => names.toSorted((a, b) => (a < b ? -1 : 1)).join(", ")
  return [
    ...([["rolsuper", "SUPERUSER"], ["rolcreatedb", "CREATEDB"], ["rolcreaterole", "CREATEROLE"], ["rolreplication", "REPLICATION"], ["rolbypassrls", "BYPASSRLS"]] as const)
      .filter(([column]) => row[column]).map(([, attribute]) => `has ${attribute}`),
    ...(row.memberships.length ? [`is a member of ${sorted(row.memberships)}`] : []),
    ...(row.owned.length ? [`owns ${sorted(row.owned)} in schema public`] : []),
    ...(row.owns_schema ? ["owns schema public"] : []),
    ...(row.owns_database ? [`owns database ${row.database}`] : []),
  ]
}

// What `role` may do that a runtime role never may: create in the schema, create temporary tables, rewrite the evidence or the migration
// records, or truncate or add a trigger to any table.
async function reach(db: SQL, role: string) {
  const [row] = await db`select has_schema_privilege(${role}::name, 'public', 'CREATE') as create, has_database_privilege(${role}::name, current_database(), 'TEMP') as temp`
  const held = await db`select forbidden.privilege, array_agg(c.relname::text order by c.relname collate "C") as tables
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
      join (values ('UPDATE', 1, 'evidence_events'), ('DELETE', 2, 'evidence_events'), ('DELETE', 2, 'evidence_payloads'), ('UPDATE', 1, 'schema_migrations'),
        ('DELETE', 2, 'schema_migrations'), ('INSERT', 3, 'schema_migrations'), ('TRUNCATE', 4, null), ('TRIGGER', 5, null)) as forbidden (privilege, rank, relation)
        on forbidden.relation is null or forbidden.relation = c.relname
    where n.nspname = 'public' and c.relkind in ('r', 'p') and has_table_privilege(${role}::name, c.oid, forbidden.privilege)
    group by forbidden.privilege, forbidden.rank order by forbidden.rank`
  const [{ database }] = await db`select current_database() as database`
  return [
    ...(row.create ? ["holds CREATE on schema public"] : []),
    ...(row.temp ? [`holds TEMP on database ${database}`] : []),
    ...held.map((grant: { privilege: string; tables: string[] }) => `holds ${grant.privilege} on ${grant.tables.join(", ")}`),
  ]
}

/**
 * Make `role` a server's runtime role on the connected database, and give it exactly `grants`: the role is created without login when it does
 * not exist (its login and password belong to deployment tooling), and refused when it has an attribute beyond login, belongs to another role or
 * owns anything there. Every privilege it held on schema `public`, its tables, sequences and functions is revoked first, together with `CREATE`
 * on the schema and `TEMP` on the database for everyone, and default privileges grant it nothing, so a table a later migration adds stays out of
 * its reach until a grant names it. Run by the owner after every `migrate`; a second run changes nothing.
 */
export async function configureRuntimeRole(db: SQL, role: string, grants: readonly Grant[]): Promise<void> {
  if (!identifier.test(role)) throw new Error(`Invalid runtime role name "${role}"`)
  for (const grant of grants) {
    if (!identifier.test(grant.table)) throw new Error(`Invalid table name "${grant.table}"`)
    const unknown = grant.privileges.find(privilege => !privileges.has(privilege))
    if (unknown) throw new Error(`Invalid privilege "${unknown}" on ${grant.table}`)
  }
  await db.begin(async tx => {
    await tx`select pg_advisory_xact_lock(hashtext('answerable:mcp-runtime-role'))`
    if (!(await tx`select 1 from pg_roles where rolname = ${role}`).length) {
      await tx.unsafe(`create role ${role} nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls`)
    }
    const problems = await standing(tx, role)
    if (problems.length) throw new Error(`Refusing to provision ${role} as a runtime role: ${problems.join("; ")}`)
    const [{ database }] = await tx`select current_database() as database`
    await tx.unsafe(`
      revoke create on schema public from public;
      revoke temporary on database ${quote(database)} from public, ${role};
      revoke all on schema public from ${role};
      grant usage on schema public to ${role};
      revoke all on all tables in schema public from public, ${role};
      revoke all on all sequences in schema public from public, ${role};
      revoke all on all functions in schema public from ${role};
      alter default privileges revoke all on tables from public, ${role};
      alter default privileges revoke all on sequences from public, ${role};
      alter default privileges in schema public revoke all on tables from public, ${role};
      alter default privileges in schema public revoke all on sequences from public, ${role};
      ${grants.filter(grant => grant.privileges.length).map(grant => `grant ${grant.privileges.join(", ")} on ${grant.table} to ${role};`).join("\n")}
    `).simple()
  })
}

/**
 * Refuse to serve as a login that could change the evidence behind the server's back: one with an attribute beyond login, a member of another
 * role, an owner of the database, of schema `public` or of anything in it (the migration's owner above all), or one that may create in the
 * schema, create temporary tables, update or delete events, delete payloads, write `schema_migrations`, or truncate or add a trigger to any table.
 * The error names each of these the connected role has. A server awaits it before it listens.
 */
export async function assertRuntimeRole(db: SQL): Promise<void> {
  const [{ role }] = await db`select current_user::text as role`
  const problems = [...await standing(db, role), ...await reach(db, role)]
  if (problems.length) {
    throw new Error(`Database role ${role} is not a restricted runtime role: ${problems.join("; ")}. Serve as the runtime login that the migration provisions, never as the owner`)
  }
}
