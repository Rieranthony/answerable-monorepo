/** A role, schema or table name this package writes into SQL unquoted-safe: lowercase letters, digits and underscores, 63 at most. */
export const identifier = /^[a-z_][a-z0-9_]{0,62}$/

/** A name quoted as an SQL identifier, so that a valid name that is also a keyword, such as "user", stays a name. */
export const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

/**
 * The advisory lock every statement on the cluster's roles takes, transaction-scoped or for a session, so that concurrent suites and
 * processes never race on `pg_authid` or `pg_auth_members`.
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

/** An MCP's two roles in the shared database: its owner, `<prefix>_<name>_owner`, and its runtime role, `<prefix>_<name>`. */
export function mcpRoles(prefix: string, name: string): { owner: string; runtime: string } {
  assertMcpName(name)
  const roles = { owner: `${prefix}_${name}_owner`, runtime: `${prefix}_${name}` }
  if (!/^[a-z][a-z0-9_]*$/.test(prefix) || !identifier.test(roles.owner)) throw new Error(`Role prefix "${prefix}" must be lowercase letters, digits and underscores, short enough for ${roles.owner} to be a role name`)
  return roles
}

/** The shared MCP database and its two logins, as the deployment's bootstrap and the development Postgres name them. */
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
