import { afterEach, beforeEach, expect, test } from "bun:test"
import { join } from "node:path"
import { main } from "../cli"
import { writeFileSync } from "node:fs"
import { generatedFiles } from "../generate"
import { mcpFiles, tableTs, toolFiles } from "../templates"
import { isolationImport } from "../templates/sources"
import { filesUnder, recorder, tempRepository, testIo } from "../test/io"

const description = "List the notes of the caller's organisation, newest first, 20 per page."
const prepares = "Prepare a new note; commit the intent to save it. Use notes.list first to avoid duplicates."
const acme = mcpFiles({ name: "acme", description: "Notes for construction projects: list, read and add notes on a project.", serve: "toolbox", database: "shared", date: "2026-10-25" })
const manifest = { description: "Notes.", tools: [{ name: "projects_list", identity: "acme/projects.list", kind: "read", scopes: ["acme:read"] }], prompts: [], resources: [] }
let repository: Awaited<ReturnType<typeof tempRepository>>
beforeEach(async () => {
  repository = await tempRepository({
    ...Object.fromEntries(Object.entries(acme).map(([path, text]) => [`mcps/acme/${path}`, text])),
    "mcps/acme/manifest.json": JSON.stringify(manifest),
    "mcps/acme/src/tools/files-list.ts": "// written by hand\n",
    "mcps/bare/mcp.json": '{ "serve": "both", "database": "shared" }\n',
    "mcps/bare/src/provider.ts": "export const provider = {}\n",
  })
  // The generated files as the repository commits them.
  for (const [path, text] of Object.entries(await generatedFiles(repository.root))) await Bun.write(join(repository.root, path), text)
})
afterEach(() => repository.remove())

const read = (path: string) => Bun.file(join(repository.root, "mcps/acme", path)).text()
const run = async (argv: string[], { cwd = repository.root, ...options }: Parameters<typeof testIo>[2] & { cwd?: string } = {}) => {
  const io = testIo(["add", "tool", ...argv], cwd, options)
  const before = await filesUnder(repository.root)
  return { ...io, code: await main(io.io), wrote: (await filesUnder(repository.root)).filter(path => !before.includes(path)) }
}

const described = ["--description", description]
test("three wrong answers are refused at once, a line each in the order of the questions, with one command that replaces all three", async () => {
  const argv = ["nope", "Notes.list", "--description", "Gets notes.", "--mutation"]
  const problems = [
    "No MCP is named nope: mcps/nope/mcp.json does not exist; bun mcp list names every MCP",
    'Tool name "Notes.list" must be <domain>.<operation>, each part a lowercase letter then up to 15 lowercase letters or digits, for example records.list',
    "A tool's description is 11 characters; write 40 to 1,000 saying what it does, when to use it and its limits",
  ]
  const fix = 'bun mcp add tool <mcp> <domain.operation> --description "<what it does, when to use it, its limits>" --mutation'
  const { code, stderr, wrote } = await run(argv)
  expect([code, wrote, stderr()]).toEqual([2, [], `${problems.join("\n")}\n\n  ${fix}\n`])
})

test("missing answers and wrong ones combine into one refusal, keeping the valid ones in its command", async () => {
  const { code, stderr } = await run(["acme", "Notes.list"])
  expect([code, stderr()]).toEqual([2, `Tool name "Notes.list" must be <domain>.<operation>, each part a lowercase letter then up to 15 lowercase letters or digits, for example records.list
Missing --description: what the tool does, when to use it and its limits, 40 to 1,000 characters
Without a terminal, bun mcp add tool asks nothing: run it again with every answer.

  bun mcp add tool acme <domain.operation> --description "<what it does, when to use it, its limits>"
`])
  expect((await run(["acme"])).stderr().split("\n").slice(0, 2)).toEqual([
    "Missing the tool: <domain.operation>, such as notes.list",
    "Missing --description: what the tool does, when to use it and its limits, 40 to 1,000 characters",
  ])
})

test("checks that need the MCP wait for it: without one, a tool another MCP has, or a commit tool's name, is not refused for that", async () => {
  const { stderr } = await run(["nope", "files.list", ...described])
  expect(stderr().split("\n").slice(0, 2)).toEqual(["No MCP is named nope: mcps/nope/mcp.json does not exist; bun mcp list names every MCP", ""])
  expect((await run(["nope", "nope.commit", ...described])).stderr().split("\n")[1]).toBe("")
})

test("from inside mcps/<name>, the MCP comes from the working directory", async () => {
  const { exec, ran } = recorder()
  const { code } = await run(["notes.list", "--description", description], { cwd: join(repository.root, "mcps/acme/src"), exec })
  expect(code).toBe(0)
  expect(ran[0]!.command.slice(-5)).toEqual(["db", "acme", "generate", "--name", "notes"])
})

test("it writes the tool and its test, adds the import and the entry above the markers and the domain's table, then writes the migration and checks", async () => {
  const { exec, ran } = recorder(command => ({ code: 0, output: command.includes("generate") ? "ok      migration  drizzle/0001_notes.sql (300 ms)\n" : " 4 pass\n" }))
  const { code, stdout } = await run(["acme", "notes.list", "--description", description], { exec })
  expect(code).toBe(0)
  for (const [path, text] of Object.entries(toolFiles("acme", { name: "notes.list", description, mutation: false }))) expect(await read(path)).toBe(text)
  expect(await read("src/provider.ts")).toBe(acme["src/provider.ts"]!
    .replace('import { database } from "./mcp"\n', 'import { database } from "./mcp"\nimport { notesList } from "./tools/notes-list"\n')
    .replace("  tools: [\n", "  tools: [\n    notesList,\n"))
  expect(await read("src/db/schema.ts")).toBe(`${isolationImport}${acme["src/db/schema.ts"]}${tableTs("acme", "notes")}`)
  expect(ran.map(({ command }) => command.slice(1).join(" ").replace(/^\S*cli\.ts/, "cli.ts"))).toEqual([
    "cli.ts db acme generate --name notes", "run typecheck", "run lint", "run test", "scripts/env-inventory.ts",
  ])
  expect(stdout().split("\n").map(line => line.replace(/ \(\d+ ms\)$/, ""))).toEqual([
    "ok      write      src/tools/notes-list.ts, src/tools/notes-list.test.ts, src/provider.ts, the notes table in src/db/schema.ts",
    "ok      migration  drizzle/0001_notes.sql",
    "ok      check      guard 7 files; none names answerable.organisation_id; typecheck 7 files; lint 7 files; test 4 pass, 0 fail; manifest current; generated current; budget no MCP has a database of its own",
    "",
    "Next:",
    "  git add mcps/acme",
    "",
  ])
  const second = await run(["acme", "notes.add", "--mutation", "--description", prepares], { exec })
  expect(second.stdout()).toContain("ok      write      src/tools/notes-add.ts, src/tools/notes-add.test.ts, src/provider.ts (")
  expect((await read("src/db/schema.ts")).match(/\.table\("notes"/g)).toHaveLength(1)
  expect(await read("src/tools/notes-add.ts")).toContain('risk: "normal"')
})

test("Next names a generated file the check rewrote, such as the chart's list when the tool brings a new scope", async () => {
  const { exec } = recorder(command => {
    if (command.at(-1) === "test") writeFileSync(join(repository.root, "mcps/acme/manifest.json"), JSON.stringify({ ...manifest, tools: [...manifest.tools, { name: "notes_add", identity: "acme/notes.add", kind: "mutate", scopes: ["acme:write"] }] }))
    return { code: 0, output: " 4 pass\n" }
  })
  const { code, stdout } = await run(["acme", "notes.add", "--mutation", "--description", prepares], { exec })
  expect(code).toBe(0)
  expect(stdout()).toEndWith("Next:\n  git add mcps/acme charts/answerable/mcps.json\n")
})

test("a table goes into a schema that already imports the isolation policy without a second import", async () => {
  await Bun.write(join(repository.root, "mcps/acme/src/db/schema.ts"), `${isolationImport}${acme["src/db/schema.ts"]}${tableTs("acme", "projects")}`)
  expect((await run(["acme", "notes.list", "--description", description])).code).toBe(0)
  expect((await read("src/db/schema.ts")).split(isolationImport)).toHaveLength(2)
})

test("in a terminal it asks for the tool, its description and read or change, and takes what the flags give", async () => {
  const asked = await run(["acme"], { isTTY: true, answers: ["files.list", "notes.add", description, "change", prepares] })
  expect(asked.code).toBe(0)
  expect(asked.asked.map(prompt => [prompt.kind, prompt.refused.length])).toEqual([["text", 1], ["text", 0], ["select", 0], ["text", 0]])
  expect(asked.asked[0]!.message).toBe("Tool, <domain>.<operation>: what the caller can do, such as notes.list or projects.search; never the vendor or the transport.")
  const flagged = await run(["acme", "--mutation", "--description", prepares], { isTTY: true, answers: ["rfis.create"] })
  expect([flagged.code, flagged.asked.length]).toEqual([0, 1])
  expect(await read("src/tools/rfis-create.ts")).toContain("defineMutation")
  const prompted = await run(["acme", "tasks.add", "--mutation"], { isTTY: true, answers: [prepares] })
  expect([prompted.code, prompted.asked[0]!.message]).toEqual([0, expect.stringContaining("use the word \"prepare\" or \"intent\"")])
})

test("a failed migration says why and finishes with generate, then check", async () => {
  const { exec } = recorder(command => (command.includes("generate") ? { code: 1, output: "drizzle-kit generate answered 1" } : { code: 0, output: "" }))
  const { code, stderr } = await run(["acme", "notes.list", "--description", description], { exec })
  expect(code).toBe(1)
  expect(stderr()).toBe("migration failed: drizzle-kit generate answered 1\n\nFinish the job with:\n  bun mcp db acme generate --name notes && bun mcp check acme\n")
})
