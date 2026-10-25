import { afterAll, expect, test } from "bun:test"
import { Pool } from "pg"
import { ensureLocalMcpDatabases } from "./local"
import { clusterUrl, localLogins } from "./test/mcps"

const admin = new Pool({ connectionString: clusterUrl, max: 1 })
afterAll(() => admin.end())

// The two databases and three logins, with PUBLIC's and the logins' privileges only: a suite running beside this one has a login of its own there.
async function local() {
  const rows = async (text: string) => (await admin.query(text, [Object.values(localLogins)])).rows
  return {
    logins: await rows("select rolname, rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls from pg_roles where rolname = any($1) order by 1"),
    databases: await rows(`select d.datname, pg_get_userbyid(d.datdba) as owner, coalesce(acl.grantee::regrole::text, 'PUBLIC') as grantee, string_agg(acl.privilege_type, ', ' order by acl.privilege_type) as privileges
      from pg_database d, aclexplode(d.datacl) acl where d.datname like 'answerable\\_mcps%' and (acl.grantee = 0 or acl.grantee::regrole::text = any($1)) group by 1, 2, 3 order by 1, 3`),
  }
}

test("the local set-up makes the shared databases and their logins as infra/postgres/init/006 does, and concurrent runs change nothing", async () => {
  await ensureLocalMcpDatabases(clusterUrl)
  const made = await local()
  const login = { rolcanlogin: true, rolinherit: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false }
  expect(made.logins).toEqual(["answerable_mcps_migrator", "answerable_mcps_standalone", "answerable_mcps_toolbox"].map(rolname => ({ rolname, ...login })))
  expect(made.databases).toEqual(["answerable_mcps", "answerable_mcps_test"].flatMap(datname => [
    { datname, owner: "answerable_mcps_migrator", grantee: "answerable_mcps_migrator", privileges: "CONNECT, CREATE, TEMPORARY" },
    { datname, owner: "answerable_mcps_migrator", grantee: "answerable_mcps_standalone", privileges: "CONNECT" },
    { datname, owner: "answerable_mcps_migrator", grantee: "answerable_mcps_toolbox", privileges: "CONNECT" },
  ]))
  await Promise.all([ensureLocalMcpDatabases(clusterUrl), ensureLocalMcpDatabases(clusterUrl)])
  expect(await local()).toEqual(made)
})

test("the local set-up refuses any host but this machine's before it connects", async () => {
  await expect(ensureLocalMcpDatabases("postgres://answerable:answerable@db.example:5432/postgres"))
    .rejects.toThrow("Refusing to set up the local MCP databases on db.example: only the development Postgres on this machine gets them")
})
