import { afterAll, expect, test } from "bun:test"
import type { SQL } from "bun"
import { migrate as migrateFiles, migrations } from "@answerable/mcp-postgres"
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { testDatabase } from "../test/database"
import { migrate } from "./migrate"

const db = testDatabase()
afterAll(() => db.close())

test("migrations apply once, in order, and a second run changes nothing", async () => {
  await migrate(db)
  const before = await db`select name, applied_at from schema_migrations order by name`
  expect(before.map((row: { name: string }) => row.name)).toEqual(["0001_catalogue.sql", "0002_evidence.sql", "0003_host_clients.sql", "0004_intents.sql"])
  expect(await migrate(db)).toEqual([])
  expect(await db`select name, applied_at from schema_migrations order by name`).toEqual(before)
  const tables = await db`select table_name from information_schema.tables where table_schema = 'public' order by table_name`
  expect(tables.map((row: { table_name: string }) => row.table_name)).toEqual([
    "capabilities", "evidence_events", "evidence_payloads", "host_clients", "intents", "organisation_catalogue", "providers", "schema_migrations",
  ])
})

// A schema of its own, so that a test can start from nothing.
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

test("a fresh schema receives every migration, each in its own transaction", async () => {
  await inSchema(async scoped => {
    expect(await migrate(scoped)).toEqual(["0001_catalogue.sql", "0002_evidence.sql", "0003_host_clients.sql", "0004_intents.sql"])
  })
})

// What was applied and what it left in the current schema that a test can compare: columns, triggers and functions.
async function snapshot(scoped: SQL) {
  const [applied, columns, triggers, routines] = await Promise.all([
    scoped`select name, applied_at from schema_migrations order by name`,
    scoped`select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = current_schema() order by table_name, ordinal_position`,
    scoped`select c.relname as table_name, t.tgname from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relnamespace = current_schema()::regnamespace and not t.tgisinternal order by 1, 2`,
    scoped`select routine_name from information_schema.routines where routine_schema = current_schema() order by 1`,
  ])
  return { applied: applied.map((row: { name: string }) => row.name), columns, triggers, routines }
}

test("a database migrated when all four files sat in one directory is not migrated again by the split layout, and a fresh one ends with the same schema", async () => {
  // The layout before the files moved to @answerable/mcp-postgres: one directory holding 0001 to 0004.
  const old = await mkdtemp(join(tmpdir(), "toolbox-migrations-"))
  for (const directory of [new URL("../../migrations/", import.meta.url), migrations]) {
    for (const name of await readdir(directory)) await copyFile(new URL(name, directory), join(old, name))
  }
  try {
    const { before, after, appliedAgain } = await inSchema(async scoped => {
      expect(await migrateFiles(scoped, [new URL(`${pathToFileURL(old).href}/`)])).toEqual(["0001_catalogue.sql", "0002_evidence.sql", "0003_host_clients.sql", "0004_intents.sql"])
      const before = await snapshot(scoped)
      const appliedAgain = await migrate(scoped)
      return { before, after: await snapshot(scoped), appliedAgain }
    })
    expect(appliedAgain).toEqual([])
    expect(after).toEqual(before)
    expect(await inSchema(async scoped => { await migrate(scoped); return snapshot(scoped) })).toEqual(before)
  } finally { await rm(old, { recursive: true }) }
})
