import { createMcpServer, defineMutation, defineProvider, defineTool, defineView, definePrompt, defineResource, type IdVerifierConfig, type IntentStore } from "@answerable/mcp"
import { z } from "zod"
import { recordSchema, recordsPage, recordsView } from "./contracts"
import type { RecordStore } from "./records"

const identityGet = defineTool({
  name: "identity.get",
  description: "Read your verified Answerable ID identity: your user id, the organisation you signed in to and the scopes your token carries.",
  input: z.object({}),
  output: z.object({ userId: z.uuid(), organizationId: z.uuid(), scopes: z.array(z.string()) }),
  scopes: ["e2e:identity"],
  async execute(_input, { principal }) {
    return { userId: principal.userId, organizationId: principal.organizationId, scopes: [...principal.scopes] }
  },
})

const fixtureWalkthrough = definePrompt({
  name: "fixture_walkthrough", description: "Walk through the test records",
  input: z.object({}),
  async execute() {
    return { messages: [{ role: "user", content: { type: "text", text: "Read fixture://guide. List my test records with records_list, following next_cursor until has_more is false, then open them with records_show. Create or delete a record only when I ask." } }] }
  },
})

const fixtureGuide = defineResource({
  name: "fixture_guide", uri: "fixture://guide", description: "How to use the test MCP", mimeType: "text/markdown",
  async read() {
    return "# Test records\n\nRecords belong to your authenticated organisation. records_list returns 20 per page; pass next_cursor as cursor for the next. records_show opens the Apps view. records_create and records_delete prepare an intent and change nothing; commit it with the tool its commit_tool names (records_delete needs the person to confirm the preview's summary first). This fixture uses synthetic data only."
  },
})

/** The e2e provider. Tools that need the record store are defined here and reach it by closure. */
export function createE2eProvider({ records, viewHtml }: { records: RecordStore; viewHtml: string }) {
  const recordsList = defineTool({
    name: "records.list",
    description: "List your organisation's test records, oldest first, 20 per page by default and at most 100. When has_more is true, pass next_cursor as cursor to read the next page.",
    input: z.object({
      limit: z.number().int().min(1).max(100).default(20).describe("Records per page, 1 to 100"),
      cursor: z.string().optional().describe("next_cursor from the previous page; omit it for the first page"),
    }),
    output: recordsPage,
    async execute(input, { principal }) {
      return records.list(principal, input)
    },
  })

  const recordsShow = defineTool({
    name: "records.show", title: "Test records",
    description: "Open your organisation's first 20 test records in an interactive view, where you can also create and delete them. Use records.list to read further pages.",
    input: z.object({}), output: recordsView,
    view: defineView({ name: "records", html: viewHtml }),
    async execute(_input, { principal }) {
      return { items: records.list(principal, { limit: 20 }).items, canWrite: principal.scopes.includes("e2e:write") }
    },
  })

  const recordsCreate = defineMutation({
    name: "records.create", risk: "low",
    description: "Prepare creating a test record in your organisation. Changes nothing: returns a preview and a commit token; commit the intent with e2e_commit to create the record.",
    input: z.object({ title: recordSchema.shape.title.describe("The record's title, 1 to 200 characters") }),
    output: recordSchema,
    async prepare({ title }) {
      return { targets: [], preview: { summary: `Create record “${title}”`, changes: [{ path: "records[]", from: null, to: { title } }] }, plan: { title } }
    },
    async commit({ plan }, { principal }) {
      const record = records.create(principal, plan.title)
      return { results: record, applied_changes: [{ path: "records[]", from: null, to: record }], effects_performed: [] }
    },
  })

  const recordsDelete = defineMutation({
    name: "records.delete",
    description: "Prepare deleting one of your organisation's test records by id. Changes nothing: returns a preview naming the record; show the person its summary, then commit the intent with e2e_commit_confirmed.",
    input: z.object({ id: z.uuid().describe("The record's id, from records.list") }),
    output: z.object({ deleted: z.literal(true), id: z.uuid() }),
    async prepare({ id }, { principal }) {
      const record = records.get(principal, id)
      return {
        targets: [{ resource_type: "record", resource_id: id, label: record.title, version: { kind: "serial", value: String(record.version) } }],
        preview: { summary: `Delete record “${record.title}”`, changes: [{ path: `records[${id}]`, from: record, to: null }] },
        plan: { id },
      }
    },
    // The target's version is unchanged, so the prepared change is the change applied.
    async commit({ plan, preview }, { principal }) {
      return { results: records.remove(principal, plan.id), applied_changes: preview.changes, effects_performed: [] }
    },
  })

  return defineProvider({
    id: "e2e", version: "2026-09-29",
    tools: [identityGet, recordsList, recordsShow, recordsCreate, recordsDelete],
    prompts: [fixtureWalkthrough], resources: [fixtureGuide],
  })
}

/** The e2e MCP server. Pass `intents` to control the intent store, for example its clock. */
export function createE2eMcp({ auth, intents, ...dependencies }: { auth: IdVerifierConfig; records: RecordStore; viewHtml: string; intents?: IntentStore }) {
  return createMcpServer({ provider: createE2eProvider(dependencies), auth, intents })
}
