import { SQL } from "bun"
import { configureRuntimeRole } from "@answerable/mcp-postgres"
import { z } from "zod"
import { migrate, runtimeGrants } from "../src/db/migrate"
import { database } from "../src/test/database"

// bun scripts/migrate.ts migrates TOOLBOX_DATABASE_MIGRATION_URL, the schema owner, then provisions TOOLBOX_DATABASE_RUNTIME_ROLE
// (answerable_toolbox_runtime by default), the restricted role the Toolbox serves as. --test resets the test database's public schema first.
const test = process.argv.includes("--test")
const url = test ? database.url : z.url({ message: "Set TOOLBOX_DATABASE_MIGRATION_URL to the Toolbox's Postgres URL as its schema owner" }).parse(Bun.env.TOOLBOX_DATABASE_MIGRATION_URL)
const role = Bun.env.TOOLBOX_DATABASE_RUNTIME_ROLE || "answerable_toolbox_runtime"
if (test) database.assertDisposable("reset")
const db = new SQL({ url, max: 1 })
try {
  if (test) await db.unsafe("drop schema public cascade; create schema public").simple()
  const applied = await migrate(db)
  await configureRuntimeRole(db, role, runtimeGrants)
  console.log(`Migrated ${new URL(url).pathname.slice(1)}: ${applied.length ? applied.join(", ") : "nothing to apply"}; provisioned ${role}`)
} finally {
  await db.close()
}
