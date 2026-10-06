import { afterAll, expect, test } from "bun:test"
import { SQL } from "bun"
import { database } from "../test/database"
import { migrate } from "./migrate"

const db = database.connect()
afterAll(() => db.close())

const applied = ["mcp-postgres/0001_evidence.sql", "mcp-postgres/0002_intents.sql", "toolbox/0001_initial.sql"]

test("migrations apply once, the package's before the Toolbox's, and a second run changes nothing", async () => {
  await migrate(db)
  const before = await db`select name, checksum, applied_at from schema_migrations order by name`
  expect(before.map((row: { name: string }) => row.name)).toEqual(applied)
  expect(await migrate(db)).toEqual([])
  expect(await db`select name, checksum, applied_at from schema_migrations order by name`).toEqual(before)
  const tables = await db`select table_name from information_schema.tables where table_schema = 'public' order by table_name`
  expect(tables.map((row: { table_name: string }) => row.table_name)).toEqual([
    "capabilities", "evidence_events", "evidence_payloads", "host_clients", "intents", "organisation_catalogue", "providers", "schema_migrations",
  ])
})

test("a fresh schema receives every migration, in that order", async () => {
  const schema = `migrate_${crypto.randomUUID().replaceAll("-", "")}`
  await db.unsafe(`create schema ${schema}`)
  const scoped = new SQL({ url: database.url, max: 1, connection: { search_path: schema } })
  try {
    expect(await migrate(scoped)).toEqual(applied)
  } finally {
    await scoped.close()
    await db.unsafe(`drop schema ${schema} cascade`)
  }
})
