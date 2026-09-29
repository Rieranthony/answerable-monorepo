import { SQL } from "bun"

export const testDatabaseName = "answerable_toolbox_test"
export const testDatabaseUrl = process.env.TOOLBOX_TEST_DATABASE_URL ?? `postgres://answerable:answerable@localhost:47432/${testDatabaseName}`

/** Refuse to reset or migrate anything but the disposable test database. */
export function assertDisposable(action: string, url = testDatabaseUrl) {
  const name = new URL(url).pathname.slice(1)
  if (name !== testDatabaseName) throw new Error(`Refusing to ${action} ${name || "an unnamed database"}; expected ${testDatabaseName}`)
}

/** A connection to the test database, closed by the caller. */
export const testDatabase = () => new SQL({ url: testDatabaseUrl, max: 4 })
