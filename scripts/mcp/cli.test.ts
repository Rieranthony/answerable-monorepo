import { afterAll, beforeAll, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { commands, main, parse } from "./cli"
import type { Refusal } from "./io"
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

test("flags take their value after a space or an equals sign; a flag given twice takes its last; a flag without a value is true; the rest are positional", () => {
  expect(parse(newMcp, ["acme", "--serve", "toolbox", "--description=A: b = c", "--mutation", "--serve", "both"])).toEqual({
    positionals: ["acme"], flags: { serve: "both", description: "A: b = c", mutation: true },
  })
})

test("parseArgs' refusals become the CLI's: an unknown flag, long or short, a value missing or starting with a dash, and a value to a flag that takes none", () => {
  const refused = (argv: string[]) => { try { parse(newMcp, argv) } catch (error) { return [(error as Refusal).code, (error as Refusal).message] } }
  const flags = "--description, --serve, --database, --tool, --tool-description, --mutation, --help"
  expect([["-s", "toolbox"], ["--serve", "--mutation"], ["--description", "-x"], ["--mutation=yes"]].map(refused)).toEqual([
    ["unknown-flag", `bun mcp new has no flag -s; its flags are ${flags}`],
    ["flag-value", "--serve takes a value, <toolbox|standalone|both>"],
    ["flag-value", "--description takes a value, <text>"],
    ["flag-value", "--mutation takes no value"],
  ])
})

test("a word after add that is not tool names no command", async () => {
  for (const [argv, named] of [[["add", "prompt"], "add prompt"], [["add"], "add"]] as const) {
    const { code, stderr } = await run([...argv])
    expect([code, stderr().split("\n")[0]]).toEqual([2, `bun mcp has no command ${named}; its commands are new, add tool, list, check, db, setup, dev, help`])
  }
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
  expect(helped.stdout()).toStartWith("bun mcp add tool [mcp] <domain.operation> --description … [--mutation]\n\nAdd a tool to an MCP")
  expect(helped.stdout()).toContain("\nFlags:\n  --description <text>  What the tool does")
  expect(helped.stdout()).toContain("  --help                This text\n")
  expect(helped.stdout()).toEndWith("Example:\n  bun mcp add tool acme notes.add --mutation --description \"Prepare a new note on a project; commit it to save it. Use notes.list first to avoid duplicates.\"\n")
})

test("the repository is found from any folder inside it, and nowhere above", () => {
  expect(findRoot(`${repository.root}/mcps`)).toBe(repository.root)
  expect(() => findRoot(tmpdir())).toThrow("bun mcp runs in the Answerable monorepo; no package.json with the mcps/* workspaces is at or above")
})

