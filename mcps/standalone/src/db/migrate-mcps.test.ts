import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureLocalMcpDatabases, provisionMcps, provisionOwnMcp, sharedMcps, sqlOf } from "@answerable/mcp-postgres"
import { mcpPostgresTestConfig } from "@answerable/mcp-postgres/testing"
import { Client } from "pg"
import { migrateDeclared } from "./migrate-mcps"

// Three MCPs laid out as bun mcp lays them out, in a repository of the test's own: two shared, one of them narrowing its grants in
// src/db/grants.ts, and one with a database of its own; each provisioned as the bootstrap provisions it, then migrated by the Job's code.
const root = mkdtempSync(join(tmpdir(), "answerable-migrate-mcps-"))
const prefix = "mcp_stdm"
const shared = "answerable_standalone_test_migrate"
const own = { database: "answerable_standalone_test_migrate_own", owner: "answerable_mcp_stdmigc_owner", runtime: "answerable_mcp_stdmigc_runtime" }
const serving = `mcp_test_login_${crypto.randomUUID().replaceAll("-", "")}`
const superuser = (database: string, login?: string) => {
  const url = new URL(mcpPostgresTestConfig.read(process.env).MCPS_TEST_DATABASE_URL)
  url.pathname = `/${database}`
  if (login) Object.assign(url, { username: login, password: "answerable" })
  return url.href
}
async function on(database: string, ...statements: string[]) {
  const client = new Client({ connectionString: superuser(database) })
  await client.connect()
  try {
    const results = []
    for (const statement of statements) results.push((await client.query(statement)).rows)
    return results.at(-1)!
  } finally {
    await client.end()
  }
}

/** Write an MCP's drizzle folder of one migration, `statements` joined as drizzle-kit joins them, and its grants file when given. */
async function mcp(name: string, statements: string[], grants?: string) {
  const dir = join(root, "mcps", name)
  await Bun.write(join(dir, "mcp.json"), JSON.stringify({ name }))
  await Bun.write(join(dir, "drizzle/0000_initial.sql"), statements.join("\n--> statement-breakpoint\n"))
  await Bun.write(join(dir, "drizzle/meta/_journal.json"), JSON.stringify({ version: "7", dialect: "postgresql", entries: [{ idx: 0, version: "7", when: 1792949252412, tag: "0000_initial", breakpoints: true }] }))
  if (grants) await Bun.write(join(dir, "src/db/grants.ts"), grants)
}
const notes = (name: string) => [`CREATE TABLE "${name}"."notes" ("id" serial PRIMARY KEY NOT NULL, "body" text NOT NULL);`]

beforeAll(async () => {
  await ensureLocalMcpDatabases(superuser("postgres"))
  await mcp("stdmiga", notes("stdmiga"))
  await mcp("stdmigb", notes("stdmigb"), `export const grants = [{ table: "notes", privileges: ["select"] }]\n`)
  await mcp("stdmigc", notes("stdmigc"))
  await mcp("stdmigd", ['CREATE TABLE "stdmigd"."broken" ("id" serial PRIMARY KEY NOT NULL, "body" text NOT NULL REFERENCES "stdmigd"."missing"("id"));'])
  await Bun.write(join(root, "mcps/stdmige/mcp.json"), JSON.stringify({ name: "stdmige" }))
  await on("postgres",
    `drop database if exists ${shared} with (force)`, `drop database if exists ${own.database} with (force)`,
    `create database ${shared} owner ${sharedMcps.logins.migrator}`, `create role ${serving} login noinherit`,
    `create role ${own.owner} login password 'answerable' noinherit`, `create role ${own.runtime} login password 'answerable' noinherit`,
    `create database ${own.database} owner ${own.owner}`, `revoke all on database ${own.database} from public`, `grant connect on database ${own.database} to ${own.owner}, ${own.runtime}`)
  const admin = new Client({ connectionString: superuser(shared) })
  await admin.connect()
  try {
    await provisionMcps(sqlOf(admin), { mcps: ["stdmiga", "stdmigb", "stdmigd", "stdmige"].map(name => ({ name, servedBy: ["standalone"] })), prefix, logins: { ...sharedMcps.logins, toolbox: serving, standalone: serving } })
  } finally {
    await admin.end()
  }
  const owner = new Client({ connectionString: superuser(own.database, own.owner) })
  await owner.connect()
  try {
    await provisionOwnMcp(sqlOf(owner), { name: "stdmigc", ...own })
  } finally {
    await owner.end()
  }
})
afterAll(async () => {
  rmSync(root, { recursive: true, force: true })
  const roles = ["stdmiga", "stdmigb", "stdmigd", "stdmige"].flatMap(name => [`${prefix}_${name}`, `${prefix}_${name}_owner`])
  await on("postgres", `drop database ${shared} with (force)`, `drop database ${own.database} with (force)`, `drop role ${[serving, own.owner, own.runtime, ...roles].join(", ")}`)
})

const migrate = (names: string[], lines: string[] = []) => migrateDeclared({
  root,
  mcps: names.map(name => ({ name, database: name === "stdmigc" ? "own" : "shared" })),
  shared: superuser(shared, sharedMcps.logins.migrator),
  own: name => superuser(own.database, `answerable_mcp_${name}_owner`),
  prefix,
  log: line => lines.push(line),
})
/** Each table's owner and its access list, in the MCP's schema, read as the superuser. */
const tables = (database: string, schema: string) => on(database, `select relname, pg_get_userbyid(relowner) as owner, relacl::text as acl from pg_class where relnamespace = '${schema}'::regnamespace and relkind = 'r' order by 1`)

test("the first failure stops the run and names the MCP; the MCPs after it are not migrated", async () => {
  const lines: string[] = []
  await expect(migrate(["stdmigd", "stdmiga"], lines)).rejects.toThrow(/^Migrating MCP stdmigd failed: stdmigd: 0000_initial.sql failed: relation "stdmigd.missing" does not exist/)
  expect(lines).toEqual(["stdmigd: migrating in answerable_standalone_test_migrate as mcp_stdm_stdmigd_owner"])
  expect(await tables(shared, "stdmigd")).toEqual([])
  expect(await tables(shared, "stdmiga")).toEqual([])
})

test("each MCP in the list's order: a shared one through the migrator as its owner role, an own one as its owner login; the grants from src/db/grants.ts when it exports them; a second run changes nothing", async () => {
  const lines: string[] = []
  await migrate(["stdmigb", "stdmigc", "stdmiga"], lines)
  expect(lines).toEqual([
    "stdmigb: migrating in answerable_standalone_test_migrate as mcp_stdm_stdmigb_owner, with src/db/grants.ts",
    `stdmigc: migrating in ${own.database} as ${own.owner}`,
    "stdmiga: migrating in answerable_standalone_test_migrate as mcp_stdm_stdmiga_owner",
  ])
  const migrated = { a: await tables(shared, "stdmiga"), b: await tables(shared, "stdmigb"), c: await tables(own.database, "stdmigc") }
  expect(migrated.a).toContainEqual({ relname: "notes", owner: "mcp_stdm_stdmiga_owner", acl: "{mcp_stdm_stdmiga_owner=arwdDxtm/mcp_stdm_stdmiga_owner,mcp_stdm_stdmiga=arwd/mcp_stdm_stdmiga_owner}" })
  expect(migrated.b).toContainEqual({ relname: "notes", owner: "mcp_stdm_stdmigb_owner", acl: "{mcp_stdm_stdmigb_owner=arwdDxtm/mcp_stdm_stdmigb_owner,mcp_stdm_stdmigb=r/mcp_stdm_stdmigb_owner}" })
  expect(migrated.c).toContainEqual({ relname: "notes", owner: own.owner, acl: `{${own.owner}=arwdDxtm/${own.owner},${own.runtime}=arwd/${own.owner}}` })
  await migrate(["stdmigb", "stdmigc", "stdmiga"])
  expect({ a: await tables(shared, "stdmiga"), b: await tables(shared, "stdmigb"), c: await tables(own.database, "stdmigc") }).toEqual(migrated)
})

test("an MCP with no migration yet is skipped, and one this repository does not hold is refused, naming it", async () => {
  const lines: string[] = []
  await migrate(["stdmige"], lines)
  expect(lines).toEqual(["stdmige: no migration yet"])
  await expect(migrate(["stdmigf"])).rejects.toThrow("mcps/stdmigf is not in this image: the chart's list and the image come from different commits")
})
