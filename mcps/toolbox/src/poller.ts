import { pages, type IdAdmin } from "@answerable/id-admin"
import { z } from "zod"
import type { GrantsReader } from "./grants"

const page = z.object({
  items: z.array(z.object({ id: z.string(), action: z.string(), organizationId: z.string().nullable(), targetId: z.string().nullable() })),
  nextCursor: z.string().nullable(),
})
/** The audit actions, by prefix, that can change what a member of the event's organisation may use: a capability is the organisation's ceiling. */
export const organisationActions = ["capability.", "entitlement.", "group_member.", "group.", "member.", "organization."]
/** The audit actions on a person's account, such as `user.disabled` and `user.erased`: they name no organisation, and the user as their target. */
export const userActions = ["user."]

/**
 * Read ID's audit log every `intervalMs` (15 seconds), newest first, back to the last event seen, and invalidate the grants of every
 * organisation a capability, entitlement, group, group member, member or organisation event names, and of every user a user event names,
 * in every organisation. The first poll only records the newest event. Polls run one at a time; a failed poll is logged and the next one catches up.
 */
export function startGrantsPoller({ id, grants, intervalMs = 15_000 }: { id: IdAdmin; grants: GrantsReader; intervalMs?: number }) {
  let last: string | undefined
  let busy = false
  let running = Promise.resolve()
  // Add what the events since the last one seen name to `organisations` and `users`, newest first, and answer the newest event's id.
  async function read(organisations: Set<string>, users: Set<string>) {
    let newest: string | undefined
    for await (const items of pages("/audit-events", async path => page.parse(await id.get(path)))) {
      for (const event of items) {
        newest ??= event.id
        // Audit event ids are UUIDv7, so they sort by time.
        if (last === undefined || event.id <= last) return newest
        if (event.organizationId && organisationActions.some(prefix => event.action.startsWith(prefix))) organisations.add(event.organizationId)
        if (event.targetId && userActions.some(prefix => event.action.startsWith(prefix))) users.add(event.targetId)
      }
    }
    return newest
  }
  async function once() {
    busy = true
    try {
      const organisations = new Set<string>()
      const users = new Set<string>()
      last = await read(organisations, users) ?? last ?? ""
      grants.invalidate(organisations, users)
    } catch (error) {
      console.error("[toolbox] reading ID's audit log failed", error)
    } finally {
      busy = false
    }
  }
  const poll = () => (running = running.then(once))
  // One poll now and one every intervalMs, none while one runs.
  const tick = () => { if (!busy) void poll() }
  const timer = setInterval(tick, intervalMs)
  tick()
  return {
    /** Poll now, after any poll in progress. */
    poll,
    stop: () => clearInterval(timer),
  }
}
