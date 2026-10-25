// A snippet the docs include: typechecked and linted with this server, never served.
import { defineProvider, defineTool } from "@answerable/mcp"
import { z } from "zod"

type NoteCounter = { count(organizationId: string): Promise<number> }

// The server passes its database; a test passes an in-memory stand-in.
export function createNotesProvider({ notes }: { notes: NoteCounter }) {
  const notesTotal = defineTool({
    name: "notes.total",
    description: "Count your organisation's notes. Use notes.list to read them.",
    input: z.object({}),
    output: z.object({ total: z.number().int() }),
    example: {},
    async execute(_input, { principal }) {
      return { total: await notes.count(principal.organizationId) }
    },
  })
  return defineProvider({ id: "example", description: "Counts your organisation's notes, from a store the server or a test passes in.", version: "2026-09-30", tools: [notesTotal] })
}
