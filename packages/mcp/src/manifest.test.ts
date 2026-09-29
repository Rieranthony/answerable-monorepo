import { expect, test } from "bun:test"
import { z } from "zod"
import { defineMutation, definePrompt, defineProvider, defineResource, defineTool, manifest } from "./index"

const $schema = "https://json-schema.org/draft/2020-12/schema"
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const
const provider = defineProvider({
  id: "acme", version: "2026-09-29",
  tools: [
    defineTool({
      name: "records.list", title: "Records",
      description: "List your organisation's records, oldest first, twenty per page.",
      input: z.object({ limit: z.number().int().min(1).max(100).default(20).describe("Records per page"), cursor: z.string().optional() }),
      output: z.object({ items: z.array(z.object({ id: z.string() })), next_cursor: z.string().nullable(), has_more: z.boolean() }),
      async execute() { return { items: [], next_cursor: null, has_more: false } },
    }),
    defineTool({
      name: "identity.get", version: "2026-01-01", scopes: ["acme:identity"],
      description: "Read the signed-in person's identity and organisation.",
      deprecated: { since: "2026-09-29", sunset: "2027-09-29", replacement: "records.list" },
      input: z.object({}), output: z.object({ name: z.string() }),
      async execute() { return { name: "Ada" } },
    }),
  ],
  prompts: [definePrompt({ name: "guide", description: "How to use Acme", input: z.object({ topic: z.string() }), async execute() { return { messages: [] } } })],
  resources: [defineResource({ name: "notes", uri: "acme://notes", description: "Notes", mimeType: "text/markdown", scopes: ["acme:notes"], async read() { return "" } })],
})

test("the manifest is the provider's contract as plain JSON, tools sorted by identity", () => {
  expect(manifest(provider)).toEqual({
    id: "acme",
    version: "2026-09-29",
    tools: [
      {
        identity: "acme/identity.get", name: "identity_get", version: "2026-01-01", kind: "read",
        description: "Read the signed-in person's identity and organisation. Deprecated since 2026-09-29; removed on 2027-09-29; use records.list instead.",
        deprecated: { since: "2026-09-29", sunset: "2027-09-29", replacement: "records.list" },
        scopes: ["acme:identity"], annotations,
        input: { $schema, type: "object", properties: {}, additionalProperties: false },
        output: { $schema, type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
      },
      {
        identity: "acme/records.list", name: "records_list", version: "2026-09-29", kind: "read", title: "Records",
        description: "List your organisation's records, oldest first, twenty per page.",
        scopes: ["acme:read"], annotations,
        input: {
          $schema, type: "object", additionalProperties: false,
          properties: { limit: { default: 20, description: "Records per page", type: "integer", minimum: 1, maximum: 100 }, cursor: { type: "string" } },
        },
        output: {
          $schema, type: "object", additionalProperties: false, required: ["items", "next_cursor", "has_more"],
          properties: {
            items: { type: "array", items: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
            next_cursor: { type: ["string", "null"] },
            has_more: { type: "boolean" },
          },
        },
      },
    ],
    prompts: [{
      name: "guide", description: "How to use Acme", scopes: ["acme:read"],
      input: { $schema, type: "object", properties: { topic: { type: "string" } }, required: ["topic"] },
    }],
    resources: [{ name: "notes", uri: "acme://notes", description: "Notes", mime_type: "text/markdown", scopes: ["acme:notes"] }],
  })
})

test("the manifest carries no code", () => {
  const document = manifest(provider)
  expect(JSON.parse(JSON.stringify(document))).toEqual(document)
  expect(Object.keys(document.tools[1]!)).toEqual(["identity", "name", "version", "kind", "title", "description", "scopes", "annotations", "input", "output"])
})

test("a mutation carries its risk, effects and the schemas of its input and results, and the provider gains the two commit tools", () => {
  const plan = async () => ({ targets: [], preview: { summary: "Nothing" } })
  const document = manifest(defineProvider({
    id: "acme", version: "2026-09-29",
    tools: [
      defineMutation({
        name: "records.delete", effects: ["cascade_delete"], prepare: plan,
        async commit() { return { results: { deleted: true }, applied_changes: [], effects_performed: [] } },
        description: "Delete one of your organisation's records. Commit the intent with acme_commit_confirmed.",
        input: z.object({ id: z.string() }), output: z.object({ deleted: z.boolean() }),
      }),
      defineMutation({
        name: "records.create", title: "Create", risk: "low", scopes: ["acme:create"], prepare: plan,
        async commit() { return { results: { id: "r1" }, applied_changes: [], effects_performed: [] } },
        description: "Create a record in your organisation. Commit the intent with acme_commit.",
        input: z.object({ title: z.string() }), output: z.object({ id: z.string() }),
      }),
      provider.tools[0]!,
    ],
  }))
  expect(document.tools.map(({ identity, name, kind }) => [identity, name, kind])).toEqual([
    ["acme/commit", "acme_commit", "commit"],
    ["acme/commit_confirmed", "acme_commit_confirmed", "commit"],
    ["acme/records.create", "records_create", "mutate"],
    ["acme/records.delete", "records_delete", "mutate"],
    ["acme/records.list", "records_list", "read"],
  ])
  expect(document.tools[3]).toEqual({
    identity: "acme/records.delete", name: "records_delete", version: "2026-09-29", kind: "mutate",
    description: "Delete one of your organisation's records. Commit the intent with acme_commit_confirmed.",
    scopes: ["acme:write"], risk: "normal", effects: ["cascade_delete"], annotations,
    input: { $schema, type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    output: { $schema, type: "object", properties: { deleted: { type: "boolean" } }, required: ["deleted"], additionalProperties: false },
  })
  expect(Object.keys(document.tools[2]!)).toEqual(["identity", "name", "version", "kind", "title", "description", "scopes", "risk", "effects", "annotations", "input", "output"])
  const [commitTool, confirmedTool] = document.tools
  expect(Object.keys(commitTool!)).toEqual(["identity", "name", "kind", "description", "scopes", "annotations", "input", "output"])
  expect(commitTool).toMatchObject({
    description: expect.stringContaining("agent-class"), scopes: ["acme:create", "acme:write"],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    input: { required: ["intent_id", "commit_token"], additionalProperties: false },
    output: { required: ["receipt_id", "intent_id", "status", "results", "applied_changes", "effects_performed", "committed_at", "committed_by", "idempotent_replay"] },
  })
  expect(confirmedTool).toMatchObject({
    description: expect.stringContaining("preview_summary"), scopes: ["acme:create", "acme:write"],
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    input: { required: ["intent_id", "commit_token", "preview_summary"], additionalProperties: false },
  })
  expect(manifest(provider).tools.map(tool => tool.kind)).toEqual(["read", "read"])
})
