import { configureRuntimeRole, connect, migrate, migrations, runtimeGrants } from "@answerable/mcp-postgres"
import { z } from "zod"
import { database } from "../src/test/database"

// bun scripts/migrate.ts migrates ADMIN_DATABASE_MIGRATION_URL, the schema owner, then provisions ADMIN_DATABASE_RUNTIME_ROLE
// (answerable_admin_runtime by default), the restricted role the admin MCP serves as. --test resets the test database's public schema first.
// The admin MCP has no tables of its own: only those of @answerable/mcp-postgres, intents and evidence, and their grants.
const test = process.argv.includes("--test")
const url = test ? database.url : z.url({ message: "Set ADMIN_DATABASE_MIGRATION_URL to the admin MCP's Postgres URL as its schema owner" }).parse(Bun.env.ADMIN_DATABASE_MIGRATION_URL)
const role = Bun.env.ADMIN_DATABASE_RUNTIME_ROLE || "answerable_admin_runtime"
if (test) database.assertDisposable("reset")
const db = connect(url, { max: 1 })
try {
  if (test) await db.unsafe("drop schema public cascade; create schema public").simple()
  const applied = await migrate(db, [migrations])
  await configureRuntimeRole(db, role, runtimeGrants)
  console.log(`Migrated ${new URL(url).pathname.slice(1)}: ${applied.length ? applied.join(", ") : "nothing to apply"}; provisioned ${role}`)
} finally {
  await db.close()
}
