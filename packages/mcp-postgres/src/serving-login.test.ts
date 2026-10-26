import { afterAll, beforeAll, expect, test } from "bun:test"
import { Pool } from "pg"
import { connect } from "./connect"
import { migrateMcp } from "./migrate-mcp"
import { roleLock, sharedMcps } from "./names"
import { provisionMcps, sqlOf } from "./provision"
import { assertServingLogin } from "./serving-login"
import { as, clientOf, fixtureFolder, forget, mcpsUrl, testLogin } from "./test/mcps"

const admin = new Pool({ connectionString: mcpsUrl, max: 1 })
// Under the lock statements on a database's privileges take: provisioning in another suite grants on answerable_mcps_test's own catalogue row meanwhile.
const run = (statements: string) => admin.query(`begin; select pg_advisory_xact_lock(${roleLock}); ${statements}; commit`)
let login: Awaited<ReturnType<typeof testLogin>>
let db: ReturnType<typeof connect>
beforeAll(async () => {
  await forget(admin, "mpgfixa", "mpgfixb")
  login = await testLogin(admin)
  await provisionMcps(sqlOf(admin), { mcps: [{ name: "mpgfixa" }, { name: "mpgfixb" }], logins: { ...sharedMcps.logins, toolbox: login.name } })
  const migrator = await clientOf(as(sharedMcps.logins.migrator))
  try {
    await migrateMcp({ client: migrator, name: "mpgfixa", folder: fixtureFolder("mpgfixa"), serving: login.name })
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

const served = { names: ["mpgfixa", "mpgfixb"] }
const refusal = (problems: string) => `Database role ${login.name} may not serve MCPs: ${problems}. Serve as the login provisioning made to serve them`
/** Make `change`, expect the assertion to refuse with `problems`, then `undo`, and expect it to pass again. */
async function refused(change: string, problems: string, undo: string) {
  await run(change)
  try {
    await expect(assertServingLogin(db, served)).rejects.toThrow(refusal(problems))
  } finally {
    await run(undo)
  }
  await assertServingLogin(db, served)
}

test("a plain login with USAGE on its MCPs' schemas and their tables' grants, a member of nothing, may serve them", async () => {
  await assertServingLogin(db, served)
})

test("each attribute beyond login is refused by name", async () => {
  for (const attribute of ["CREATEDB", "CREATEROLE", "REPLICATION", "BYPASSRLS"]) await refused(`alter role ${login.name} ${attribute}`, `has ${attribute}`, `alter role ${login.name} no${attribute}`)
  await run(`alter role ${login.name} superuser`)
  try {
    await expect(assertServingLogin(db, served)).rejects.toThrow(refusal("has SUPERUSER; holds CREATE on database answerable_mcps_test; holds TEMPORARY on database answerable_mcps_test"))
  } finally {
    await run(`alter role ${login.name} nosuperuser`)
  }
})

test("a membership of any role, and a served MCP's schema without USAGE, are each refused", async () => {
  await refused(`grant pg_read_all_data to ${login.name}`, "is a member of pg_read_all_data", `revoke pg_read_all_data from ${login.name}`)
  await refused(`revoke usage on schema mpgfixb from ${login.name}`, "lacks USAGE on schema mpgfixb", `grant usage on schema mpgfixb to ${login.name}`)
  await expect(assertServingLogin(db, { names: ["mpgfixa", "mpgfixb", "mpgfixc"] })).rejects.toThrow(refusal("lacks USAGE on schema mpgfixc"))
  // USAGE on a schema it does not serve is no reason to refuse: an MCP removed from the list keeps what it had.
  await assertServingLogin(db, { names: ["mpgfixa"] })
})

test("anything it owns, CREATE on a schema and CREATE or TEMPORARY on the database are refused", async () => {
  await refused(`grant create on schema mpgfixa to ${login.name}`, "holds CREATE on schema mpgfixa", `revoke create on schema mpgfixa from ${login.name}`)
  await refused(`grant temporary on database answerable_mcps_test to ${login.name}`, "holds TEMPORARY on database answerable_mcps_test", `revoke temporary on database answerable_mcps_test from ${login.name}`)
  await refused(`create table public.mpgfix_owned (id int); alter table public.mpgfix_owned owner to ${login.name}`, "owns table mpgfix_owned", "drop table public.mpgfix_owned")
})
