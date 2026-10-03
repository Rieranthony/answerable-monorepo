import type { SQL } from "bun"
import { readdir } from "node:fs/promises"

/** The directory of this package's own migrations, `0002_evidence.sql` and `0004_intents.sql`, as a URL that ends in `/`. A server that keeps nothing else in its database passes `[migrations]` to `migrate`. */
export const migrations = new URL("../migrations/", import.meta.url)

// Any fixed number: concurrent migrators take turns on it.
const lock = 4_751_300

/**
 * Apply the numbered SQL files of `directories` (URLs that end in `/`) that `schema_migrations` does not list, in the order of their names across
 * all the directories, each in its own transaction, and return their names. A file is recorded by its name alone, so it does not matter which
 * directory holds it: a database that applied it from one directory does not apply it again from another. Two files with one name are refused
 * before anything is applied.
 */
export async function migrate(db: SQL, directories: readonly URL[]): Promise<string[]> {
  const files = new Map<string, URL>()
  for (const directory of directories) {
    for (const name of await readdir(directory)) {
      if (!name.endsWith(".sql")) continue
      if (files.has(name)) throw new Error(`Two migrations are named ${name}`)
      files.set(name, new URL(name, directory))
    }
  }
  // Under the lock too: two migrators creating the table at once would collide in the catalogue.
  await db.begin(async tx => {
    await tx`select pg_advisory_xact_lock(${lock})`
    await tx`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`
  })
  const applied: string[] = []
  for (const name of [...files.keys()].sort()) {
    await db.begin(async tx => {
      await tx`select pg_advisory_xact_lock(${lock})`
      if ((await tx`select 1 from schema_migrations where name = ${name}`).length) return
      await tx.unsafe(await Bun.file(files.get(name)!).text()).simple()
      await tx`insert into schema_migrations (name) values (${name})`
      applied.push(name)
    })
  }
  return applied
}
