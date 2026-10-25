import { defineProvider, withDatabase } from "@answerable/mcp"
import { z } from "zod"
import * as schema from "./pltfix"

// A fixture MCP with a database, as an MCP's tool files write it: its handlers reach pltfix through context.db.
const { defineTool, defineMutation } = withDatabase({ schema })

const notesCount = defineTool({
  name: "notes.count", description: "Count the notes of the caller's organisation, and say who the database serves them as. A fixture MCP.",
  input: z.object({}), output: z.object({ notes: z.number(), role: z.string() }), example: {},
  async execute(_input, { db }) {
    return { notes: await db.$count(schema.notes), role: String((await db.execute<{ role: string }>("select current_user::text as role")).rows[0]!.role) }
  },
})

const notesAdd = defineMutation({
  name: "notes.add", risk: "low", description: "Prepare adding a note to the caller's organisation; commit the intent to add it. A fixture MCP.",
  input: z.object({ title: z.string() }), output: z.object({ title: z.string() }), example: { title: "First" },
  async prepare({ title }) { return { targets: [], preview: { summary: `Add “${title}”`, changes: [{ path: "notes[]", to: title }] }, plan: { title } } },
  async commit({ plan }, { db, organisation }) {
    await db.insert(schema.notes).values({ organisation_id: organisation.id, title: plan.title })
    return { results: { title: plan.title }, applied_changes: [], effects_performed: [] }
  },
})

export const pltfix = defineProvider({
  id: "pltfix", description: "A fixture MCP with a database: the notes of the caller's organisation, in schema pltfix.", version: "2026-10-25",
  database: { schema, migrations: new URL("pltfix", import.meta.url) }, tools: [notesCount, notesAdd],
})
