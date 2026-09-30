import { ToolError } from "@answerable/mcp"

/** One note, as the tools return it. */
export type Note = { id: string; text: string; created_at: string }

//#region store
/** Notes in memory, kept per organisation until the process stops. A real server keeps them in its database. */
export function createNoteStore() {
  const byOrganisation = new Map<string, Note[]>()
  return {
    /** A page of the organisation's notes, oldest first. The cursor is the id of the last note of the previous page. */
    list(organizationId: string, { limit, cursor }: { limit: number; cursor?: string }) {
      const notes = byOrganisation.get(organizationId) ?? []
      const start = cursor === undefined ? 0 : notes.findIndex(note => note.id === cursor) + 1
      if (cursor !== undefined && start === 0) throw new ToolError("INVALID_INPUT", "Unknown cursor; list again without one")
      const items = notes.slice(start, start + limit)
      const has_more = start + limit < notes.length
      return { items, next_cursor: has_more ? items.at(-1)!.id : null, has_more }
    },
    add(organizationId: string, text: string): Note {
      const note = { id: crypto.randomUUID(), text, created_at: new Date().toISOString() }
      byOrganisation.set(organizationId, [...(byOrganisation.get(organizationId) ?? []), note])
      return note
    },
  }
}
//#endregion
