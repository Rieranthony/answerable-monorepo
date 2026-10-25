// The records table as the tools read it: a row in the shape the tools return, one record, and a page of them.
import { ToolError, type DatabaseContext } from "@answerable/mcp"
import { asc, eq, gt } from "drizzle-orm"
import { z } from "zod"
import type { FixtureRecord } from "./contracts"
import * as schema from "./db/schema"

type Database = DatabaseContext<typeof schema>["db"]
const { records } = schema
const unknownCursor = "Unknown cursor; list again without one"
const id = z.uuid()

/** A row as the tools return it. */
export const recordOf = (row: typeof records.$inferSelect): FixtureRecord => ({
  id: row.id, organizationId: row.organisation_id, creatorId: row.creator_id, title: row.title, createdAt: row.created_at.toISOString(), version: row.version,
})

/** The caller's record `recordId`; `NOT_FOUND` when their organisation has none by that id. */
export async function getRecord(db: Database, recordId: string) {
  const [row] = id.safeParse(recordId).success ? await db.select().from(records).where(eq(records.id, recordId)) : []
  if (!row) throw new ToolError("NOT_FOUND", "No accessible record exists")
  return recordOf(row)
}

/** A page of the caller's records, oldest first. The cursor is the id of the page before's last record, which must still be there. */
export async function listRecords(db: Database, { limit, cursor }: { limit: number; cursor?: string }) {
  if (cursor !== undefined && !(await getRecord(db, cursor).then(() => true, () => false))) {
    throw new ToolError("INVALID_INPUT", `cursor: ${unknownCursor}`, { details: { field_violations: [{ field: "cursor", message: unknownCursor }] } })
  }
  const rows = await db.select().from(records).where(cursor === undefined ? undefined : gt(records.id, cursor)).orderBy(asc(records.id)).limit(limit + 1)
  const items = rows.slice(0, limit).map(recordOf)
  const has_more = rows.length > limit
  return { items, next_cursor: has_more ? items.at(-1)!.id : null, has_more }
}
