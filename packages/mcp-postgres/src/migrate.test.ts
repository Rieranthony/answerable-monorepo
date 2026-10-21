import { afterAll, expect, test } from "bun:test"
import { appendFile, cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api"
import type { Database } from "./connect"
import { createEvidence } from "./evidence"
import { evidenceChainSql, legacyBaseline, migrate, migrationsFolder } from "./migrate"
import * as schema from "./schema"
import { database } from "./test/database"
import { refusalOf, rowsOf } from "./testing"

const db = database.connect()
afterAll(() => db.$client.end())
const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex")
const receipts = (on = db) => rowsOf(on)`select hash, created_at::text as created_at from drizzle.__drizzle_migrations order by id`
const tables = async (on: Database) => (await rowsOf(on)`select table_name from information_schema.tables where table_schema = 'public' order by table_name`).map(row => row.table_name)
/** The file this package's file migrator applied before drizzle, kept for the adoption test. */
export const legacyFile = { name: "mcp-postgres/0001_initial.sql", url: new URL("test/legacy/0001_initial.sql", import.meta.url) }

/** What the file migrator did: its table, each file in its own transaction, recorded with the SHA-256 of its text. */
export async function applyLegacy(on: Database, files: { name: string; url: URL }[]) {
  await on.execute(sql`create table if not exists schema_migrations (name text primary key, checksum text not null, applied_at timestamptz not null default now())`)
  for (const file of files) {
    const text = await Bun.file(file.url).text()
    await on.transaction(async tx => {
      await tx.execute(sql.raw(text))
      await tx.execute(sql`insert into schema_migrations (name, checksum) values (${file.name}, ${sha256(text)})`)
    })
  }
}

/** Everything that defines a database's schema, as the catalogue prints it, and drizzle's receipts. */
export async function describe(on: Database) {
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

test("the migrations apply once, each recorded by the hash of its text and its journal time, and a second run changes nothing", async () => {
  await migrate(db, { folder: migrationsFolder })
  const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8")) as { entries: { tag: string; when: number }[] }
  const applied = await receipts()
  expect(applied).toEqual(await Promise.all(journal.entries.map(async entry => ({ hash: sha256(await readFile(join(migrationsFolder, `${entry.tag}.sql`), "utf8")), created_at: String(entry.when) }))))
  await migrate(db, { folder: migrationsFolder })
  expect(await receipts()).toEqual(applied)
  expect(await tables(db)).toEqual(["evidence_events", "evidence_payloads", "intents"])
})

test("the schema matches the committed migrations, whose custom file is the evidence chain's SQL", async () => {
  const folder = new URL("../drizzle/", import.meta.url)
  const journal: { entries: { tag: string }[] } = await Bun.file(new URL("meta/_journal.json", folder)).json()
  expect(journal.entries.map(({ tag }) => tag)).toEqual(["0000_initial", "0001_evidence_chain"])
  expect((await readdir(folder)).filter(name => name.endsWith(".sql")).sort()).toEqual(journal.entries.map(({ tag }) => `${tag}.sql`))
  expect((await readdir(new URL("meta/", folder))).filter(name => name.endsWith("_snapshot.json")).sort()).toEqual(journal.entries.map(({ tag }) => `${tag.split("_")[0]}_snapshot.json`))
  expect((await Bun.file(new URL("meta/0000_snapshot.json", folder)).json()).prevId).toBe("00000000-0000-0000-0000-000000000000")
  // Drizzle names snapshots by the migration number, without the SQL name; a custom migration keeps the snapshot before it.
  const previous = await Bun.file(new URL("meta/0001_snapshot.json", folder)).json()
  expect(await generateMigration(previous, generateDrizzleJson(schema, previous.id)), "Schema drifted from the committed migrations; run `bun run db:generate`").toEqual([])
  expect(await Bun.file(new URL("0001_evidence_chain.sql", folder)).text()).toBe(evidenceChainSql)
  expect(legacyBaseline).toEqual({ records: { [legacyFile.name]: sha256(await Bun.file(legacyFile.url).text()) }, entries: 2 })
})

async function editJournal(folder: string, edit: (entries: { tag: string; when: number }[]) => void) {
  const path = join(folder, "meta/_journal.json")
  const journal = JSON.parse(await readFile(path, "utf8"))
  edit(journal.entries)
  await writeFile(path, JSON.stringify(journal))
}

test.each([
  ["an applied file was edited", "drizzle/0001_evidence_chain.sql", (folder: string) => appendFile(join(folder, "0001_evidence_chain.sql"), "\n-- edited\n")],
  ["an applied file was regenerated with a new journal time", "drizzle/0000_initial.sql", (folder: string) => editJournal(folder, entries => { entries[0]!.when += 1 })],
  ["an applied file was removed", "the file applied as migration 2", (folder: string) => editJournal(folder, entries => { entries.pop() })],
])("migration refuses, naming the file, when %s", async (_, file, change) => {
  const folder = await mkdtemp(join(tmpdir(), "mcp-postgres-migrations-"))
  try {
    await cp(migrationsFolder, folder, { recursive: true })
    await change(folder)
    const applied = await receipts()
    await expect(migrate(db, { folder })).rejects.toThrow(`Refusing to migrate: ${file} is not the migration this database applied`)
    expect(await receipts()).toEqual(applied)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test("a database the file migrator built is adopted without DDL: it equals a fresh one, and the chain its triggers built still verifies", async () => {
  const [legacy, fresh] = await Promise.all([database.scratch("legacy"), database.scratch("fresh")])
  try {
    await applyLegacy(legacy.db, [legacyFile])
    const organisation = crypto.randomUUID()
    const evidence = createEvidence(legacy.db)
    const event = (kind: "intent.prepared" | "capability.completed", payload?: Record<string, unknown>) => evidence.record({ organisation_id: organisation, kind, actor_type: "user", actor_id: "ada", outcome: "success", payload })
    const { payload_ref } = await event("intent.prepared", { summary: "Delete" })
    await event("capability.completed")
    await migrate(legacy.db, { folder: migrationsFolder, legacy: legacyBaseline })
    await migrate(fresh.db, { folder: migrationsFolder })
    expect(await describe(legacy.db)).toEqual(await describe(fresh.db))
    expect(await tables(legacy.db)).toEqual(["evidence_events", "evidence_payloads", "intents"])
    await evidence.erase(payload_ref!)
    await event("capability.completed")
    expect(await evidence.verify(organisation)).toEqual({ ok: true, length: 3 })
    // A second run is an ordinary drizzle one, and changes nothing.
    await migrate(legacy.db, { folder: migrationsFolder, legacy: legacyBaseline })
    expect(await describe(legacy.db)).toEqual(await describe(fresh.db))
  } finally {
    await Promise.all([legacy.drop(), fresh.drop()])
  }
})

test("adoption refuses a schema_migrations that is not exactly the legacy records, naming what differs, and one beside drizzle's receipts; without legacy, nothing is adopted", async () => {
  const scratch = await database.scratch("refused")
  try {
    const on = scratch.db
    const checksum = legacyBaseline.records[legacyFile.name]!
    await applyLegacy(on, [legacyFile])
    const refused = (problems: string) => `Refusing to adopt a database the file migrator built: ${problems}. Recreate a disposable database, or restore its files`
    await on.execute(sql`update schema_migrations set checksum = 'f'`)
    await expect(migrate(on, { folder: migrationsFolder, legacy: legacyBaseline })).rejects.toThrow(refused("mcp-postgres/0001_initial.sql was applied with another text"))
    await on.execute(sql`update schema_migrations set name = 'mcp-postgres/0001_evidence.sql', checksum = ${checksum}`)
    await expect(migrate(on, { folder: migrationsFolder, legacy: legacyBaseline })).rejects.toThrow(refused("mcp-postgres/0001_initial.sql was never applied; mcp-postgres/0001_evidence.sql is not a file the first 2 drizzle migrations reproduce"))
    await on.execute(sql`update schema_migrations set name = ${legacyFile.name}`)
    await on.execute(sql`insert into schema_migrations (name, checksum) values ('toolbox/0001_initial.sql', 'a')`)
    await expect(migrate(on, { folder: migrationsFolder, legacy: legacyBaseline })).rejects.toThrow(refused("toolbox/0001_initial.sql is not a file the first 2 drizzle migrations reproduce"))
    await on.execute(sql`delete from schema_migrations where name = 'toolbox/0001_initial.sql'`)
    // Without legacy, the table is not looked at: drizzle tries its first migration against the tables that are there, and leaves its empty receipts table.
    expect(await refusalOf(migrate(on, { folder: migrationsFolder }))).toBe('relation "evidence_events" already exists')
    expect(await tables(on)).toEqual(["evidence_events", "evidence_payloads", "intents", "schema_migrations"])
    expect(await receipts(on)).toEqual([])
    await migrate(on, { folder: migrationsFolder, legacy: legacyBaseline })
    expect(await tables(on)).toEqual(["evidence_events", "evidence_payloads", "intents"])
    await on.execute(sql`create table schema_migrations (name text primary key, checksum text not null, applied_at timestamptz not null default now())`)
    await expect(migrate(on, { folder: migrationsFolder, legacy: legacyBaseline })).rejects.toThrow("Refusing to migrate: schema_migrations, the file migrator's table, is beside drizzle's receipts; drop whichever is not this database's history")
  } finally {
    await scratch.drop()
  }
})
