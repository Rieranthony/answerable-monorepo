import { afterEach, beforeEach, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { chmod } from "node:fs/promises"
import { join } from "node:path"
import { main } from "../cli"
import { mcpFiles } from "../templates"
import { filesUnder, migrations, recorder, tempRepository, testIo } from "../test/io"

const description = "Notes for construction projects: list, read and add notes on a project."
const toolDescription = "List the notes of the caller's organisation, newest first, 20 per page."
let repository: Awaited<ReturnType<typeof tempRepository>>
beforeEach(async () => { repository = await tempRepository({ "mcps/taken/mcp.json": '{ "serve": "toolbox", "database": "shared" }\n', "mcps/retired.json": '["gone"]\n' }) })
afterEach(() => repository.remove())

const run = async (argv: string[], options: Parameters<typeof testIo>[2] = {}) => {
  const io = testIo(["new", ...argv], repository.root, options)
  const before = await filesUnder(repository.root)
  return { ...io, code: await main(io.io), wrote: (await filesUnder(repository.root)).filter(path => !before.includes(path)) }
}
const full = (name: string) => [name, "--description", description, "--serve", "toolbox"]

test("three wrong answers are refused at once, a line each in the order of the questions, with one command that replaces all three", async () => {
  const { code, stderr, wrote } = await run(["Acme", "--description", "x", "--serve", "cloud"])
  expect([code, wrote]).toEqual([2, []])
  expect(stderr()).toBe(`MCP name "Acme" must be a lowercase letter then up to 11 lowercase letters or digits, for example acme
An MCP's description is 1 character; write 40 to 1,000 saying what it does, when to use it and its limits
--serve must be toolbox, standalone or both, not "cloud"

  bun mcp new <name> --description "<what the MCP is for, 40 to 1,000 characters>" --serve <toolbox|standalone|both>
`)
})

test("missing answers and wrong ones combine into one refusal, and the valid ones are kept in its command", async () => {
  const { code, stderr } = await run(["acme", "--serve", "cloud", "--database", "big", "--tool", "Notes.list"])
  expect(code).toBe(2)
  expect(stderr()).toBe(`Missing --description: what the MCP is for, 40 to 1,000 characters
--serve must be toolbox, standalone or both, not "cloud"
--database must be shared or own, not "big"
Tool name "Notes.list" must be <domain>.<operation>, each part a lowercase letter then up to 15 lowercase letters or digits, for example records.list
Missing --tool-description: what Notes.list does, when to use it and its limits, 40 to 1,000 characters
Without a terminal, bun mcp new asks nothing: run it again with every answer.

  bun mcp new acme --description "<what the MCP is for, 40 to 1,000 characters>" --serve <toolbox|standalone|both> --database <shared|own> --tool <domain.operation> --tool-description "<what the tool does, when to use it, its limits>"
`)
})

test("a check that needs a valid name waits for it: with a wrong name, whether the tool is a commit tool's is not checked", async () => {
  const { stderr } = await run(["Acme", "--description", description, "--serve", "toolbox", "--tool", "acme.commit", "--tool-description", toolDescription, "--mutation"])
  expect(stderr().split("\n").slice(0, 3)).toEqual([
    'MCP name "Acme" must be a lowercase letter then up to 11 lowercase letters or digits, for example acme',
    '<name>/acme.commit: a mutation\'s description must say that it prepares an intent; use the word "prepare" or "intent"',
    "",
  ])
})

test("without a terminal, a missing answer exits 2 and prints the full command with placeholders, asking nothing", async () => {
  const { code, stderr, asked, wrote } = await run([])
  expect([code, asked, wrote]).toEqual([2, [], []])
  expect(stderr()).toBe(`Missing the name: a lowercase letter, then up to 11 lowercase letters or digits, such as acme
Missing --description: what the MCP is for, 40 to 1,000 characters
Missing --serve: where it runs, toolbox, standalone or both
Without a terminal, bun mcp new asks nothing: run it again with every answer.

  bun mcp new <name> --description "<what the MCP is for, 40 to 1,000 characters>" --serve <toolbox|standalone|both>
`)
  const tool = await run([...full("acme"), "--tool", "notes.list"])
  expect([tool.code, tool.stderr().split("\n")[0]]).toEqual([2, "Missing --tool-description: what notes.list does, when to use it and its limits, 40 to 1,000 characters"])
  expect(tool.stderr()).toContain("--tool notes.list --tool-description \"<what the tool does, when to use it, its limits>\"")
})

test("in a terminal it asks what is missing, in the design's order, with the default first, retrying what a rule refuses", async () => {
  const { code, asked, stdout } = await run([], { isTTY: true, answers: ["Acme", "acme", "Short.", description, "toolbox", "notes.add", toolDescription, "change", "Prepare a new note; commit the intent to save it on the project."] })
  expect(code).toBe(0)
  expect(asked.map(({ kind, initialValue, options, refused }) => ({ kind, initialValue, options, refused }))).toEqual([
    { kind: "text", initialValue: undefined, options: undefined, refused: ['MCP name "Acme" must be a lowercase letter then up to 11 lowercase letters or digits, for example acme'] },
    { kind: "text", initialValue: undefined, options: undefined, refused: ["An MCP's description is 6 characters; write 40 to 1,000 saying what it does, when to use it and its limits"] },
    { kind: "select", initialValue: "toolbox", options: ["toolbox", "standalone", "both"], refused: [] },
    { kind: "text", initialValue: undefined, options: undefined, refused: [] },
    { kind: "text", initialValue: undefined, options: undefined, refused: [] },
    { kind: "select", initialValue: "read", options: ["read", "change"], refused: [] },
    { kind: "text", initialValue: undefined, options: undefined, refused: [] },
  ])
  expect(asked.map(prompt => prompt.message.split(":")[0])).toEqual([
    "Name", "What is the MCP for, in a sentence or two? 40 to 1,000 characters, for example", "Where does it run?", "First tool, <domain>.<operation>",
    "What does notes.add do? Say when to use it and its limits, in 40 to 1,000 characters. Good", "Read or change?",
    "What does notes.add do? Say when to use it and its limits, in 40 to 1,000 characters. Good",
  ])
  expect(asked[6]!.message).toEndWith('A change\'s description says that it prepares an intent: use the word "prepare" or "intent".')
  expect(asked[3]!.message).toEndWith("never the vendor or the transport. Enter skips it: the MCP starts with no tool.")
  expect(stdout()).toContain("its first tool is notes.add")
  expect(await Bun.file(join(repository.root, "mcps/acme/src/tools/notes-add.ts")).text()).toContain("Prepare a new note; commit the intent to save it on the project.")
})

test("in a terminal Enter skips the first tool, and the MCP has none; flags given are not asked", async () => {
  const { code, asked, stdout } = await run(["acme", "--serve", "both"], { isTTY: true, answers: [description, ""] })
  expect([code, asked.map(prompt => prompt.kind)]).toEqual([0, ["text", "text"]])
  expect(await Bun.file(join(repository.root, "mcps/acme/mcp.json")).json()).toEqual({ serve: "both", database: "shared" })
  expect(await Array.fromAsync(new Bun.Glob("**").scan({ cwd: join(repository.root, "mcps/acme/src"), onlyFiles: true }))).not.toContainEqual(expect.stringMatching(/^tools\//))
  expect(stdout()).toStartWith("Making acme in mcps/acme: it runs in the Toolbox and on its own URL; it has no tool yet.\n")
  const tool = await run(["beta", "--serve", "toolbox", "--tool", "notes.list"], { isTTY: true, answers: [description, toolDescription] })
  expect([tool.code, tool.asked.map(prompt => prompt.message.split("?")[0])]).toEqual([0, ["What is the MCP for, in a sentence or two", "What does notes.list do"]])
})

test("cancelling a prompt writes nothing and exits 2", async () => {
  const { code, stderr, wrote } = await run([], { isTTY: true, answers: [Symbol("cancel")] })
  expect([code, wrote]).toEqual([2, []])
  expect(stderr()).toBe("Cancelled: nothing was written\n\n  bun mcp new <name> --description \"<what the MCP is for, 40 to 1,000 characters>\" --serve <toolbox|standalone|both>\n")
  for (const answers of [[description, Symbol("cancel")], [description, "toolbox", "notes.list", Symbol("cancel")], [description, "toolbox", "notes.list", toolDescription, Symbol("cancel")]]) {
    expect((await run(["acme"], { isTTY: true, answers })).code).toBe(2)
  }
})

test("it writes the templates, then the generated list, the install, the migration, the schema and the check, one line each, then Next", async () => {
  // The MCP's tests write its manifest, as the conformance kit does with UPDATE_MANIFEST=1.
  const { exec, ran } = recorder(command => {
    if (command.at(-1) === "test") writeFileSync(join(repository.root, "mcps/acme/manifest.json"), `${JSON.stringify({ description, tools: [], prompts: [], resources: [] })}\n`)
    return { code: 0, output: " 3 pass\n 0 fail\n" }
  })
  const { migrate, asked } = migrations()
  const { code, stdout, stderr } = await run([...full("acme"), "--tool", "notes.list", "--tool-description", toolDescription], { exec, migrate })
  expect([code, stderr()]).toEqual([0, ""])
  const date = new Date().toISOString().slice(0, 10)
  const expected = mcpFiles({ name: "acme", description, serve: "toolbox", database: "shared", date, tool: { name: "notes.list", description: toolDescription, mutation: false } })
  for (const [path, text] of Object.entries(expected)) expect(await Bun.file(join(repository.root, "mcps/acme", path)).text()).toBe(text)
  expect(ran.map(({ command, cwd, env }) => [command.slice(1).join(" ").replace(/^\S*cli\.ts/, "cli.ts"), cwd.slice(repository.root.length), env])).toEqual([
    ["install", "", undefined],
    ["cli.ts db acme generate --name initial", "", undefined],
    ["run typecheck", "/mcps/acme", undefined],
    ["run lint", "/mcps/acme", undefined],
    ["run test", "/mcps/acme", { UPDATE_MANIFEST: "1" }],
    ["scripts/env-inventory.ts", "", undefined],
  ])
  expect(asked).toEqual([["acme"]])
  const lines = stdout().split("\n")
  expect(lines.slice(0, 2)).toEqual([
    "Making acme in mcps/acme: it runs in the Toolbox; its first tool is notes.list.",
    "Database: schema acme in answerable_mcps (shared). Pass --database own for a database of its own.",
  ])
  expect(lines.slice(2, 8).map(line => line.replace(/ \(\d+ ms\)$/, ""))).toEqual([
    "ok      write      mcps/acme: 11 files",
    "ok      generate   rewrote charts/answerable/mcps.json",
    "ok      install    bun install",
    "ok      migration  mcps/acme/drizzle/0000_initial.sql",
    "ok      database   schema acme in answerable_mcps: migrated",
    "ok      check      guard 6 files; none names answerable.organisation_id; typecheck 6 files; lint 6 files; test 3 pass, 0 fail; manifest rewritten: commit mcps/acme/manifest.json; generated current; budget no MCP has a database of its own",
  ])
  expect(lines.slice(8).join("\n")).toBe(`
Next:
  bun mcp add tool acme <domain.operation> --description "<what it does, when to use it, its limits>"
  git add mcps/acme charts/answerable/mcps.json bun.lock
`)
})

test("an MCP of its own database says where its schema is", async () => {
  expect((await run([...full("beta"), "--database", "own"])).stdout()).toContain("Database: schema beta in answerable_mcp_beta, a database of its own (own).")
})

test("a failed step stops the run, says why and gives the commands that finish the job, and exits 1 with the files kept", async () => {
  const { code, stdout, stderr } = await run(full("acme"), { migrate: migrations("the development Postgres does not answer on localhost:47432; start it with bun run env:up from the main checkout").migrate })
  expect(code).toBe(1)
  expect(stdout()).toMatch(/failed {2}database {3}\(\d+ ms\)\n$/)
  expect(stderr()).toBe(`database failed: the development Postgres does not answer on localhost:47432; start it with bun run env:up from the main checkout

Finish the job with:
  bun mcp db acme migrate && bun mcp check acme
`)
  expect(await Bun.file(join(repository.root, "mcps/acme/mcp.json")).exists()).toBe(true)
})

test("a failure to write the files says to remove them and make the MCP again", async () => {
  await chmod(join(repository.root, "mcps"), 0o555)
  try {
    const { code, stderr } = await run(full("acme"))
    expect(code).toBe(1)
    expect(stderr()).toStartWith("write failed: ")
    expect(stderr()).toEndWith(`Finish the job with:\n  rm -rf mcps/acme && bun mcp new acme --description '${description}' --serve toolbox\n`)
  } finally {
    await chmod(join(repository.root, "mcps"), 0o755)
  }
})
