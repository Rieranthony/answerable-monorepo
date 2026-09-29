import { afterAll, expect, test } from "bun:test"
import { testDatabase } from "../test/database"
import { migrate } from "./migrate"

const db = testDatabase()
afterAll(() => db.close())

test("migrations apply once, in order, and a second run changes nothing", async () => {
  await migrate(db)
  const before = await db`select name, applied_at from schema_migrations order by name`
  expect(before.map((row: { name: string }) => row.name)).toEqual(["0001_catalogue.sql", "0002_evidence.sql"])
  expect(await migrate(db)).toEqual([])
  expect(await db`select name, applied_at from schema_migrations order by name`).toEqual(before)
  const tables = await db`select table_name from information_schema.tables where table_schema = 'public' order by table_name`
  expect(tables.map((row: { table_name: string }) => row.table_name)).toEqual([
    "capabilities", "evidence_events", "evidence_payloads", "organisation_catalogue", "providers", "schema_migrations",
  ])
})

test("a fresh schema receives every migration, each in its own transaction", async () => {
  const schema = `migrate_${crypto.randomUUID().replaceAll("-", "")}`
  await db.unsafe(`create schema ${schema}`)
  try {
    const scoped = await db.reserve()
    try {
      await scoped.unsafe(`set search_path to ${schema}`)
      expect(await migrate(scoped)).toEqual(["0001_catalogue.sql", "0002_evidence.sql"])
    } finally { scoped.release() }
  } finally { await db.unsafe(`drop schema ${schema} cascade`) }
})
