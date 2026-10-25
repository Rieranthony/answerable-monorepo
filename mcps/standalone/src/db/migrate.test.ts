import { afterAll, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api"
import { evidenceChainSql, type Database } from "@answerable/mcp-postgres"
import { rowsOf } from "@answerable/mcp-postgres/testing"
import { database } from "../test/database"
import { migrate, migrationsFolder } from "./migrate"
import * as schema from "./schema"

const db = database.connect()
afterAll(() => db.$client.end())
const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex")
const receipts = (on: Database) => rowsOf(on)`select hash, created_at::text as created_at from drizzle.__drizzle_migrations order by id`

test("the migrations apply once, the package's tables then the chain and nothing else, and a second run changes nothing", async () => {
  await migrate(db)
  const journal = JSON.parse(await readFile(join(migrationsFolder, "meta/_journal.json"), "utf8")) as { entries: { tag: string; when: number }[] }
  const applied = await receipts(db)
  expect(applied).toEqual(await Promise.all(journal.entries.map(async entry => ({ hash: sha256(await readFile(join(migrationsFolder, `${entry.tag}.sql`), "utf8")), created_at: String(entry.when) }))))
  await migrate(db)
  expect(await receipts(db)).toEqual(applied)
  expect((await rowsOf(db)`select table_name from information_schema.tables where table_schema = 'public' order by table_name`).map(row => row.table_name)).toEqual(["evidence_events", "evidence_payloads", "intents"])
})

test("the schema matches the committed migrations, whose custom file is the package's evidence chain SQL", async () => {
  const folder = new URL("../../drizzle/", import.meta.url)
  const journal: { entries: { tag: string }[] } = await Bun.file(new URL("meta/_journal.json", folder)).json()
  expect(journal.entries.map(({ tag }) => tag)).toEqual(["0000_initial", "0001_evidence_chain"])
  expect((await readdir(folder)).filter(name => name.endsWith(".sql")).sort()).toEqual(journal.entries.map(({ tag }) => `${tag}.sql`))
  const previous = await Bun.file(new URL("meta/0001_snapshot.json", folder)).json()
  expect(await generateMigration(previous, generateDrizzleJson(schema, previous.id)), "Schema drifted from the committed migrations; run `bun run db:generate`").toEqual([])
  expect(await Bun.file(new URL("0001_evidence_chain.sql", folder)).text()).toBe(evidenceChainSql)
})
