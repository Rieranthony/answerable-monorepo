import { expect, test } from "bun:test"
import { z } from "zod"
import { defineMutation, definePrompt, defineProvider, defineResource, defineTool, defineView, type Mutation, type Tool } from "./index"

const description = "A fixture tool that returns nothing, used to test providers."
const tool = (name: string, extra: Partial<Pick<Tool, "version" | "scopes" | "view" | "deprecated" | "errors">> = {}) => defineTool({
  name, description, input: z.object({}), output: z.object({}), async execute() { return {} }, ...extra,
})
const mutation = (name: string, extra: Partial<Pick<Mutation, "version" | "scopes" | "deprecated" | "errors">> = {}) => defineMutation({
  name, description, input: z.object({}), output: z.object({}),
  async prepare() { return { targets: [], preview: { summary: "Nothing" } } },
  async commit() { return { results: {}, applied_changes: [], effects_performed: [] } },
  ...extra,
})
const prompt = definePrompt({ name: "guide", description: "Guide", input: z.object({}), async execute() { return { messages: [] } } })
const resource = defineResource({ name: "notes", uri: "fixture://notes", description: "Notes", mimeType: "text/plain", async read() { return "" } })

test("fills each definition's identity, version and scopes and freezes the result", () => {
  const provider = defineProvider({
    id: "acme", version: "2026-09-29",
    tools: [tool("records.list"), tool("identity.get", { version: "2026-01-01", scopes: ["acme:identity"] })],
    prompts: [prompt], resources: [resource],
  })
  expect(provider).toMatchObject({ id: "acme", version: "2026-09-29" })
  expect(provider.tools.map(({ name, identity, version, scopes }) => ({ name, identity, version, scopes }))).toEqual([
    { name: "records.list", identity: "acme/records.list", version: "2026-09-29", scopes: ["acme:read"] },
    { name: "identity.get", identity: "acme/identity.get", version: "2026-01-01", scopes: ["acme:identity"] },
  ])
  expect(provider.prompts[0]).toMatchObject({ name: "guide", scopes: ["acme:read"] })
  expect(provider.resources[0]).toMatchObject({ name: "notes", scopes: ["acme:read"] })
  for (const value of [provider, provider.tools, provider.prompts, provider.resources, ...provider.tools, ...provider.prompts, ...provider.resources, provider.tools[0]!.scopes]) {
    expect(Object.isFrozen(value)).toBe(true)
  }
  expect(defineProvider({ id: "acme", version: "2026-09-29", tools: [] })).toEqual({ id: "acme", version: "2026-09-29", tools: [], prompts: [], resources: [] })
})

test("ids are a lowercase letter then up to 11 letters or digits, and the version is a date", () => {
  for (const id of ["Acme", "acme-co", "1acme", "", "abcdefghijklm"]) {
    expect(() => defineProvider({ id, version: "2026-09-29", tools: [] })).toThrow(`Provider id "${id}" must be a lowercase letter then up to 11 lowercase letters or digits, for example acme`)
  }
  expect(defineProvider({ id: "abcdefghijkl", version: "2026-09-29", tools: [] }).id).toBe("abcdefghijkl")
  for (const version of ["0.1.0", "2026-13-01", "20260929"]) {
    expect(() => defineProvider({ id: "acme", version, tools: [] })).toThrow(`Provider acme: version "${version}" must be a date, YYYY-MM-DD`)
  }
})

test("refuses duplicate tools, prompts and resource URIs, and conflicting views", () => {
  const base = { id: "acme", version: "2026-09-29" }
  expect(() => defineProvider({ ...base, tools: [tool("records.list"), tool("records.list", { version: "2026-01-01" })] })).toThrow("Provider acme defines tool records.list twice")
  expect(() => defineProvider({ ...base, tools: [], prompts: [prompt, prompt] })).toThrow("Provider acme defines prompt guide twice")
  expect(() => defineProvider({ ...base, tools: [], resources: [resource, resource] })).toThrow("Provider acme defines resource fixture://notes twice")
  const view = defineView({ name: "records", html: "<title>Records</title>" })
  const other = defineView({ name: "records", html: "<title>Other</title>" })
  expect(() => defineProvider({ ...base, tools: [tool("records.show", { view })], resources: [{ ...resource, uri: view.uri }] })).toThrow(`Provider acme defines resource ${view.uri} twice`)
  expect(() => defineProvider({ ...base, tools: [tool("records.show", { view }), tool("records.open", { view: other })] })).toThrow(`Provider acme defines two different views at ${view.uri}`)
  expect(defineProvider({ ...base, tools: [tool("records.show", { view }), tool("records.open", { view })] }).tools).toHaveLength(2)
})

test("a deprecated tool names a current tool of the provider as its replacement", () => {
  const base = { id: "acme", version: "2026-09-29" }
  const deprecated = { since: "2026-09-29", sunset: "2027-09-29", replacement: "records.search" }
  const old = tool("records.find", { deprecated })
  expect(defineProvider({ ...base, tools: [old, tool("records.search")] }).tools[0]!.deprecated).toEqual(deprecated)
  expect(defineProvider({ ...base, tools: [tool("records.find", { deprecated: { since: "2026-09-29", sunset: "2027-09-29" } })] }).tools).toHaveLength(1)
  const refusal = "Provider acme: tool records.find is deprecated in favour of records.search, which is not a current tool of this provider"
  expect(() => defineProvider({ ...base, tools: [old] })).toThrow(refusal)
  expect(() => defineProvider({ ...base, tools: [old, tool("records.search", { deprecated: { ...deprecated, replacement: "records.find" } })] })).toThrow(refusal)
})

test("mutations join the tools: <id>:write by default, and the same identity, duplicate and deprecation rules", () => {
  const base = { id: "acme", version: "2026-09-29" }
  const provider = defineProvider({ ...base, tools: [tool("records.list"), mutation("records.delete"), mutation("records.create", { version: "2026-01-01", scopes: ["acme:create"] })] })
  expect(provider.tools.map(({ name, kind, identity, version, scopes }) => ({ name, kind, identity, version, scopes }))).toEqual([
    { name: "records.list", kind: "read", identity: "acme/records.list", version: "2026-09-29", scopes: ["acme:read"] },
    { name: "records.delete", kind: "mutate", identity: "acme/records.delete", version: "2026-09-29", scopes: ["acme:write"] },
    { name: "records.create", kind: "mutate", identity: "acme/records.create", version: "2026-01-01", scopes: ["acme:create"] },
  ])
  expect(() => defineProvider({ ...base, tools: [tool("records.delete"), mutation("records.delete")] })).toThrow("Provider acme defines tool records.delete twice")
  const deprecated = { since: "2026-09-29", sunset: "2027-09-29", replacement: "records.delete" }
  expect(defineProvider({ ...base, tools: [mutation("records.remove", { deprecated }), mutation("records.delete")] }).tools).toHaveLength(2)
  expect(() => defineProvider({ ...base, tools: [mutation("records.remove", { deprecated })] })).toThrow("Provider acme: tool records.remove is deprecated in favour of records.delete, which is not a current tool of this provider")
})

test("a declared error starts with the provider's id in capitals", () => {
  const base = { id: "acme", version: "2026-09-29" }
  const locked = { errors: ["ACME_LOCKED"] }
  expect(defineProvider({ ...base, tools: [tool("records.list", locked), mutation("records.delete", locked)] }).tools.map(({ errors }) => errors)).toEqual([["ACME_LOCKED"], ["ACME_LOCKED"]])
  expect(defineProvider({ id: "e2e", version: "2026-09-29", tools: [tool("records.list", { errors: ["E2E_LOCKED"] })] }).tools).toHaveLength(1)
  for (const code of ["OTHER_LOCKED", "ACMEX_LOCKED"]) {
    expect(() => defineProvider({ ...base, tools: [tool("records.list", { errors: [code] })] })).toThrow(`Provider acme: records.list declares error "${code}"; a custom code of this provider starts with ACME_`)
    expect(() => defineProvider({ ...base, tools: [mutation("records.delete", { errors: [code] })] })).toThrow(`Provider acme: records.delete declares error "${code}"; a custom code of this provider starts with ACME_`)
  }
})
