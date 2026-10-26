import { expect, test } from "bun:test"
import type { DeclaredMcp, Sql } from "@answerable/mcp-postgres"
import { bootstrap, databasesFor } from "./bootstrap"
import { memoryStore } from "./testing"

type Role = { password: string; rolsuper: boolean; rolreplication: boolean; rolbypassrls: boolean; restricted: boolean; login: boolean }

/**
 * A PostgreSQL that understands the statements bootstrap sends: roles, databases and their owners, and a log of every statement, prefixed by its
 * database when it is not the administrative connection's. `provision` stands in for `@answerable/mcp-postgres`'s provisioning, which its own
 * tests prove on a real Postgres, and records what bootstrap hands it: the database of the connection, and the arguments.
 */
function fakePostgres({ roles = {}, owners = {} }: { roles?: Record<string, Partial<Role>>; owners?: Record<string, string> } = {}) {
  const state = {
    roles: Object.fromEntries(Object.entries(roles).map(([name, role]) => [name, { password: "", rolsuper: false, rolreplication: false, rolbypassrls: false, restricted: false, login: true, ...role }])) as Record<string, Role>,
    owners: { ...owners },
    statements: [] as string[],
    connections: [] as string[],
    provisioned: [] as { kind: "shared" | "own"; database: string; with: unknown }[],
  }
  const databaseOf = new Map<Sql, string>()
  const on = (database?: string): Sql => async (text, params = []) => {
    state.statements.push(database ? `${database}: ${text}` : text)
    let match: RegExpMatchArray | null
    if (text.startsWith("select rolsuper")) {
      const role = state.roles[String(params[0])]
      return role ? [role] : []
    }
    if (text.startsWith("select pg_get_userbyid(datdba)")) {
      const owner = state.owners[String(params[0])]
      return owner ? [{ owner }] : []
    }
    if ((match = text.match(/^create role "(\w+)" with login password '((?:[^']|'')*)'(.*)$/))) {
      state.roles[match[1]!] = { password: match[2]!, rolsuper: false, rolreplication: false, rolbypassrls: false, restricted: match[3]!.includes("nobypassrls"), login: true }
      return []
    }
    if ((match = text.match(/^alter role "(\w+)" with login password '((?:[^']|'')*)'(.*)$/))) {
      const role = state.roles[match[1]!]!
      role.password = match[2]!
      if (match[3]!.includes("noinherit")) role.restricted = true
      return []
    }
    if ((match = text.match(/^create database "(\w+)" owner "(\w+)"$/))) state.owners[match[1]!] = match[2]!
    if ((match = text.match(/^alter database "(\w+)" owner to "(\w+)"$/))) state.owners[match[1]!] = match[2]!
    return []
  }
  const database = (name: string) => {
    state.connections.push(name)
    const sql = on(name)
    databaseOf.set(sql, name)
    return { sql, close: async () => {} }
  }
  const provision = {
    shared: async (sql: Sql, options: unknown) => void state.provisioned.push({ kind: "shared", database: databaseOf.get(sql)!, with: options }),
    own: async (sql: Sql, options: unknown) => void state.provisioned.push({ kind: "own", database: databaseOf.get(sql)!, with: options }),
  }
  return { sql: on(), database, provision, state }
}

const options = { host: "db.internal", port: 5432, sslRootCert: "/etc/ssl/db/ca.pem", mcps: [] as DeclaredMcp[] }
let counter = 0
const password = () => `generated-${++counter}-password`
const run = (pg: ReturnType<typeof fakePostgres>, store = memoryStore().store, more: Partial<Parameters<typeof bootstrap>[0]> = {}) =>
  bootstrap({ sql: pg.sql, database: pg.database, provision: pg.provision, store, ...options, password, log: () => {}, ...more })
const mcps: DeclaredMcp[] = [
  { name: "e2e", serve: "both", database: "shared", scopes: [] }, { name: "example", serve: "toolbox", database: "shared", scopes: [] }, { name: "acme", serve: "standalone", database: "own", scopes: [] },
]
const sharedLogins = { migrator: "answerable_mcps_migrator", toolbox: "answerable_mcps_toolbox" }

test("on an empty cluster: four databases owned by their owners, their logins, the serving ones restricted, every URL written", async () => {
  const pg = fakePostgres()
  const { store, values, writes } = memoryStore()
  const lines: string[] = []
  await bootstrap({ sql: pg.sql, database: pg.database, provision: pg.provision, store, ...options, log: line => lines.push(line) })
  // No statement waits on a lock or runs for long: the Job fails with the reason instead of hanging.
  expect(pg.state.statements.slice(0, 2)).toEqual(["set lock_timeout = '10s'", "set statement_timeout = '60s'"])
  expect(Object.keys(pg.state.owners).sort()).toEqual(["answerable_admin", "answerable_id", "answerable_mcps", "answerable_toolbox"])
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
    "toolbox-database-owner/TOOLBOX_DATABASE_MIGRATION_URL", "toolbox-database/TOOLBOX_DATABASE_URL",
    "toolbox-mcps-database/TOOLBOX_MCPS_DATABASE_URL",
  ])
  // The shared database is owned by the migrator and served by the Toolbox's login; with no MCP, provisioning only keeps its privileges.
  expect(pg.state.owners.answerable_mcps).toBe("answerable_mcps_migrator")
  expect(pg.state.connections).toEqual(["answerable_mcps"])
  expect(pg.state.provisioned).toEqual([{ kind: "shared", database: "answerable_mcps", with: { mcps: [], logins: sharedLogins } }])
  expect(lines).toContain("answerable_mcps: no MCP to provision")
  // Generated passwords: 32 random bytes, base64url, each different.
  const passwords = Object.values(pg.state.roles).map(role => role.password)
  for (const value of passwords) expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(new Set(passwords).size).toBe(8)
  // What it says names logins, databases and Secrets, never a password.
  for (const line of lines) for (const value of passwords) expect(line).not.toContain(value)
})

test("with the chart's list: the shared MCPs provisioned in answerable_mcps for the migrator and the Toolbox's login, and no role; a database, two logins and its provisioning for each own one", async () => {
  const pg = fakePostgres()
  const { store, values, writes } = memoryStore()
  const lines: string[] = []
  await run(pg, store, { mcps, log: line => lines.push(line) })
  expect(writes.filter(write => write.startsWith("mcp-")).sort()).toEqual(["mcp-acme-database-owner/DATABASE_MIGRATION_URL", "mcp-acme-database/DATABASE_URL"])
  expect(pg.state.owners.answerable_mcp_acme).toBe("answerable_mcp_acme_owner")
  expect(pg.state.roles.answerable_mcp_acme_runtime!.restricted).toBe(true)
  expect(new URL(values["mcp-acme-database/DATABASE_URL"]!).pathname).toBe("/answerable_mcp_acme")
  expect(pg.state.connections).toEqual(["answerable_mcps", "answerable_mcp_acme"])
  // provisionMcps for the shared ones, on a connection to the shared database; provisionOwnMcp on one to the own MCP's database.
  expect(pg.state.provisioned).toEqual([
    { kind: "shared", database: "answerable_mcps", with: { mcps: [{ name: "e2e" }, { name: "example" }], logins: sharedLogins } },
    { kind: "own", database: "answerable_mcp_acme", with: { name: "acme", owner: "answerable_mcp_acme_owner", runtime: "answerable_mcp_acme_runtime" } },
  ])
  // Each connection is bounded before provisioning runs on it.
  expect(pg.state.statements.filter(statement => statement.startsWith("answerable_mcp"))).toEqual(["answerable_mcps", "answerable_mcp_acme"].flatMap(name => [`${name}: set lock_timeout = '10s'`, `${name}: set statement_timeout = '60s'`]))
  // The logins are the eight services' and the own MCP's two: no role for an MCP.
  expect(Object.keys(pg.state.roles).filter(role => role.startsWith("mcp_"))).toEqual([])
  expect(lines).toContain("answerable_mcps: e2e, example provisioned")
  expect(lines).toContain("answerable_mcp_acme: schema acme provisioned")
})

test("a second run writes nothing and creates nothing: each password is set to the one its Secret holds, and the MCPs are provisioned as before", async () => {
  const pg = fakePostgres()
  const memory = memoryStore()
  await run(pg, memory.store, { mcps })
  const before = { roles: structuredClone(pg.state.roles), provisioned: [...pg.state.provisioned] }
  memory.writes.length = 0
  pg.state.statements.length = 0
  pg.state.provisioned.length = 0
  await run(pg, memory.store, { mcps })
  expect(memory.writes).toEqual([])
  expect(pg.state.statements.filter(statement => /^(\w+: )?create (role|database)/.test(statement))).toEqual([])
  expect(pg.state.statements.filter(statement => statement.startsWith("alter role"))).toHaveLength(10)
  expect({ roles: pg.state.roles, provisioned: pg.state.provisioned }).toEqual(before)
})

test("where an MCP is served changes nothing of its provisioning: the Toolbox serves it in its hub and alone alike", async () => {
  const pg = fakePostgres()
  await run(pg, memoryStore().store, { mcps: [{ name: "e2e", serve: "standalone", database: "shared", scopes: [] }, { name: "example", serve: "both", database: "shared", scopes: [] }] })
  expect(pg.state.provisioned).toEqual([{ kind: "shared", database: "answerable_mcps", with: { mcps: [{ name: "e2e" }, { name: "example" }], logins: sharedLogins } }])
})

test("the Secrets of the list's own MCPs are named after them, as the chart names them for the ops Role", () => {
  const refs = (list: DeclaredMcp[]) => databasesFor(list).flatMap(database => [database.owner, ...database.runtime]).map(login => login.ref.secret)
  expect(refs([])).toEqual([
    "id-database-owner", "id-database", "toolbox-database-owner", "toolbox-database", "admin-database-owner", "admin-database",
    "mcps-database-owner", "toolbox-mcps-database",
  ])
  expect(refs(mcps).slice(8)).toEqual(["mcp-acme-database-owner", "mcp-acme-database"])
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
