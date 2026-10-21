import { afterAll, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { sql } from "drizzle-orm"
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api"
import { createEvidence, evidenceChainSql, legacyBaseline, type Database } from "@answerable/mcp-postgres"
import { rowsOf } from "@answerable/mcp-postgres/testing"
import { database } from "../test/database"
import { migrate, migrationsFolder } from "./migrate"
import * as schema from "./schema"

const db = database.connect()
afterAll(() => db.$client.end())
const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex")
const receipts = (on: Database) => rowsOf(on)`select hash, created_at::text as created_at from drizzle.__drizzle_migrations order by id`
const tables = async (on: Database) => (await rowsOf(on)`select table_name from information_schema.tables where table_schema = 'public' order by table_name`).map(row => row.table_name)
// The one file the file migrator applied before drizzle: the package's.
const legacyFile = { name: "mcp-postgres/0001_initial.sql", url: new URL("../../../../packages/mcp-postgres/src/test/legacy/0001_initial.sql", import.meta.url) }

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

test("the migrations apply once, the package's tables then the chain and nothing else, and a second run changes nothing", async () => {
  await migrate(db)
  const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8")) as { entries: { tag: string; when: number }[] }
  const applied = await receipts(db)
  expect(applied).toEqual(await Promise.all(journal.entries.map(async entry => ({ hash: sha256(await readFile(join(migrationsFolder, `${entry.tag}.sql`), "utf8")), created_at: String(entry.when) }))))
  await migrate(db)
  expect(await receipts(db)).toEqual(applied)
  expect(await tables(db)).toEqual(["evidence_events", "evidence_payloads", "intents"])
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
})

test("a database the file migrator built is adopted without DDL: it equals a fresh one, and the chain its triggers built still verifies", async () => {
  const [legacy, fresh] = await Promise.all([database.scratch("legacy"), database.scratch("fresh")])
  try {
    // What the file migrator did: its table, the file in one transaction, recorded with the SHA-256 of its text.
    const text = await Bun.file(legacyFile.url).text()
    expect(sha256(text)).toBe(legacyBaseline.records[legacyFile.name]!)
    await legacy.db.execute(sql`create table schema_migrations (name text primary key, checksum text not null, applied_at timestamptz not null default now())`)
    await legacy.db.transaction(async tx => {
      await tx.execute(sql.raw(text))
      await tx.execute(sql`insert into schema_migrations (name, checksum) values (${legacyFile.name}, ${sha256(text)})`)
    })
    const platform = crypto.randomUUID()
    const evidence = createEvidence(legacy.db)
    const event = () => evidence.record({ organisation_id: platform, kind: "capability.completed", actor_type: "user", actor_id: "staff", outcome: "success" })
    await event()
    await migrate(legacy.db)
    await migrate(fresh.db)
    expect(await describe(legacy.db)).toEqual(await describe(fresh.db))
    expect(await tables(legacy.db)).toEqual(["evidence_events", "evidence_payloads", "intents"])
    await event()
    expect(await evidence.verify(platform)).toEqual({ ok: true, length: 2 })
    await migrate(legacy.db)
    expect(await describe(legacy.db)).toEqual(await describe(fresh.db))
  } finally {
    await Promise.all([legacy.drop(), fresh.drop()])
  }
})
