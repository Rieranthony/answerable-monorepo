import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkDescription, checkToolName } from "@answerable/mcp"
import { spawn } from "./io"
import { isolationImport, mcpFiles, schemaBinding, tableTs, toolBinding, toolFiles, type Answers } from "./templates"
import { tableBinding, unusable } from "./templates/names"
import { statusDescription } from "./templates/tool"
import { pins } from "./templates/workspace"

const repo = new URL("../../", import.meta.url).pathname
const answers: Answers = { name: "acme", description: "Notes for construction projects: list, read and add notes on a project.", serve: "toolbox", database: "shared", date: "2026-10-25" }
const read = { name: "notes.list", description: "List the notes of the caller's organisation, newest first, 20 per page.", mutation: false }
const mutation = { name: "notes.add", description: "Prepare a new note; commit the intent to save it. Use notes.list first to avoid duplicates.", mutation: true }

test("every file of a new MCP, for a fixed name and date, with the status tool", () => {
  for (const [path, text] of Object.entries(mcpFiles(answers))) expect(text).toMatchSnapshot(path)
})

test("a new MCP whose first tool is a read has its domain's table; a mutation's file and test", () => {
  const files = mcpFiles({ ...answers, serve: "both", database: "own", tool: read })
  expect(Object.keys(files)).toContain("src/tools/notes-list.ts")
  for (const path of ["src/db/schema.ts", "src/provider.ts", "src/tools/notes-list.ts", "src/tools/notes-list.test.ts", "README.md", "mcp.json"]) expect(files[path]).toMatchSnapshot(path)
  for (const [path, text] of Object.entries(toolFiles("acme", mutation))) expect(text).toMatchSnapshot(path)
  expect(mcpFiles({ ...answers, serve: "standalone" })["README.md"]).toContain("on its own URL, `/acme/mcp` on the standalone server, which serves it from `mcps/standalone/src/served.generated.ts`: `http://localhost:47510/acme/mcp` locally")
})

test("the package pins the repository's versions, so an MCP never drifts from the packages it shares", async () => {
  const [mcpPostgres, mcp] = await Promise.all(["packages/mcp-postgres", "packages/mcp"].map(path => Bun.file(join(repo, path, "package.json")).json()))
  expect(pins.dependencies).toEqual({ "@answerable/mcp": "workspace:*", "@answerable/mcp-postgres": "workspace:*", "drizzle-orm": mcpPostgres.dependencies["drizzle-orm"], zod: mcpPostgres.dependencies.zod })
  for (const [name, version] of Object.entries(pins.devDependencies)) expect(version, name).toBe(mcp.devDependencies[name])
})

test("the README's links reach the docs' sources", () => {
  for (const [, link] of mcpFiles(answers)["README.md"]!.matchAll(/\]\(([^)#]+)[^)]*\)/g)) expect(existsSync(join(repo, "mcps/acme", link!)), link).toBe(true)
})

test("the status tool's description passes the SDK's rule for the longest name", () => {
  expect(checkDescription(statusDescription("abcdefghijkl"))).toBeUndefined()
})

test("a domain that cannot name a binding gets a Table suffix; schema and tool bindings have a capital, so they never meet a table's", () => {
  expect(["class", "delete", "pg", "new", "notes", "text"].map(tableBinding)).toEqual(["classTable", "deleteTable", "pgTable", "newTable", "notes", "text"])
  expect([schemaBinding("acme"), toolBinding("notes.list"), toolBinding("rfi2.add")]).toEqual(["acmeSchema", "notesList", "rfi2Add"])
})

test("the longest legal name in the Toolbox, <mcp>_<domain>_<operation>, is 46 characters, within every host's 64", () => {
  const [mcp, domain, operation] = ["a".repeat(12), "b".repeat(16), "c".repeat(16)]
  expect(checkToolName(`${domain}.${operation}`)).toBeUndefined()
  expect(checkToolName(`${domain}x.${operation}`)).toBeDefined()
  expect(`${mcp}_${domain}_${operation}`).toHaveLength(46)
})

test("an MCP whose domains are every word that cannot name a binding, and its own name, typechecks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bun-mcp-names-"))
  try {
    const domains = [...unusable, "class2", "text", "uuid", "schema", "items", "acme"]
    const files: Record<string, string> = { ...mcpFiles({ ...answers, name: "new" }) }
    files["src/db/schema.ts"] = `${isolationImport}${files["src/db/schema.ts"]}${domains.map(domain => tableTs("new", domain)).join("")}`
    for (const domain of domains) Object.assign(files, toolFiles("new", { ...read, name: `${domain}.list` }), toolFiles("new", { ...mutation, name: `${domain}.add` }))
    for (const [path, text] of Object.entries(files)) await Bun.write(join(dir, path), text)
    // The compiler resolves the MCP's imports from the repository's install, as it would inside mcps/.
    await symlink(join(repo, "node_modules"), join(dir, "node_modules"))
    const { code, output } = await spawn([process.execPath, join(repo, "node_modules/typescript/bin/tsc"), "--noEmit", "-p", dir], { cwd: dir })
    expect(output).toBe("")
    expect(code).toBe(0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}, 60_000)
