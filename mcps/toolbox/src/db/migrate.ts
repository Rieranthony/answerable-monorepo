import type { SQL } from "bun"
import { readdir } from "node:fs/promises"

const directory = new URL("../../migrations/", import.meta.url)
// Any fixed number: concurrent migrators take turns on it.
const lock = 4_751_300

/** Apply the numbered SQL files in `migrations/` that `schema_migrations` does not list, each in its own transaction, and return their names. */
export async function migrate(db: SQL): Promise<string[]> {
  await db`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`
  const applied: string[] = []
  for (const name of (await readdir(directory)).filter(file => file.endsWith(".sql")).sort()) {
    await db.begin(async tx => {
      await tx`select pg_advisory_xact_lock(${lock})`
      if ((await tx`select 1 from schema_migrations where name = ${name}`).length) return
      await tx.unsafe(await Bun.file(new URL(name, directory)).text()).simple()
      await tx`insert into schema_migrations (name) values (${name})`
      applied.push(name)
    })
  }
  return applied
}
