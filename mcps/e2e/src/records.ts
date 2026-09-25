import type { UserPrincipal } from "@answerable/auth"
import { ToolError } from "@answerable/mcp-base"
import type { FixtureRecord } from "./contracts"

export type RecordStore = ReturnType<typeof createRecordStore>

export function createRecordStore() {
  const organisations = new Map<string, Map<string, FixtureRecord>>()
  return {
    list(principal: UserPrincipal): FixtureRecord[] {
      return [...(organisations.get(principal.organizationId)?.values() ?? [])].slice(0, 100)
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
        throw new ToolError("record_not_found", "No accessible record exists")
      }
      return { deleted: true, id: recordId }
    },
  }
}
