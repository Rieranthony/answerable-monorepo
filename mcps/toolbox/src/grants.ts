import { found, type IdAdmin } from "@answerable/id-admin"
import { ToolError, type Provider, type UserPrincipal } from "@answerable/mcp"
import { z } from "zod"

const grantForm = /^([a-z][a-z0-9]{0,11})(\/[a-z][a-z0-9]{0,15}(\.[a-z][a-z0-9]{0,15})?)?$/

/** Whether an entitlement scope is a grant string: a provider (`e2e`), a domain (`e2e/records`), a capability (`e2e/records.list`), `toolbox/approve` or `toolbox/code`. */
export const isGrant = (scope: string) => scope === "toolbox/approve" || scope === "toolbox/code" || (scope !== "toolbox" && grantForm.test(scope))

/** The Toolbox resource's `allowedScopes` in ID: `toolbox`, `offline_access`, `toolbox/approve` and every grant string of the mounted providers. */
export function allowedScopes(providers: readonly Provider[]) {
  const scopes = new Set(["offline_access", "toolbox", "toolbox/approve"])
  for (const { id, tools } of providers) {
    scopes.add(id)
    for (const { name } of tools) scopes.add(`${id}/${name.split(".")[0]}`).add(`${id}/${name}`)
  }
  return [...scopes].sort()
}

const accessView = z.object({ targets: z.array(z.object({ kind: z.string(), id: z.string(), resource: z.string().optional(), scopes: z.array(z.string()) })) })
type Entry = { userId: string; version: number; grants: readonly string[]; expiresAt: number; stale: boolean }

/** A member's grant strings, read from ID and cached. */
export type GrantsReader = {
  /** The caller's grant strings, sorted: from the cache for 60 seconds after a read, else from ID's member access view. */
  read(principal: UserPrincipal): Promise<readonly string[]>
  /** Read these organisations' members, and these users in every organisation, from ID again on their next call, and call `changed` when at least one is named. */
  invalidate(organisationIds: Iterable<string>, userIds?: Iterable<string>): void
}

/**
 * Read each caller's grant strings from ID's member access view: the scopes of every target whose resource is the Toolbox, keeping only
 * grant strings. Cached per organisation, member and the token's organisation authorisation version for 60 seconds. When ID fails,
 * a cached entry answers until it expires; without one the read throws `UPSTREAM_UNAVAILABLE`. `changed` runs after an invalidation that names an
 * organisation or a user, cached or not, since a member who is listening may not have been read for a while.
 */
export function createGrantsReader({ id, resource, changed = () => {} }: { id: IdAdmin; resource: string; changed?: () => void }): GrantsReader {
  const cache = new Map<string, Map<string, Entry>>()
  const pending = new Map<string, Promise<readonly string[]>>()
  async function fetchGrants(organisationId: string, memberId: string) {
    const view = await found(id.get(`/organizations/${organisationId}/members/${memberId}/access`))
    const targets = view === undefined ? [] : accessView.parse(view).targets
    const scopes = targets.filter(target => (target.kind === "resource" ? target.id : target.resource) === resource).flatMap(target => target.scopes)
    return [...new Set(scopes.filter(isGrant))].sort()
  }
  function remember(organisationId: string, memberId: string, entry: Entry) {
    const now = Date.now()
    for (const [organisation, members] of cache) {
      for (const [member, { expiresAt }] of members) if (expiresAt <= now) members.delete(member)
      if (!members.size) cache.delete(organisation)
    }
    cache.set(organisationId, (cache.get(organisationId) ?? new Map()).set(memberId, entry))
  }
  async function refresh({ userId, organizationId, membershipId, organizationAuthorizationVersion: version }: UserPrincipal, kept: Entry | undefined) {
    try {
      const grants = await fetchGrants(organizationId, membershipId)
      remember(organizationId, membershipId, { userId, version, grants, expiresAt: Date.now() + 60_000, stale: false })
      return grants
    } catch (error) {
      console.error("[toolbox] reading access failed", error)
      if (kept && Date.now() < kept.expiresAt) return kept.grants
      throw new ToolError("UPSTREAM_UNAVAILABLE", "Answerable ID did not answer with your access; try again shortly")
    }
  }
  return {
    async read(principal) {
      const { organizationId, membershipId, organizationAuthorizationVersion: version } = principal
      const cached = cache.get(organizationId)?.get(membershipId)
      const kept = cached?.version === version ? cached : undefined
      if (kept && !kept.stale && Date.now() < kept.expiresAt) return kept.grants
      const key = `${organizationId}/${membershipId}/${version}`
      let read = pending.get(key)
      if (!read) {
        read = refresh(principal, kept).finally(() => pending.delete(key))
        pending.set(key, read)
      }
      return read
    },
    invalidate(organisationIds, userIds = []) {
      const users = new Set(userIds)
      let named = users.size > 0
      for (const organisationId of organisationIds) {
        named = true
        for (const entry of cache.get(organisationId)?.values() ?? []) entry.stale = true
      }
      for (const members of users.size ? cache.values() : []) for (const entry of members.values()) if (users.has(entry.userId)) entry.stale = true
      if (named) changed()
    },
  }
}
