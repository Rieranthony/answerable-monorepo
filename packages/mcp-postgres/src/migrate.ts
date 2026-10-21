import { readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { sql } from "drizzle-orm"
import { readMigrationFiles } from "drizzle-orm/migrator"
import { migrate as apply } from "drizzle-orm/node-postgres/migrator"
import type { Database } from "./connect"

/**
 * The evidence chain's functions and triggers, which drizzle cannot express: the text of `sql/evidence-chain.sql`, with `--> statement-breakpoint`
 * between statements. Each server's drizzle folder holds it as its custom migration `0001_evidence_chain.sql`, right after `0000_initial.sql`
 * creates the tables, and a test keeps the file equal to this.
 */
export const evidenceChainSql = readFileSync(new URL("../sql/evidence-chain.sql", import.meta.url), "utf8")

/** This package's own drizzle folder, which its tests migrate; a server names its own. */
export const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url))

/**
 * What the file migrator this package had before drizzle recorded in `schema_migrations` for a database it built: each file's record name and the
 * SHA-256 of its text, and how many of the journal's first entries those files produced (the tables, then the evidence chain's triggers).
 */
export type LegacyBaseline = { records: Record<string, string>; entries: number }

/**
 * This package's files under the file migrator: `mcp-postgres/0001_initial.sql`, which a drizzle folder's first two migrations reproduce. The admin
 * MCP passes it to `migrate` as it is; the Toolbox adds its own file. The checksum is the SHA-256 of `src/test/legacy/0001_initial.sql`, the file kept
 * for the adoption test.
 */
export const legacyBaseline: LegacyBaseline = {
  records: { "mcp-postgres/0001_initial.sql": "64545bb4db7470215fab0cb6eb8299a825610c40e17483fe69ab79fbf3c36240" },
  entries: 2,
}

type File = ReturnType<typeof readMigrationFiles>[number]
const receipts = sql`drizzle.__drizzle_migrations`

// A database the file migrator built: `schema_migrations` lists exactly the legacy records, and drizzle has recorded nothing yet (a run without
// `legacy` leaves its empty receipts table). Record drizzle's receipts for the journal entries those files reproduce and drop the table, in one
// transaction and without DDL on the schema itself.
async function adopt(db: Database, legacy: LegacyBaseline, files: File[], applied: boolean) {
  const { rows: [table] } = await db.execute<{ present: boolean }>(sql`select to_regclass('public.schema_migrations') is not null as present`)
  if (!table!.present) return
  if (applied) throw new Error("Refusing to migrate: schema_migrations, the file migrator's table, is beside drizzle's receipts; drop whichever is not this database's history")
  const { rows } = await db.execute<{ name: string; checksum: string }>(sql`select name, checksum from schema_migrations order by name`)
  const recorded = new Map(rows.map(row => [row.name, row.checksum]))
  const expected = Object.entries(legacy.records)
  const differences = [
    ...expected.filter(([name]) => !recorded.has(name)).map(([name]) => `${name} was never applied`),
    ...expected.filter(([name, checksum]) => recorded.has(name) && recorded.get(name) !== checksum).map(([name]) => `${name} was applied with another text`),
    ...rows.filter(row => !(row.name in legacy.records)).map(row => `${row.name} is not a file the first ${legacy.entries} drizzle migrations reproduce`),
  ]
  if (differences.length) throw new Error(`Refusing to adopt a database the file migrator built: ${differences.join("; ")}. Recreate a disposable database, or restore its files`)
  await db.transaction(async tx => {
    await tx.execute(sql`create schema if not exists drizzle`)
    await tx.execute(sql`create table if not exists ${receipts} (id serial primary key, hash text not null, created_at bigint)`)
    for (const file of files.slice(0, legacy.entries)) await tx.execute(sql`insert into ${receipts} (hash, created_at) values (${file.hash}, ${file.folderMillis})`)
    await tx.execute(sql`drop table schema_migrations`)
  })
}

/**
 * Apply the folder's pending migrations in one transaction, as drizzle's migrator does, after refusing what it would silently mishandle: it records
 * each file's hash and journal time but compares neither, so an applied file that was edited would be ignored and a regenerated one would run again.
 * An applied file that is not the one in the folder refuses the run, naming it.
 *
 * With `legacy`, a database the file migrator built is adopted first: when `schema_migrations` lists exactly `legacy.records`, drizzle's receipts for the
 * journal's first `legacy.entries` entries are recorded and the table dropped, in one transaction and without DDL, since those files made the same
 * schema. Any other `schema_migrations`, or one beside drizzle's receipts, refuses the run, naming what differs.
 */
export async function migrate(db: Database, { folder, legacy }: { folder: string; legacy?: LegacyBaseline }): Promise<void> {
  const files = readMigrationFiles({ migrationsFolder: folder })
  const { entries } = JSON.parse(await readFile(`${folder}/meta/_journal.json`, "utf8")) as { entries: { tag: string }[] }
  const recorded = async () => (await db.execute<{ applied: boolean }>(sql`select to_regclass('drizzle.__drizzle_migrations') is not null as applied`)).rows[0]!.applied
    ? (await db.execute<{ hash: string; created_at: string }>(sql`select hash, created_at::text from ${receipts} order by id`)).rows
    : []
  if (legacy) await adopt(db, legacy, files, (await recorded()).length > 0)
  for (const [index, receipt] of (await recorded()).entries()) {
    const file = files[index]
    if (file?.hash === receipt.hash && String(file.folderMillis) === receipt.created_at) continue
    const name = entries[index] ? `drizzle/${entries[index].tag}.sql` : `the file applied as migration ${index + 1}`
    throw new Error(`Refusing to migrate: ${name} is not the migration this database applied. Restore the applied file, or recreate a disposable database.`)
  }
  await apply(db, { migrationsFolder: folder })
}
