import type { UserPrincipal } from "@answerable/mcp"

/** A verified caller for unit tests: a fresh person, membership and organisation unless given. */
export const principal = (overrides: Partial<UserPrincipal> = {}): UserPrincipal => ({
  userId: crypto.randomUUID(), organizationId: crypto.randomUUID(), membershipId: crypto.randomUUID(), grantId: crypto.randomUUID(),
  clientId: "claude-code", scopes: ["toolbox"], expiresAt: Math.floor(Date.now() / 1000) + 60, organizationAuthorizationVersion: 1, ...overrides,
})
