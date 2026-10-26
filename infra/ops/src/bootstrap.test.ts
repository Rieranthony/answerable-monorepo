import { expect, test } from "bun:test"
import type { DeclaredMcp, Sql } from "@answerable/mcp-postgres"
import { bootstrap, databasesFor } from "./bootstrap"
import { memoryStore } from "./testing"

type Role = { password: string; rolsuper: boolean; rolreplication: boolean; rolbypassrls: boolean; restricted: boolean; login: boolean }

/**
 * A PostgreSQL that understands the statements bootstrap sends, and those `@answerable/mcp-postgres`'s provisioning sends on a connection to
 * another database: roles, databases and their owners, memberships, schemas, and a log of every statement, prefixed by its database when it
 * is not the administrative connection's.
 */
function fakePostgres({ roles = {}, owners = {} }: { roles?: Record<string, Partial<Role>>; owners?: Record<string, string> } = {}) {
  const state = {
    roles: Object.fromEntries(Object.entries(roles).map(([name, role]) => [name, { password: "", rolsuper: false, rolreplication: false, rolbypassrls: false, restricted: false, login: true, ...role }])) as Record<string, Role>,
    owners: { ...owners },
    memberships: new Set<string>(),
    schemas: new Set<string>(),
    statements: [] as string[],
    connections: [] as string[],
  }
  const on = (database?: string): Sql => async (text, params = []) => {
    state.statements.push(database ? `${database}: ${text}` : text)
    let match: RegExpMatchArray | null
    if (text.startsWith("select rolsuper")) {
      const role = state.roles[String(params[0])]
      return role ? [role] : []
    }
    if (text.startsWith("select rolcanlogin")) {
      const role = state.roles[String(params[0])]
      return role ? [{ rolcanlogin: role.login, rolinherit: false, rolcreatedb: false, rolcreaterole: false, ...role }] : []
    }
    if (text.startsWith("select pg_get_userbyid(datdba)")) {
      const owner = state.owners[String(params[0])]
      return owner ? [{ owner }] : []
    }
    if (text.startsWith("select datname as name")) return [{ name: database, owner: state.owners[database!] }]
    if (text.startsWith("select pg_get_userbyid(grantor)")) return state.memberships.has(`${params[0]}>${params[1]}`) ? [{ grantor: "dbadmin" }] : []
    if ((match = text.match(/^create role "(\w+)" with login password '((?:[^']|'')*)'(.*)$/))) {
      state.roles[match[1]!] = { password: match[2]!, rolsuper: false, rolreplication: false, rolbypassrls: false, restricted: match[3]!.includes("nobypassrls"), login: true }
      return []
    }
    if ((match = text.match(/^create role "(\w+)" nologin noinherit$/))) state.roles[match[1]!] = { password: "", rolsuper: false, rolreplication: false, rolbypassrls: false, restricted: true, login: false }
    if ((match = text.match(/^alter role "(\w+)" with login password '((?:[^']|'')*)'(.*)$/))) {
      const role = state.roles[match[1]!]!
      role.password = match[2]!
      if (match[3]!.includes("noinherit")) role.restricted = true
      return []
    }
    if ((match = text.match(/^grant "(\w+)" to "?(\w+)"? with inherit false, set true$/))) state.memberships.add(`${match[1]}>${match[2]}`)
    if ((match = text.match(/^revoke "(\w+)" from "(\w+)" granted by/))) state.memberships.delete(`${match[1]}>${match[2]}`)
    if ((match = text.match(/^create schema if not exists "(\w+)" authorization "(\w+)"$/))) state.schemas.add(`${database}.${match[1]}`)
    if ((match = text.match(/^create database "(\w+)" owner "(\w+)"$/))) state.owners[match[1]!] = match[2]!
    if ((match = text.match(/^alter database "(\w+)" owner to "(\w+)"$/))) state.owners[match[1]!] = match[2]!
    return []
  }
  const database = (name: string) => {
    state.connections.push(name)
    return { sql: on(name), close: async () => {} }
  }
  return { sql: on(), database, state }
}

const options = { host: "db.internal", port: 5432, sslRootCert: "/etc/ssl/db/ca.pem", mcps: [] as DeclaredMcp[] }
let counter = 0
const password = () => `generated-${++counter}-password`
const run = (pg: ReturnType<typeof fakePostgres>, store = memoryStore().store, more: Partial<Parameters<typeof bootstrap>[0]> = {}) =>
  bootstrap({ sql: pg.sql, database: pg.database, store, ...options, password, log: () => {}, ...more })
const mcps: DeclaredMcp[] = [{ name: "e2e", serve: "both", database: "shared" }, { name: "example", serve: "toolbox", database: "shared" }, { name: "acme", serve: "standalone", database: "own" }]

test("on an empty cluster: five databases owned by their owners, their logins, the serving ones restricted, every URL written", async () => {
  const pg = fakePostgres()
  const { store, values, writes } = memoryStore()
  const lines: string[] = []
  await bootstrap({ sql: pg.sql, database: pg.database, store, ...options, log: line => lines.push(line) })
  // No statement waits on a lock or runs for long: the Job fails with the reason instead of hanging.
  expect(pg.state.statements.slice(0, 2)).toEqual(["set lock_timeout = '10s'", "set statement_timeout = '60s'"])
  expect(Object.keys(pg.state.owners).sort()).toEqual(["answerable_admin", "answerable_id", "answerable_mcps", "answerable_standalone", "answerable_toolbox"])
  for (const database of databasesFor([])) {
    expect(pg.state.owners[database.name]).toBe(database.owner.name)
    expect(pg.state.roles[database.owner.name]!.restricted).toBe(false)
    expect(pg.state.statements).toContain(`grant "${database.owner.name}" to current_user`)
    expect(pg.state.statements).toContain(`revoke all on database "${database.name}" from public`)
    const runtime = database.runtime.map(({ name }) => `"${name}"`).join(", ")
    expect(pg.state.statements).toContain(`grant connect on database "${database.name}" to ${runtime}`)
    expect(pg.state.statements).toContain(`revoke temporary on database "${database.name}" from ${runtime}`)
    for (const { name } of database.runtime) expect(pg.state.roles[name]!.restricted).toBe(true)
    for (const login of [database.owner, ...database.runtime]) {
      const url = new URL(values[`${login.ref.secret}/${login.ref.key}`]!)
      expect(url.username).toBe(login.name)
      expect(decodeURIComponent(url.password)).toBe(pg.state.roles[login.name]!.password)
      expect(url.host).toBe("db.internal:5432")
      expect(url.pathname).toBe(`/${database.name}`)
      expect(url.search).toBe("?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.pem")
    }
  }
  expect(writes.sort()).toEqual([
    "admin-database-owner/ADMIN_DATABASE_MIGRATION_URL", "admin-database/ADMIN_DATABASE_URL",
    "id-database-owner/DATABASE_MIGRATION_URL", "id-database/DATABASE_URL",
    "mcps-database-owner/MCPS_DATABASE_MIGRATION_URL",
    "standalone-database-owner/STANDALONE_DATABASE_MIGRATION_URL", "standalone-database/STANDALONE_DATABASE_URL",
    "standalone-mcps-database/STANDALONE_MCPS_DATABASE_URL",
    "toolbox-database-owner/TOOLBOX_DATABASE_MIGRATION_URL", "toolbox-database/TOOLBOX_DATABASE_URL",
    "toolbox-mcps-database/TOOLBOX_MCPS_DATABASE_URL",
  ])
  // The shared database is owned by the migrator and served by the Toolbox's and the standalone server's logins; with no MCP, provisioning
  // only keeps its privileges.
  expect(pg.state.owners.answerable_mcps).toBe("answerable_mcps_migrator")
  expect(pg.state.connections).toEqual(["answerable_mcps"])
  expect(lines).toContain("answerable_mcps: no MCP to provision")
  // Generated passwords: 32 random bytes, base64url, each different.
  const passwords = Object.values(pg.state.roles).map(role => role.password)
  for (const value of passwords) expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(new Set(passwords).size).toBe(11)
  // What it says names logins, databases and Secrets, never a password.
  for (const line of lines) for (const value of passwords) expect(line).not.toContain(value)
})

test("with the chart's list: each shared MCP's schema and roles in answerable_mcps, for the servers that serve it; a database and two logins for each own one", async () => {
  const pg = fakePostgres()
  const { store, values, writes } = memoryStore()
  const lines: string[] = []
  await run(pg, store, { mcps, log: line => lines.push(line) })
  expect(writes.filter(write => write.startsWith("mcp-")).sort()).toEqual(["mcp-acme-database-owner/DATABASE_MIGRATION_URL", "mcp-acme-database/DATABASE_URL"])
  expect(pg.state.owners.answerable_mcp_acme).toBe("answerable_mcp_acme_owner")
  expect(pg.state.roles.answerable_mcp_acme_runtime!.restricted).toBe(true)
  expect(new URL(values["mcp-acme-database/DATABASE_URL"]!).pathname).toBe("/answerable_mcp_acme")
  expect(pg.state.connections).toEqual(["answerable_mcps", "answerable_mcp_acme"])
  // provisionMcps for the shared ones, as the administrative login, which takes each owner role without inheriting it.
  expect([...pg.state.schemas].sort()).toEqual(["answerable_mcp_acme.acme", "answerable_mcps.e2e", "answerable_mcps.example"])
  expect([...pg.state.memberships].sort()).toEqual([
    "mcp_e2e>answerable_mcps_standalone", "mcp_e2e>answerable_mcps_toolbox", "mcp_e2e_owner>answerable_mcps_migrator", "mcp_e2e_owner>current_user",
    "mcp_example>answerable_mcps_toolbox", "mcp_example_owner>answerable_mcps_migrator", "mcp_example_owner>current_user",
  ])
  // provisionOwnMcp in the own MCP's database: its schema, owned by its owner login, USAGE for its runtime login.
  expect(pg.state.statements).toContain('answerable_mcp_acme: grant usage on schema "acme" to "answerable_mcp_acme_runtime"')
  expect(lines).toContain("answerable_mcps: e2e, example provisioned")
  expect(lines).toContain("answerable_mcp_acme: schema acme provisioned")
})

test("a second run writes nothing and creates nothing: each password is set to the one its Secret holds, every MCP as it was", async () => {
  const pg = fakePostgres()
  const memory = memoryStore()
  await run(pg, memory.store, { mcps })
  const before = { roles: structuredClone(pg.state.roles), memberships: [...pg.state.memberships], schemas: [...pg.state.schemas] }
  memory.writes.length = 0
  pg.state.statements.length = 0
  await run(pg, memory.store, { mcps })
  expect(memory.writes).toEqual([])
  expect(pg.state.statements.filter(statement => /^(\w+: )?create (role|database)/.test(statement))).toEqual([])
  expect(pg.state.statements.filter(statement => statement.startsWith("alter role"))).toHaveLength(13)
  expect({ roles: pg.state.roles, memberships: [...pg.state.memberships], schemas: [...pg.state.schemas] }).toEqual(before)
})

test("an MCP whose servedBy changed keeps its schema and loses the role of the server that no longer serves it", async () => {
  const pg = fakePostgres()
  const memory = memoryStore()
  await run(pg, memory.store, { mcps })
  await run(pg, memory.store, { mcps: [{ name: "e2e", serve: "standalone", database: "shared" }, { name: "example", serve: "both", database: "shared" }] })
  expect([...pg.state.memberships].filter(membership => !membership.includes("_owner>")).sort()).toEqual(["mcp_e2e>answerable_mcps_standalone", "mcp_example>answerable_mcps_standalone", "mcp_example>answerable_mcps_toolbox"])
  expect(pg.state.statements).toContain('answerable_mcps: revoke "mcp_e2e" from "answerable_mcps_toolbox" granted by "dbadmin"')
})

test("the Secrets of the list's own MCPs are named after them, as the chart names them for the ops Role", () => {
  const refs = (list: DeclaredMcp[]) => databasesFor(list).flatMap(database => [database.owner, ...database.runtime]).map(login => login.ref.secret)
  expect(refs([])).toEqual([
    "id-database-owner", "id-database", "toolbox-database-owner", "toolbox-database", "admin-database-owner", "admin-database",
    "standalone-database-owner", "standalone-database", "mcps-database-owner", "toolbox-mcps-database", "standalone-mcps-database",
  ])
  expect(refs(mcps).slice(11)).toEqual(["mcp-acme-database-owner", "mcp-acme-database"])
})

test("a login that lost its Secret gets a new password, written; a Secret whose login is missing recreates it with that password", async () => {
  const stored = `postgres://answerable_id_owner:${encodeURIComponent("kept p@ss'")}@db.internal:5432/answerable_id?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.pem`
  const pg = fakePostgres({ roles: { answerable_id_runtime: { password: "lost", restricted: true } }, owners: { answerable_id: "answerable_id_owner" } })
  const memory = memoryStore({ "id-database-owner/DATABASE_MIGRATION_URL": stored })
  await run(pg, memory.store)
  expect(pg.state.roles.answerable_id_owner!.password).toBe("kept p@ss''")
  expect(memory.writes).not.toContain("id-database-owner/DATABASE_MIGRATION_URL")
  expect(memory.writes).toContain("id-database/DATABASE_URL")
  expect(pg.state.roles.answerable_id_runtime!.password).not.toBe("lost")
  expect(pg.state.statements.filter(statement => statement.startsWith('create database "answerable_id"'))).toEqual([])
})

test("a database owned by another role is given to its owner, or the migrations' revokes would do nothing", async () => {
  const pg = fakePostgres({ owners: { answerable_toolbox: "someone_else" } })
  await run(pg)
  expect(pg.state.statements).toContain('alter database "answerable_toolbox" owner to "answerable_toolbox_owner"')
  expect(pg.state.owners.answerable_toolbox).toBe("answerable_toolbox_owner")
})

test("refuses, naming the attribute, a login it cannot restrict: a superuser, replication or row-security-bypassing role", async () => {
  for (const attribute of ["rolsuper", "rolreplication", "rolbypassrls"] as const) {
    const pg = fakePostgres({ roles: { answerable_admin_runtime: { [attribute]: true } } })
    const memory = memoryStore()
    await expect(run(pg, memory.store)).rejects.toThrow(`answerable_admin_runtime has ${attribute.slice(3).toUpperCase()}`)
    expect(memory.writes).not.toContain("admin-database/ADMIN_DATABASE_URL")
  }
})

test("refuses a Secret that holds another login's URL, or no URL, naming the Secret and not its value", async () => {
  const cases = { "postgres://someone:x@db/answerable_admin": "admin-database/ADMIN_DATABASE_URL holds a URL for someone, not answerable_admin_runtime", "not a url": "admin-database/ADMIN_DATABASE_URL does not hold a URL" }
  for (const [value, message] of Object.entries(cases)) {
    const attempt = run(fakePostgres(), memoryStore({ "admin-database/ADMIN_DATABASE_URL": value }).store)
    await expect(attempt).rejects.toThrow(message)
    await expect(attempt).rejects.not.toThrow("db/answerable_admin")
  }
})

test("an IPv6 host is bracketed in the URLs", async () => {
  const memory = memoryStore()
  await run(fakePostgres(), memory.store, { host: "fd00::5", port: 6432, sslRootCert: "/ca.pem" })
  expect(new URL(memory.values["id-database/DATABASE_URL"]!).host).toBe("[fd00::5]:6432")
})
