import type { SQL } from "bun"
import { readdir } from "node:fs/promises"

/** A directory of numbered `.sql` files: `name` prefixes each file's record in `schema_migrations`, and `url` ends in `/`. */
export type MigrationDirectory = { name: string; url: URL }

/** This package's own migrations, `0001_evidence.sql` and `0002_intents.sql`, recorded as `mcp-postgres/<file>`. A server passes it to `migrate` first. */
export const migrations: MigrationDirectory = { name: "mcp-postgres", url: new URL("../migrations/", import.meta.url) }

// Any fixed number: concurrent migrators take turns on it.
const lock = 4_751_300
const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex")

/**
 * Apply the `.sql` files of `directories` that `schema_migrations` does not list: the directories in the order given, the files of each in the
 * order of their names, each file in its own transaction under an advisory lock. Each file is recorded as `<directory name>/<file name>` with the
 * SHA-256 of its text, and the names applied are returned. A recorded file whose text has changed since refuses the run before anything applies.
 */
export async function migrate(db: SQL, directories: readonly MigrationDirectory[]): Promise<string[]> {
  const files: { name: string; text: string; checksum: string }[] = []
  for (const directory of directories) {
    for (const file of (await readdir(directory.url)).filter(file => file.endsWith(".sql")).sort()) {
      const text = await Bun.file(new URL(file, directory.url)).text()
      files.push({ name: `${directory.name}/${file}`, text, checksum: sha256(text) })
    }
  }
  // Under the lock too: two migrators creating the table at once would collide in the catalogue.
  await db.begin(async tx => {
    await tx`select pg_advisory_xact_lock(${lock})`
    await tx`create table if not exists schema_migrations (name text primary key, checksum text not null, applied_at timestamptz not null default now())`
    const recorded = new Map((await tx`select name, checksum from schema_migrations`).map((row: { name: string; checksum: string }) => [row.name, row.checksum]))
    const changed = files.find(file => recorded.has(file.name) && recorded.get(file.name) !== file.checksum)
    if (changed) throw new Error(`Migration ${changed.name} changed after it was applied; restore it and put the change in a new file`)
  })
  const applied: string[] = []
  for (const { name, text, checksum } of files) {
    await db.begin(async tx => {
      await tx`select pg_advisory_xact_lock(${lock})`
      if ((await tx`select 1 from schema_migrations where name = ${name}`).length) return
      await tx.unsafe(text).simple()
      await tx`insert into schema_migrations (name, checksum) values (${name}, ${checksum})`
      applied.push(name)
    })
  }
  return applied
}
