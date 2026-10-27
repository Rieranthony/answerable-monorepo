import { afterAll, beforeAll, expect, test } from "bun:test"
import { main } from "./cli"
import { definitions, exitCodes } from "./definitions"
import { tempRepository, testIo } from "./test/io"

let repository: Awaited<ReturnType<typeof tempRepository>>
beforeAll(async () => { repository = await tempRepository() })
afterAll(() => repository.remove())

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

test("a flag's default is shown by help, after its description", async () => {
  const io = testIo(["new", "--help"], repository.root)
  expect(await main(io.io)).toBe(0)
  expect(io.stdout()).toContain("or a database of its own. Default: shared\n")
  expect(io.stdout()).toContain("The first tool is a change: prepared, then committed. Default: a read\n")
})
