import { found, type IdAdmin } from "@answerable/id-admin"
import { ToolError, type UserPrincipal } from "@answerable/mcp"
import { z } from "zod"

/** The staff roles, lowest first: `team` reads, `admin` also makes ordinary changes, `owner` also runs the critical operations. */
export const roles = ["team", "admin", "owner"] as const
export type Role = (typeof roles)[number]

/** The scope that confers a role: `answerable-<role>`. ID accepts any string as a scope, so every other string confers nothing. */
export const grantString = (role: Role) => `answerable-${role}`
/** The highest role that scopes on the admin MCP's resource confer, or null. */
export const roleOf = (scopes: readonly string[]): Role | null => roles.findLast(role => scopes.includes(grantString(role))) ?? null
/** Whether a target of ID's member access view can confer a role: an entitlement on the admin MCP's resource itself, not one through a single client. */
export const confers = (resource: string) => (target: { kind: string; id: string }) => target.kind === "resource" && target.id === resource

/** Why a caller may not use a tool, as its `capability.denied` evidence records it. */
type Refusal = { reason: "not_platform" | "missing_scope" | "role_below_minimum"; data: Record<string, unknown> }

const accessView = z.object({ targets: z.array(z.object({ kind: z.string(), id: z.string(), scopes: z.array(z.string()) })) })

/**
 * Each caller's staff role, read from ID's member access view: the scopes of the target that is the admin MCP's resource alone (an entitlement
 * with no client), held by the caller's membership of the platform organisation through the organisation, a group or the member. Read once per
 * request and shared by every decision of that request, never kept longer, so a change in ID applies on the next request. When ID does not
 * answer, every request that needs the role fails with `UPSTREAM_UNAVAILABLE`.
 */
export function createRoles({ id, platform, resource }: { id: IdAdmin; platform: string; resource: string }) {
  // The SDK verifies the token into a new principal object for every request.
  const read = new WeakMap<UserPrincipal, Promise<Role | null>>()
  async function fetchRole({ membershipId }: UserPrincipal) {
    try {
      const view = await found(id.get(`/organizations/${platform}/members/${membershipId}/access`))
      const targets = view === undefined ? [] : accessView.parse(view).targets
      return roleOf(targets.filter(confers(resource)).flatMap(target => target.scopes))
    } catch (error) {
      console.error("[admin] reading the role failed", error)
      throw new ToolError("UPSTREAM_UNAVAILABLE", "Answerable ID did not answer with your role; try again shortly")
    }
  }
  /** The caller's role, or null. A caller of another organisation has none, and ID is not asked. */
  function role(principal: UserPrincipal) {
    if (principal.organizationId !== platform) return Promise.resolve(null)
    let held = read.get(principal)
    if (!held) {
      held = fetchRole(principal)
      read.set(principal, held)
    }
    return held
  }
  /**
   * Why the caller may not use a tool that needs `scopes` and the role `minimum` (null: any member of the platform organisation), or undefined
   * when they may. A member of the platform organisation always has their role read, so that a request fails when ID does not answer.
   */
  async function refusal(principal: UserPrincipal, scopes: readonly string[], minimum: Role | null): Promise<Refusal | undefined> {
    if (principal.organizationId !== platform) return { reason: "not_platform", data: { organisation_id: principal.organizationId } }
    const missing = scopes.filter(scope => !principal.scopes.includes(scope))
    if (missing.length) return { reason: "missing_scope", data: { missing } }
    const held = await role(principal)
    if (minimum !== null && (held === null || roles.indexOf(held) < roles.indexOf(minimum))) return { reason: "role_below_minimum", data: { held, needed: minimum } }
  }
  return { role, refusal }
}
/** The staff role of each caller, read once per request. */
export type Roles = ReturnType<typeof createRoles>
