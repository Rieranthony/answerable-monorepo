import { ToolError, type Mutation, type Target, type Tool, type ToolContext, type UserPrincipal } from "@answerable/mcp"
import { z } from "zod"
import type { Calls } from "./calls"
import { reauthenticationRequired } from "./fresh"
import type { Role, Roles } from "./roles"

/** What the mutations share: ID's admin API, the role registry, the platform organisation, the admin MCP's resource and the critical-operation checks. */
export type Writes = ReturnType<typeof createOrganisations> & {
  calls: Calls
  role: <Definition extends Tool | Mutation>(minimum: Role | null, tool: Definition) => Definition
  platform: string
  resource: string
  /** The freshness check of a critical operation: throws `ADMIN_REAUTHENTICATION_REQUIRED` when the caller's directory sign-in is too old. */
  fresh(principal: UserPrincipal): void
}

// Every tool needs the admin scope, which ID issues to staff for the admin MCP's resource.
export const scopes = ["admin"]
/** Every write that can touch the platform organisation can answer that the caller must sign in again (`createOrganisations`'s guard). */
export const errors = [reauthenticationRequired]
/** How every mutation's description ends: what prepare returns and how to commit it. */
export const commitWith = "Changes nothing: returns a preview; show the person its summary, then commit the intent with admin_commit_confirmed and that summary."
export const organizationId = z.uuid().describe("The organisation's id in Answerable ID, from organisations_list")
export const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/
// ID's host rule for a domain (apps/id/src/http/admin/domains.ts hostSchema).
export const domain = z.string().trim().toLowerCase().max(253).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?([.][a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, "Must be a domain name such as newco.example")

/** ID's rows, as far as the mutations read them. */
export type Organisation = { id: string; slug: string; name: string; status: "active" | "disabled"; logo: string | null; metadata: string | null }
export type Group = { id: string; slug: string; name: string; externalId: string | null; status: "active" | "disabled" }
export type Member = { id: string; userId: string; email: string; name: string; effective: boolean; membershipStatus: "active" | "revoked" }
export type Entitlement = { id: string; memberId: string | null; groupId: string | null; clientId: string | null; resource: string | null; scopes: string[]; status: "active" | "disabled" }
export type Assignment = { id: string; validFrom: string | null; validUntil: string | null }

/** A target bound to the ETag ID answered for it; commit sends that ETag as `If-Match` where ID takes one. */
export const target = (resource_type: string, resource_id: string, label: string, etag: string): Target => ({ resource_type, resource_id, label, version: { kind: "etag", value: etag } })
/** The idempotency key of an intent's writes, minted once by `prepare` and stored in its plan: commit receives the stored plan, never a new one. */
export const newKey = () => Bun.randomUUIDv7()
/** A preview warning for a write that ID takes without a precondition. */
export const noPrecondition = (write: string) =>
  `Answerable ID takes no precondition on ${write}: the admin MCP reads the target again just before it writes, but a change in between is not refused by ID.`
export const named = (organisation: Organisation) => `“${organisation.name}” (${organisation.slug})`
export const missingOrganisation = (organizationId: string) => `Answerable ID has no organisation ${organizationId}; organisations_list lists them`
export const precondition = (message: string, details: Record<string, unknown>) => new ToolError("PRECONDITION_FAILED", message, { details: { preconditions: [details] } })
export const invalid = (field: string, message: string) => new ToolError("INVALID_INPUT", message, { details: { field_violations: [{ field, message }] } })

/** The organisation a write acts on, read with its ETag, and that write's guard. */
export function createOrganisations({ calls, authority, platform, fresh }: { calls: Calls; authority: Roles; platform: string; fresh: Writes["fresh"] }) {
  /**
   * Changing the platform organisation changes who is staff and how staff sign in, so every write to it is a critical operation: the owner role
   * and a recent sign-in, whatever the tool's own minimum. Without this, an admin could add themselves to the owner group.
   */
  async function guard(organizationId: string, { principal }: ToolContext) {
    if (organizationId !== platform) return
    if (await authority.role(principal) !== "owner") {
      throw new ToolError("PERMISSION_DENIED", "Changing the platform organisation is an owner's critical operation: it decides who is staff and how staff sign in")
    }
    fresh(principal)
  }
  /** The organisation with its ETag, as a target; guarded when it is the platform organisation. */
  async function organisation(organizationId: string, context: ToolContext) {
    await guard(organizationId, context)
    const { body, etag } = await calls.versioned<Organisation>(`/organizations/${organizationId}`, context, missingOrganisation(organizationId))
    return { organisation: body, target: target("organization", organizationId, named(body), etag) }
  }
  return { guard, organisation }
}
