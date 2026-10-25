import type { UserPrincipal } from "@answerable/mcp"

/**
 * `read`, once per request: the SDK verifies the token into a new principal for every request, so the first read for a principal is shared by
 * every decision of its request, and none outlives it.
 */
export function perRequest<T>(read: (principal: UserPrincipal) => Promise<T>): (principal: UserPrincipal) => Promise<T> {
  const reads = new WeakMap<UserPrincipal, Promise<T>>()
  return principal => {
    let held = reads.get(principal)
    if (!held) {
      held = read(principal)
      reads.set(principal, held)
    }
    return held
  }
}
