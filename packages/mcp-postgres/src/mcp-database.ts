import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import type { Pool, PoolClient, QueryConfig, QueryResult } from "pg"
import { mcpRoles, quote } from "./names"
import { organisationSetting } from "./organisation"

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// One round trip on release, whatever the borrow set.
const reset = `reset role; reset search_path; reset ${organisationSetting}`

/**
 * A pool-shaped view of the shared pool for one MCP: every borrowed connection runs `setup()` first and the reset when it is released. A
 * connection is destroyed rather than returned when its reset fails or when it is released inside a transaction, so no role, schema or
 * organisation outlives the borrow. A class only because drizzle takes a client as a pool when its constructor's name contains `Pool`
 * (`drizzle-orm/node-postgres/session.js:181`), and so borrows a connection for each transaction.
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
      if (error) return release(error)
      if (client.getTransactionStatus() !== "I") return release(new Error("Released inside a transaction"))
      client.query(reset).then(() => release(), (failure: Error) => release(failure))
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
 * The drizzle database an MCP's tools use, made once per process for each MCP over a pool that may be shared by every MCP. Each borrowed
 * connection, for a query or a transaction, first takes, in one round trip: in mode `shared`, the MCP's runtime role `<prefix>_<name>`
 * (`prefix` is `mcp` unless given); its schema as the search path; and the caller's organisation from `organisation()`, a UUID or `undefined`
 * (reset). On release it resets all three, and a failed reset destroys the connection. In mode `own` the pool is the MCP's own, as its
 * runtime login, and no role is taken.
 */
export function mcpDatabase<Schema extends Record<string, unknown>>(
  pool: Pool,
  { name, prefix = "mcp", schema, mode, organisation }: { name: string; prefix?: string; schema: Schema; mode: "shared" | "own"; organisation: () => string | undefined },
): NodePgDatabase<Schema> {
  const role = mcpRoles(prefix, name).runtime
  const setup = () => {
    const id = organisation()
    if (id !== undefined && !uuid.test(id)) throw new Error(`The organisation "${id}" is not a UUID`)
    return [
      ...(mode === "shared" ? [`set role ${quote(role)}`] : []),
      `set search_path to ${quote(name)}`,
      id === undefined ? `reset ${organisationSetting}` : `select set_config('${organisationSetting}', '${id}', false)`,
    ].join("; ")
  }
  return drizzle({ client: new McpPool(pool, setup) as unknown as Pool, schema })
}
