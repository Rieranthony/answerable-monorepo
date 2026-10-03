import { SQL } from "bun"
import { migrate, migrations } from "@answerable/mcp-postgres"
import { z } from "zod"
import { database } from "../src/test/database"

// bun scripts/migrate.ts migrates ADMIN_DATABASE_URL; --test resets the test database's public schema first. The admin MCP has no tables of
// its own: only those of @answerable/mcp-postgres, intents and evidence.
const test = process.argv.includes("--test")
const url = test ? database.url : z.url({ message: "Set ADMIN_DATABASE_URL to the admin MCP's Postgres URL" }).parse(Bun.env.ADMIN_DATABASE_URL)
if (test) database.assertDisposable("reset")
const db = new SQL({ url, max: 1 })
try {
  if (test) await db.unsafe("drop schema public cascade; create schema public").simple()
  const applied = await migrate(db, [migrations])
  console.log(`Migrated ${new URL(url).pathname.slice(1)}: ${applied.length ? applied.join(", ") : "nothing to apply"}`)
} finally {
  await db.close()
}
