import { afterAll, beforeAll, expect, test } from "bun:test"
import { AsyncLocalStorage } from "node:async_hooks"
import { eq, sql } from "drizzle-orm"
import { Pool, type PoolClient } from "pg"
import { ensureLocalMcpDatabases } from "./local"
import { mcpDatabase } from "./mcp-database"
import { migrateMcps } from "./migrate-mcp"
import { sharedMcps } from "./names"
import { provisionMcps, sqlOf } from "./provision"
import * as fixtureA from "./test/fixtures/mpgfixa"
import { notes, projects } from "./test/fixtures/mpgfixa"
import * as fixtureB from "./test/fixtures/mpgfixb"
import { secrets } from "./test/fixtures/mpgfixb"
import { as, clientOf, clusterUrl, fixtureFolder, forget, mcpsUrl, testLogin } from "./test/mcps"
import { refusalOf } from "./testing"

// The Toolbox's shape: one serving login granted both MCPs' schemas, one pool, and a database for each MCP over it.
const admin = new Pool({ connectionString: mcpsUrl, max: 1 })
const organisations = new AsyncLocalStorage<string | undefined>()
const organisation = () => organisations.getStore()
/** Run `query` for `id`, inside the scope `organisation()` reads, as a tool call does. */
const asOrganisation = <T>(id: string | undefined, query: () => PromiseLike<T>) => organisations.run(id, async () => await query())
let login: Awaited<ReturnType<typeof testLogin>>
let pool: Pool
let a: ReturnType<typeof mcpDatabase<typeof fixtureA>>
let b: ReturnType<typeof mcpDatabase<typeof fixtureB>>
beforeAll(async () => {
  await ensureLocalMcpDatabases(clusterUrl)
  await forget(admin, "mpgfixa", "mpgfixb")
  login = await testLogin(admin)
  await provisionMcps(sqlOf(admin), { mcps: [{ name: "mpgfixa" }, { name: "mpgfixb" }], logins: { ...sharedMcps.logins, toolbox: login.name } })
  const migrator = await clientOf(as(sharedMcps.logins.migrator))
  try {
    await migrateMcps((["mpgfixa", "mpgfixb"] as const).map(name => ({ name, folder: fixtureFolder(name), serving: login.name })), () => migrator)
  } finally {
    await migrator.end()
  }
  pool = new Pool({ connectionString: login.url, max: 4 })
  a = mcpDatabase(pool, { name: "mpgfixa", schema: fixtureA, organisation })
  b = mcpDatabase(pool, { name: "mpgfixb", schema: fixtureB, organisation })
})
afterAll(async () => {
  await pool.end()
  await login.drop()
  await forget(admin, "mpgfixa", "mpgfixb")
  await admin.end()
})

const who = sql.raw("select current_user::text as role, current_setting('search_path') as path, nullif(current_setting('answerable.organisation_id', true), '') as organisation")
const project = (id: string) => asOrganisation(id, () => a.insert(projects).values({ organisation_id: id, name: "Tower" }).returning().then(([row]) => row!))

test("queries and drizzle transactions run as the serving login itself, which owns no table, in the MCP's schema, for the caller's organisation", async () => {
  const id = crypto.randomUUID()
  expect((await asOrganisation(id, () => a.execute(who))).rows).toEqual([{ role: login.name, path: "mpgfixa", organisation: id }])
  expect(await asOrganisation(id, () => a.transaction(async tx => (await tx.execute(who)).rows))).toEqual([{ role: login.name, path: "mpgfixa", organisation: id }])
  expect((await asOrganisation(id, () => b.execute(who))).rows).toEqual([{ role: login.name, path: "mpgfixb", organisation: id }])
  // Row-level security binds every login but a table's owner: the migrator owns them all.
  expect((await admin.query("select distinct tableowner from pg_tables where schemaname in ('mpgfixa', 'mpgfixb')")).rows).toEqual([{ tableowner: "answerable_mcps_migrator" }])
  // The search path makes an unqualified name the MCP's own.
  expect((await asOrganisation(id, () => a.execute(sql`select count(*)::int as notes from notes`))).rows).toEqual([{ notes: 0 }])
})

test("organisation A's rows are invisible as B, and neither an insert nor an update can write B's rows as A", async () => {
  const [first, second] = [crypto.randomUUID(), crypto.randomUUID()]
  const tower = await project(first)
  await asOrganisation(first, () => a.insert(notes).values({ organisation_id: first, project_id: tower.id, body: "Pour the slab" }))
  expect(await asOrganisation(first, () => a.select({ body: notes.body }).from(notes))).toEqual([{ body: "Pour the slab" }])
  expect(await asOrganisation(second, () => a.select().from(notes))).toEqual([])
  expect(await asOrganisation(second, () => a.update(notes).set({ body: "Taken" }).returning())).toEqual([])
  expect(await refusalOf(asOrganisation(first, () => a.insert(projects).values({ organisation_id: second, name: "Planted" })))).toBe('new row violates row-level security policy for table "projects"')
  expect(await refusalOf(asOrganisation(first, () => a.update(projects).set({ organisation_id: second }).where(eq(projects.id, tower.id))))).toBe('new row violates row-level security policy for table "projects"')
})

test("with no organisation there are no rows and every insert is refused; an organisation that is not a UUID borrows nothing", async () => {
  const id = crypto.randomUUID()
  await project(id)
  expect(await asOrganisation(undefined, () => a.select().from(projects))).toEqual([])
  expect(await refusalOf(asOrganisation(undefined, () => a.insert(projects).values({ organisation_id: id, name: "Orphan" })))).toBe('new row violates row-level security policy for table "projects"')
  const open = pool.totalCount
  expect(await refusalOf(asOrganisation("acme", () => a.select().from(projects)))).toBe('The organisation "acme" is not a UUID')
  expect(pool.totalCount).toBe(open)
})

test("a thrown transaction rolls back", async () => {
  const id = crypto.randomUUID()
  await expect(asOrganisation(id, () => a.transaction(async tx => {
    await tx.insert(projects).values({ organisation_id: id, name: "Abandoned" })
    throw new Error("Changed my mind")
  }))).rejects.toThrow("Changed my mind")
  expect(await asOrganisation(id, () => a.select().from(projects))).toEqual([])
})

test("a query naming another MCP's schema reaches it, since one login serves both, and still sees only the caller's organisation; the journal stays out of reach", async () => {
  const [first, second] = [crypto.randomUUID(), crypto.randomUUID()]
  for (const id of [first, second]) await asOrganisation(id, () => b.insert(secrets).values({ organisation_id: id, value: `Of ${id}` }))
  expect((await asOrganisation(first, () => a.execute(sql`select value from mpgfixb.secrets`))).rows).toEqual([{ value: `Of ${first}` }])
  expect((await asOrganisation(undefined, () => a.execute(sql`select value from mpgfixb.secrets`))).rows).toEqual([])
  expect(await refusalOf(asOrganisation(first, () => a.execute(sql`select * from __drizzle_migrations`)))).toBe("permission denied for table __drizzle_migrations")
})

test("a borrow never keeps the last one's organisation or schema: on one connection, after a call of one organisation, a call of none sees no row", async () => {
  const single = new Pool({ connectionString: login.url, max: 1 })
  try {
    const [one, none] = [mcpDatabase(single, { name: "mpgfixa", schema: fixtureA, organisation }), mcpDatabase(single, { name: "mpgfixb", schema: fixtureB, organisation })]
    const id = crypto.randomUUID()
    await asOrganisation(id, () => one.insert(projects).values({ organisation_id: id, name: "Kept" }))
    expect((await asOrganisation(undefined, () => none.execute(who))).rows).toEqual([{ role: login.name, path: "mpgfixb", organisation: null }])
    expect(await asOrganisation(undefined, () => one.select().from(projects))).toEqual([])
    expect(single.totalCount).toBe(1)
  } finally {
    await single.end()
  }
})

test("a connection released inside a transaction, or whose setup fails, is destroyed rather than returned", async () => {
  const id = crypto.randomUUID()
  await asOrganisation(id, () => a.execute(sql`select 1`))
  expect(await refusalOf(asOrganisation(id, () => a.execute(sql`select nonsense`)))).toBe('column "nonsense" does not exist')
  await expect(asOrganisation(id, () => a.transaction(async tx => { await tx.execute(sql`select 1`); throw new Error("thrown") }))).rejects.toThrow("thrown")
  expect(await refusalOf(asOrganisation(id, () => a.transaction(tx => tx.execute(sql`select nonsense`))))).toBe('column "nonsense" does not exist')
  const removed = () => new Promise(resolve => pool.once("remove", resolve))
  const inside = removed()
  await asOrganisation(id, () => a.execute(sql`begin`))
  await inside
  // A setup that fails, here injected on the next connection the pool hands out, fails the borrow, and that connection goes too.
  pool.once("acquire", (client: PoolClient) => Object.assign(client, { query: () => Promise.reject(new Error("injected")) }))
  const failed = removed()
  expect(await refusalOf(asOrganisation(id, () => a.execute(sql`select 1`)))).toBe("injected")
  await failed
  // The pool still serves.
  expect((await asOrganisation(id, () => a.execute(who))).rows).toEqual([{ role: login.name, path: "mpgfixa", organisation: id }])
})

test("200 interleaved calls for two organisations on one database never see each other's rows", async () => {
  const pair = [crypto.randomUUID(), crypto.randomUUID()] as const
  const towers = await Promise.all(pair.map(project))
  const seen = await Promise.all(Array.from({ length: 200 }, (_, index) => {
    const id = pair[index % 2]!
    return asOrganisation(id, async () => {
      if (index % 4 < 2) await a.insert(notes).values({ organisation_id: id, project_id: towers[index % 2]!.id, body: `Note ${index}` })
      const rows = index % 8 < 4 ? await a.select().from(notes) : await a.transaction(tx => tx.select().from(notes))
      return { id, visible: [...new Set(rows.map(row => row.organisation_id))] }
    })
  }))
  for (const { id, visible } of seen) expect(visible.filter(other => other !== id)).toEqual([])
  for (const id of pair) expect(await asOrganisation(id, () => a.select().from(notes).then(rows => rows.length))).toBe(50)
})
