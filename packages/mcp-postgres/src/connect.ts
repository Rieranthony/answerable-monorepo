import { SQL } from "bun"
import { readFileSync } from "node:fs"

/** What `connect` passes through to `Bun.SQL`: everything but the URL and the TLS settings, which come from the URL. */
export type ConnectOptions = Omit<Extract<SQL.Options, { url?: unknown }>, "url" | "tls" | "ssl">

/**
 * A `Bun.SQL` pool on a Postgres URL, read the way libpq and `pg` read it. Bun 1.3.1 honours `sslmode` in the URL but ignores
 * `sslrootcert`, so a `verify-full` URL naming a private certificate authority would fail every handshake: `connect` reads the file and
 * gives it to Bun as the authority to verify the server against. A URL naming `sslrootcert` must ask for `sslmode=verify-full` or
 * `verify-ca`, so that the file is never there for show. The pool is lazy: nothing connects until the first query.
 */
export function connect(url: string, options: ConnectOptions = {}): SQL {
  const parsed = new URL(url)
  const root = parsed.searchParams.get("sslrootcert")
  if (root === null) return new SQL({ ...options, url })
  const mode = parsed.searchParams.get("sslmode")
  if (mode !== "verify-full" && mode !== "verify-ca") throw new Error(`sslrootcert needs sslmode=verify-full or sslmode=verify-ca, not ${mode ? `sslmode=${mode}` : "no sslmode"}`)
  parsed.searchParams.delete("sslrootcert")
  return new SQL({ ...options, url: parsed.toString(), tls: { ca: readFileSync(root, "utf8") } })
}
