import { readFile } from "node:fs/promises"
import { Client } from "pg"
import { roleLock } from "./names"

/** The development Postgres's set-up of the shared MCP database, which the Postgres image runs on a fresh volume. */
const initFile = new URL("../../../infra/postgres/init/006-create-mcps-databases.sql", import.meta.url)
const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"])

/**
 * Create `answerable_mcps`, `answerable_mcps_test` and their three logins on the development Postgres when they are missing, by running
 * `infra/postgres/init/006-create-mcps-databases.sql` as psql would, so an existing volume needs no manual step. `adminUrl` is a superuser's URL
 * to any database of that cluster, on this machine: any other host is refused, since the logins get the development password. Concurrent
 * callers wait on the lock every role statement here takes.
 */
export async function ensureLocalMcpDatabases(adminUrl: string): Promise<void> {
  const { hostname } = new URL(adminUrl)
  if (!localHosts.has(hostname)) throw new Error(`Refusing to set up the local MCP databases on ${hostname}: only the development Postgres on this machine gets them`)
  const client = new Client({ connectionString: adminUrl })
  await client.connect()
  try {
    // A session lock, released when the connection closes: CREATE DATABASE refuses to run inside a transaction.
    await client.query(`select pg_advisory_lock(${roleLock})`)
    const [last, ...queries] = (await readFile(initFile, "utf8")).split("\\gexec").reverse()
    // psql's \gexec runs each value of the query before it as a statement of its own.
    for (const query of queries.reverse()) {
      const results = [await client.query(query)].flat()
      for (const row of results.at(-1)!.rows) for (const statement of Object.values(row)) await client.query(statement as string)
    }
    await client.query(last!)
  } finally {
    await client.end()
  }
}
