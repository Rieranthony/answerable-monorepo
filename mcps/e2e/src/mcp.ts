import { createMcpApp, defineTool, defineView, definePrompt, defineResource, type ToolContext } from "@answerable/mcp-base"
import type { IdVerifierConfig } from "@answerable/auth"
import { z } from "zod"
import { createInput, deleteInput, recordSchema, recordsOutput } from "./contracts"
import type { RecordStore } from "./services/records"

type Services = { records: RecordStore }
type Context = ToolContext<Services>
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false }

export const identityGet = defineTool({
  name: "identity_get",
  description: "Read your verified Answerable ID identity and permissions",
  input: z.object({}).strict(),
  output: z.object({ userId: z.uuid(), organizationId: z.uuid(), scopes: z.array(z.string()) }),
  scopes: ["e2e:identity"],
  annotations: readOnly,
  async execute(_input, context: Context) {
    const { userId, organizationId, scopes } = context.principal
    return { data: { userId, organizationId, scopes: [...scopes] }, text: `Authenticated in organisation ${organizationId}` }
  },
})

export const recordsList = defineTool({
  name: "records_list", description: "List up to 100 test records in your organisation",
  input: z.object({}).strict(), output: recordsOutput, scopes: ["e2e:read"], annotations: readOnly,
  async execute(_input, context: Context) {
    const records = context.services.records.list(context.principal)
    return { data: { records }, text: `${records.length} test records` }
  },
})

export const recordsGet = defineTool({
  name: "records_get", description: "Read one test record in your organisation",
  input: z.object({ recordId: z.uuid() }).strict(), output: recordSchema, scopes: ["e2e:read"], annotations: readOnly,
  async execute(input, context: Context) {
    const record = context.services.records.get(context.principal, input.recordId)
    return { data: record, text: record.title }
  },
})

export const recordsCreate = defineTool({
  name: "records_create", description: "Create a test record. Reuse the operation key when retrying an uncertain result.",
  input: createInput, output: recordSchema, scopes: ["e2e:write"],
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async execute(input, context: Context) {
    const record = context.services.records.create(context.principal, input)
    return { data: record, text: `Created ${record.title}` }
  },
})

export const recordsDelete = defineTool({
  name: "records_delete", description: "Delete a test record. Reuse the operation key when retrying an uncertain result.",
  input: deleteInput, output: z.object({ deleted: z.literal(true), id: z.uuid() }), scopes: ["e2e:write"],
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  async execute(input, context: Context) {
    return { data: context.services.records.remove(context.principal, input), text: "Deleted the test record" }
  },
})

export const fixtureWalkthrough = definePrompt({
  name: "fixture_walkthrough", description: "Walk through safe test-record operations",
  input: z.object({}).strict(), scopes: ["e2e:read"],
  async execute() {
    return { messages: [{ role: "user", content: { type: "text", text: "Read fixture://guide. List records with records_list. If I ask to create a test record, use records_create with a fresh operation key and verify it with records_get. Reuse the key and input after an uncertain response. Only delete records I ask you to remove." } }] }
  },
})

export const fixtureGuide = defineResource({
  name: "fixture_guide", uri: "fixture://guide", description: "How to use the test MCP",
  mimeType: "text/markdown", scopes: ["e2e:read"],
  async read() {
    return "# Test records\n\nRecords belong to your authenticated organisation. Creation and deletion require e2e:write. Supply an operation key for each intended change; retry with the same key and input after an uncertain response. records_show opens the Apps view. This fixture uses synthetic data only."
  },
})

export function createE2eMcp(config: {
  auth: IdVerifierConfig
  viewHtml: string
  records: RecordStore
  readOnly?: boolean
  allowedHosts?: string[]
  allowedOrigins?: string[]
}) {
  const view = defineView({ name: "records", html: config.viewHtml })
  const recordsShow = defineTool({
    name: "records_show", description: "Open your organisation's interactive test records",
    input: z.object({}).strict(), output: recordsOutput, scopes: ["e2e:read"], view, annotations: readOnly,
    async execute(_input, context: Context) {
      const records = context.services.records.list(context.principal)
      return { data: { records }, text: `${records.length} test records` }
    },
  })
  return createMcpApp({
    name: "answerable-e2e", version: "0.1.0", auth: config.auth,
    services: { records: config.records }, allowedHosts: config.allowedHosts, allowedOrigins: config.allowedOrigins,
    prompts: [fixtureWalkthrough], resources: [fixtureGuide],
    tools: [identityGet, recordsList, recordsGet, recordsShow, ...(config.readOnly ? [] : [recordsCreate, recordsDelete])],
  })
}
