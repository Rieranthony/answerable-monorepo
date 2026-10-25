import { afterAll, beforeAll, expect, test } from "bun:test"
import { AsyncLocalStorage } from "node:async_hooks"
import { eq, sql } from "drizzle-orm"
import { Pool, type PoolClient } from "pg"
import { ensureLocalMcpDatabases } from "./local"
import { mcpDatabase } from "./mcp-database"
import { migrateMcps } from "./migrate-mcp"
import { provisionMcps } from "./provision"
import * as fixtureA from "./test/fixtures/mpgfixa"
import { notes, projects } from "./test/fixtures/mpgfixa"
import * as fixtureB from "./test/fixtures/mpgfixb"
import { as, clientOf, clusterUrl, fixtureFolder, forget, localLogins, mcpsUrl, sqlOf, testLogin } from "./test/mcps"
import { refusalOf } from "./testing"

// The Toolbox's shape: one serving login that holds both MCPs' runtime roles, one pool, and a database for each MCP over it.
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
  await provisionMcps(sqlOf(admin), { mcps: [{ name: "mpgfixa", servedBy: ["toolbox"] }, { name: "mpgfixb", servedBy: ["toolbox"] }], prefix: "mcp_test", logins: { ...localLogins, toolbox: login.name } })
  const migrator = await clientOf(as(localLogins.migrator))
  try {
    await migrateMcps((["mpgfixa", "mpgfixb"] as const).map(name => ({ name, folder: fixtureFolder(name), mode: "shared", prefix: "mcp_test" })), () => migrator)
  } finally {
    await migrator.end()
  }
  pool = new Pool({ connectionString: login.url, max: 4 })
  a = mcpDatabase(pool, { name: "mpgfixa", prefix: "mcp_test", schema: fixtureA, mode: "shared", organisation })
  b = mcpDatabase(pool, { name: "mpgfixb", prefix: "mcp_test", schema: fixtureB, mode: "shared", organisation })
})
afterAll(async () => {
  await pool.end()
  await login.drop()
  await forget(admin, "mpgfixa", "mpgfixb")
  await admin.end()
})

const whoText = "select current_user::text as role, current_setting('search_path') as path, nullif(current_setting('answerable.organisation_id', true), '') as organisation"
const who = sql.raw(whoText)
const state = async (client: Pool | PoolClient) => (await client.query(whoText)).rows[0]
const clean = () => ({ role: login.name, path: '"$user", public', organisation: null })
const project = (id: string) => asOrganisation(id, () => a.insert(projects).values({ organisation_id: id, name: "Tower" }).returning().then(([row]) => row!))

test("queries and drizzle transactions run as the MCP's runtime role, in its schema, for the caller's organisation", async () => {
  const id = crypto.randomUUID()
  expect((await asOrganisation(id, () => a.execute(who))).rows).toEqual([{ role: "mcp_test_mpgfixa", path: "mpgfixa", organisation: id }])
  expect(await asOrganisation(id, () => a.transaction(async tx => (await tx.execute(who)).rows))).toEqual([{ role: "mcp_test_mpgfixa", path: "mpgfixa", organisation: id }])
  expect((await asOrganisation(id, () => b.execute(who))).rows).toEqual([{ role: "mcp_test_mpgfixb", path: "mpgfixb", organisation: id }])
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

test("an MCP cannot read another MCP's schema, nor the journal of its own", async () => {
  const id = crypto.randomUUID()
  expect(await refusalOf(asOrganisation(id, () => a.execute(sql`select * from mpgfixb.secrets`)))).toBe("permission denied for schema mpgfixb")
  expect(await refusalOf(asOrganisation(id, () => b.execute(sql`select * from mpgfixa.projects`)))).toBe("permission denied for schema mpgfixa")
  expect(await refusalOf(asOrganisation(id, () => a.execute(sql`select * from __drizzle_migrations`)))).toBe("permission denied for table __drizzle_migrations")
})

test("after a query succeeds or fails, a transaction throws or one is left open, every connection of the shared pool is the serving login again", async () => {
  const id = crypto.randomUUID()
  await asOrganisation(id, () => a.execute(sql`select 1`))
  expect(await refusalOf(asOrganisation(id, () => a.execute(sql`select nonsense`)))).toBe('column "nonsense" does not exist')
  await expect(asOrganisation(id, () => a.transaction(async tx => { await tx.execute(sql`select 1`); throw new Error("thrown") }))).rejects.toThrow("thrown")
  expect(await refusalOf(asOrganisation(id, () => a.transaction(tx => tx.execute(sql`select nonsense`))))).toBe('column "nonsense" does not exist')
  // A connection released inside a transaction block is destroyed, not reset inside it.
  const removed = new Promise(resolve => pool.once("remove", resolve))
  await asOrganisation(id, () => a.execute(sql`begin`))
  await removed
  // A role the login cannot take fails the borrow, and that connection goes too.
  const unknown = mcpDatabase(pool, { name: "mpgfixc", prefix: "mcp_test", schema: {}, mode: "shared", organisation })
  expect(await refusalOf(asOrganisation(id, () => unknown.execute(sql`select 1`)))).toBe('role "mcp_test_mpgfixc" does not exist')
  const clients = await Promise.all(Array.from({ length: 4 }, () => pool.connect()))
  try {
    for (const client of clients) expect(await state(client)).toEqual(clean())
  } finally {
    for (const client of clients) client.release()
  }
})

test("a connection whose reset fails is destroyed, not returned with its role, and the next borrow is clean", async () => {
  const id = crypto.randomUUID()
  const client = await organisations.run(id, () => (a as unknown as { $client: Pool }).$client.connect())
  expect(await state(client)).toEqual({ role: "mcp_test_mpgfixa", path: "mpgfixa", organisation: id })
  const query = client.query.bind(client) as (text: string) => Promise<unknown>
  Object.assign(client, { query: (text: string) => (text.startsWith("reset role") ? Promise.reject(new Error("injected")) : query(text)) })
  const removed = new Promise(resolve => pool.once("remove", resolve))
  const open = pool.totalCount
  client.release()
  await removed
  expect(pool.totalCount).toBe(open - 1)
  expect(await state(pool)).toEqual(clean())
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
