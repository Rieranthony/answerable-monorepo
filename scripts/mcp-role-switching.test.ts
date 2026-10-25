// The trust boundary of the shared MCP database (docs/goals/mcp-cli/design.md, Database, Trust): a provider runs inside the process that
// serves it, whose login may take the runtime role of every MCP that process serves, so no MCP's code may switch role or set the caller's
// organisation. mcpDatabase does both on every borrow.
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const repo = new URL("../", import.meta.url).pathname
const forbidden = /\b(?:set\s+(?:local\s+|session\s+)?role|reset\s+role|set\s+(?:local\s+|session\s+)?session\s+authorization|answerable\.organisation_id)\b/gi

/** Each place in `mcps/*\/src/**\/*.ts` under `root`, generated files aside, that switches role or names the organisation setting: "path:line: text". */
async function roleSwitching(root: string) {
  const found: string[] = []
  for await (const path of new Bun.Glob("mcps/*/src/**/*.ts").scan({ cwd: root })) {
    if (path.endsWith(".generated.ts")) continue
    const text = await Bun.file(join(root, path)).text()
    for (const match of text.matchAll(forbidden)) found.push(`${path}:${text.slice(0, match.index).split("\n").length}: ${match[0]}`)
  }
  return found.sort()
}

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "mcp-role-switching-")) })
afterEach(() => rm(root, { recursive: true, force: true }))
const write = async (path: string, text: string) => {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), text)
}

test("no MCP's code switches role, changes session authorization or sets the caller's organisation", async () => {
  expect(await roleSwitching(repo)).toEqual([])
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
  expect(await roleSwitching(root)).toEqual([
    "mcps/acme/src/tools/notes.ts:1: SET ROLE",
    "mcps/acme/src/tools/notes.ts:2: set local role",
    "mcps/acme/src/tools/notes.ts:3: Set Session Role",
    "mcps/acme/src/tools/notes.ts:4: reset\n  role",
    "mcps/acme/src/tools/notes.ts:6: set session authorization",
    "mcps/acme/src/tools/notes.ts:7: set local session authorization",
    "mcps/acme/src/tools/notes.ts:8: answerable.organisation_id",
  ].sort())
})
