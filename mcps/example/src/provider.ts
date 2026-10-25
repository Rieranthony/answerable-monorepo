// The example MCP: what it is for, its version and its tools. bun mcp add tool adds a tool above each "bun mcp: tools" line.
import { defineProvider } from "@answerable/mcp"
import { database } from "./mcp"
import { exampleStatus } from "./tools/example-status"
import { notesList } from "./tools/notes-list"
import { notesAdd } from "./tools/notes-add"
// bun mcp: tools

//#region provider
export const provider = defineProvider({
  id: "example",
  description: "Your organisation's notes: list them a page at a time, and add one. The finished quickstart of the MCP docs.",
  version: "2026-10-25",
  database,
  tools: [
    exampleStatus,
    notesList,
    notesAdd,
    // bun mcp: tools
  ],
})
//#endregion
