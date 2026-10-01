import { ToolError, type UserPrincipal } from "@answerable/mcp"

/** The custom code a critical operation answers when the caller's directory sign-in is older than the freshness window, or unknown. */
export const reauthenticationRequired = "ADMIN_REAUTHENTICATION_REQUIRED"

const span = (seconds: number) => seconds % 60 ? `${seconds} seconds` : seconds === 60 ? "minute" : `${seconds / 60} minutes`

/**
 * Refuse a critical operation unless the caller signed in at their company's directory within `maxAge` seconds, as their token's
 * `upstream_auth_time` says; a token without one counts as stale. ID fixes that time when it creates an authorisation and keeps it across
 * refreshes (`apps/id/src/auth/user-token-boundary.ts`), so the remedy is a new directory sign-in followed by a new authorisation in the host.
 */
export function requireFresh(principal: UserPrincipal, { maxAge, issuer }: { maxAge: number; issuer: string }) {
  const time = principal.upstreamAuthTime
  if (time !== null && Date.now() / 1000 - time <= maxAge) return
  const yours = time === null ? "your token carries no sign-in time" : `yours is from ${new Date(time * 1000).toISOString()}`
  throw new ToolError(reauthenticationRequired, [
    `This operation needs a sign-in at your company's directory within the last ${span(maxAge)}; ${yours}.`,
    `In the browser you use for Answerable ID, open ${new URL("/security", issuer)} and choose Verify sign-in; then, in your host, clear this server's authentication and authenticate again (Claude Code: /mcp, choose this server, Clear authentication, then Authenticate).`,
    "Refreshing the token does not help: it keeps the sign-in time of the authorisation it belongs to.",
  ].join(" "), { retry: { policy: "after_state_change" }, details: { upstream_auth_time: time, max_age_seconds: maxAge } })
}
