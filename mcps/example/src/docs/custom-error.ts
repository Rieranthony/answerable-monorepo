// A snippet the docs include: typechecked and linted with this server, never served.
import { defineTool, ToolError } from "@answerable/mcp"
import { z } from "zod"

// Your search index.
declare const index: { ready: boolean; count(organizationId: string, word: string): number }

export const notesCount = defineTool({
  name: "notes.count",
  description: "Count your organisation's notes that contain a word. Use notes.list to read them.",
  input: z.object({ word: z.string().min(1).max(100).describe("The word to look for") }),
  output: z.object({ count: z.number().int() }),
  errors: ["EXAMPLE_INDEX_BUILDING"],
  async execute({ word }, { principal }) {
    if (!index.ready) {
      throw new ToolError("EXAMPLE_INDEX_BUILDING", "The search index is still building", { retry: { policy: "after_delay", after_ms: 60_000 } })
    }
    return { count: index.count(principal.organizationId, word) }
  },
})
