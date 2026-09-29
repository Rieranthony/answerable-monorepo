import { ToolError, type UserPrincipal } from "@answerable/mcp"
import type { FixtureRecord } from "./contracts"

export type RecordStore = ReturnType<typeof createRecordStore>

const unknownCursor = "Unknown cursor; list again without one"

export function createRecordStore() {
  const organisations = new Map<string, Map<string, FixtureRecord>>()
  return {
    /** Oldest first. The cursor is the id of the last record returned. */
    list(principal: UserPrincipal, { limit, cursor }: { limit: number; cursor?: string }) {
      const all = [...(organisations.get(principal.organizationId)?.values() ?? [])]
      const start = cursor === undefined ? 0 : all.findIndex(record => record.id === cursor) + 1
      if (cursor !== undefined && !start) {
        throw new ToolError("INVALID_INPUT", `cursor: ${unknownCursor}`, { details: { field_violations: [{ field: "cursor", message: unknownCursor }] } })
      }
      const items = all.slice(start, start + limit)
      const has_more = start + limit < all.length
      return { items, next_cursor: has_more ? items.at(-1)!.id : null, has_more }
    },
    create(principal: UserPrincipal, title: string): FixtureRecord {
      const records = organisations.get(principal.organizationId) ?? new Map<string, FixtureRecord>()
      organisations.set(principal.organizationId, records)
      const record = { id: crypto.randomUUID(), organizationId: principal.organizationId, creatorId: principal.userId, title, createdAt: new Date().toISOString() }
      records.set(record.id, record)
      return record
    },
    remove(principal: UserPrincipal, recordId: string): { deleted: true; id: string } {
      if (!organisations.get(principal.organizationId)?.delete(recordId)) {
        throw new ToolError("NOT_FOUND", "No accessible record exists")
      }
      return { deleted: true, id: recordId }
    },
  }
}
