import { createMcpServer, defineProvider, defineTool, defineView, definePrompt, defineResource, type IdVerifierConfig } from "@answerable/mcp"
import { z } from "zod"
import { recordsPage, recordsView } from "./contracts"
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
    return { messages: [{ role: "user", content: { type: "text", text: "Read fixture://guide. List my test records with records_list, following next_cursor until has_more is false, then open them with records_show." } }] }
  },
})

const fixtureGuide = defineResource({
  name: "fixture_guide", uri: "fixture://guide", description: "How to use the test MCP", mimeType: "text/markdown",
  async read() {
    return "# Test records\n\nRecords belong to your authenticated organisation. records_list returns 20 per page; pass next_cursor as cursor for the next. records_show opens the Apps view. This fixture uses synthetic data only."
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
    description: "Open your organisation's first 20 test records in an interactive view. Use records.list to read further pages.",
    input: z.object({}), output: recordsView,
    view: defineView({ name: "records", html: viewHtml }),
    async execute(_input, { principal }) {
      return { items: records.list(principal, { limit: 20 }).items }
    },
  })

  return defineProvider({
    id: "e2e", version: "2026-09-29",
    tools: [identityGet, recordsList, recordsShow],
    prompts: [fixtureWalkthrough], resources: [fixtureGuide],
  })
}

/** The e2e MCP server. */
export function createE2eMcp({ auth, ...dependencies }: { auth: IdVerifierConfig; records: RecordStore; viewHtml: string }) {
  return createMcpServer({ provider: createE2eProvider(dependencies), auth })
}
