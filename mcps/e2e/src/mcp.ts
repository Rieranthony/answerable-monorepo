import { createMcpServer, defineTool, defineView, definePrompt, defineResource, type IdVerifierConfig } from "@answerable/mcp"
import { z } from "zod"
import { createInput, deleteInput, recordSchema, recordsOutput, recordsViewOutput } from "./contracts"
import type { RecordStore } from "./records"

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }

const identityGet = defineTool({
  name: "identity_get",
  description: "Read your verified Answerable ID identity and permissions",
  input: z.object({}).strict(),
  output: z.object({ userId: z.uuid(), organizationId: z.uuid(), scopes: z.array(z.string()) }),
  scopes: ["e2e:identity"],
  annotations: readOnly,
  async execute(_input, { principal }) {
    return { userId: principal.userId, organizationId: principal.organizationId, scopes: [...principal.scopes] }
  },
})

const fixtureWalkthrough = definePrompt({
  name: "fixture_walkthrough", description: "Walk through safe test-record operations",
  input: z.object({}).strict(), scopes: ["e2e:read"],
  async execute() {
    return { messages: [{ role: "user", content: { type: "text", text: "Read fixture://guide. List records with records_list. If I ask to create a test record, use records_create and verify it with records_list. Only delete records I ask you to remove." } }] }
  },
})

const fixtureGuide = defineResource({
  name: "fixture_guide", uri: "fixture://guide", description: "How to use the test MCP",
  mimeType: "text/markdown", scopes: ["e2e:read"],
  async read() {
    return "# Test records\n\nRecords belong to your authenticated organisation. Creation and deletion require e2e:write. records_show opens the Apps view. This fixture uses synthetic data only."
  },
})

/** The e2e MCP. Tools that need the record store are defined here and reach it by closure. */
export function createE2eMcp({ auth, records, viewHtml }: { auth: IdVerifierConfig; records: RecordStore; viewHtml: string }) {
  const recordsList = defineTool({
    name: "records_list", description: "List up to 100 test records in your organisation",
    input: z.object({}).strict(), output: recordsOutput, scopes: ["e2e:read"], annotations: readOnly,
    async execute(_input, { principal }) {
      return { records: records.list(principal) }
    },
  })

  const recordsShow = defineTool({
    name: "records_show", description: "Open your organisation's interactive test records",
    input: z.object({}).strict(), output: recordsViewOutput, scopes: ["e2e:read"], annotations: readOnly,
    view: defineView({ name: "records", html: viewHtml }),
    async execute(_input, { principal }) {
      return { records: records.list(principal), canWrite: principal.scopes.includes("e2e:write") }
    },
  })

  const recordsCreate = defineTool({
    name: "records_create", description: "Create a test record",
    input: createInput, output: recordSchema, scopes: ["e2e:write"],
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async execute({ title }, { principal }) {
      return records.create(principal, title)
    },
  })

  const recordsDelete = defineTool({
    name: "records_delete", description: "Delete a test record",
    input: deleteInput, output: z.object({ deleted: z.literal(true), id: z.uuid() }), scopes: ["e2e:write"],
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    async execute({ recordId }, { principal }) {
      return records.remove(principal, recordId)
    },
  })

  return createMcpServer({
    name: "answerable-e2e", version: "0.1.0", auth,
    tools: [identityGet, recordsList, recordsShow, recordsCreate, recordsDelete],
    prompts: [fixtureWalkthrough], resources: [fixtureGuide],
  })
}
