import { SQL } from "bun"
import { configureRuntimeRole, type Grant } from "./runtime-role"

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
    /**
     * A fresh restricted login on the test database, made as deployment tooling makes one and provisioned with `grants` by `configureRuntimeRole`,
     * as a server's migrate script provisions its runtime role; the name and password are generated. Its `role`, its `url`, a connection `db` as
     * it, and `drop()`, which closes the connection and removes the login and its privileges. The URL's owner makes it.
     */
    async runtimeLogin(grants: readonly Grant[]) {
      assertDisposable("provision a login on")
      const role = `test_runtime_${crypto.randomUUID().replaceAll("-", "")}`
      const password = crypto.randomUUID().replaceAll("-", "")
      const owner = new SQL({ url, max: 1 })
      try {
        // CREATE ROLE takes no parameters; the name and the password are generated here.
        await owner.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls`)
        await configureRuntimeRole(owner, role, grants)
      } finally {
        await owner.close()
      }
      const login = new URL(url)
      login.username = role
      login.password = password
      const db = new SQL({ url: login.href, max: 4 })
      return {
        role,
        url: login.href,
        db,
        async drop() {
          await db.close()
          const owner = new SQL({ url, max: 1 })
          try {
            await owner.unsafe(`drop owned by ${role}; drop role ${role}`).simple()
          } finally {
            await owner.close()
          }
        },
      }
    },
  }
}
