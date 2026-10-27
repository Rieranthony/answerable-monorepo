// records.create: a new record in the caller's organisation, prepared, then committed. Agent class: risk low.
import { z } from "zod"
import { recordSchema } from "../contracts"
import { records } from "../db/schema"
import { defineMutation } from "../mcp"
import { recordOf } from "../records"

export const recordsCreate = defineMutation({
  name: "records.create", risk: "low",
  description: "Prepare creating a test record in your organisation. Changes nothing: returns a preview and a commit token; commit the intent with the tool its commit_tool names to create the record.",
  input: z.object({ title: recordSchema.shape.title.describe("The record's title, 1 to 200 characters") }),
  output: recordSchema,
  example: { title: "Example" },
  async prepare({ title }) {
    return { targets: [], preview: { summary: `Create record “${title}”`, changes: [{ path: "records[]", from: null, to: { title } }] }, plan: { title } }
  },
  async commit({ plan }, { db, person, organisation }) {
    const [row] = await db.insert(records).values({ organisation_id: organisation.id, creator_id: person.id, title: plan.title }).returning()
    const record = recordOf(row!)
    return { results: record, applied_changes: [{ path: "records[]", from: null, to: record }], effects_performed: [] }
  },
})
