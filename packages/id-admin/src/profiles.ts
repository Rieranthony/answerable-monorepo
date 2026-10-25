import { ToolError, type Profile, type UserPrincipal } from "@answerable/mcp"
import { z } from "zod"
import { found, type IdAdmin } from "./index"

// The fields of ID's member and organisation reads that a profile needs (apps/id/openapi.admin.json).
const window = { validFrom: z.string().nullable(), validUntil: z.string().nullable() }
const memberRead = z.object({
  name: z.string(), email: z.string(), effective: z.boolean(),
  groups: z.array(z.object({ groupId: z.string(), slug: z.string(), name: z.string(), ...window })),
})
const organisationRead = z.object({ name: z.string(), slug: z.string() })
type Member = z.output<typeof memberRead>
// Whose an entry is, so that an invalidation finds it: the organisation, and for a member the user.
type Owner = { organisationId: string; userId?: string }
type Entry<Value> = Owner & { value: Value; expiresAt: number }

/** Who is calling, read from ID and cached: `createMcpServer`'s `profiles`, with `invalidate` for an audit-log poller. */
export type IdProfiles = ((principal: UserPrincipal) => Promise<Profile>) & {
  /** Read these organisations, and their members, from ID again on their next call, and these users in every organisation. */
  invalidate(organisationIds: Iterable<string>, userIds?: Iterable<string>): void
}

/**
 * Who is calling, for `createMcpServer`'s `profiles`: the member (`GET /organizations/{org}/members/{membershipId}`, the token's membership id is
 * the member id) and the organisation (`GET /organizations/{org}`), read from ID's admin API in parallel with the server's `platform:read` client.
 * Each read is cached for `ttlMs` (60 seconds), per member and per organisation; concurrent calls share one read. When ID does not answer, the last
 * value is served for up to `staleMs` (an hour) after it expired; with none, the call rejects and the server answers `UPSTREAM_UNAVAILABLE`.
 * `groups` are the member's groups in force now: `validFrom` unset or past, `validUntil` unset or future. A member who is not in force
 * (`effective: false`), or whom ID no longer knows (404), is refused with `PERMISSION_DENIED`, and never served from an old value. `invalidate(organisationIds, userIds)` takes the poller's events: an organisation
 * drops it and its members; a user, named by an event of no organisation, drops that user in every organisation.
 *
 * @example
 * ```ts
 * const id = createIdAdmin(config)
 * const profiles = createIdProfiles(id)
 * const server = createMcpServer({ provider, auth, profiles })
 * ```
 */
// ID answered that the member or the organisation does not exist: the token outlived them, so the call is refused, never retried.
function known<Value>(read: Value | undefined): Value {
  if (read === undefined) throw new ToolError("PERMISSION_DENIED", "Answerable ID has no such member of this organisation any more; ask an administrator of the organisation")
  return read
}

export function createIdProfiles(id: IdAdmin, { ttlMs = 60_000, staleMs = 3_600_000, now = Date.now }: { ttlMs?: number; staleMs?: number; now?: () => number } = {}): IdProfiles {
  const members = new Map<string, Entry<Member>>()
  const organisations = new Map<string, Entry<z.output<typeof organisationRead>>>()
  const pending = new Map<string, Promise<unknown>>()
  // The cached value while fresh; else one read shared by every caller, and the old value for its stale window when that read fails.
  async function cached<Value>(cache: Map<string, Entry<Value>>, key: string, owner: Owner, read: () => Promise<Value>) {
    const entry = cache.get(key)
    const at = now()
    if (entry && at < entry.expiresAt) return entry.value
    let reading = pending.get(key) as Promise<Value> | undefined
    if (!reading) {
      reading = read().then(value => {
        for (const [stored, { expiresAt }] of cache) if (expiresAt + staleMs <= at) cache.delete(stored)
        cache.set(key, { ...owner, value, expiresAt: now() + ttlMs })
        return value
      }).finally(() => pending.delete(key))
      pending.set(key, reading)
    }
    try {
      return await reading
    } catch (error) {
      // ID's own answer, such as no such member, is never covered by an old value; only ID not answering is.
      if (error instanceof ToolError || !entry || at >= entry.expiresAt + staleMs) throw error
      console.error("[id-admin] reading who is calling failed; serving what ID said before", error)
      return entry.value
    }
  }
  async function profiles({ organizationId, membershipId, userId }: UserPrincipal): Promise<Profile> {
    const [member, organisation] = await Promise.all([
      cached(members, `${organizationId}/${membershipId}`, { organisationId: organizationId, userId }, async () => memberRead.parse(known(await found(id.get(`/organizations/${organizationId}/members/${membershipId}`))))),
      cached(organisations, organizationId, { organisationId: organizationId }, async () => organisationRead.parse(known(await found(id.get(`/organizations/${organizationId}`))))),
    ])
    if (!member.effective) throw new ToolError("PERMISSION_DENIED", "Your membership of this organisation is not in force; ask an administrator of the organisation")
    const at = now()
    const inForce = ({ validFrom, validUntil }: Member["groups"][number]) => (validFrom === null || Date.parse(validFrom) <= at) && (validUntil === null || Date.parse(validUntil) > at)
    return {
      person: { name: member.name, email: member.email, groups: member.groups.filter(inForce).map(({ groupId, slug, name }) => ({ id: groupId, slug, name })) },
      organisation: { name: organisation.name, slug: organisation.slug },
    }
  }
  function invalidate(organisationIds: Iterable<string>, userIds: Iterable<string> = []) {
    const named = new Set(organisationIds)
    const users = new Set(userIds)
    const at = now()
    for (const cache of [members, organisations] as Map<string, Entry<unknown>>[]) {
      for (const entry of cache.values()) {
        if (named.has(entry.organisationId) || (entry.userId !== undefined && users.has(entry.userId))) entry.expiresAt = Math.min(entry.expiresAt, at)
      }
    }
  }
  return Object.assign(profiles, { invalidate })
}
