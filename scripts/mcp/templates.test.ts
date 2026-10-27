import { expect, test } from "bun:test"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkToolName } from "@answerable/mcp"
import { spawn } from "./io"
import { mcpFiles, schemaBinding, toolBinding, toolFiles, withTool, type Answers, type ToolAnswers } from "./templates"
import { tableBinding, unusable } from "./templates/names"
import { pins } from "./templates/workspace"

const repo = new URL("../../", import.meta.url).pathname
const answers: Answers = { name: "acme", description: "Notes for construction projects: list, read and add notes on a project.", serve: "toolbox", database: "shared", date: "2026-10-25" }
const read = { name: "notes.list", description: "List the notes of the caller's organisation, newest first, 20 per page.", mutation: false }
const mutation = { name: "notes.add", description: "Prepare a new note; commit the intent to save it. Use notes.list first to avoid duplicates.", mutation: true }

test("mcps/example is what bun mcp new, then add tool for notes.list and notes.add, write for it, its region lines aside", async () => {
  const example = join(repo, "mcps/example")
  const manifest = await Bun.file(join(example, "manifest.json")).json() as { description: string; version: string; tools: { identity: string; kind: string; description: string }[] }
  const tool = (name: string): ToolAnswers => {
    const { description, kind } = manifest.tools.find(entry => entry.identity === `example/${name}`)!
    return { name, description, mutation: kind === "mutate" }
  }
  let files = mcpFiles({ name: "example", description: manifest.description, serve: "toolbox", database: "shared", date: manifest.version })
  for (const added of ["notes.list", "notes.add"].map(tool)) {
    const { provider, schema } = withTool("example", { provider: files["src/provider.ts"]!, schema: files["src/db/schema.ts"]! }, added)
    files = { ...files, ...toolFiles("example", added), "src/provider.ts": provider, "src/db/schema.ts": schema }
  }
  for (const [path, text] of Object.entries(files)) {
    const committed = (await Bun.file(join(example, path)).text()).split("\n").filter(line => !/^\s*\/\/#(end)?region\b/.test(line)).join("\n")
    expect(committed, path).toBe(text)
  }
})

test("a new MCP has no tool; given one, it is the MCP add tool makes of it", () => {
  const bare = mcpFiles(answers)
  expect(Object.keys(bare).filter(path => path.startsWith("src/tools/"))).toEqual([])
  expect(bare["src/provider.ts"]).toContain("  tools: [\n    // bun mcp: tools\n  ],")
  expect(JSON.parse(bare["mcp.json"]!)).toEqual({ serve: "toolbox", database: "shared" })
  const { provider, schema } = withTool("acme", { provider: bare["src/provider.ts"]!, schema: bare["src/db/schema.ts"]! }, read)
  expect(mcpFiles({ ...answers, tool: read })).toEqual({ ...bare, ...toolFiles("acme", read), "src/provider.ts": provider, "src/db/schema.ts": schema })
  // A second tool of the same domain adds no second table.
  const again = withTool("acme", { provider, schema }, mutation)
  expect([again.table, again.schema]).toEqual([false, schema])
})

test("the package pins the repository's versions, so an MCP never drifts from the packages it shares", async () => {
  const [mcpPostgres, mcp] = await Promise.all(["packages/mcp-postgres", "packages/mcp"].map(path => Bun.file(join(repo, path, "package.json")).json()))
  expect(pins.dependencies).toEqual({ "@answerable/mcp": "workspace:*", "@answerable/mcp-postgres": "workspace:*", "drizzle-orm": mcpPostgres.dependencies["drizzle-orm"], zod: mcpPostgres.dependencies.zod })
  for (const [name, version] of Object.entries(pins.devDependencies)) expect(version, name).toBe(mcp.devDependencies[name])
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
    let files: Record<string, string> = { ...mcpFiles({ ...answers, name: "new" }) }
    for (const domain of domains) {
      for (const tool of [{ ...read, name: `${domain}.list` }, { ...mutation, name: `${domain}.add` }]) {
        const { provider, schema } = withTool("new", { provider: files["src/provider.ts"]!, schema: files["src/db/schema.ts"]! }, tool)
        files = { ...files, ...toolFiles("new", tool), "src/provider.ts": provider, "src/db/schema.ts": schema }
      }
    }
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
