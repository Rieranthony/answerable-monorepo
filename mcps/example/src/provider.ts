import { defineMutation, defineProvider, defineTool } from "@answerable/mcp"
import { z } from "zod"
import { createNoteStore } from "./notes"

const notes = createNoteStore()
const note = z.object({ id: z.uuid(), text: z.string(), created_at: z.iso.datetime() })

//#region list
const notesList = defineTool({
  name: "notes.list",
  description: "List your organisation's notes, oldest first, 20 per page by default and at most 100. When has_more is true, pass next_cursor as cursor to read the next page.",
  input: z.object({
    limit: z.number().int().min(1).max(100).default(20).describe("Notes per page, 1 to 100"),
    cursor: z.string().optional().describe("next_cursor from the previous page; omit it for the first page"),
  }),
  output: z.object({ items: z.array(note), next_cursor: z.string().nullable(), has_more: z.boolean() }),
  async execute(input, { principal }) {
    return notes.list(principal.organizationId, input)
  },
})
//#endregion

//#region add
const notesAdd = defineMutation({
  name: "notes.add",
  risk: "low",
  description: "Prepare adding a note to your organisation. Changes nothing: returns a preview and a commit token; commit the intent with the tool its commit_tool names to add the note.",
  input: z.object({ text: z.string().trim().min(1).max(200).describe("The note, 1 to 200 characters") }),
  output: note,
  async prepare({ text }) {
    return {
      targets: [],
      preview: { summary: `Add the note “${text}”`, changes: [{ path: "notes[]", to: { text } }] },
      plan: { text },
    }
  },
  async commit({ plan }, { principal }) {
    const added = notes.add(principal.organizationId, plan.text)
    return { results: added, applied_changes: [{ path: "notes[]", to: added }], effects_performed: [] }
  },
})
//#endregion

//#region provider
export const provider = defineProvider({ id: "example", version: "2026-09-30", tools: [notesList, notesAdd] })
//#endregion
