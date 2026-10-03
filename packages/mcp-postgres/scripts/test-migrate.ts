import { SQL } from "bun"
import { migrate, migrations } from "../src/migrate"
import { database } from "../src/test/database"

// Reset the test database's public schema and apply this package's migrations. The tests that need a database start from this.
database.assertDisposable("reset")
const db = new SQL({ url: database.url, max: 1 })
try {
  await db.unsafe("drop schema public cascade; create schema public").simple()
  console.log(`Migrated ${new URL(database.url).pathname.slice(1)}: ${(await migrate(db, [migrations])).join(", ")}`)
} finally {
  await db.close()
}
