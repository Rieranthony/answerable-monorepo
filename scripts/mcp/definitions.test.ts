import { afterEach, beforeEach, expect, test } from "bun:test"
import { commands, main } from "./cli"
import { definitions, errorCodes, exitCodes } from "./definitions"
import { choices } from "./rules"
import { mcpFiles } from "./templates"
import { generatedFiles } from "./generate"
import { recorder, tempRepository, testIo } from "./test/io"

const description = "Notes for construction projects: list, read and add notes on a project."
const toolDescription = "List the notes of the caller's organisation, newest first, 20 per page."
const acme = mcpFiles({ name: "acme", description, serve: "toolbox", database: "shared", date: "2026-10-25" })
let repository: Awaited<ReturnType<typeof tempRepository>>
beforeEach(async () => {
  repository = await tempRepository(Object.fromEntries(Object.entries(acme).map(([path, text]) => [`mcps/acme/${path}`, text])))
  await Bun.write(`${repository.root}/mcps/acme/manifest.json`, `${JSON.stringify({ description, tools: [], prompts: [], resources: [] })}\n`)
  for (const [path, text] of Object.entries(await generatedFiles(repository.root))) await Bun.write(`${repository.root}/${path}`, text)
})
afterEach(() => repository.remove())

// The steps a command printed with --json, by name.
async function stepsOf(argv: string[]) {
  const io = testIo(argv, repository.root, { exec: recorder().exec })
  expect(await main(io.io), io.stderr()).toBe(0)
  return (JSON.parse(io.stdout()).steps as { name: string }[]).map(step => step.name)
}
const names = (command: keyof typeof definitions) => definitions[command].steps.map(step => step.name)

test("the commands are the definitions, spread with what runs them, in the order help lists them", () => {
  expect(commands.map(({ name, usage, summary, flags, steps, example }) => ({ name, usage, summary, flags, steps, example }))).toEqual(Object.values(definitions))
  expect(commands.map(command => command.name)).toEqual(Object.keys(definitions))
})

test("every command, flag and step is described; every command has an example that runs it; a usage starts with the command", () => {
  for (const command of Object.values(definitions)) {
    expect(command.usage, command.name).toStartWith(`bun mcp ${command.name}`)
    expect(command.example, command.name).toStartWith(`bun mcp ${command.name}`)
    expect(command.summary, command.name).toBeTruthy()
    for (const [flag, { description }] of Object.entries(command.flags)) expect(description, `${command.name} --${flag}`).toBeTruthy()
    for (const step of command.steps) expect(step.does, `${command.name} ${step.name}`).toBeTruthy()
  }
  expect(exitCodes.map(({ code }) => code)).toEqual([0, 1, 2])
})

test("new, add tool and check print the steps their definitions name, in order", async () => {
  const fresh = ["new", "beta", "--description", description, "--serve", "toolbox", "--json"]
  expect(await stepsOf(fresh)).toEqual(names("new"))
  expect(await stepsOf(["add", "tool", "acme", "notes.list", "--description", toolDescription, "--json"])).toEqual(names("add tool"))
  expect(await stepsOf(["check", "acme", "--json"])).toEqual(names("check"))
})

test("a flag's default is shown by help, after its description", async () => {
  const io = testIo(["new", "--help"], repository.root)
  expect(await main(io.io)).toBe(0)
  expect(io.stdout()).toContain("or a database of its own. Default: shared\n")
  expect(io.stdout()).toContain("The first tool is a change: prepared, then committed. Default: a read\n")
})

test("the error codes are exactly the codes the CLI's code can answer", async () => {
  const found = new Set<string>(Object.keys(choices).map(flag => `invalid-${flag}`))
  for await (const path of new Bun.Glob("**/*.ts").scan({ cwd: import.meta.dir })) {
    if (/(^|\/)test\/|\.test\.ts$|^(definitions|errors)\.ts$/.test(path)) continue
    const text = await Bun.file(`${import.meta.dir}/${path}`).text()
    for (const [, code] of text.matchAll(/(?:Refusal\(|refuse\(|code: )"([a-z]+(?:-[a-z]+)*)"/g)) found.add(code!)
  }
  expect([...found].sort()).toEqual([...errorCodes].sort())
  expect(new Set(errorCodes).size).toBe(errorCodes.length)
})
