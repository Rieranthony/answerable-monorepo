/** A role, schema or table name this package writes into SQL unquoted-safe: lowercase letters, digits and underscores, 63 at most. */
export const identifier = /^[a-z_][a-z0-9_]{0,62}$/

/** A name quoted as an SQL identifier, so that a valid name that is also a keyword, such as "user", stays a name. */
export const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

/**
 * The advisory lock every statement on the cluster's roles or on a database's own privileges takes, transaction-scoped or for a session, so
 * that concurrent suites and processes never race on `pg_authid`, `pg_auth_members` or a `pg_database` row: of two grants on one database at
 * once, the second waits for the first, then fails with "tuple concurrently updated".
 */
export const roleLock = "hashtext('answerable:mcp-runtime-role')"

/**
 * Refuse a name that is not an MCP's: the provider id's rule, a lowercase letter then up to 11 lowercase letters or digits, and never `public`
 * or `drizzle`, the schemas Postgres and drizzle own.
 */
export function assertMcpName(name: string): void {
  if (!/^[a-z][a-z0-9]{0,11}$/.test(name)) throw new Error(`MCP name "${name}" must be a lowercase letter then up to 11 lowercase letters or digits, for example acme`)
  if (name === "public" || name === "drizzle") throw new Error(`MCP name ${name} is reserved: Postgres or drizzle owns a schema of that name`)
}

/**
 * The shared MCP database and its two logins, as the deployment's bootstrap and the development Postgres name them: the migrator, which owns
 * the database and every MCP's schema and migrates them, and the Toolbox's serving login, granted every MCP's schema and tables.
 */
export const sharedMcps = {
  database: "answerable_mcps",
  logins: { migrator: "answerable_mcps_migrator", toolbox: "answerable_mcps_toolbox" },
} as const

/** An own MCP's database, `answerable_mcp_<name>`, and its two logins: its owner, `…_owner`, which migrates it, and its runtime login, `…_runtime`. */
export function ownMcpDatabase(name: string): { database: string; owner: string; runtime: string } {
  assertMcpName(name)
  const database = `answerable_mcp_${name}`
  return { database, owner: `${database}_owner`, runtime: `${database}_runtime` }
}
