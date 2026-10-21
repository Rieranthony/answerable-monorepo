import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import { Pool, type PoolConfig } from "pg"

/** A server's database: drizzle over a `pg` pool, which is `db.$client`; `db.$client.end()` closes it. */
export type Database = NodePgDatabase & { $client: Pool }
/** A database (over a pool or one client), or a transaction on one, as this package's functions take it. */
export type Executor = NodePgDatabase | Parameters<Parameters<NodePgDatabase["transaction"]>[0]>[0]
/** What `connect` passes through to `pg.Pool`: everything but the URL and the TLS settings, which come from the URL. */
export type ConnectOptions = Omit<PoolConfig, "connectionString" | "ssl">

/**
 * A drizzle database over a `pg` pool on a Postgres URL, read the way libpq reads it: `sslmode` and `sslrootcert` in the URL make the pool verify the
 * server against that certificate authority, so a deployment's URL ends in `?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.pem`. A URL naming
 * `sslrootcert` must ask for `sslmode=verify-full` or `verify-ca`, so that the file is never there for show (pg 8 verifies fully under either, and
 * warns once that `verify-ca` will mean less in pg 9). The pool is lazy: nothing connects until the first query. `options` are the pool's, such as `max`.
 */
export function connect(url: string, options: ConnectOptions = {}): Database {
  const parsed = new URL(url)
  if (parsed.searchParams.has("sslrootcert")) {
    const mode = parsed.searchParams.get("sslmode")
    if (mode !== "verify-full" && mode !== "verify-ca") throw new Error(`sslrootcert needs sslmode=verify-full or sslmode=verify-ca, not ${mode ? `sslmode=${mode}` : "no sslmode"}`)
  }
  return drizzle({ client: new Pool({ ...options, connectionString: url }) })
}
