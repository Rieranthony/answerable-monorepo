import { ownMcpDatabase, provisionMcps, provisionOwnMcp, servedBy, sharedMcps, type DeclaredMcp, type Sql } from "@answerable/mcp-postgres"
import type { SecretRef, SecretStore } from "./secret-store"

type Login = { name: string; ref: SecretRef }
/** A database, owned by its owner login, which migrates it, and served by restricted runtime logins. */
type Database = { name: string; owner: Login; runtime: Login[] }

const login = (name: string, secret: string, key: string): Login => ({ name, ref: { secret, key } })
/** A server's own database: `answerable_<name>`, its owner's URL in `<name>-database-owner`, its runtime login's in `<name>-database`. */
const server = (name: string, prefix: string): Database => ({
  name: `answerable_${name}`,
  owner: login(`answerable_${name}_owner`, `${name}-database-owner`, `${prefix}DATABASE_MIGRATION_URL`),
  runtime: [login(`answerable_${name}_runtime`, `${name}-database`, `${prefix}DATABASE_URL`)],
})

/**
 * Every database the release runs on (D4, B1), each login's URL a key of a Secret the chart reads: the owners' in the Secrets the migration
 * Jobs mount, the runtime logins' in those the services mount.
 * - ID's, the Toolbox's, the admin MCP's and the standalone server's, each with its owner and one runtime login;
 * - the shared MCP database, owned by its migrator, which the mcps-migrate Job mounts, and served by the Toolbox's and the standalone server's
 *   logins, which take each MCP's runtime role;
 * - for each own MCP of the chart's list, `answerable_mcp_<name>`, with its owner and runtime logins in `mcp-<name>-database-owner` and
 *   `mcp-<name>-database`.
 */
export function databasesFor(mcps: readonly DeclaredMcp[]): Database[] {
  const { database, logins } = sharedMcps
  return [
    server("id", ""),
    server("toolbox", "TOOLBOX_"),
    server("admin", "ADMIN_"),
    server("standalone", "STANDALONE_"),
    {
      name: database,
      owner: login(logins.migrator, "mcps-database-owner", "MCPS_DATABASE_MIGRATION_URL"),
      runtime: [login(logins.toolbox, "toolbox-mcps-database", "TOOLBOX_MCPS_DATABASE_URL"), login(logins.standalone, "standalone-mcps-database", "STANDALONE_MCPS_DATABASE_URL")],
    },
    ...mcps.filter(mcp => mcp.database === "own").map(({ name }) => {
      const own = ownMcpDatabase(name)
      return { name: own.database, owner: login(own.owner, `mcp-${name}-database-owner`, "DATABASE_MIGRATION_URL"), runtime: [login(own.runtime, `mcp-${name}-database`, "DATABASE_URL")] }
    }),
  ]
}

/** 32 random bytes, base64url: a password with no character that needs quoting in a URL or SQL. */
function generatePassword() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
}

const identifier = (name: string) => `"${name}"`
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`
// What a runtime login must not be. The administrative login of a managed database can set these on a role it creates, but only a
// superuser can clear SUPERUSER, REPLICATION or BYPASSRLS on an existing one, so those are checked rather than altered.
const restrictedOnCreate = "nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls"
const restrictedOnAlter = "nocreatedb nocreaterole noinherit"
const unfixable = [["rolsuper", "SUPERUSER"], ["rolreplication", "REPLICATION"], ["rolbypassrls", "BYPASSRLS"]] as const

type Options = {
  sql: Sql
  /** The same administrative login, on one connection to another database, for provisioning the MCPs there. */
  database: (name: string) => { sql: Sql; close: () => Promise<void> }
  /** The chart's list of MCPs (OPS_MCPS). */
  mcps: readonly DeclaredMcp[]
  store: SecretStore
  /** The database host and port the services connect to, written into each URL. */
  host: string
  port: number
  /** The certificate authority the services verify the database against: each URL's `sslrootcert` (D5). */
  sslRootCert: string
  password?: () => string
  log?: (line: string) => void
}

// A statement that waits on a lock, or runs away, fails with PostgreSQL's reason instead of holding the Job until its deadline.
async function bounded(sql: Sql) {
  await sql("set lock_timeout = '10s'")
  await sql("set statement_timeout = '60s'")
}

/**
 * Create, or bring back in line, every database of {@link databasesFor} and their logins with an administrative login that may create databases
 * and roles (a managed database's administrator, not necessarily a superuser), and write each login's URL to the store. A login whose Secret
 * holds a URL gets that URL's password; one whose Secret is empty gets a new password, written. Then, on a connection to each, `@answerable/mcp-
 * postgres` provisions the MCPs of `mcps`: in the shared database, each shared MCP's schema and roles for the servers that serve it; in each own
 * MCP's database, its schema. Running it again changes nothing. Never prints a password.
 */
export async function bootstrap({ sql, database: connect, mcps, store, host, port, sslRootCert, password = generatePassword, log = console.log }: Options) {
  const address = host.includes(":") ? `[${host}]` : host
  await bounded(sql)
  for (const database of databasesFor(mcps)) {
    for (const [login, restricted] of [[database.owner, false], ...database.runtime.map(runtime => [runtime, true] as const)] as const) {
      const where = `${login.ref.secret}/${login.ref.key}`
      const stored = await store.get(login.ref)
      const secret = stored === undefined ? password() : passwordIn(stored, where, login.name)
      const [existing] = await sql("select rolsuper, rolreplication, rolbypassrls from pg_roles where rolname = $1", [login.name])
      if (existing) {
        for (const [column, attribute] of unfixable) if (existing[column]) throw new Error(`The login ${login.name} has ${attribute}: make it an ordinary login, then run bootstrap again`)
        await sql(`alter role ${identifier(login.name)} with login password ${literal(secret)}${restricted ? ` ${restrictedOnAlter}` : ""}`)
        log(`${login.name}: password set ${stored === undefined ? "anew, because its Secret was empty" : "to the one its Secret holds"}`)
      } else {
        await sql(`create role ${identifier(login.name)} with login password ${literal(secret)}${restricted ? ` ${restrictedOnCreate}` : ""}`)
        log(`${login.name}: created`)
      }
      if (stored === undefined) {
        await store.put(login.ref, `postgres://${login.name}:${encodeURIComponent(secret)}@${address}:${port}/${database.name}?sslmode=verify-full&sslrootcert=${sslRootCert}`)
        log(`${login.name}: URL written to ${where}`)
      }
    }
    // Acting as the owner lets the administrative login create the owner's database (PostgreSQL 16 and later ask for it) and change its privileges.
    await sql(`grant ${identifier(database.owner.name)} to current_user`)
    const [current] = await sql("select pg_get_userbyid(datdba) as owner from pg_database where datname = $1", [database.name])
    if (!current) {
      await sql(`create database ${identifier(database.name)} owner ${identifier(database.owner.name)}`)
      log(`${database.name}: created, owned by ${database.owner.name}`)
    } else if (current.owner !== database.owner.name) {
      // Owned by anyone else, the migrations' revokes of CREATE and TEMP from PUBLIC do nothing and the services refuse to start.
      await sql(`alter database ${identifier(database.name)} owner to ${identifier(database.owner.name)}`)
      log(`${database.name}: now owned by ${database.owner.name}`)
    }
    const runtime = database.runtime.map(({ name }) => identifier(name)).join(", ")
    await sql(`revoke all on database ${identifier(database.name)} from public`)
    await sql(`grant connect on database ${identifier(database.name)} to ${runtime}`)
    await sql(`revoke temporary on database ${identifier(database.name)} from ${runtime}`)
    log(`${database.name}: only its owner and ${database.runtime.map(({ name }) => name).join(" and ")} may connect`)
  }
  const shared = mcps.filter(mcp => mcp.database === "shared")
  await on(connect(sharedMcps.database), sql => provisionMcps(sql, { mcps: shared.map(({ name, serve }) => ({ name, servedBy: servedBy[serve] })), logins: sharedMcps.logins }))
  log(`${sharedMcps.database}: ${shared.length ? `${shared.map(({ name }) => name).join(", ")} provisioned` : "no MCP to provision"}`)
  for (const { name } of mcps.filter(mcp => mcp.database === "own")) {
    const own = ownMcpDatabase(name)
    await on(connect(own.database), sql => provisionOwnMcp(sql, { name, owner: own.owner, runtime: own.runtime }))
    log(`${own.database}: schema ${name} provisioned`)
  }
}

/** `work` on a bounded connection, closed afterwards. */
async function on(connection: { sql: Sql; close: () => Promise<void> }, work: (sql: Sql) => Promise<void>) {
  try {
    await bounded(connection.sql)
    await work(connection.sql)
  } finally {
    await connection.close()
  }
}

/** The password of the URL a Secret holds, refusing one for another login. Errors name the Secret, never its value. */
function passwordIn(stored: string, where: string, name: string) {
  let url: URL
  try {
    url = new URL(stored)
  } catch {
    throw new Error(`${where} does not hold a URL`)
  }
  if (decodeURIComponent(url.username) !== name) throw new Error(`${where} holds a URL for ${decodeURIComponent(url.username)}, not ${name}`)
  return decodeURIComponent(url.password)
}
