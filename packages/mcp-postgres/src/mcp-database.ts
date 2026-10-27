import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import type { Pool, PoolClient, QueryConfig, QueryResult } from "pg"
import { assertMcpName, quote } from "./names"
import { organisationSetting } from "./organisation"

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A pool-shaped view of the shared pool for one MCP: every borrowed connection runs `setup()` first, and is destroyed rather than returned when
 * the setup fails or when it is released inside a transaction. Nothing is reset on release: the next borrow sets everything again. A class only
 * because drizzle takes a client as a pool when its constructor's name contains `Pool` (`drizzle-orm/node-postgres/session.js:181`), and so
 * borrows a connection for each transaction.
 */
class McpPool {
  constructor(private readonly pool: Pool, private readonly setup: () => string) {}

  async connect(): Promise<PoolClient> {
    const setup = this.setup()
    const client = await this.pool.connect()
    try {
      await client.query(setup)
    } catch (error) {
      client.release(error as Error)
      throw error
    }
    const release = client.release
    client.release = (error?: Error | boolean) => {
      client.release = release
      release(error || (client.getTransactionStatus() === "I" ? undefined : new Error("Released inside a transaction")))
    }
    return client
  }

  async query(config: string | QueryConfig, values?: unknown[]): Promise<QueryResult> {
    const client = await this.connect()
    try {
      return await client.query(config, values)
    } finally {
      client.release()
    }
  }
}

/**
 * The drizzle database an MCP's tools use, made once per process for each MCP over a pool that may be shared by every MCP: the shared database's,
 * as the serving login, or an own MCP's, as its runtime login. Each borrowed connection, for a query or a transaction, first sets, in one round
 * trip, the MCP's schema as the search path and the caller's organisation from `organisation()`, a UUID, or `undefined`, which resets it so that
 * no row matches. The next borrow sets both again, so nothing is reset on release.
 */
export function mcpDatabase<Schema extends Record<string, unknown>>(
  pool: Pool,
  { name, schema, organisation }: { name: string; schema: Schema; organisation: () => string | undefined },
): NodePgDatabase<Schema> {
  assertMcpName(name)
  const setup = () => {
    const id = organisation()
    if (id !== undefined && !uuid.test(id)) throw new Error(`The organisation "${id}" is not a UUID`)
    return [
      `set search_path to ${quote(name)}`,
      id === undefined ? `reset ${organisationSetting}` : `select set_config('${organisationSetting}', '${id}', false)`,
    ].join("; ")
  }
  return drizzle({ client: new McpPool(pool, setup) as unknown as Pool, schema })
}
