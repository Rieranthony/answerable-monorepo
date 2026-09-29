import { expect, test } from "bun:test"
import { defineMutation, defineProvider, defineTool, type Mutation, type Served } from "@answerable/mcp"
import { z } from "zod"
import type { Catalogue } from "./catalogue"
import { allowed, measure, policyClassOf, project, truncation } from "./projection"

const read = (name: string) => defineTool({ name, description: "A fixture read that returns its name and changes nothing.", input: z.object({}), output: z.object({ name: z.string() }), async execute() { return { name } } })
const remove = defineMutation({
  name: "records.delete", description: "Prepare deleting a record: returns an intent and changes nothing.", input: z.object({}), output: z.object({}),
  async prepare() { return { targets: [], preview: { summary: "Delete" } } }, async commit() { return { results: {}, applied_changes: [], effects_performed: [] } },
})
const provider = defineProvider({ id: "e2e", version: "2026-09-29", tools: [read("records.list"), read("identity.get"), remove, read("records.get")] })
const enabled = (overrides: Partial<{ disabled: string[]; policy_class: Record<string, "agent" | "controlled" | "human"> }> = {}): Catalogue =>
  new Map([["e2e", { enabled: true, overrides: { disabled: [], policy_class: {}, ...overrides } }]])

test("a grant string covers a capability by provider, domain or identity, within an enabled provider and outside its disabled list", () => {
  const capability = { identity: "e2e/records.list" }
  for (const grants of [["e2e"], ["e2e/records"], ["e2e/records.list"], ["crm", "e2e/records"]]) expect(allowed(grants, enabled(), capability), grants.join()).toBe(true)
  for (const grants of [[], ["e2e/identity"], ["e2e/records.get"], ["e2e/record"], ["crm"], ["e2e/records.list.x"], ["toolbox/approve"]]) expect(allowed(grants, enabled(), capability), grants.join()).toBe(false)
  expect(allowed(["e2e"], new Map(), capability)).toBe(false)
  expect(allowed(["e2e"], new Map([["e2e", { enabled: false, overrides: { disabled: [], policy_class: {} } }]]), capability)).toBe(false)
  expect(allowed(["e2e"], enabled({ disabled: ["e2e/records.list"] }), capability)).toBe(false)
  expect(allowed(["e2e"], enabled({ disabled: ["e2e/records.list"] }), { identity: "e2e/records.get" })).toBe(true)
})

test("a mutation's policy class is the organisation's override, else the class its risk gives", () => {
  const mutation = provider.tools.find(tool => tool.kind === "mutate") as Served<Mutation>
  expect(policyClassOf(enabled(), mutation)).toBe("controlled")
  expect(policyClassOf(new Map(), mutation)).toBe("controlled")
  expect(policyClassOf(enabled({ policy_class: { "e2e/records.delete": "human" } }), mutation)).toBe("human")
})

test("a projected provider lists its tools by domain then operation, and each read also admits the truncation notice", async () => {
  const projected = project(provider)
  expect(projected.tools.map(tool => tool.name)).toEqual(["identity.get", "records.delete", "records.get", "records.list"])
  const list = projected.tools.find(tool => tool.name === "records.list")!
  expect(await list.output.parseAsync({ name: "x", extra: 1 })).toEqual({ name: "x" })
  expect(await list.output.parseAsync({ truncated: true, message: "Narrow it" })).toEqual({ truncated: true, message: "Narrow it" })
  expect(list.output["~standard"].jsonSchema.output({ target: "draft-2020-12" })).toMatchObject({ anyOf: [{ required: ["truncated", "message"] }, { required: ["name"] }] })
  expect(projected.tools.find(tool => tool.kind === "mutate")).toBe(provider.tools.find(tool => tool.kind === "mutate"))
})

test("a result is measured in bytes of JSON, and above 100 KiB it is too large for a read", () => {
  expect(measure({ items: ["x".repeat(100)] })).toEqual({ bytes: 114, tooLarge: false })
  expect(measure({ items: ["x".repeat(102_386)] })).toEqual({ bytes: 102_400, tooLarge: false })
  expect(measure({ items: ["é".repeat(52_000)] })).toEqual({ bytes: 104_014, tooLarge: true })
  expect(truncation).toEqual({ truncated: true, message: "Narrow the request with limit, cursor or filters." })
})
