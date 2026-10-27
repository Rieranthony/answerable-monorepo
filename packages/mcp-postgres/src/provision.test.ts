import { afterAll, beforeAll, expect, test } from "bun:test"
import { Pool } from "pg"
import { ownMcpDatabase, sharedMcps } from "./names"
import { provisionMcps, provisionOwnMcp, sqlOf, type Sql } from "./provision"
import { database } from "./test/database"
import { clientOf, forget, mcpsUrl, testLogin } from "./test/mcps"

const admin = new Pool({ connectionString: mcpsUrl, max: 1 })
const sql = sqlOf(admin)
const names = ["mpgprova", "mpgprovb", "mpgprovc"]
beforeAll(async () => {
  await forget(admin, ...names)
})
afterAll(async () => {
  await forget(admin, ...names)
  await admin.end()
})

// Every catalogue row provisioning writes for these MCPs: their schemas and the database's privileges.
async function catalogue() {
  const rows = async (text: string, values?: unknown[]) => (await admin.query(text, values)).rows
  return {
    schemas: await rows(`select nspname, pg_get_userbyid(nspowner) as owner, nspacl::text as acl from pg_namespace where nspname = any($1) order by 1`, [names]),
    // PUBLIC's and the two logins' privileges only: a suite running beside this one has a login of its own there.
    database: await rows(`select pg_get_userbyid(d.datdba) as owner, coalesce(acl.grantee::regrole::text, 'PUBLIC') as grantee, string_agg(acl.privilege_type, ', ' order by acl.privilege_type) as privileges
      from pg_database d, aclexplode(d.datacl) acl where d.datname = current_database() and (acl.grantee = 0 or acl.grantee::regrole::text = any($1)) group by 1, 2 order by 2`, [Object.values(sharedMcps.logins)]),
  }
}
// The roles named after these MCPs, which provisioning never makes.
const roles = async () => (await admin.query("select rolname from pg_roles where rolname ~ 'mpgprov'")).rows
const provisioned = (name: string) => ({ nspname: name, owner: "answerable_mcps_migrator", acl: "{answerable_mcps_migrator=UC/answerable_mcps_migrator,answerable_mcps_toolbox=U/answerable_mcps_migrator}" })

test("each MCP gets its schema, owned by the migrator, with USAGE for the serving login and nothing for anyone else; no role is made, and a second run changes nothing", async () => {
  await provisionMcps(sql, { mcps: [{ name: "mpgprova" }, { name: "mpgprovb" }], logins: sharedMcps.logins })
  const after = await catalogue()
  expect(after.schemas).toEqual(["mpgprova", "mpgprovb"].map(provisioned))
  expect(await roles()).toEqual([])
  await provisionMcps(sql, { mcps: [{ name: "mpgprova" }, { name: "mpgprovb" }], logins: sharedMcps.logins })
  expect(await catalogue()).toEqual(after)
})

test("answerable_mcps is owned by the migrator; PUBLIC holds nothing on it, the two logins may connect, and the serving login may not create temporary tables", async () => {
  await provisionMcps(sql, { mcps: [], logins: sharedMcps.logins })
  expect((await catalogue()).database).toEqual([
    { owner: "answerable_mcps_migrator", grantee: "answerable_mcps_migrator", privileges: "CONNECT, CREATE, TEMPORARY" },
    { owner: "answerable_mcps_migrator", grantee: "answerable_mcps_toolbox", privileges: "CONNECT" },
  ])
  const scratch = await database.scratch("owned")
  try {
    await expect(provisionMcps(sqlOf(scratch.db.$client), { mcps: [], logins: sharedMcps.logins }))
      .rejects.toThrow("Database answerable_mcp_postgres_test_owned is owned by answerable; the migrator login, answerable_mcps_migrator, must own it")
  } finally {
    await scratch.drop()
  }
})

test("a privilege on its schema taken away by hand is given back", async () => {
  await provisionMcps(sql, { mcps: [{ name: "mpgprova" }], logins: sharedMcps.logins })
  await admin.query("revoke usage on schema mpgprova from answerable_mcps_toolbox")
  await provisionMcps(sql, { mcps: [{ name: "mpgprova" }], logins: sharedMcps.logins })
  expect((await catalogue()).schemas.find(row => row.nspname === "mpgprova")).toEqual(provisioned("mpgprova"))
})

test("a CREATEROLE login that is not a superuser provisions once it is a member of the migrator, as a managed database's administrator, and makes no role", async () => {
  // The Civo shape: the managed database's administrator, a member of the migrator as the bootstrap makes it.
  const civo = await testLogin(admin, "createrole")
  await admin.query(`grant answerable_mcps_migrator to ${civo.name}`)
  const client = await clientOf(civo.url)
  try {
    await provisionMcps(sqlOf(client), { mcps: [{ name: "mpgprovc" }], logins: sharedMcps.logins })
    expect((await catalogue()).schemas.find(row => row.nspname === "mpgprovc")).toEqual(provisioned("mpgprovc"))
    // It made no role and granted no membership.
    expect(await roles()).toEqual([])
    expect((await admin.query("select count(*)::int as granted from pg_auth_members where grantor = $1::regrole", [civo.name])).rows).toEqual([{ granted: 0 }])
  } finally {
    await client.end()
    await forget(admin, "mpgprovc")
    await civo.drop()
  }
})

test("an own MCP's database and logins are named after it, as the deployment and the development Postgres make them", () => {
  expect(ownMcpDatabase("acme")).toEqual({ database: "answerable_mcp_acme", owner: "answerable_mcp_acme_owner", runtime: "answerable_mcp_acme_runtime" })
})

test("a bad name, login or a name listed twice is refused before any SQL runs", async () => {
  const sent: string[] = []
  const spy: Sql = async text => { sent.push(text); return [] }
  const refused = (options: Partial<Parameters<typeof provisionMcps>[1]>) => provisionMcps(spy, { mcps: [], logins: sharedMcps.logins, ...options })
  await expect(refused({ mcps: [{ name: "Acme" }] })).rejects.toThrow('MCP name "Acme" must be a lowercase letter then up to 11 lowercase letters or digits, for example acme')
  await expect(refused({ mcps: [{ name: "acme; drop" }] })).rejects.toThrow('MCP name "acme; drop" must be')
  await expect(refused({ mcps: [{ name: "public" }] })).rejects.toThrow("MCP name public is reserved: Postgres or drizzle owns a schema of that name")
  await expect(refused({ mcps: [{ name: "drizzle" }] })).rejects.toThrow("MCP name drizzle is reserved")
  await expect(refused({ mcps: [{ name: "acme" }, { name: "acme" }] })).rejects.toThrow("MCP acme is listed twice")
  await expect(refused({ logins: { ...sharedMcps.logins, toolbox: 'toolbox"; drop' } })).rejects.toThrow('Invalid login name "toolbox"; drop"')
  await expect(provisionOwnMcp(spy, { name: "Acme", owner: "o", runtime: "r" })).rejects.toThrow('MCP name "Acme" must be')
  expect(() => ownMcpDatabase("Acme")).toThrow('MCP name "Acme" must be')
  await expect(provisionOwnMcp(spy, { name: "acme", owner: "o; drop", runtime: "r" })).rejects.toThrow('Invalid login name "o; drop"')
  expect(sent).toEqual([])
})
