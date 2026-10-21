import { DrizzleQueryError, sql } from "drizzle-orm"
import { connect, type Executor } from "./connect"
import { configureRuntimeRole, type Grant } from "./runtime-role"

/** A tagged template that runs a query on `db` and returns its rows: `const query = rowsOf(db); await query\`select …\``, for a suite's own reads. */
export const rowsOf = (db: Executor) => async <T extends Record<string, unknown> = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]> =>
  (await db.execute(sql(strings, ...values))).rows as T[]

/** What the database said when it refused `query`, unwrapped from drizzle's query error; throws when the query succeeded. */
export const refusalOf = (query: Promise<unknown>): Promise<string> =>
  query.then(() => { throw new Error("The query succeeded") }, (error: unknown) => (error instanceof DrizzleQueryError ? (error.cause as Error).message : (error as Error).message))

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
  // Statements as the URL's owner, each on its own, on a connection closed afterwards: a database is created or dropped outside any transaction.
  async function asOwner(...statements: string[]) {
    const owner = connect(url, { max: 1 })
    try {
      for (const statement of statements) await owner.execute(sql.raw(statement))
    } finally {
      await owner.$client.end()
    }
  }
  return {
    url,
    assertDisposable,
    /** A connection to the test database, closed by the caller with `db.$client.end()`. */
    connect() {
      assertDisposable("connect to")
      return connect(url, { max: 4 })
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
      // CREATE ROLE takes no parameters; the name and the password are generated here.
      await asOwner(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls`)
      const owner = connect(url, { max: 1 })
      try {
        await configureRuntimeRole(owner, role, grants)
      } finally {
        await owner.$client.end()
      }
      const login = new URL(url)
      login.username = role
      login.password = password
      const db = connect(login.href, { max: 4 })
      return {
        role,
        url: login.href,
        db,
        async drop() {
          await db.$client.end()
          await asOwner(`drop owned by ${role}; drop role ${role}`)
        },
      }
    },
    /**
     * An empty database beside the test database, `<name>_<suffix>`, for a test that starts from nothing: created now, after dropping what a previous
     * run left, with its `url`, a connection `db` as the owner and `drop()`, which closes the connection and drops it. Its name derives from the test
     * database's, so it is as disposable.
     */
    async scratch(suffix: string) {
      assertDisposable("create a scratch database beside")
      const scratch = `${name}_${suffix}`
      await asOwner(`drop database if exists ${scratch} with (force)`, `create database ${scratch}`)
      const location = new URL(url)
      location.pathname = `/${scratch}`
      const db = connect(location.href, { max: 4 })
      return {
        url: location.href,
        db,
        async drop() {
          await db.$client.end()
          await asOwner(`drop database ${scratch} with (force)`)
        },
      }
    },
  }
}
