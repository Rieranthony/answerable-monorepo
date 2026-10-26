import { afterAll, beforeAll, expect, test } from "bun:test"
import { symlink } from "node:fs/promises"
import { join } from "node:path"
import { main } from "../cli"
import { migrateLocal } from "../database"
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
  const io = testIo(["db", ...argv], repository.root, { exec: spawn, migrate: migrateLocal })
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
  const second = await run([shared, "generate"])
  expect([second.code, second.stdout()]).toEqual([0, expect.stringContaining(`\nNext:\n  bun mcp db ${shared} migrate\n  git add mcps/${shared}/drizzle\n`)])
  const [written] = (await Array.fromAsync(new Bun.Glob("drizzle/0001_*.sql").scan({ cwd: join(repository.root, "mcps", shared) })))
  expect(await file(shared, written!).text()).toStartWith(`CREATE TABLE "${shared}"."notes" (`)
  expect(lines((await run([shared, "generate"])).stdout())).toEqual(["ok      migration  no change to src/db/schema.ts", ""])
})

test("migrate provisions the shared schema, applies the journal as the migrator, makes no role, and grants the serving login every table", async () => {
  const { code, stdout } = await run([shared, "migrate"])
  expect([code, lines(stdout())[0]]).toEqual([0, `ok      database   schema ${shared} in answerable_mcps: migrated`])
  expect(lines(stdout())[0]!.split(/ +/)[1]).toBe(definitions.db.steps[1]!.name)
  expect(await traces(shared)).toEqual([`answerable_mcps.${shared}`])
  expect(await query("answerable_mcps", "select tableowner from pg_tables where schemaname = $1 and tablename = 'notes'", [shared])).toEqual([{ tableowner: "answerable_mcps_migrator" }])
  expect(await query("answerable_mcps", "select privilege_type from information_schema.role_table_grants where grantee = $1 and table_schema = $2 and table_name = 'notes' order by privilege_type", ["answerable_mcps_toolbox", shared])).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"].map(privilege_type => ({ privilege_type })))
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

test("migrate from inside the MCP's folder reads the root .env, as setup and dev do", async () => {
  // Bun loads a .env from the working directory only, so this one, at the repository's root, reaches the CLI only if it reads it itself.
  const environment = join(repository.root, ".env")
  const given = process.env.MCPS_DATABASE_ADMIN_URL
  delete process.env.MCPS_DATABASE_ADMIN_URL
  await Bun.write(environment, "MCPS_DATABASE_ADMIN_URL=postgres://answerable:answerable@localhost:1/answerable_mcps\n")
  try {
    const io = testIo(["db", "migrate"], join(repository.root, "mcps", shared), { exec: spawn, migrate: migrateLocal })
    expect([await main(io.io), io.stderr()]).toEqual([1, `database failed: the development Postgres does not answer on localhost:1; start it with bun run env:up from the main checkout\n\nFinish the job with:\n  bun mcp db ${shared} migrate\n`])
  } finally {
    await Bun.file(environment).delete()
    if (given !== undefined) process.env.MCPS_DATABASE_ADMIN_URL = given
  }
})

test("every MCP in one call, as bun mcp dev migrates them: the shared ones on one connection each way, then each own one, a line each", async () => {
  expect(await migrateLocal(repository.root, [{ name: own, serve: "both", database: "own" }, { name: shared, serve: "both", database: "shared" }])).toEqual([
    `schema ${own} in answerable_mcp_${own}: migrated`, `schema ${shared} in answerable_mcps: migrated`,
  ])
})
