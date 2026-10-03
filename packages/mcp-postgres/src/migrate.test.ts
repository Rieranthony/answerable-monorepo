import { afterAll, expect, test } from "bun:test"
import type { SQL } from "bun"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { migrate, migrations } from "./migrate"
import { testDatabase } from "./test/database"

const db = testDatabase()
afterAll(() => db.close())

const names = (rows: { name: string }[]) => rows.map(row => row.name)

// A schema of its own, so that a test can start from nothing while the others share the public one.
async function inSchema<T>(run: (scoped: SQL) => Promise<T>) {
  const schema = `migrate_${crypto.randomUUID().replaceAll("-", "")}`
  await db.unsafe(`create schema ${schema}`)
  try {
    const scoped = await db.reserve()
    try {
      await scoped.unsafe(`set search_path to ${schema}`)
      return await run(scoped)
    } finally { scoped.release() }
  } finally { await db.unsafe(`drop schema ${schema} cascade`) }
}

// A directory of migrations as files named by `files`, as a URL that ends in "/".
async function directory(files: Record<string, string>) {
  const path = await mkdtemp(join(tmpdir(), "migrations-"))
  for (const [name, sql] of Object.entries(files)) await writeFile(join(path, name), sql)
  return { url: new URL(`${pathToFileURL(path).href}/`), remove: () => rm(path, { recursive: true }) }
}

test("the package's migrations apply once, in order, and a second run changes nothing", async () => {
  await migrate(db, [migrations])
  const before = await db`select name, applied_at from schema_migrations order by name`
  expect(names(before)).toEqual(["0002_evidence.sql", "0004_intents.sql"])
  expect(await migrate(db, [migrations])).toEqual([])
  expect(await db`select name, applied_at from schema_migrations order by name`).toEqual(before)
  const tables = await db`select table_name from information_schema.tables where table_schema = 'public' order by table_name`
  expect(tables.map((row: { table_name: string }) => row.table_name)).toEqual(["evidence_events", "evidence_payloads", "intents", "schema_migrations"])
})

test("two migrators on a fresh schema at once apply each file once, and both succeed", async () => {
  const schema = `migrate_${crypto.randomUUID().replaceAll("-", "")}`
  await db.unsafe(`create schema ${schema}`)
  const [first, second] = await Promise.all([db.reserve(), db.reserve()])
  try {
    for (const replica of [first, second]) await replica.unsafe(`set search_path to ${schema}`)
    const applied = await Promise.all([migrate(first, [migrations]), migrate(second, [migrations])])
    expect(applied.flat().sort()).toEqual(["0002_evidence.sql", "0004_intents.sql"])
    expect(names(await first`select name from schema_migrations order by name`)).toEqual(["0002_evidence.sql", "0004_intents.sql"])
  } finally {
    first.release()
    second.release()
    await db.unsafe(`drop schema ${schema} cascade`)
  }
})

test("the files of several directories apply in the order of their names across all of them, and files that are not SQL are left alone", async () => {
  const [first, second] = await Promise.all([
    directory({ "0001_a.sql": "create table a (id int)", "0003_c.sql": "create table c (id int)", "notes.txt": "not SQL" }),
    directory({ "0002_b.sql": "create table b (id int)", "0004_d.sql": "create table d (id int)" }),
  ])
  try {
    await inSchema(async scoped => {
      expect(await migrate(scoped, [second.url, first.url])).toEqual(["0001_a.sql", "0002_b.sql", "0003_c.sql", "0004_d.sql"])
      expect(await migrate(scoped, [first.url, second.url])).toEqual([])
    })
  } finally { await Promise.all([first.remove(), second.remove()]) }
})

test("a file is recorded by its name alone: what one directory applied, another directory holding that name does not apply again", async () => {
  const [first, second] = await Promise.all([directory({ "0001_a.sql": "create table a (id int)" }), directory({ "0001_a.sql": "create table a_again (id int)" })])
  try {
    await inSchema(async scoped => {
      await migrate(scoped, [first.url])
      expect(await migrate(scoped, [second.url])).toEqual([])
      expect((await scoped`select table_name from information_schema.tables where table_schema = current_schema() and table_name like 'a%'`).map((row: { table_name: string }) => row.table_name)).toEqual(["a"])
    })
  } finally { await Promise.all([first.remove(), second.remove()]) }
})

test("two directories holding one name are refused before anything is applied", async () => {
  const [first, second] = await Promise.all([directory({ "0001_a.sql": "create table a (id int)" }), directory({ "0001_a.sql": "create table b (id int)", "0002_c.sql": "create table c (id int)" })])
  try {
    await inSchema(async scoped => {
      await expect(migrate(scoped, [first.url, second.url])).rejects.toThrow("Two migrations are named 0001_a.sql")
      expect(await scoped`select table_name from information_schema.tables where table_schema = current_schema()`).toHaveLength(0)
    })
  } finally { await Promise.all([first.remove(), second.remove()]) }
})
