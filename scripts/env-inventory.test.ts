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

test("a variable whose deployed value comes from the image is one an image sets", async () => {
  // Every ENV instruction's names, continuation lines joined.
  const set = new Set<string>()
  for (const dockerfile of ["apps/id/Dockerfile", "mcps/Dockerfile", "infra/ops/Dockerfile"]) {
    const text = (await Bun.file(new URL(`../${dockerfile}`, import.meta.url)).text()).replace(/\\\n/g, " ")
    for (const [, assignments] of text.matchAll(/^ENV\s+(.+)$/gm)) for (const [, name] of assignments!.matchAll(/([A-Z][A-Z0-9_]*)=/g)) set.add(name!)
  }
  const groups = JSON.parse(files["packages/config/inventory.json"]!) as { fields: { name: string; source?: string }[] }[]
  const fromImage = [...new Set(groups.flatMap(group => group.fields).filter(field => field.source === "image").map(field => field.name))]
  expect(fromImage.filter(name => !set.has(name))).toEqual([])
})
