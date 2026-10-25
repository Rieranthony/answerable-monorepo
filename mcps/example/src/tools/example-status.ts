// One tool = one thing the caller can do. Hosts call this tool example_example_status in the Toolbox, example_status alone.
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
// execute: gets the checked input and the caller: person, organisation and db. Row-level security (D19) limits every query to
//   the caller's organisation, so no query filters on it by hand. Throw ToolError for a failure the caller can fix.
import { z } from "zod"
import { defineTool } from "../mcp"

export const exampleStatus = defineTool({
  name: "example.status",
  description: "Report that example is running and who is calling: your name and your organisation's. Replace it with the MCP's first real tool.",
  input: z.object({}),
  output: z.object({
    status: z.string().describe("ok while the MCP runs"),
    person: z.string().describe("Your name"),
    organisation: z.string().describe("Your organisation's name"),
  }),
  example: {},
  async execute(_input, { person, organisation }) {
    return { status: "ok", person: person.name, organisation: organisation.name }
  },
})
