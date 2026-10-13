import { afterAll, expect, test } from "bun:test"
import { SQL } from "bun"
import { assertRuntimeRole } from "@answerable/mcp-postgres"
import { ingest, readCatalogue, readHostClient, removeHostClient, writeCatalogue, writeHostClient } from "../catalogue"
import { e2e } from "../test/hub"
import { database } from "../test/database"
import { migrate, runtimeGrants } from "./migrate"

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

test("after migrating, the runtime role holds exactly what the Toolbox's tables need, nothing on schema_migrations, and serves the catalogue", async () => {
  await migrate(db)
  const login = await database.runtimeLogin(runtimeGrants)
  try {
    const held = await db`select c.relname as table, string_agg(p.privilege, ', ' order by p.privilege) as privileges
      from pg_class c join pg_namespace n on n.oid = c.relnamespace,
        unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p (privilege)
      where n.nspname = 'public' and c.relkind = 'r' and has_table_privilege(${login.role}::name, c.oid, p.privilege)
      group by c.relname order by c.relname`
    expect(Object.fromEntries(held.map((row: { table: string; privileges: string }) => [row.table, row.privileges]))).toEqual({
      capabilities: "INSERT, SELECT, UPDATE",
      evidence_events: "INSERT, SELECT",
      evidence_payloads: "INSERT, SELECT, UPDATE",
      host_clients: "DELETE, INSERT, SELECT, UPDATE",
      intents: "DELETE, INSERT, SELECT, UPDATE",
      organisation_catalogue: "INSERT, SELECT, UPDATE",
      providers: "INSERT, SELECT",
    })
    await assertRuntimeRole(login.db)
    // The boot's ingest, twice as on a restart, a catalogue write and read, and a host client's life, all as the runtime role.
    const organisation = crypto.randomUUID()
    await ingest(login.db, [e2e()])
    await ingest(login.db, [e2e()])
    await writeCatalogue(login.db, organisation, "e2e", { enabled: true })
    expect((await readCatalogue(login.db, organisation)).get("e2e")?.enabled).toBe(true)
    const client = `client-${crypto.randomUUID()}`
    await writeHostClient(login.db, client, { projection: "meta" })
    await writeHostClient(login.db, client, { projection: "direct" })
    expect(await readHostClient(login.db, client)).toEqual({ projection: "direct", direct_limit: 40 })
    expect(await removeHostClient(login.db, client)).toBe(true)
  } finally {
    await login.drop()
  }
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
