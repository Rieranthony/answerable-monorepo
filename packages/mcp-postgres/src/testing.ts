import { afterAll, describe } from "bun:test"
import { fileURLToPath } from "node:url"
import { callerOrganisation, type Provider, type Target, type UserPrincipal } from "@answerable/mcp"
import { assertProviderConformance as assertConformance, createTestMcp as createSdkTestMcp, type ConformanceFixture, type TestMcp, type TestServing } from "@answerable/mcp/testing"
import { DrizzleQueryError, sql } from "drizzle-orm"
import type { NodePgDatabase } from "drizzle-orm/node-postgres"
import { connect, type Executor } from "./connect"
import { configureRuntimeRole, type Grant } from "./runtime-role"
import { testMcpDatabase } from "./mcp-test-database"

export { mcpPostgresTestConfig } from "./mcp-test-database"

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

// A provider's test database, as testMcpDatabase makes it, with the organisation of the call the SDK is running.
function providerDatabase(provider: Provider) {
  if (!provider.database) throw new Error(`Provider ${provider.id} has no database; import createTestMcp and assertProviderConformance from @answerable/mcp/testing`)
  const { schema, migrations } = provider.database
  return testMcpDatabase({ name: provider.id, schema, folder: fileURLToPath(migrations), organisation: callerOrganisation })
}

/** What a test's own server is built from: the SDK's `TestServing`, with the provider and its test `db`, ready to spread into `createMcpServer`. */
export type DatabaseServing = TestServing & { provider: Provider; db: unknown }

/** An in-process MCP with a database: the SDK's `TestMcp`, with the test database to seed and read rows as an organisation. */
export type DatabaseTestMcp = TestMcp & {
  /** The provider's test database, the one its handlers receive, typed by no schema: pass its tables to `insert` and `select`. */
  db: NodePgDatabase<Record<string, unknown>>
  /** Run `fn` as a member of organisation `id` and await it, so that `db` reads and writes that organisation's rows. */
  asOrganisation<T>(id: string, fn: () => T): Promise<Awaited<T>>
}

/**
 * `@answerable/mcp/testing`'s `createTestMcp`, for a provider with a `database`: it serves the provider with its `db`, made by `testMcpDatabase`
 * from `provider.database` (schema `<id>` in `answerable_mcps_test`, reset and migrated), each call seeing only the rows of its caller's
 * organisation, so `connect({ organizationId })` gives isolation by organisation. `db` and `asOrganisation(id, fn)` seed and read rows as an
 * organisation. `server` builds the server from the local issuer's `auth`, the test `profiles`, the provider and its `db`, for options such as
 * `intents` or `policyClass`. `close()` also drops the test login.
 *
 * @example
 * ```ts
 * import { createTestMcp } from "@answerable/mcp-postgres/testing"
 * import { notes } from "./db/schema"
 * import { provider } from "./provider"
 *
 * const mcp = await createTestMcp(provider)
 * const organizationId = crypto.randomUUID()
 * await mcp.asOrganisation(organizationId, () => mcp.db.insert(notes).values({ organisation_id: organizationId, title: "First" }))
 * const client = await mcp.connect({ organizationId })
 * await mcp.close()
 * ```
 */
export async function createTestMcp(provider: Provider, { server, ...options }: Omit<NonNullable<Parameters<typeof createSdkTestMcp>[1]>, "db"> & {
  /** Build the server from what the test serves with, `{ auth, profiles, provider, db }`, which spreads into `createMcpServer`'s options. */
  server?: (serving: DatabaseServing) => { fetch(request: Request): Promise<Response> }
} = {}): Promise<DatabaseTestMcp> {
  const database = await providerDatabase(provider)
  const { db } = database
  const mcp = await createSdkTestMcp(server ? serving => server({ ...serving, provider, db }) : provider, { ...options, db })
  return {
    ...mcp,
    db,
    asOrganisation: database.asOrganisation,
    async close() {
      await mcp.close()
      await database.close()
    },
  }
}

/** What the functions of a database fixture also receive: the provider's test database, and `asOrganisation` to seed or change its rows as one. */
export type FixtureDatabase = Pick<DatabaseTestMcp, "db" | "asOrganisation">

/** The SDK's `ConformanceFixture` for a provider with a `database`: its `examples` functions and `moveTarget` also receive the test database. */
export type DatabaseFixture = Omit<ConformanceFixture, "db" | "examples" | "moveTarget"> & {
  /** As the SDK's, and a function also receives the test database, to create the row an input names. */
  examples?: Record<string, Record<string, unknown> | ((principal: UserPrincipal, database: FixtureDatabase) => Record<string, unknown> | Promise<Record<string, unknown>>)>
  /** As the SDK's, with the test database to change the target's row in. */
  moveTarget?(target: Target, principal: UserPrincipal, database: FixtureDatabase): unknown
}

/**
 * `@answerable/mcp/testing`'s `assertProviderConformance`, for a provider with a `database`: the kit serves the provider with its `db`, made by
 * `testMcpDatabase` from `provider.database` and dropped after the checks, and hands that database to the fixture's functions. Call it at the
 * top level of a test file, as the SDK's.
 */
export function assertProviderConformance(provider: Provider, { examples, moveTarget, ...fixture }: DatabaseFixture) {
  describe(`${provider.id} database`, async () => {
    const database = await providerDatabase(provider)
    afterAll(() => database.close())
    const given = Object.entries(examples ?? {}).map(([name, input]) => [name, typeof input === "function" ? (principal: UserPrincipal) => input(principal, database) : input])
    assertConformance(provider, {
      ...fixture, db: database.db, examples: Object.fromEntries(given),
      ...(moveTarget ? { moveTarget: (target: Target, principal: UserPrincipal) => moveTarget(target, principal, database) } : {}),
    })
  })
}
