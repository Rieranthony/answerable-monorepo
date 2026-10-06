import { afterAll, expect, test } from "bun:test"
import { SQL } from "bun"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { migrate, migrations } from "./migrate"
import { database } from "./test/database"

const db = database.connect()
afterAll(() => db.close())

const names = (rows: { name: string }[]) => rows.map(row => row.name)
const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex")

// A schema of its own, so that a test can start from nothing while the others share the public one. Its own pool rather than a reserved
// connection: Bun 1.3.1 does not reject a failed transaction on a reserved connection, so a test could not see a migration fail.
async function inSchema<T>(run: (scoped: SQL) => Promise<T>) {
  const schema = `migrate_${crypto.randomUUID().replaceAll("-", "")}`
  await db.unsafe(`create schema ${schema}`)
  const scoped = new SQL({ url: database.url, max: 2, connection: { search_path: schema } })
  try {
    return await run(scoped)
  } finally {
    await scoped.close()
    await db.unsafe(`drop schema ${schema} cascade`)
  }
}

// A directory of migrations named `name`, holding the files of `files`, and a way to rewrite one of them.
async function directory(name: string, files: Record<string, string>) {
  const path = await mkdtemp(join(tmpdir(), "migrations-"))
  const write = (file: string, sql: string) => writeFile(join(path, file), sql)
  for (const [file, sql] of Object.entries(files)) await write(file, sql)
  return { name, url: new URL(`${pathToFileURL(path).href}/`), write, remove: () => rm(path, { recursive: true }) }
}

test("the package's migrations apply once, recorded as mcp-postgres/<file> with the SHA-256 of their text, and a second run changes nothing", async () => {
  await migrate(db, [migrations])
  const before = await db`select name, checksum, applied_at from schema_migrations order by name`
  expect(names(before)).toEqual(["mcp-postgres/0001_evidence.sql", "mcp-postgres/0002_intents.sql"])
  for (const row of before) expect(row.checksum).toBe(sha256(await Bun.file(new URL(row.name.split("/")[1], migrations.url)).text()))
  expect(await migrate(db, [migrations])).toEqual([])
  expect(await db`select name, checksum, applied_at from schema_migrations order by name`).toEqual(before)
  const tables = await db`select table_name from information_schema.tables where table_schema = 'public' order by table_name`
  expect(tables.map((row: { table_name: string }) => row.table_name)).toEqual(["evidence_events", "evidence_payloads", "intents", "schema_migrations"])
})

test("two migrators on a fresh schema at once apply each file once, and both succeed", async () => {
  await inSchema(async scoped => {
    const applied = await Promise.all([migrate(scoped, [migrations]), migrate(scoped, [migrations])])
    expect(applied.flat().sort()).toEqual(["mcp-postgres/0001_evidence.sql", "mcp-postgres/0002_intents.sql"])
    expect(names(await scoped`select name from schema_migrations order by name`)).toEqual(["mcp-postgres/0001_evidence.sql", "mcp-postgres/0002_intents.sql"])
  })
})

test("directories apply in the order given and their files in the order of their names; one file name in two directories is two migrations", async () => {
  // The second directory's file needs the first's tables, and its name sorts first.
  const [shared, server] = await Promise.all([
    directory("zeta", { "0002_more.sql": "create table more (id int primary key references base (id))", "0001_initial.sql": "create table base (id int primary key)", "notes.txt": "not SQL" }),
    directory("alpha", { "0001_initial.sql": "create table uses (id int references more (id) on delete cascade)" }),
  ])
  try {
    await inSchema(async scoped => {
      await expect(migrate(scoped, [server, shared])).rejects.toThrow('relation "more" does not exist')
      expect(await migrate(scoped, [shared, server])).toEqual(["zeta/0001_initial.sql", "zeta/0002_more.sql", "alpha/0001_initial.sql"])
      expect(await migrate(scoped, [shared, server])).toEqual([])
      expect(names(await scoped`select name from schema_migrations order by name`)).toEqual(["alpha/0001_initial.sql", "zeta/0001_initial.sql", "zeta/0002_more.sql"])
    })
  } finally { await Promise.all([shared.remove(), server.remove()]) }
})

test("a file changed after it was applied refuses the run before anything applies, naming it", async () => {
  const files = await directory("server", { "0001_initial.sql": "create table a (id int)" })
  try {
    await inSchema(async scoped => {
      await migrate(scoped, [files])
      await files.write("0001_initial.sql", "create table a (id int, name text)")
      await files.write("0002_next.sql", "create table b (id int)")
      await expect(migrate(scoped, [files])).rejects.toThrow("Migration server/0001_initial.sql changed after it was applied; restore it and put the change in a new file")
      expect((await scoped`select table_name from information_schema.tables where table_schema = current_schema() order by 1`).map((row: { table_name: string }) => row.table_name)).toEqual(["a", "schema_migrations"])
    })
  } finally { await files.remove() }
})
