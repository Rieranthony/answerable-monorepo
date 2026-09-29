import { expect, test } from "bun:test"
import { defineMutation, defineProvider, defineTool, type Mutation, type Served } from "@answerable/mcp"
import { z } from "zod"
import type { Catalogue } from "./catalogue"
import { allowed, ordered, policyClassOf, projectionOf } from "./projection"

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

test("an ordered provider lists its tools by domain then operation, and keeps each definition", () => {
  const sorted = ordered(provider)
  expect(sorted.tools.map(tool => tool.name)).toEqual(["identity.get", "records.delete", "records.get", "records.list"])
  for (const tool of sorted.tools) expect(tool).toBe(provider.tools.find(original => original.name === tool.name)!)
})

test("auto serves the direct projection while the granted tools number at most the direct limit, the meta projection above it; direct and meta are fixed", () => {
  expect(projectionOf({ projection: "auto", direct_limit: 40 }, 40)).toBe("direct")
  expect(projectionOf({ projection: "auto", direct_limit: 40 }, 41)).toBe("meta")
  expect(projectionOf({ projection: "auto", direct_limit: 0 }, 0)).toBe("direct")
  expect(projectionOf({ projection: "direct", direct_limit: 1 }, 500)).toBe("direct")
  expect(projectionOf({ projection: "meta", direct_limit: 40 }, 1)).toBe("meta")
})
