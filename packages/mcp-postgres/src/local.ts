import { readFile } from "node:fs/promises"
import { Client } from "pg"
import { roleLock } from "./names"

/** The development Postgres's set-up of the shared MCP database, which the Postgres image runs on a fresh volume. */
const initFile = new URL("../../../infra/postgres/init/006-create-mcps-databases.sql", import.meta.url)
const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"])

/**
 * Create `answerable_mcps`, `answerable_mcps_test` and their two logins on the development Postgres when they are missing, by running
 * `infra/postgres/init/006-create-mcps-databases.sql` as psql would, so an existing volume needs no manual step. The file's database privileges
 * are applied only when it has just created a database: `provisionMcps` keeps them on a database that exists. `adminUrl` is a superuser's URL
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
    const [grants, ...queries] = (await readFile(initFile, "utf8")).split("\\gexec").reverse()
    let created = false
    // psql's \gexec runs each value of the query before it as a statement of its own: here, each CREATE DATABASE.
    for (const query of queries.reverse()) {
      const { rows } = [await client.query(query)].flat().at(-1)!
      for (const row of rows) for (const statement of Object.values(row)) created = Boolean(await client.query(statement as string))
    }
    // The databases' privileges, only when this run created one. For one that exists, provisionMcps keeps them, under the lock it takes in
    // that database; this connection's lock is the postgres database's, so granting here would race it on the database's catalogue row.
    if (created) await client.query(grants!)
  } finally {
    await client.end()
  }
}
