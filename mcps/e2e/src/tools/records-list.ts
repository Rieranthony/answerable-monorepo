// records.list: the caller's organisation's records, a page at a time.
import { pageInput, recordsPage } from "../contracts"
import { defineTool } from "../mcp"
import { listRecords } from "../records"

export const recordsList = defineTool({
  name: "records.list",
  description: "List your organisation's test records, oldest first, 20 per page by default and at most 100. When has_more is true, pass next_cursor as cursor to read the next page.",
  input: pageInput,
  output: recordsPage,
  example: { limit: 5 },
  async execute(input, { db }) {
    return listRecords(db, input)
  },
})
