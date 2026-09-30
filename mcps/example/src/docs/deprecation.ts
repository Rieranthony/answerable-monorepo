// A snippet the docs include: typechecked and linted with this server, never served.
import { defineTool } from "@answerable/mcp"
import { z } from "zod"

export const notesRecent = defineTool({
  name: "notes.recent",
  description: "List your organisation's five newest notes. Use notes.list instead, which pages through every note.",
  input: z.object({}),
  output: z.object({ texts: z.array(z.string()) }),
  deprecated: { since: "2026-09-30", sunset: "2027-09-30", replacement: "notes.list" },
  async execute() {
    return { texts: [] }
  },
})
