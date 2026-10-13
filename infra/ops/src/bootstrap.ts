import type { SecretRef, SecretStore } from "./secret-store"

/** A statement on the administrative connection: `text` with `$1`… bound to `params`, returning its rows. */
export type Sql = (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>

type Login = { name: string; ref: SecretRef }
type Database = { name: string; owner: Login; runtime: Login }

const login = (name: string, secret: string, key: string): Login => ({ name, ref: { secret, key } })

/**
 * The three databases, each owned by its owner login, which migrates, and served by a restricted runtime login (D4, B1). Each login's URL is
 * a key of a Secret the chart reads: the owners' in the `*-database-owner` Secrets the migration Jobs mount, the runtime logins' in the
 * `*-database` Secrets the services mount.
 */
export const databases: Database[] = [
  { name: "answerable_id", owner: login("answerable_id_owner", "id-database-owner", "DATABASE_MIGRATION_URL"), runtime: login("answerable_id_runtime", "id-database", "DATABASE_URL") },
  { name: "answerable_toolbox", owner: login("answerable_toolbox_owner", "toolbox-database-owner", "TOOLBOX_DATABASE_MIGRATION_URL"), runtime: login("answerable_toolbox_runtime", "toolbox-database", "TOOLBOX_DATABASE_URL") },
  { name: "answerable_admin", owner: login("answerable_admin_owner", "admin-database-owner", "ADMIN_DATABASE_MIGRATION_URL"), runtime: login("answerable_admin_runtime", "admin-database", "ADMIN_DATABASE_URL") },
]

/** 32 random bytes, base64url: a password with no character that needs quoting in a URL or SQL. */
export function generatePassword() {
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
  store: SecretStore
  /** The database host and port the services connect to, written into each URL. */
  host: string
  port: number
  /** The certificate authority the services verify the database against: each URL's `sslrootcert` (D5). */
  sslRootCert: string
  password?: () => string
  log?: (line: string) => void
}

/**
 * Create, or bring back in line, the three databases and their six logins with an administrative login that may create databases and roles
 * (a managed database's administrator, not necessarily a superuser), and write each login's URL to the store. A login whose Secret holds a URL
 * gets that URL's password; one whose Secret is empty gets a new password, written. Running it again changes nothing. Never prints a password.
 */
export async function bootstrap({ sql, store, host, port, sslRootCert, password = generatePassword, log = console.log }: Options) {
  const address = host.includes(":") ? `[${host}]` : host
  for (const database of databases) {
    for (const [login, restricted] of [[database.owner, false], [database.runtime, true]] as const) {
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
    await sql(`revoke all on database ${identifier(database.name)} from public`)
    await sql(`grant connect on database ${identifier(database.name)} to ${identifier(database.runtime.name)}`)
    await sql(`revoke temporary on database ${identifier(database.name)} from ${identifier(database.runtime.name)}`)
    log(`${database.name}: only its owner and ${database.runtime.name} may connect`)
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
