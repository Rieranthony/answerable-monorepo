// The role-switching scan over every MCP's code (role-switching.ts), which bun mcp check also runs over one MCP's.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { roleSwitching } from "./role-switching"

const repo = new URL("../../", import.meta.url).pathname

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "mcp-role-switching-")) })
afterEach(() => rm(root, { recursive: true, force: true }))
const write = async (path: string, text: string) => {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), text)
}

test("no MCP's code switches role, changes session authorization or sets the caller's organisation", async () => {
  expect((await roleSwitching(repo)).found).toEqual([])
})

test("the scan finds each forbidden form, in any case and across lines, names its file and line, and skips generated files and other places", async () => {
  await write("mcps/acme/src/tools/notes.ts", [
    'await db.execute(sql`SET ROLE mcp_beta`)',
    'await db.execute(sql`set local role mcp_beta`)',
    'await db.execute(sql`Set Session Role mcp_beta`)',
    'await db.execute(sql`reset\n  role`)',
    'await db.execute(sql`set session authorization answerable`)',
    'await db.execute(sql`set local session authorization answerable`)',
    "await db.execute(sql`select set_config('answerable.organisation_id', ${id}, true)`)",
    "const roleName = 'settings' // not a role switch",
  ].join("\n"))
  await write("mcps/acme/src/mcp.generated.ts", "await db.execute(sql`set role mcp_acme`)")
  await write("mcps/acme/scripts/migrate.ts", "await db.execute(sql`set role mcp_acme_owner`)")
  await write("packages/mcp-postgres/src/mcp-database.ts", "`set role mcp_acme`")
  expect((await roleSwitching(root)).found).toEqual([
    "mcps/acme/src/tools/notes.ts:1: SET ROLE",
    "mcps/acme/src/tools/notes.ts:2: set local role",
    "mcps/acme/src/tools/notes.ts:3: Set Session Role",
    "mcps/acme/src/tools/notes.ts:4: reset\n  role",
    "mcps/acme/src/tools/notes.ts:6: set session authorization",
    "mcps/acme/src/tools/notes.ts:7: set local session authorization",
    "mcps/acme/src/tools/notes.ts:8: answerable.organisation_id",
  ].sort())
  expect(await roleSwitching(root, "mcps/acme/src/**/*.ts")).toMatchObject({ files: 1 })
})
