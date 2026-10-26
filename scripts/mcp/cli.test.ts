import { afterAll, beforeAll, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { commands, main, parse } from "./cli"
import { tempRepository, testIo } from "./test/io"
import { findRoot } from "./workspace"
let repository: Awaited<ReturnType<typeof tempRepository>>
beforeAll(async () => { repository = await tempRepository() })
afterAll(() => repository.remove())

const run = async (argv: string[], cwd = repository.root) => {
  const io = testIo(argv, cwd)
  return { ...io, code: await main(io.io) }
}
const newMcp = commands.find(command => command.name === "new")!

test("flags take their value after a space or an equals sign; a flag without a value is true; the rest are positional", () => {
  expect(parse(newMcp, ["acme", "--serve", "toolbox", "--description=A: b = c", "--mutation", "--json"])).toEqual({
    positionals: ["acme"], flags: { serve: "toolbox", description: "A: b = c", mutation: true, json: true },
  })
})

test.each([
  [["new", "acme", "--force"], "unknown-flag", "bun mcp new has no flag --force; its flags are --description, --serve, --database, --tool, --tool-description, --mutation, --no-check, --json, --help"],
  [["new", "acme", "-s", "toolbox"], "unknown-flag", "bun mcp new has no flag -s; its flags are --description, --serve, --database, --tool, --tool-description, --mutation, --no-check, --json, --help"],
  [["new", "acme", "--serve", "toolbox", "--serve", "both"], "repeated-flag", "--serve is given twice; give it once"],
  [["new", "acme", "--serve"], "flag-value", "--serve takes a value, <toolbox|standalone|both>"],
  [["new", "acme", "--serve", "--mutation"], "flag-value", "--serve takes a value, <toolbox|standalone|both>"],
  [["new", "acme", "--mutation=yes"], "flag-value", "--mutation takes no value"],
  [["deploy", "acme"], "unknown-command", "bun mcp has no command deploy; its commands are new, add tool, list, check, db, setup, dev, help"],
  [["add", "prompt"], "unknown-command", "bun mcp has no command add prompt; its commands are new, add tool, list, check, db, setup, dev, help"],
  [["add"], "unknown-command", "bun mcp has no command add; its commands are new, add tool, list, check, db, setup, dev, help"],
])("refuses %j with %s, exit 2", async (argv, code, message) => {
  const text = await run(argv)
  expect([text.code, text.stderr().split("\n")[0]]).toEqual([2, message])
  expect(JSON.parse((await run([...argv, "--json"])).stdout()).error).toMatchObject({ code })
})

test("help refuses a command it does not have", async () => {
  const { code, stderr } = await run(["help", "deploy"])
  expect([code, stderr()]).toEqual([2, "bun mcp has no command deploy; its commands are new, add tool, list, check, db, setup, dev, help\n\n  bun mcp help\n"])
})

test("help lists every command with its summary; help <command> and --help give its usage, every flag and an example", async () => {
  for (const argv of [[], ["--help"], ["help"]]) {
    const { code, stdout } = await run(argv)
    expect(code).toBe(0)
    expect(stdout()).toStartWith("bun mcp makes, checks and runs the MCPs of this repository.")
    for (const command of commands) expect(stdout()).toContain(`  ${command.name.padEnd(8)}  ${command.summary}\n`)
  }
  const [helped, flagged] = [await run(["help", "add", "tool"]), await run(["add", "tool", "--help"])]
  expect(helped.stdout()).toBe(flagged.stdout())
  expect(helped.stdout()).toStartWith("bun mcp add tool [mcp] <domain.operation> --description … [--mutation] [--no-check] [--json]\n\nAdd a tool to an MCP")
  expect(helped.stdout()).toContain("\nFlags:\n  --description <text>  What the tool does")
  expect(helped.stdout()).toContain("  --help                This text\n")
  expect(helped.stdout()).toEndWith("Example:\n  bun mcp add tool acme notes.add --mutation --description \"Prepare a new note on a project; commit it to save it. Use notes.list first to avoid duplicates.\"\n")
})

test("every command and flag has a description, and every command an example", () => {
  for (const command of commands) {
    expect([command.summary, command.example, command.usage].every(Boolean), command.name).toBe(true)
    for (const [flag, { description }] of Object.entries(command.flags)) expect(description, `${command.name} --${flag}`).toBeTruthy()
  }
})

test("outside the repository every command is refused, and an error that is not a refusal exits 1 with its message", async () => {
  expect(() => findRoot(tmpdir())).toThrow("bun mcp runs in the Answerable monorepo; no package.json with the mcps/* workspaces is at or above")
  const outside = await run(["list"], "/")
  expect([outside.code, outside.stderr().split("\n")[0]]).toEqual([2, "bun mcp runs in the Answerable monorepo; no package.json with the mcps/* workspaces is at or above /"])
  await Bun.write(`${repository.root}/mcps/retired.json`, "not json")
  const broken = await run(["new", "acme", "--json"])
  expect([broken.code, JSON.parse(broken.stdout()).error.code]).toEqual([2, "invalid-file"])
  await Bun.write(`${repository.root}/mcps/acme/mcp.json`, '{ "name": "acme", "serve": "toolbox", "database": "shared" }\n')
  const failed = await run(["db", "acme", "generate"])
  expect(failed.code).toBe(1)
  expect(failed.stderr()).toStartWith("bun mcp failed: Cannot find module")
})

