import { afterAll, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { Pool } from "pg"
import * as fixtureA from "./test/fixtures/mpgfixa"
import { projects } from "./test/fixtures/mpgfixa"
import * as fixtureB from "./test/fixtures/mpgfixb"
import { secrets } from "./test/fixtures/mpgfixb"
import { fixtureFolder, forget, mcpsUrl } from "./test/mcps"
import { refusalOf, testDatabase, testMcpDatabase } from "./testing"

const admin = new Pool({ connectionString: mcpsUrl, max: 1 })
afterAll(async () => {
  // The helper never drops an MCP's roles; this suite's fixtures are its own to remove.
  await forget(admin, "mpgfixa", "mpgfixb")
  await admin.end()
})
const who = sql`select session_user::text as login, current_user::text as role, nullif(current_setting('answerable.organisation_id', true), '') as organisation`

test("a test database refuses a URL that names any other database before it is reset, migrated, connected to or built beside", async () => {
  const named = (url?: string) => testDatabase("answerable_example_test", url)
  expect(named().url).toBe("postgres://answerable:answerable@localhost:47432/answerable_example_test")
  expect(() => named("postgres://u:p@localhost:47436/answerable_example_test").assertDisposable("reset")).not.toThrow()
  expect(() => named("postgres://u:p@localhost:47432/answerable_admin").assertDisposable("migrate")).toThrow("Refusing to migrate answerable_admin; expected answerable_example_test")
  expect(() => named("postgres://u:p@localhost:47432/answerable_toolbox_test").connect()).toThrow("Refusing to connect to answerable_toolbox_test; expected answerable_example_test")
  expect(() => named("postgres://u:p@localhost:47432").assertDisposable("reset")).toThrow("Refusing to reset an unnamed database; expected answerable_example_test")
  await expect(named("postgres://u:p@localhost:47432/answerable_toolbox").runtimeLogin([])).rejects.toThrow("Refusing to provision a login on answerable_toolbox; expected answerable_example_test")
  await expect(named("postgres://u:p@localhost:47432/answerable_toolbox").scratch("legacy")).rejects.toThrow("Refusing to create a scratch database beside answerable_toolbox; expected answerable_example_test")
})

test("refusalOf gives the database's message from drizzle's query error, any other error's message, and refuses a query that succeeded", async () => {
  expect(await refusalOf(Promise.reject(new Error("plain")))).toBe("plain")
  await expect(refusalOf(Promise.resolve(1))).rejects.toThrow("The query succeeded")
})

test("two MCPs' suites run at once, each in its own schema as a login of its own, and close() leaves no login behind", async () => {
  const [first, second] = await Promise.all([
    testMcpDatabase({ name: "mpgfixa", schema: fixtureA, folder: fixtureFolder("mpgfixa") }),
    testMcpDatabase({ name: "mpgfixb", schema: fixtureB, folder: fixtureFolder("mpgfixb") }),
  ])
  const id = crypto.randomUUID()
  await first.asOrganisation(id, async () => await first.db.insert(projects).values({ organisation_id: id, name: "Tower" }))
  await second.asOrganisation(id, async () => await second.db.insert(secrets).values({ organisation_id: id, value: "Hidden" }))
  expect(await first.asOrganisation(id, async () => await first.db.select({ name: projects.name }).from(projects))).toEqual([{ name: "Tower" }])
  expect(await second.asOrganisation(crypto.randomUUID(), async () => await second.db.select().from(secrets))).toEqual([])
  const [a, b] = await Promise.all([first, second].map(async suite => (await suite.asOrganisation(id, async () => await suite.db.execute(who))).rows[0]!))
  expect([a!.role, b!.role, a!.organisation]).toEqual(["mcp_test_mpgfixa", "mcp_test_mpgfixb", id])
  expect([a!.login, b!.login].every(login => String(login).startsWith("mcp_test_login_"))).toBe(true)
  expect(a!.login).not.toBe(b!.login)
  await Promise.all([first.close(), second.close()])
  expect((await admin.query("select rolname from pg_roles where rolname = any($1)", [[a!.login, b!.login]])).rows).toEqual([])
})

test("an organisation getter replaces the helper's own, and a run again starts from an empty schema", async () => {
  const id = crypto.randomUUID()
  const suite = await testMcpDatabase({ name: "mpgfixa", schema: fixtureA, folder: fixtureFolder("mpgfixa"), organisation: () => id })
  try {
    expect((await suite.db.execute(who)).rows[0]!.organisation).toBe(id)
    expect(await suite.db.select().from(projects)).toEqual([])
  } finally {
    await suite.close()
  }
})

test("the helper refuses a URL that names another database, and a name that is not an MCP's, before it touches anything", async () => {
  process.env.MCPS_TEST_DATABASE_URL = "postgres://answerable:answerable@localhost:47432/answerable_toolbox"
  try {
    await expect(testMcpDatabase({ name: "mpgfixa", schema: fixtureA, folder: fixtureFolder("mpgfixa") })).rejects.toThrow("Refusing to reset an MCP's schema in answerable_toolbox; expected answerable_mcps_test")
  } finally {
    delete process.env.MCPS_TEST_DATABASE_URL
  }
  await expect(testMcpDatabase({ name: "public", schema: fixtureA, folder: fixtureFolder("mpgfixa") })).rejects.toThrow("MCP name public is reserved")
})
