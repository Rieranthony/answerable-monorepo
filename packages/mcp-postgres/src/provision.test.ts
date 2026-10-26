import { afterAll, beforeAll, expect, test } from "bun:test"
import { Pool } from "pg"
import { ensureLocalMcpDatabases } from "./local"
import { ownMcpDatabase, sharedMcps } from "./names"
import { provisionMcps, provisionOwnMcp, sqlOf, type Sql } from "./provision"
import { database } from "./test/database"
import { clientOf, clusterUrl, forget, mcpsUrl, testLogin } from "./test/mcps"

const admin = new Pool({ connectionString: mcpsUrl, max: 1 })
const sql = sqlOf(admin)
const names = ["mpgprova", "mpgprovb", "mpgprovc"]
beforeAll(async () => {
  await ensureLocalMcpDatabases(clusterUrl)
  await forget(admin, ...names)
})
afterAll(async () => {
  await forget(admin, ...names)
  await admin.end()
})

// Every catalogue row provisioning writes for these MCPs: their roles, the memberships in them, their schemas and the database's privileges.
async function catalogue() {
  const rows = async (text: string, values?: unknown[]) => (await admin.query(text, values)).rows
  return {
    roles: await rows(`select rolname, rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls from pg_roles
      where rolname = any(select 'mcp_test_' || name from unnest($1::text[]) name union all select 'mcp_test_' || name || '_owner' from unnest($1::text[]) name) order by 1`, [names]),
    memberships: await rows(`select r.rolname as role, m.rolname as member, g.rolname as grantor, a.inherit_option, a.set_option, a.admin_option
      from pg_auth_members a join pg_roles r on r.oid = a.roleid join pg_roles m on m.oid = a.member join pg_roles g on g.oid = a.grantor
      where r.rolname like any(select 'mcp_test_' || name || '%' from unnest($1::text[]) name) order by 1, 2, 3`, [names]),
    schemas: await rows(`select nspname, pg_get_userbyid(nspowner) as owner, nspacl::text as acl from pg_namespace where nspname = any($1) order by 1`, [names]),
    // PUBLIC's and the two logins' privileges only: a suite running beside this one has a login of its own there.
    database: await rows(`select pg_get_userbyid(d.datdba) as owner, coalesce(acl.grantee::regrole::text, 'PUBLIC') as grantee, string_agg(acl.privilege_type, ', ' order by acl.privilege_type) as privileges
      from pg_database d, aclexplode(d.datacl) acl where d.datname = current_database() and (acl.grantee = 0 or acl.grantee::regrole::text = any($1)) group by 1, 2 order by 2`, [Object.values(sharedMcps.logins)]),
  }
}
const membership = (role: string, member: string, grantor = "answerable") => ({ role, member, grantor, inherit_option: false, set_option: true, admin_option: false })

test("each MCP gets its owner and runtime roles, its schema and the memberships the migrator and the serving login need, and a second run changes nothing", async () => {
  await provisionMcps(sql, { mcps: [{ name: "mpgprova" }, { name: "mpgprovb" }], prefix: "mcp_test", logins: sharedMcps.logins })
  const after = await catalogue()
  const role = (rolname: string) => ({ rolname, rolcanlogin: false, rolinherit: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false })
  expect(after.roles).toEqual(["mcp_test_mpgprova", "mcp_test_mpgprova_owner", "mcp_test_mpgprovb", "mcp_test_mpgprovb_owner"].map(role))
  expect(after.memberships).toEqual([
    membership("mcp_test_mpgprova", "answerable_mcps_toolbox"),
    membership("mcp_test_mpgprova_owner", "answerable"),
    membership("mcp_test_mpgprova_owner", "answerable_mcps_migrator"),
    membership("mcp_test_mpgprovb", "answerable_mcps_toolbox"),
    membership("mcp_test_mpgprovb_owner", "answerable"),
    membership("mcp_test_mpgprovb_owner", "answerable_mcps_migrator"),
  ])
  expect(after.schemas).toEqual(["mpgprova", "mpgprovb"].map(name => ({ nspname: name, owner: `mcp_test_${name}_owner`, acl: `{mcp_test_${name}_owner=UC/mcp_test_${name}_owner,mcp_test_${name}=U/mcp_test_${name}_owner}` })))
  await provisionMcps(sql, { mcps: [{ name: "mpgprova" }, { name: "mpgprovb" }], prefix: "mcp_test", logins: sharedMcps.logins })
  expect(await catalogue()).toEqual(after)
})

test("answerable_mcps is owned by the migrator; PUBLIC holds nothing on it, the two logins may connect, and the serving login may not create temporary tables", async () => {
  await provisionMcps(sql, { mcps: [], prefix: "mcp_test", logins: sharedMcps.logins })
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

test("a role or membership changed by hand is brought back in line, and a role only a superuser could clear is refused, naming it", async () => {
  const provision = () => provisionMcps(sql, { mcps: [{ name: "mpgprova" }], prefix: "mcp_test", logins: sharedMcps.logins })
  const runtime = async () => {
    const { roles, memberships } = await catalogue()
    return { role: roles.find(row => row.rolname === "mcp_test_mpgprova"), memberships: memberships.filter(row => row.role === "mcp_test_mpgprova") }
  }
  await provision()
  const provisioned = await runtime()
  expect(provisioned.memberships).toEqual([membership("mcp_test_mpgprova", "answerable_mcps_toolbox")])
  await admin.query("alter role mcp_test_mpgprova login inherit createdb createrole; grant mcp_test_mpgprova to answerable_mcps_toolbox with inherit true, set false")
  await provision()
  expect(await runtime()).toEqual(provisioned)
  await admin.query("alter role mcp_test_mpgprova bypassrls")
  await expect(provision()).rejects.toThrow("The role mcp_test_mpgprova has BYPASSRLS: make it an ordinary role, then provision again")
  await admin.query("alter role mcp_test_mpgprova nobypassrls")
})

test("a CREATEROLE login that is not a superuser provisions once it holds the database owner's privileges, could not give the schema away without granting itself the owner, and inherits no owner role afterwards", async () => {
  // The Civo shape: the managed database's administrator, a member of the migrator as the bootstrap makes it.
  const civo = await testLogin(admin, "createrole")
  await admin.query(`grant answerable_mcps_migrator to ${civo.name}`)
  const client = await clientOf(civo.url)
  try {
    await client.query("create role mcp_test_mpgprovc_owner nologin")
    await expect(client.query("create schema mpgprovc authorization mcp_test_mpgprovc_owner")).rejects.toThrow('must be able to SET ROLE "mcp_test_mpgprovc_owner"')
    await provisionMcps(sqlOf(client), { mcps: [{ name: "mpgprovc" }], prefix: "mcp_test", logins: sharedMcps.logins })
    const after = await catalogue()
    expect(after.schemas.find(row => row.nspname === "mpgprovc")).toEqual({ nspname: "mpgprovc", owner: "mcp_test_mpgprovc_owner", acl: "{mcp_test_mpgprovc_owner=UC/mcp_test_mpgprovc_owner,mcp_test_mpgprovc=U/mcp_test_mpgprovc_owner}" })
    expect(after.memberships.filter(row => row.grantor === civo.name && row.member !== civo.name)).toEqual([
      membership("mcp_test_mpgprovc", "answerable_mcps_toolbox", civo.name),
      membership("mcp_test_mpgprovc_owner", "answerable_mcps_migrator", civo.name),
    ])
    // It may take the owner role, which giving it the schema needs, but holds none of the owner's privileges outside that.
    const own = after.memberships.filter(row => row.member === civo.name && row.role === "mcp_test_mpgprovc_owner")
    expect(own.some(row => row.set_option)).toBe(true)
    expect(own.some(row => row.inherit_option)).toBe(false)
  } finally {
    await client.end()
    await forget(admin, "mpgprovc")
    await civo.drop()
  }
})

test("an own MCP's database and logins are named after it, as the deployment and the development Postgres make them", () => {
  expect(ownMcpDatabase("acme")).toEqual({ database: "answerable_mcp_acme", owner: "answerable_mcp_acme_owner", runtime: "answerable_mcp_acme_runtime" })
})

test("a bad name, prefix, login or a name listed twice is refused before any SQL runs", async () => {
  const sent: string[] = []
  const spy: Sql = async text => { sent.push(text); return [] }
  const refused = (options: Partial<Parameters<typeof provisionMcps>[1]>) => provisionMcps(spy, { mcps: [], prefix: "mcp_test", logins: sharedMcps.logins, ...options })
  await expect(refused({ mcps: [{ name: "Acme" }] })).rejects.toThrow('MCP name "Acme" must be a lowercase letter then up to 11 lowercase letters or digits, for example acme')
  await expect(refused({ mcps: [{ name: "acme; drop" }] })).rejects.toThrow('MCP name "acme; drop" must be')
  await expect(refused({ mcps: [{ name: "public" }] })).rejects.toThrow("MCP name public is reserved: Postgres or drizzle owns a schema of that name")
  await expect(refused({ mcps: [{ name: "drizzle" }] })).rejects.toThrow("MCP name drizzle is reserved")
  await expect(refused({ mcps: [{ name: "acme" }], prefix: "mcp-test" })).rejects.toThrow('Role prefix "mcp-test" must be lowercase letters, digits and underscores')
  await expect(refused({ mcps: [{ name: "acme" }, { name: "acme" }] })).rejects.toThrow("MCP acme is listed twice")
  await expect(refused({ logins: { ...sharedMcps.logins, toolbox: 'toolbox"; drop' } })).rejects.toThrow('Invalid login name "toolbox"; drop"')
  await expect(provisionOwnMcp(spy, { name: "Acme", owner: "o", runtime: "r" })).rejects.toThrow('MCP name "Acme" must be')
  expect(() => ownMcpDatabase("Acme")).toThrow('MCP name "Acme" must be')
  await expect(provisionOwnMcp(spy, { name: "acme", owner: "o; drop", runtime: "r" })).rejects.toThrow('Invalid login name "o; drop"')
  expect(sent).toEqual([])
})
