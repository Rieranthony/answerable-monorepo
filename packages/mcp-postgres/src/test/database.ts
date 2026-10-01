import { SQL } from "bun"

const testDatabaseName = "answerable_mcp_postgres_test"
export const testDatabaseUrl = process.env.MCP_POSTGRES_TEST_DATABASE_URL ?? `postgres://answerable:answerable@localhost:47432/${testDatabaseName}`

/** Refuse to reset or migrate anything but the disposable test database. */
export function assertDisposable(action: string, url = testDatabaseUrl) {
  const name = new URL(url).pathname.slice(1)
  if (name !== testDatabaseName) throw new Error(`Refusing to ${action} ${name || "an unnamed database"}; expected ${testDatabaseName}`)
}

/** A connection to the test database, closed by the caller. Refuses to connect to anything else. */
export function testDatabase() {
  assertDisposable("connect to")
  return new SQL({ url: testDatabaseUrl, max: 4 })
}
