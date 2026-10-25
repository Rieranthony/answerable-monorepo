// The prompt and the resource the e2e MCP serves beside its tools, each to a token with e2e:read.
import { definePrompt, defineResource } from "@answerable/mcp"
import { z } from "zod"

//#region prompt
export const fixtureWalkthrough = definePrompt({
  name: "fixture_walkthrough", description: "Walk through the test records",
  input: z.object({}),
  async execute() {
    return { messages: [{ role: "user", content: { type: "text", text: "Read fixture://guide. List my test records with records_list, following next_cursor until has_more is false, then open them with records_show. Create or delete a record only when I ask." } }] }
  },
})
//#endregion

//#region resource
export const fixtureGuide = defineResource({
  name: "fixture_guide", uri: "fixture://guide", description: "How to use the test MCP", mimeType: "text/markdown",
  async read() {
    return "# Test records\n\nRecords belong to your authenticated organisation. records_list returns 20 per page; pass next_cursor as cursor for the next. records_show opens the Apps view. records_create and records_delete prepare an intent and change nothing; commit it with the tool its commit_tool names (records_delete needs the person to confirm the preview's summary first). This fixture uses synthetic data only."
  },
})
//#endregion
