import { afterAll, beforeAll, expect, test } from "bun:test"
import { AsyncLocalStorage } from "node:async_hooks"
import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Client, Pool } from "pg"
import { mcpDatabase } from "./mcp-database"
import { migrateMcp } from "./migrate-mcp"
import { provisionOwnMcp, sqlOf } from "./provision"
import { assertOwnLogin } from "./serving-login"
import { database } from "./test/database"
import * as fixtureA from "./test/fixtures/mpgfixa"
import { projects } from "./test/fixtures/mpgfixa"
import { clientOf, fixtureFolder, mcpsUrl, testLogin } from "./test/mcps"
import { refusalOf } from "./testing"

// An MCP with a database of its own, made here as the deployment makes one: owned by its owner login, reachable by it and its runtime login alone.
const admin = new Pool({ connectionString: mcpsUrl, max: 1 })
const organisations = new AsyncLocalStorage<string | undefined>()
const asOrganisation = <T>(id: string | undefined, query: () => PromiseLike<T>) => organisations.run(id, async () => await query())
let scratch: Awaited<ReturnType<typeof database.scratch>>
let owner: Awaited<ReturnType<typeof testLogin>>
let runtime: Awaited<ReturnType<typeof testLogin>>
let pool: Pool
/** `work` on a connection as the database's owner login. */
const asOwner = async (work: (client: Client) => Promise<unknown>) => {
  const client = await clientOf(owner.url)
  try {
    await work(client)
  } finally {
    await client.end()
  }
}
const provision = () => asOwner(client => provisionOwnMcp(sqlOf(client), { name: "mpgfixa", owner: owner.name, runtime: runtime.name }))
const migrateAsOwner = () => asOwner(client => migrateMcp({ client, name: "mpgfixa", folder: fixtureFolder("mpgfixa"), mode: "own", runtime: runtime.name }))
const relations = async () => (await scratch.db.$client.query("select relname, pg_get_userbyid(relowner) as owner, relacl::text as acl from pg_class where relnamespace = 'mpgfixa'::regnamespace order by 1")).rows
beforeAll(async () => {
  scratch = await database.scratch("ownmode")
  owner = await testLogin(admin, "noinherit", scratch.url)
  runtime = await testLogin(admin, "noinherit", scratch.url)
  await admin.query(`alter database answerable_mcp_postgres_test_ownmode owner to ${owner.name}; revoke all on database answerable_mcp_postgres_test_ownmode from public;
    grant connect on database answerable_mcp_postgres_test_ownmode to ${owner.name}, ${runtime.name}`)
  pool = new Pool({ connectionString: runtime.url, max: 2 })
})
afterAll(async () => {
  await pool.end()
  await scratch.drop()
  await admin.query(`drop role ${owner.name}; drop role ${runtime.name}`)
  await admin.end()
})

// The tests run in order: provisioned, then migrated, then served.
test("its owner login makes the schema and gives the runtime login USAGE, sets no role setting and changes nothing else, twice", async () => {
  const state = async () => ({
    roles: (await admin.query("select rolname, rolcanlogin, rolinherit, rolconfig from pg_roles where rolname = any($1) order by 1", [[owner.name, runtime.name]])).rows,
    settings: (await admin.query("select setdatabase, setconfig from pg_db_role_setting where setrole = any(select oid from pg_roles where rolname = any($1))", [[owner.name, runtime.name]])).rows,
    memberships: (await admin.query("select roleid::regrole::text as role from pg_auth_members where member = any(select oid from pg_roles where rolname = any($1))", [[owner.name, runtime.name]])).rows,
    schemas: (await scratch.db.$client.query("select nspname, pg_get_userbyid(nspowner) as owner, nspacl::text as acl from pg_namespace where nspname !~ '^pg_' and nspname <> 'information_schema' order by 1")).rows,
  })
  const before = await state()
  await provision()
  const after = await state()
  expect(after).toEqual({ ...before, schemas: [{ nspname: "mpgfixa", owner: owner.name, acl: `{${owner.name}=UC/${owner.name},${runtime.name}=U/${owner.name}}` }, ...before.schemas] })
  await provision()
  expect(await state()).toEqual(after)
})

test("the owner login migrates its schema with the journal in it, grants the runtime login the default, and a second run changes nothing", async () => {
  await migrateAsOwner()
  const migrated = await relations()
  expect(migrated.filter(row => !row.relname.endsWith("_pkey")).map(({ relname, owner: by }) => ({ relname, by }))).toEqual(
    ["__drizzle_migrations", "__drizzle_migrations_id_seq", "notes", "notes_id_seq", "projects"].map(relname => ({ relname, by: owner.name })))
  expect(migrated.find(row => row.relname === "notes")!.acl).toBe(`{${owner.name}=arwdDxtm/${owner.name},${runtime.name}=arwd/${owner.name}}`)
  expect(migrated.find(row => row.relname === "__drizzle_migrations")!.acl).toBe(`{${owner.name}=arwdDxtm/${owner.name}}`)
  await migrateAsOwner()
  expect(await relations()).toEqual(migrated)
})

test("served as the runtime login itself, with no role taken, in the MCP's schema, with the same organisation isolation", async () => {
  const [first, second] = [crypto.randomUUID(), crypto.randomUUID()]
  const db = mcpDatabase(pool, { name: "mpgfixa", schema: fixtureA, mode: "own", organisation: () => organisations.getStore() })
  expect((await asOrganisation(first, () => db.execute(sql`select current_user::text as role, current_setting('search_path') as path`))).rows).toEqual([{ role: runtime.name, path: "mpgfixa" }])
  await asOrganisation(first, () => db.insert(projects).values({ organisation_id: first, name: "Tower" }))
  expect(await asOrganisation(first, () => db.select({ name: projects.name }).from(projects))).toEqual([{ name: "Tower" }])
  expect(await asOrganisation(second, () => db.select().from(projects))).toEqual([])
  expect(await refusalOf(asOrganisation(second, () => db.insert(projects).values({ organisation_id: first, name: "Planted" })))).toBe('new row violates row-level security policy for table "projects"')
  expect(await refusalOf(asOrganisation(first, () => db.execute(sql`create table mpgfixa.extra (id int)`)))).toBe("permission denied for schema mpgfixa")
})

test("its runtime login may serve it: no attribute but login, no membership, owns nothing, no CREATE or TEMPORARY on the database, USAGE on its schema", async () => {
  const db = drizzle({ client: pool })
  await assertOwnLogin(db, { name: "mpgfixa" })
  const refusal = (problems: string) => `Database role ${runtime.name} may not serve the own MCP mpgfixa: ${problems}. Serve as its runtime login, which provisioning made`
  const database = "answerable_mcp_postgres_test_ownmode"
  /** Make `change`, expect the assertion to refuse with `problems`, then `undo`, and expect it to pass again. */
  async function refused(change: string, problems: string, undo: string, on: Pool | Client = admin) {
    await on.query(change)
    try {
      await expect(assertOwnLogin(db, { name: "mpgfixa" })).rejects.toThrow(refusal(problems))
    } finally {
      await on.query(undo)
    }
    await assertOwnLogin(db, { name: "mpgfixa" })
  }
  await refused(`alter role ${runtime.name} createdb`, "has CREATEDB", `alter role ${runtime.name} nocreatedb`)
  await refused(`grant pg_read_all_data to ${runtime.name}`, "is a member of pg_read_all_data", `revoke pg_read_all_data from ${runtime.name}`)
  await refused(`grant create, temporary on database ${database} to ${runtime.name}`, `holds CREATE on database ${database}; holds TEMPORARY on database ${database}`, `revoke create, temporary on database ${database} from ${runtime.name}`)
  await asOwner(client => refused(`revoke usage on schema mpgfixa from ${runtime.name}`, "lacks USAGE on schema mpgfixa", `grant usage on schema mpgfixa to ${runtime.name}`, client))
  await asOwner(client => refused(`grant create on schema mpgfixa to ${runtime.name}`, "holds CREATE on schema mpgfixa", `revoke create on schema mpgfixa from ${runtime.name}`, client))
  await refused(`create table mpgfix_owned (id int); alter table mpgfix_owned owner to ${runtime.name}`, "owns table mpgfix_owned", "drop table mpgfix_owned", scratch.db.$client)
})
