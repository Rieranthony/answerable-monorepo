import { SQL } from "bun"
import { z } from "zod"
import { migrate } from "../src/db/migrate"
import { assertDisposable, testDatabaseUrl } from "../src/test/database"

// bun scripts/migrate.ts migrates TOOLBOX_DATABASE_URL; --test resets the test database's public schema first.
const test = process.argv.includes("--test")
const url = test ? testDatabaseUrl : z.url({ message: "Set TOOLBOX_DATABASE_URL to the Toolbox's Postgres URL" }).parse(Bun.env.TOOLBOX_DATABASE_URL)
if (test) assertDisposable("reset", url)
const db = new SQL({ url, max: 1 })
try {
  if (test) await db.unsafe("drop schema public cascade; create schema public").simple()
  const applied = await migrate(db)
  console.log(`Migrated ${new URL(url).pathname.slice(1)}: ${applied.length ? applied.join(", ") : "nothing to apply"}`)
} finally {
  await db.close()
}
