// One tool = one thing the caller can do. Hosts call this tool example_notes_list in the Toolbox, notes_list alone.
//
// name: <domain>.<operation>, from the caller's side: notes.list, projects.search, rfis.create.
//   Never the vendor or the transport (sharepoint_query), never a mode switch (manage_notes).
//   Unique in this MCP; the CLI and defineProvider refuse a second one.
//
// description: the model reads only this to choose the tool. Say what it does, when to use it,
//   its limits (page size, what it cannot see) and what the ids mean. 40 to 1,000 characters.
//   Good: "List the notes of a project, newest first, 20 per page. Use projects.search first to find the project id."
//   Bad: "Gets notes."
//
// input and output: Zod objects. Describe every field (.describe("…")): hosts show it to the model.
//   A list takes limit and cursor and returns items, next_cursor and has_more (the conformance kit checks it).
//
// execute: gets the checked input and the caller: person, organisation and db. Row-level security limits every query to
//   the caller's organisation, so no query filters on it by hand. Throw ToolError for a failure the caller can fix.
import { desc, lt } from "drizzle-orm"
import { z } from "zod"
import * as schema from "../db/schema"
import { defineTool } from "../mcp"

//#region list
const item = z.object({
  id: z.uuid().describe("The row's id"),
  title: z.string(),
  created_at: z.iso.datetime().describe("When it was added"),
})

export const notesList = defineTool({
  name: "notes.list",
  description: "List your organisation's notes, newest first, 20 per page by default and at most 100. When has_more is true, pass next_cursor as cursor to read the next page.",
  input: z.object({
    limit: z.number().int().min(1).max(100).default(20).describe("Items per page, 1 to 100"),
    cursor: z.uuid().optional().describe("next_cursor from the previous page; omit it for the first page"),
  }),
  output: z.object({
    items: z.array(item).describe("Newest first"),
    next_cursor: z.uuid().nullable().describe("The cursor of the next page, or null on the last"),
    has_more: z.boolean(),
  }),
  example: { limit: 5 },
  //#region page
  async execute({ limit, cursor }, { db }) {
    const table = schema.notes
    const rows = await db.select().from(table).where(cursor ? lt(table.id, cursor) : undefined).orderBy(desc(table.id)).limit(limit + 1)
    const items = rows.slice(0, limit).map(row => ({ id: row.id, title: row.title, created_at: row.created_at.toISOString() }))
    const has_more = rows.length > limit
    return { items, next_cursor: has_more ? items.at(-1)!.id : null, has_more }
  },
  //#endregion
})
//#endregion
