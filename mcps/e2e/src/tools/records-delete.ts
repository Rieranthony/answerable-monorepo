// records.delete: one of the caller's records, prepared with its version as the target, then committed with the person's confirmation.
import { eq } from "drizzle-orm"
import { z } from "zod"
import { records } from "../db/schema"
import { defineMutation } from "../mcp"
import { getRecord } from "../records"

//#region delete
export const recordsDelete = defineMutation({
  name: "records.delete",
  description: "Prepare deleting one of your organisation's test records by id. Changes nothing: returns a preview naming the record; show the person its summary, then commit the intent with the tool its commit_tool names.",
  input: z.object({ id: z.uuid().describe("The record's id, from records.list") }),
  output: z.object({ deleted: z.literal(true), id: z.uuid() }),
  async prepare({ id }, { db }) {
    const record = await getRecord(db, id)
    return {
      targets: [{ resource_type: "record", resource_id: id, label: record.title, version: { kind: "serial", value: String(record.version) } }],
      preview: { summary: `Delete record “${record.title}”`, changes: [{ path: `records[${id}]`, from: record, to: null }] },
      plan: { id },
    }
  },
  // The target's version is unchanged, so the prepared change is the change applied.
  async commit({ plan, preview }, { db }) {
    await db.delete(records).where(eq(records.id, plan.id))
    return { results: { deleted: true as const, id: plan.id }, applied_changes: preview.changes, effects_performed: [] }
  },
})
//#endregion
