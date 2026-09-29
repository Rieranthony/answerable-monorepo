import { z } from "zod"
import type { GrantsReader } from "./grants"
import { createIdAdmin, type IdConfig } from "./id"

const page = z.object({
  items: z.array(z.object({ id: z.string(), action: z.string(), organizationId: z.string().nullable() })),
  nextCursor: z.string().nullable(),
})
// Actions that can change what a member of the event's organisation may use.
const changes = ["entitlement.", "group_member.", "group.", "member.", "organization."]

/**
 * Read ID's audit log every `intervalMs` (15 seconds), newest first, back to the last event seen, and invalidate the grants of every
 * organisation an entitlement, group, group member, member or organisation event names. The first poll only records the newest event.
 * Polls run one at a time; a failed poll is logged and the next one catches up.
 */
export function startGrantsPoller({ id, grants, intervalMs = 15_000 }: { id: IdConfig; grants: GrantsReader; intervalMs?: number }) {
  const admin = createIdAdmin(id)
  let last: string | undefined
  let busy = false
  let running = Promise.resolve()
  async function once() {
    busy = true
    try {
      const organisations = new Set<string>()
      let newest: string | undefined
      let cursor: string | null = null
      pages: do {
        const { items, nextCursor } = page.parse(await admin.get(`/audit-events?limit=200${cursor ? `&cursor=${cursor}` : ""}`))
        for (const event of items) {
          newest ??= event.id
          // Audit event ids are UUIDv7, so they sort by time.
          if (last === undefined || event.id <= last) break pages
          if (event.organizationId && changes.some(prefix => event.action.startsWith(prefix))) organisations.add(event.organizationId)
        }
        cursor = nextCursor
      } while (cursor)
      last = newest ?? last ?? ""
      grants.invalidate(organisations)
    } catch (error) {
      console.error("[toolbox] reading ID's audit log failed", error)
    } finally {
      busy = false
    }
  }
  const poll = () => (running = running.then(once))
  const timer = setInterval(() => { if (!busy) void poll() }, intervalMs)
  void poll()
  return {
    /** Poll now, after any poll in progress. */
    poll,
    stop: () => clearInterval(timer),
  }
}
