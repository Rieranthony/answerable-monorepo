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
const shared = "answerable_toolbox_test_migrate"
const own = { database: "answerable_toolbox_test_migrate_own", owner: "answerable_mcp_tbxmigc_owner", runtime: "answerable_mcp_tbxmigc_runtime" }
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
  await mcp("tbxmiga", notes("tbxmiga"))
  await mcp("tbxmigb", notes("tbxmigb"), `export const grants = [{ table: "notes", privileges: ["select"] }]\n`)
  await mcp("tbxmigc", notes("tbxmigc"))
  await mcp("tbxmigd", ['CREATE TABLE "tbxmigd"."broken" ("id" serial PRIMARY KEY NOT NULL, "body" text NOT NULL REFERENCES "tbxmigd"."missing"("id"));'])
  await Bun.write(join(root, "mcps/tbxmige/mcp.json"), JSON.stringify({ name: "tbxmige" }))
  await on("postgres",
    `drop database if exists ${shared} with (force)`, `drop database if exists ${own.database} with (force)`,
    `create database ${shared} owner ${sharedMcps.logins.migrator}`, `create role ${serving} login noinherit`,
    `create role ${own.owner} login password 'answerable' noinherit`, `create role ${own.runtime} login password 'answerable' noinherit`,
    `create database ${own.database} owner ${own.owner}`, `revoke all on database ${own.database} from public`, `grant connect on database ${own.database} to ${own.owner}, ${own.runtime}`)
  const admin = new Client({ connectionString: superuser(shared) })
  await admin.connect()
  try {
    await provisionMcps(sqlOf(admin), { mcps: ["tbxmiga", "tbxmigb", "tbxmigd", "tbxmige"].map(name => ({ name })), logins: { ...sharedMcps.logins, toolbox: serving } })
  } finally {
    await admin.end()
  }
  const owner = new Client({ connectionString: superuser(own.database, own.owner) })
  await owner.connect()
  try {
    await provisionOwnMcp(sqlOf(owner), { name: "tbxmigc", ...own })
  } finally {
    await owner.end()
  }
})
afterAll(async () => {
  rmSync(root, { recursive: true, force: true })
  await on("postgres", `drop database ${shared} with (force)`, `drop database ${own.database} with (force)`, `drop role ${[serving, own.owner, own.runtime].join(", ")}`)
})

const migrate = (names: string[], lines: string[] = []) => migrateDeclared({
  root,
  mcps: names.map(name => ({ name, database: name === "tbxmigc" ? "own" : "shared" })),
  shared: superuser(shared, sharedMcps.logins.migrator),
  serving,
  own: name => superuser(own.database, `answerable_mcp_${name}_owner`),
  log: line => lines.push(line),
})
/** Each table's owner and its access list, in the MCP's schema, read as the superuser. */
const tables = (database: string, schema: string) => on(database, `select relname, pg_get_userbyid(relowner) as owner, relacl::text as acl from pg_class where relnamespace = '${schema}'::regnamespace and relkind = 'r' order by 1`)

test("the first failure stops the run and names the MCP; the MCPs after it are not migrated", async () => {
  const lines: string[] = []
  await expect(migrate(["tbxmigd", "tbxmiga"], lines)).rejects.toThrow(/^Migrating MCP tbxmigd failed: tbxmigd: 0000_initial.sql failed: relation "tbxmigd.missing" does not exist/)
  expect(lines).toEqual(["tbxmigd: migrating in answerable_toolbox_test_migrate as answerable_mcps_migrator"])
  // Nothing of the failed file: only drizzle's journal, which its migrator makes before the migrations' transaction, and empty.
  expect((await tables(shared, "tbxmigd")).map(table => table.relname)).toEqual(["__drizzle_migrations"])
  expect(await on(shared, "select count(*)::int as receipts from tbxmigd.__drizzle_migrations")).toEqual([{ receipts: 0 }])
  expect(await tables(shared, "tbxmiga")).toEqual([])
})

test("each MCP in the list's order: a shared one as the migrator, granting the serving login, an own one as its owner login, granting its runtime login; the grants from src/db/grants.ts when it exports them; a second run changes nothing", async () => {
  const lines: string[] = []
  await migrate(["tbxmigb", "tbxmigc", "tbxmiga"], lines)
  expect(lines).toEqual([
    "tbxmigb: migrating in answerable_toolbox_test_migrate as answerable_mcps_migrator, with src/db/grants.ts",
    `tbxmigc: migrating in ${own.database} as ${own.owner}`,
    "tbxmiga: migrating in answerable_toolbox_test_migrate as answerable_mcps_migrator",
  ])
  const migrated = { a: await tables(shared, "tbxmiga"), b: await tables(shared, "tbxmigb"), c: await tables(own.database, "tbxmigc") }
  const migrator = sharedMcps.logins.migrator
  expect(migrated.a).toContainEqual({ relname: "notes", owner: migrator, acl: `{${migrator}=arwdDxtm/${migrator},${serving}=arwd/${migrator}}` })
  expect(migrated.b).toContainEqual({ relname: "notes", owner: migrator, acl: `{${migrator}=arwdDxtm/${migrator},${serving}=r/${migrator}}` })
  expect(migrated.c).toContainEqual({ relname: "notes", owner: own.owner, acl: `{${own.owner}=arwdDxtm/${own.owner},${own.runtime}=arwd/${own.owner}}` })
  await migrate(["tbxmigb", "tbxmigc", "tbxmiga"])
  expect({ a: await tables(shared, "tbxmiga"), b: await tables(shared, "tbxmigb"), c: await tables(own.database, "tbxmigc") }).toEqual(migrated)
})

test("an MCP with no migration yet is skipped, and one this repository does not hold is refused, naming it", async () => {
  const lines: string[] = []
  await migrate(["tbxmige"], lines)
  expect(lines).toEqual(["tbxmige: no migration yet"])
  await expect(migrate(["tbxmigf"])).rejects.toThrow("mcps/tbxmigf is not in this image: the chart's list and the image come from different commits")
})
