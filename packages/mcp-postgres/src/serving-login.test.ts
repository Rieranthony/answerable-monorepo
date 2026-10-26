import { afterAll, beforeAll, expect, test } from "bun:test"
import { Pool } from "pg"
import { connect } from "./connect"
import { ensureLocalMcpDatabases } from "./local"
import { migrateMcp } from "./migrate-mcp"
import { roleLock, sharedMcps } from "./names"
import { provisionMcps, sqlOf } from "./provision"
import { assertServingLogin } from "./serving-login"
import { as, clientOf, clusterUrl, fixtureFolder, forget, mcpsUrl, testLogin } from "./test/mcps"

const admin = new Pool({ connectionString: mcpsUrl, max: 1 })
// Under the lock every role statement takes: provisioning in another suite grants on answerable_mcps_test's own catalogue row meanwhile.
const run = (statements: string) => admin.query(`begin; select pg_advisory_xact_lock(${roleLock}); ${statements}; commit`)
let login: Awaited<ReturnType<typeof testLogin>>
let db: ReturnType<typeof connect>
beforeAll(async () => {
  await ensureLocalMcpDatabases(clusterUrl)
  await forget(admin, "mpgfixa", "mpgfixb")
  login = await testLogin(admin)
  await provisionMcps(sqlOf(admin), { mcps: [{ name: "mpgfixa", servedBy: ["toolbox"] }, { name: "mpgfixb", servedBy: ["toolbox"] }], prefix: "mcp_test", logins: { ...sharedMcps.logins, toolbox: login.name } })
  const migrator = await clientOf(as(sharedMcps.logins.migrator))
  try {
    await migrateMcp({ client: migrator, name: "mpgfixa", folder: fixtureFolder("mpgfixa"), mode: "shared", prefix: "mcp_test" })
  } finally {
    await migrator.end()
  }
  db = connect(login.url, { max: 1 })
})
afterAll(async () => {
  await db.$client.end()
  await login.drop()
  await forget(admin, "mpgfixa", "mpgfixb")
  await admin.end()
})

const served = { prefix: "mcp_test", names: ["mpgfixa", "mpgfixb"] }
const refusal = (problems: string) => `Database role ${login.name} may not serve MCPs: ${problems}. Serve as the serving login provisioning made, which holds only its MCPs' runtime roles`
/** Make `change`, expect the assertion to refuse with `problems`, then `undo`, and expect it to pass again. */
async function refused(change: string, problems: string, undo: string, options = served) {
  await run(change)
  try {
    await expect(assertServingLogin(db, options)).rejects.toThrow(refusal(problems))
  } finally {
    await run(undo)
  }
  await assertServingLogin(db, served)
}

test("a plain login that holds exactly its MCPs' runtime roles, without inheriting them, may serve them", async () => {
  await assertServingLogin(db, served)
})

test("each attribute beyond login is refused by name", async () => {
  for (const attribute of ["CREATEDB", "CREATEROLE", "REPLICATION", "BYPASSRLS"]) await refused(`alter role ${login.name} ${attribute}`, `has ${attribute}`, `alter role ${login.name} no${attribute}`)
  await run(`alter role ${login.name} superuser`)
  try {
    await expect(assertServingLogin(db, served)).rejects.toThrow(`Database role ${login.name} may not serve MCPs: has SUPERUSER; holds CREATE on database answerable_mcps_test; holds TEMPORARY on database answerable_mcps_test`)
  } finally {
    await run(`alter role ${login.name} nosuperuser`)
  }
})

test("a membership outside its MCPs, one it inherits, holds with ADMIN OPTION or may not SET, and a missing one are each refused", async () => {
  await refused(`grant pg_read_all_data to ${login.name}`, "is a member of pg_read_all_data", `revoke pg_read_all_data from ${login.name}`)
  await refused(`grant mcp_test_mpgfixa to ${login.name} with inherit true`, "inherits mcp_test_mpgfixa", `grant mcp_test_mpgfixa to ${login.name} with inherit false`)
  await refused(`grant mcp_test_mpgfixa to ${login.name} with admin true`, "holds mcp_test_mpgfixa with ADMIN OPTION", `revoke admin option for mcp_test_mpgfixa from ${login.name}`)
  await refused(`grant mcp_test_mpgfixa to ${login.name} with set false`, "may not SET ROLE mcp_test_mpgfixa", `grant mcp_test_mpgfixa to ${login.name} with set true`)
  await expect(assertServingLogin(db, { prefix: "mcp_test", names: ["mpgfixa"] })).rejects.toThrow(refusal("is a member of mcp_test_mpgfixb"))
  await expect(assertServingLogin(db, { prefix: "mcp_test", names: ["mpgfixa", "mpgfixb", "mpgfixc"] })).rejects.toThrow(refusal("is not a member of mcp_test_mpgfixc"))
})

test("anything it owns, and any privilege of its own on a schema, a table or the database, is refused", async () => {
  await refused(`grant select, update on mpgfixa.notes to ${login.name}`, "holds SELECT on mpgfixa.notes; holds UPDATE on mpgfixa.notes", `revoke all on mpgfixa.notes from ${login.name}`)
  await refused(`grant usage on schema mpgfixb to ${login.name}`, "holds USAGE on schema mpgfixb", `revoke usage on schema mpgfixb from ${login.name}`)
  await refused(`grant temporary on database answerable_mcps_test to ${login.name}`, "holds TEMPORARY on database answerable_mcps_test", `revoke temporary on database answerable_mcps_test from ${login.name}`)
  await refused(`create table public.mpgfix_owned (id int); alter table public.mpgfix_owned owner to ${login.name}`, "owns table mpgfix_owned", "drop table public.mpgfix_owned")
})
