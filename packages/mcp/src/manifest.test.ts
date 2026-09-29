import { expect, test } from "bun:test"
import { z } from "zod"
import { definePrompt, defineProvider, defineResource, defineTool, manifest } from "./index"

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
