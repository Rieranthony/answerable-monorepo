import { expect, test } from "bun:test"
import { bootstrap, databases, type Sql } from "./bootstrap"
import { memoryStore } from "./testing"

type Role = { password: string; rolsuper: boolean; rolreplication: boolean; rolbypassrls: boolean; restricted: boolean }

/** A PostgreSQL that understands the statements bootstrap sends: roles, databases and their owners, and a log of every statement. */
function fakePostgres({ roles = {}, owners = {} }: { roles?: Record<string, Partial<Role>>; owners?: Record<string, string> } = {}) {
  const state = {
    roles: Object.fromEntries(Object.entries(roles).map(([name, role]) => [name, { password: "", rolsuper: false, rolreplication: false, rolbypassrls: false, restricted: false, ...role }])) as Record<string, Role>,
    owners: { ...owners },
    statements: [] as string[],
  }
  const sql: Sql = async (text, params = []) => {
    state.statements.push(text)
    let match: RegExpMatchArray | null
    if (text.startsWith("select rolsuper")) {
      const role = state.roles[String(params[0])]
      return role ? [role] : []
    }
    if (text.startsWith("select pg_get_userbyid")) {
      const owner = state.owners[String(params[0])]
      return owner ? [{ owner }] : []
    }
    if ((match = text.match(/^create role "(\w+)" with login password '((?:[^']|'')*)'(.*)$/))) {
      state.roles[match[1]!] = { password: match[2]!, rolsuper: false, rolreplication: false, rolbypassrls: false, restricted: match[3]!.includes("nobypassrls") }
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
  return { sql, state }
}

const options = { host: "db.internal", port: 5432, sslRootCert: "/etc/ssl/db/ca.pem" }
let counter = 0
const password = () => `generated-${++counter}-password`

test("on an empty cluster: three databases owned by their owners, six logins, the runtime ones restricted, six URLs written", async () => {
  const pg = fakePostgres()
  const { store, values, writes } = memoryStore()
  const lines: string[] = []
  await bootstrap({ sql: pg.sql, store, ...options, log: line => lines.push(line) })
  expect(Object.keys(pg.state.owners).sort()).toEqual(["answerable_admin", "answerable_id", "answerable_toolbox"])
  for (const database of databases) {
    expect(pg.state.owners[database.name]).toBe(database.owner.name)
    expect(pg.state.roles[database.owner.name]!.restricted).toBe(false)
    expect(pg.state.roles[database.runtime.name]!.restricted).toBe(true)
    expect(pg.state.statements).toContain(`grant "${database.owner.name}" to current_user`)
    expect(pg.state.statements).toContain(`revoke all on database "${database.name}" from public`)
    expect(pg.state.statements).toContain(`grant connect on database "${database.name}" to "${database.runtime.name}"`)
    expect(pg.state.statements).toContain(`revoke temporary on database "${database.name}" from "${database.runtime.name}"`)
    for (const login of [database.owner, database.runtime]) {
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
    "toolbox-database-owner/TOOLBOX_DATABASE_MIGRATION_URL", "toolbox-database/TOOLBOX_DATABASE_URL",
  ])
  // Generated passwords: 32 random bytes, base64url, each different.
  const passwords = Object.values(pg.state.roles).map(role => role.password)
  for (const value of passwords) expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/)
  expect(new Set(passwords).size).toBe(6)
  // What it says names logins, databases and Secrets, never a password.
  expect(lines.length).toBeGreaterThan(0)
  for (const line of lines) for (const value of passwords) expect(line).not.toContain(value)
})

test("a second run writes nothing and creates nothing: each password is set to the one its Secret holds", async () => {
  const pg = fakePostgres()
  const memory = memoryStore()
  await bootstrap({ sql: pg.sql, store: memory.store, ...options, password, log: () => {} })
  const before = structuredClone(pg.state.roles)
  memory.writes.length = 0
  pg.state.statements.length = 0
  await bootstrap({ sql: pg.sql, store: memory.store, ...options, password, log: () => {} })
  expect(memory.writes).toEqual([])
  expect(pg.state.statements.filter(statement => statement.startsWith("create"))).toEqual([])
  expect(pg.state.statements.filter(statement => statement.startsWith("alter role"))).toHaveLength(6)
  expect(pg.state.roles).toEqual(before)
})

test("a login that lost its Secret gets a new password, written; a Secret whose login is missing recreates it with that password", async () => {
  const stored = `postgres://answerable_id_owner:${encodeURIComponent("kept p@ss'")}@db.internal:5432/answerable_id?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.pem`
  const pg = fakePostgres({ roles: { answerable_id_runtime: { password: "lost", restricted: true } }, owners: { answerable_id: "answerable_id_owner" } })
  const memory = memoryStore({ "id-database-owner/DATABASE_MIGRATION_URL": stored })
  await bootstrap({ sql: pg.sql, store: memory.store, ...options, password, log: () => {} })
  expect(pg.state.roles.answerable_id_owner!.password).toBe("kept p@ss''")
  expect(memory.writes).not.toContain("id-database-owner/DATABASE_MIGRATION_URL")
  expect(memory.writes).toContain("id-database/DATABASE_URL")
  expect(pg.state.roles.answerable_id_runtime!.password).not.toBe("lost")
  expect(pg.state.statements.filter(statement => statement.startsWith('create database "answerable_id"'))).toEqual([])
})

test("a database owned by another role is given to its owner, or the migrations' revokes would do nothing", async () => {
  const pg = fakePostgres({ owners: { answerable_toolbox: "someone_else" } })
  await bootstrap({ sql: pg.sql, store: memoryStore().store, ...options, password, log: () => {} })
  expect(pg.state.statements).toContain('alter database "answerable_toolbox" owner to "answerable_toolbox_owner"')
  expect(pg.state.owners.answerable_toolbox).toBe("answerable_toolbox_owner")
})

test("refuses, naming the attribute, a login it cannot restrict: a superuser, replication or row-security-bypassing role", async () => {
  for (const attribute of ["rolsuper", "rolreplication", "rolbypassrls"] as const) {
    const pg = fakePostgres({ roles: { answerable_admin_runtime: { [attribute]: true } } })
    const memory = memoryStore()
    await expect(bootstrap({ sql: pg.sql, store: memory.store, ...options, password, log: () => {} })).rejects.toThrow(`answerable_admin_runtime has ${attribute.slice(3).toUpperCase()}`)
    expect(memory.writes).not.toContain("admin-database/ADMIN_DATABASE_URL")
  }
})

test("refuses a Secret that holds another login's URL, or no URL, naming the Secret and not its value", async () => {
  const cases = { "postgres://someone:x@db/answerable_admin": "admin-database/ADMIN_DATABASE_URL holds a URL for someone, not answerable_admin_runtime", "not a url": "admin-database/ADMIN_DATABASE_URL does not hold a URL" }
  for (const [value, message] of Object.entries(cases)) {
    const attempt = bootstrap({ sql: fakePostgres().sql, store: memoryStore({ "admin-database/ADMIN_DATABASE_URL": value }).store, ...options, password, log: () => {} })
    await expect(attempt).rejects.toThrow(message)
    await expect(attempt).rejects.not.toThrow("db/answerable_admin")
  }
})

test("an IPv6 host is bracketed in the URLs", async () => {
  const memory = memoryStore()
  await bootstrap({ sql: fakePostgres().sql, store: memory.store, host: "fd00::5", port: 6432, sslRootCert: "/ca.pem", password, log: () => {} })
  expect(new URL(memory.values["id-database/DATABASE_URL"]!).host).toBe("[fd00::5]:6432")
})
