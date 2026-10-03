import { SQL } from "bun"

/**
 * A suite's disposable test database, `name`, at `url`: the variable that overrides it, else the development Postgres on port 47432. Every use
 * refuses a URL that names any other database, so that a suite's reset can never reach a real one.
 */
export function testDatabase(name: string, url = `postgres://answerable:answerable@localhost:47432/${name}`) {
  /** Throw, naming `action` (reset, migrate, connect to), unless the URL names the test database. */
  function assertDisposable(action: string) {
    const named = new URL(url).pathname.slice(1)
    if (named !== name) throw new Error(`Refusing to ${action} ${named || "an unnamed database"}; expected ${name}`)
  }
  return {
    url,
    assertDisposable,
    /** A connection to the test database, closed by the caller. */
    connect() {
      assertDisposable("connect to")
      return new SQL({ url, max: 4 })
    },
  }
}
