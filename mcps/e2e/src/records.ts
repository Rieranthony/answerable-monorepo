import { ToolError, type UserPrincipal } from "@answerable/mcp"
import type { FixtureRecord } from "./contracts"

export type RecordStore = ReturnType<typeof createRecordStore>

const unknownCursor = "Unknown cursor; list again without one"

export function createRecordStore() {
  const organisations = new Map<string, Map<string, FixtureRecord>>()
  const records = (principal: UserPrincipal) => organisations.get(principal.organizationId) ?? new Map<string, FixtureRecord>()
  function get(principal: UserPrincipal, id: string) {
    const record = records(principal).get(id)
    if (!record) throw new ToolError("NOT_FOUND", "No accessible record exists")
    return record
  }
  return {
    get,
    /** Oldest first. The cursor is the id of the last record returned. */
    list(principal: UserPrincipal, { limit, cursor }: { limit: number; cursor?: string }) {
      const all = [...records(principal).values()]
      const start = cursor === undefined ? 0 : all.findIndex(record => record.id === cursor) + 1
      if (cursor !== undefined && !start) {
        throw new ToolError("INVALID_INPUT", `cursor: ${unknownCursor}`, { details: { field_violations: [{ field: "cursor", message: unknownCursor }] } })
      }
      const items = all.slice(start, start + limit)
      const has_more = start + limit < all.length
      return { items, next_cursor: has_more ? items.at(-1)!.id : null, has_more }
    },
    create(principal: UserPrincipal, title: string): FixtureRecord {
      const organisation = records(principal)
      organisations.set(principal.organizationId, organisation)
      const record = { id: crypto.randomUUID(), organizationId: principal.organizationId, creatorId: principal.userId, title, createdAt: new Date().toISOString(), version: 1 }
      organisation.set(record.id, record)
      return record
    },
    remove(principal: UserPrincipal, id: string): { deleted: true; id: string } {
      get(principal, id)
      records(principal).delete(id)
      return { deleted: true, id }
    },
    /** A change made outside the MCP: the record's version moves, as another writer's edit would move it. */
    touch(principal: UserPrincipal, id: string): FixtureRecord {
      const record = { ...get(principal, id) }
      record.version++
      records(principal).set(id, record)
      return record
    },
  }
}
