import { afterAll, beforeAll, expect, test } from "bun:test"
import { symlink } from "node:fs/promises"
import { join } from "node:path"
import { main } from "../cli"
import { definitions } from "../definitions"
import { spawn } from "../io"
import { mcpFiles, tableTs } from "../templates"
import { forget, query, randomName, traces } from "../test/postgres"
import { tempRepository, testIo } from "../test/io"

const repo = new URL("../../../", import.meta.url).pathname
// Two MCPs of this suite alone, on the development Postgres: dropped before and after, whatever happens.
const [shared, own] = [randomName(), randomName()]
let repository: Awaited<ReturnType<typeof tempRepository>>
beforeAll(async () => {
  const files = (name: string, database: "shared" | "own") => Object.entries(mcpFiles({ name, description: "A database test's MCP, made and removed by scripts/mcp/commands/db.test.ts.", serve: "both", database, date: "2026-10-25" }))
    .map(([path, text]) => [`mcps/${name}/${path}`, text])
  repository = await tempRepository(Object.fromEntries([...files(shared, "shared"), ...files(own, "own")]))
  // drizzle-kit and the schema's imports resolve from the repository's install, as they would in the repository.
  await symlink(join(repo, "node_modules"), join(repository.root, "node_modules"))
})
afterAll(async () => {
  await Promise.all([forget(shared), forget(own)])
  await repository.remove()
})

const run = async (argv: string[]) => {
  const io = testIo(["db", ...argv], repository.root, { exec: spawn })
  return { ...io, code: await main(io.io) }
}
const lines = (text: string) => text.split("\n").map(line => line.replace(/ \(\d+ ms\)$/, ""))
const file = (name: string, path: string) => Bun.file(join(repository.root, "mcps", name, path))

test("generate writes the first migration without drizzle-kit's schema line, then the next for a new table, then nothing", async () => {
  const first = await run([shared, "generate", "--name", "initial"])
  expect([first.code, lines(first.stdout())]).toEqual([0, ["ok      migration  drizzle/0000_initial.sql", "", "Next:", `  bun mcp db ${shared} migrate`, `  git add mcps/${shared}/drizzle`, ""]])
  expect(await file(shared, "drizzle/0000_initial.sql").text()).toBe("")
  expect(lines(first.stdout())[0]!.split(/ +/)[1]).toBe(definitions.db.steps[0]!.name)
  await Bun.write(file(shared, "src/db/schema.ts"), `import { organisationIsolation } from "@answerable/mcp-postgres"\n${await file(shared, "src/db/schema.ts").text()}${tableTs(shared, "notes")}`)
  const second = await run([shared, "generate", "--json"])
  expect([second.code, JSON.parse(second.stdout()).next]).toEqual([0, [`bun mcp db ${shared} migrate`, `git add mcps/${shared}/drizzle`]])
  const [written] = (await Array.fromAsync(new Bun.Glob("drizzle/0001_*.sql").scan({ cwd: join(repository.root, "mcps", shared) })))
  expect(await file(shared, written!).text()).toStartWith(`CREATE TABLE "${shared}"."notes" (`)
  expect(lines((await run([shared, "generate"])).stdout())).toEqual(["ok      migration  no change to src/db/schema.ts", ""])
})

test("generate refuses a table outside the MCP's schema, writing nothing", async () => {
  const schema = await file(own, "src/db/schema.ts").text()
  await Bun.write(file(own, "src/db/schema.ts"), `${schema}export const loose = pg.pgTable("loose", { id: pg.uuid().primaryKey() })\n`)
  try {
    const { code, stderr } = await run([own, "generate"])
    expect([code, stderr()]).toEqual([2, `mcps/${own}/src/db/schema.ts defines loose outside pgSchema("${own}"); define every table with ${own}Schema.table(…)\n\n  bun mcp db ${own} generate\n`])
    expect(await file(own, "drizzle/meta/_journal.json").exists()).toBe(false)
  } finally {
    await Bun.write(file(own, "src/db/schema.ts"), schema)
  }
})

test("migrate provisions the shared schema and its roles, applies the journal, and narrows the grants src/db/grants.ts exports", async () => {
  await Bun.write(file(shared, "src/db/grants.ts"), 'export const grants = [{ table: "notes", privileges: ["select"] }]\n')
  const { code, stdout } = await run([shared, "migrate"])
  expect([code, lines(stdout())[0]]).toEqual([0, `ok      database   schema ${shared} in answerable_mcps: migrated, with src/db/grants.ts`])
  expect(lines(stdout())[0]!.split(/ +/)[1]).toBe(definitions.db.steps[1]!.name)
  expect(await traces(shared)).toEqual([`answerable_mcps.${shared}`, `mcp_${shared}`, `mcp_${shared}_owner`])
  expect(await query("answerable_mcps", "select privilege_type from information_schema.role_table_grants where grantee = $1 and table_name = 'notes'", [`mcp_${shared}`])).toEqual([{ privilege_type: "SELECT" }])
  expect((await run([shared, "migrate"])).code).toBe(0)
})

test("migrate makes an own MCP's database and two logins first, and provisions it before any migration", async () => {
  const { code, stdout } = await run([own, "migrate"])
  expect([code, lines(stdout())[0]]).toEqual([0, `ok      database   schema ${own} in answerable_mcp_${own}: provisioned; no migration yet`])
  expect(await traces(own)).toEqual([`answerable_mcp_${own}_owner`, `answerable_mcp_${own}_runtime`, `answerable_mcp_${own}`])
  expect(await query(`answerable_mcp_${own}`, "select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = $1", [own])).toEqual([{ owner: `answerable_mcp_${own}_owner` }])
  expect((await run([own, "generate", "--name", "initial"])).code).toBe(0)
  expect(lines((await run([own, "migrate"])).stdout())[0]).toBe(`ok      database   schema ${own} in answerable_mcp_${own}: migrated`)
})

test("a Postgres that does not answer is named, with how to start it", async () => {
  process.env.MCPS_DATABASE_ADMIN_URL = "postgres://answerable:answerable@localhost:1/answerable_mcps"
  try {
    const { code, stderr } = await run([shared, "migrate"])
    expect([code, stderr()]).toEqual([1, `database failed: the development Postgres does not answer on localhost:1; start it with bun run env:up from the main checkout\n\nFinish the job with:\n  bun mcp db ${shared} migrate\n`])
  } finally {
    delete process.env.MCPS_DATABASE_ADMIN_URL
  }
})

test.each([
  [["generate", "migrate", "x"], "bun mcp db takes generate or migrate, after the MCP's name, not generate migrate x"],
  [["acme", "seed"], "bun mcp db takes generate or migrate, after the MCP's name, not acme seed"],
  [[], "bun mcp db takes generate or migrate, after the MCP's name"],
  [["acme", "migrate", "--name", "x"], "--name names the migration bun mcp db generate writes; migrate takes none"],
])("refuses %j", async (argv, message) => {
  const { code, stderr } = await run(argv)
  expect([code, stderr().split("\n")[0]]).toEqual([2, message])
})
