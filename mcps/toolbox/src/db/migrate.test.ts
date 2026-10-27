import { afterAll, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api"
import { assertRuntimeRole, createEvidence, evidenceChainSql, legacyBaseline as shared, type Database } from "@answerable/mcp-postgres"
import { rowsOf } from "@answerable/mcp-postgres/testing"
import { ingest, readCatalogue, readHostClient, removeHostClient, writeCatalogue, writeHostClient } from "../catalogue"
import { e2e } from "../test/mcps"
import { database } from "../test/database"
import { legacyBaseline, migrate, migrationsFolder, runtimeGrants } from "./migrate"
import * as schema from "./schema"

const db = database.connect()
const query = rowsOf(db)
afterAll(() => db.$client.end())

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex")
const receipts = (on: Database) => rowsOf(on)`select hash, created_at::text as created_at from drizzle.__drizzle_migrations order by id`
const tables = async (on: Database) => (await rowsOf(on)`select table_name from information_schema.tables where table_schema = 'public' order by table_name`).map(row => row.table_name)
const every = ["capabilities", "evidence_events", "evidence_payloads", "host_clients", "intents", "organisation_catalogue", "providers"]
// The two files the file migrator applied before drizzle: the package's, then the Toolbox's own.
const legacyFiles = [
  { name: "mcp-postgres/0001_initial.sql", url: new URL("../../../../packages/mcp-postgres/src/test/legacy/0001_initial.sql", import.meta.url) },
  { name: "toolbox/0001_initial.sql", url: new URL("../test/legacy/0001_initial.sql", import.meta.url) },
]

/** What the file migrator did: its table, each file in its own transaction, recorded with the SHA-256 of its text. */
async function applyLegacy(on: Database) {
  await on.execute(sql`create table if not exists schema_migrations (name text primary key, checksum text not null, applied_at timestamptz not null default now())`)
  for (const file of legacyFiles) {
    const text = await Bun.file(file.url).text()
    await on.transaction(async tx => {
      await tx.execute(sql.raw(text))
      await tx.execute(sql`insert into schema_migrations (name, checksum) values (${file.name}, ${sha256(text)})`)
    })
  }
}

/** Everything that defines a database's schema, as the catalogue prints it, and drizzle's receipts. */
async function describe(on: Database) {
  const rows = rowsOf(on)
  return {
    columns: await rows`select table_schema, table_name, column_name, ordinal_position, data_type, is_nullable, column_default, is_generated, generation_expression
      from information_schema.columns where table_schema in ('public', 'drizzle') order by table_schema, table_name, ordinal_position`,
    constraints: await rows`select n.nspname as schema, c.conrelid::regclass::text as table, c.conname as name, pg_get_constraintdef(c.oid) as definition
      from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname in ('public', 'drizzle') order by 1, 2, 3`,
    indexes: await rows`select schemaname, tablename, indexname, indexdef from pg_indexes where schemaname in ('public', 'drizzle') order by 1, 2, 3`,
    triggers: await rows`select tgrelid::regclass::text as table, tgname as name, pg_get_triggerdef(oid) as definition from pg_trigger where not tgisinternal order by 1, 2`,
    functions: await rows`select p.proname as name, pg_get_functiondef(p.oid) as definition from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' order by 1`,
    receipts: await receipts(on),
  }
}

test("the migrations apply once, the package's tables with the Toolbox's then the chain, and a second run changes nothing", async () => {
  await migrate(db)
  const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8")) as { entries: { tag: string; when: number }[] }
  const applied = await receipts(db)
  expect(applied).toEqual(await Promise.all(journal.entries.map(async entry => ({ hash: sha256(await readFile(join(migrationsFolder, `${entry.tag}.sql`), "utf8")), created_at: String(entry.when) }))))
  await migrate(db)
  expect(await receipts(db)).toEqual(applied)
  expect(await tables(db)).toEqual(every)
})

test("the schema matches the committed migrations, whose custom file is the package's evidence chain SQL", async () => {
  const folder = new URL("../../drizzle/", import.meta.url)
  const journal: { entries: { tag: string }[] } = await Bun.file(new URL("meta/_journal.json", folder)).json()
  expect(journal.entries.map(({ tag }) => tag)).toEqual(["0000_initial", "0001_evidence_chain"])
  expect((await readdir(folder)).filter(name => name.endsWith(".sql")).sort()).toEqual(journal.entries.map(({ tag }) => `${tag}.sql`))
  expect((await readdir(new URL("meta/", folder))).filter(name => name.endsWith("_snapshot.json")).sort()).toEqual(journal.entries.map(({ tag }) => `${tag.split("_")[0]}_snapshot.json`))
  expect((await Bun.file(new URL("meta/0000_snapshot.json", folder)).json()).prevId).toBe("00000000-0000-0000-0000-000000000000")
  const previous = await Bun.file(new URL("meta/0001_snapshot.json", folder)).json()
  expect(await generateMigration(previous, generateDrizzleJson(schema, previous.id)), "Schema drifted from the committed migrations; run `bun run db:generate`").toEqual([])
  expect(await Bun.file(new URL("0001_evidence_chain.sql", folder)).text()).toBe(evidenceChainSql)
  expect(legacyBaseline).toEqual({ records: { ...shared.records, "toolbox/0001_initial.sql": sha256(await Bun.file(legacyFiles[1]!.url).text()) }, entries: 2 })
})

test("after migrating, the runtime role holds exactly what the Toolbox's tables need, nothing on the receipts, and serves the catalogue", async () => {
  await migrate(db)
  const login = await database.runtimeLogin(runtimeGrants)
  try {
    const held = await query<{ table: string; privileges: string }>`select case when n.nspname = 'public' then c.relname::text else n.nspname || '.' || c.relname end as table,
        string_agg(p.privilege, ', ' order by p.privilege) as privileges
      from pg_class c join pg_namespace n on n.oid = c.relnamespace,
        unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p (privilege)
      where n.nspname in ('public', 'drizzle') and c.relkind = 'r' and has_table_privilege(${login.role}::name, c.oid, p.privilege)
      group by 1 order by 1`
    expect(Object.fromEntries(held.map(row => [row.table, row.privileges]))).toEqual({
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
    await ingest(login.db, [e2e.provider])
    await ingest(login.db, [e2e.provider])
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

test("a database the file migrator built is adopted without DDL: it equals a fresh one, serves the catalogue, and its chain still verifies", async () => {
  const [legacy, fresh] = await Promise.all([database.scratch("legacy"), database.scratch("fresh")])
  try {
    await applyLegacy(legacy.db)
    const organisation = crypto.randomUUID()
    await ingest(legacy.db, [e2e.provider])
    await writeCatalogue(legacy.db, organisation, "e2e", { enabled: true, overrides: { disabled: ["e2e/records.show"] } })
    const evidence = createEvidence(legacy.db)
    await evidence.record({ organisation_id: organisation, kind: "capability.completed", actor_type: "user", actor_id: "ada", outcome: "success" })
    await migrate(legacy.db)
    await migrate(fresh.db)
    expect(await describe(legacy.db)).toEqual(await describe(fresh.db))
    expect(await tables(legacy.db)).toEqual(every)
    expect((await readCatalogue(legacy.db, organisation)).get("e2e")).toEqual({ enabled: true, overrides: { disabled: ["e2e/records.show"], policy_class: {} } })
    await ingest(legacy.db, [e2e.provider])
    await evidence.record({ organisation_id: organisation, kind: "capability.completed", actor_type: "user", actor_id: "ada", outcome: "success" })
    expect(await evidence.verify(organisation)).toEqual({ ok: true, length: 2 })
    await migrate(legacy.db)
    expect(await describe(legacy.db)).toEqual(await describe(fresh.db))
  } finally {
    await Promise.all([legacy.drop(), fresh.drop()])
  }
})

test("a database that applied only the package's file is not adopted: the Toolbox's own file is named", async () => {
  const scratch = await database.scratch("partial")
  try {
    await scratch.db.execute(sql`create table schema_migrations (name text primary key, checksum text not null, applied_at timestamptz not null default now())`)
    await scratch.db.execute(sql`insert into schema_migrations (name, checksum) values ('mcp-postgres/0001_initial.sql', ${shared.records["mcp-postgres/0001_initial.sql"]})`)
    await expect(migrate(scratch.db)).rejects.toThrow("Refusing to adopt a database the file migrator built: toolbox/0001_initial.sql was never applied. Recreate a disposable database, or restore its files")
  } finally {
    await scratch.drop()
  }
})
