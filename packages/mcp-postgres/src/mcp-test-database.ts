// An MCP's schema in the shared test database, served as production serves it: what `createTestMcp` and `assertProviderConformance` give a
// provider with a database (testing.ts). Apart from that entry point, so that it is no part of the package's API.
import { AsyncLocalStorage } from "node:async_hooks"
import { defineConfig } from "@answerable/config"
import type { NodePgDatabase } from "drizzle-orm/node-postgres"
import { Client, Pool } from "pg"
import { z } from "zod"
import { mcpDatabase } from "./mcp-database"
import { migrateMcp } from "./migrate-mcp"
import { assertMcpName, roleLock, sharedMcps } from "./names"
import { provisionMcps, sqlOf } from "./provision"

/** The test databases this package's helpers reset: on their own, so that a process the tests start with `NODE_ENV=production` needs nothing else. */
export const mcpPostgresTestConfig = defineConfig("MCP Postgres test databases", {
  MCP_POSTGRES_TEST_DATABASE_URL: {
    schema: z.url(),
    fallback: "postgres://answerable:answerable@localhost:47432/answerable_mcp_postgres_test",
    doc: "The disposable database @answerable/mcp-postgres's own tests reset, named answerable_mcp_postgres_test",
  },
  MCPS_TEST_DATABASE_URL: {
    schema: z.url(),
    fallback: "postgres://answerable:answerable@localhost:47432/answerable_mcps_test",
    doc: "The shared MCP test database, answerable_mcps_test, as a superuser of the development Postgres: each MCP's tests reset only their own schema there",
  },
})

/**
 * An MCP's test database, served as production serves it: its schema `name` in `answerable_mcps_test` (`MCPS_TEST_DATABASE_URL`), dropped and
 * recreated, provisioned, then migrated from `folder` as the migrator login, with the development password, and reached through `mcpDatabase`
 * as a fresh serving login with a generated name. `db` takes its organisation from
 * `asOrganisation(id, fn)`, which awaits `fn` as that organisation, and otherwise from the `organisation` getter; `close()` drops the login.
 * Suites for different MCPs run at once, each in its own schema as a login of its own.
 */
export async function testMcpDatabase<Schema extends Record<string, unknown>>({ name, schema, folder, organisation }: {
  name: string
  schema: Schema
  folder: string
  organisation?: () => string | undefined
}): Promise<{ db: NodePgDatabase<Schema>; asOrganisation: <T>(id: string, fn: () => T) => Promise<Awaited<T>>; close: () => Promise<void> }> {
  assertMcpName(name)
  const url = new URL(mcpPostgresTestConfig.read(process.env).MCPS_TEST_DATABASE_URL)
  if (url.pathname !== "/answerable_mcps_test") throw new Error(`Refusing to reset an MCP's schema in ${url.pathname.slice(1) || "an unnamed database"}; expected answerable_mcps_test`)
  const login = `mcp_test_login_${crypto.randomUUID().replaceAll("-", "")}`
  const password = crypto.randomUUID().replaceAll("-", "")
  const as = async (location: URL, work: (client: Client) => Promise<unknown>) => {
    const client = new Client({ connectionString: location.href })
    await client.connect()
    try {
      await work(client)
    } finally {
      await client.end()
    }
  }
  await as(url, async client => {
    // CREATE ROLE takes no parameters; the name and the password are generated here.
    await client.query(`drop schema if exists "${name}" cascade; create role ${login} login password '${password}' noinherit`)
    await provisionMcps(sqlOf(client), { mcps: [{ name }], logins: { ...sharedMcps.logins, toolbox: login } })
  })
  await as(Object.assign(new URL(url), { username: sharedMcps.logins.migrator, password: "answerable" }), client => migrateMcp({ client, name, folder, serving: login }))
  const served = new URL(url)
  served.username = login
  served.password = password
  const pool = new Pool({ connectionString: served.href, max: 4 })
  const organisations = new AsyncLocalStorage<string>()
  return {
    db: mcpDatabase(pool, { name, schema, organisation: () => organisations.getStore() ?? organisation?.() }),
    asOrganisation: <T>(id: string, fn: () => T) => organisations.run(id, async (): Promise<Awaited<T>> => await fn()),
    async close() {
      await pool.end()
      // Under the lock: dropping what the login was granted rewrites the database's privileges, which provisioning beside it rewrites too.
      await as(url, client => client.query(`begin; select pg_advisory_xact_lock(${roleLock}); drop owned by ${login}; drop role ${login}; commit`))
    },
  }
}
