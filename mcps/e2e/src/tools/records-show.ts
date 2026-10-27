// records.show: the same page as records.list, in the MCP Apps view, which creates and deletes through the tools.
import { defineView } from "@answerable/mcp"
import { pageInput, recordsView } from "../contracts"
import { defineTool } from "../mcp"
import { listRecords } from "../records"
import { viewHtml } from "../view"

export const recordsShow = defineTool({
  name: "records.show", title: "Test records",
  description: "Open your organisation's test records in an interactive view, 20 per page by default, where you can also create and delete them. When has_more is true, pass next_cursor as cursor to show the next page.",
  input: pageInput, output: recordsView, example: {},
  view: defineView({ name: "records", html: viewHtml }),
  async execute(input, { db, principal }) {
    return { ...await listRecords(db, input), canWrite: principal.scopes.includes("e2e:write") }
  },
})
