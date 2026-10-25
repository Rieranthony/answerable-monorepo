import { expect, test } from "bun:test"
import { inventory } from "./env-inventory"

const files = inventory()

test.each(Object.keys(files))("%s is what bun run env:inventory writes", async path => {
  expect(await Bun.file(new URL(`../${path}`, import.meta.url)).text(), `${path} drifted from the definitions: run bun run env:inventory`).toBe(files[path]!)
})

test("default.env and .env.example hold names with empty values, each once", () => {
  for (const path of ["default.env", ".env.example"]) {
    const assignments = files[path]!.split("\n").filter(line => line !== "" && !line.startsWith("#"))
    expect(assignments.filter(line => !/^[A-Z][A-Z0-9_]*=$/.test(line)), `${path} holds names with empty values only`).toEqual([])
    expect(assignments.filter((line, index) => assignments.indexOf(line) !== index)).toEqual([])
  }
})
