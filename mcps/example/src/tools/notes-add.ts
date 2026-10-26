// One tool = one thing the caller can do. Hosts call this tool example_notes_add in the Toolbox, notes_add alone.
//
// name: <domain>.<operation>, from the caller's side: notes.list, projects.search, rfis.create.
//   Never the vendor or the transport (sharepoint_query), never a mode switch (manage_notes).
//   Unique in this MCP; the CLI and defineProvider refuse a second one.
//
// description: the model reads only this to choose the tool. Say what it changes, that it prepares an intent to commit, when to use it
//   and its limits. 40 to 1,000 characters, with the word "prepare" or "intent" (the conformance kit checks it).
//   Good: "Prepare a new note on a project; commit it to save it. Use notes.list first to avoid duplicates."
//   Bad: "Adds notes."
//
// input and output: Zod objects. Describe every field (.describe("…")): hosts show it to the model. output is the receipt's results.
//
// risk: low lets the agent commit on its own; normal, the default, shows the person the preview's summary first; high needs a
//   person's approval.
//
// prepare: computes the preview and changes nothing. It checks the input, reads nothing that changes, and returns the summary the
//   person confirms, naming their organisation.
//
// commit: applies exactly what was prepared, from plan. Row-level security limits it to the caller's organisation, so it
//   sets organisation_id from organisation.id and filters on nothing by hand. Throw ToolError for a failure the caller can fix.
import { z } from "zod"
import * as schema from "../db/schema"
import { defineMutation } from "../mcp"

//#region add
export const notesAdd = defineMutation({
  name: "notes.add",
  description: "Prepare adding a note to your organisation. Changes nothing: returns a preview and a commit token; commit the intent with the tool its commit_tool names to add the note.",
  risk: "normal",
  input: z.object({ title: z.string().trim().min(1).max(200).describe("The title, 1 to 200 characters") }),
  output: z.object({ id: z.uuid(), title: z.string(), created_at: z.iso.datetime() }),
  example: { title: "First" },
  async prepare({ title }, { organisation }) {
    return {
      targets: [],
      preview: { summary: `Add “${title}” to the notes of ${organisation.name}`, changes: [{ path: "notes[]", to: { title } }] },
      plan: { title },
    }
  },
  async commit({ plan }, { db, organisation }) {
    const [row] = await db.insert(schema.notes).values({ organisation_id: organisation.id, title: plan.title }).returning()
    const added = { id: row!.id, title: row!.title, created_at: row!.created_at.toISOString() }
    return { results: added, applied_changes: [{ path: "notes[]", to: added }], effects_performed: [] }
  },
})
//#endregion
