import { sql } from "drizzle-orm"
import { connect } from "../src/connect"
import { migrate, migrationsFolder } from "../src/migrate"
import { database } from "../src/test/database"

// Reset the test database and apply this package's migrations. The tests that need a database start from this.
database.assertDisposable("reset")
const db = connect(database.url, { max: 1 })
try {
  await db.execute(sql.raw("drop schema public cascade; drop schema if exists drizzle cascade; create schema public"))
  await migrate(db, { folder: migrationsFolder })
  console.log(`Migrated ${new URL(database.url).pathname.slice(1)}`)
} finally {
  await db.$client.end()
}
