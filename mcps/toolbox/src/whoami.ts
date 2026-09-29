import { defineTool, type Mutation, type PolicyClass, type Served, type Tool, type UserPrincipal } from "@answerable/mcp"
import { z } from "zod"

/** A capability the caller may use, with its policy class in their organisation (null for a read). */
type Usable = { tool: Served<Tool | Mutation>; policy_class: PolicyClass | null }
/** The caller's grant strings and the capabilities they may use. */
export type Caller = { grants: readonly string[]; capabilities: readonly Usable[] }

export const kind = z.enum(["read", "mutate"])
export const policyClass = z.enum(["agent", "controlled", "human"]).nullable().describe("Who may commit a mutation's intent; null for a read")

/** `toolbox_whoami`: who the caller is to the Toolbox, from the token and from `caller`. */
export const whoami = (caller: (principal: UserPrincipal) => Promise<Caller>) => defineTool({
  name: "toolbox.whoami",
  title: "Who am I",
  description: "Read who you are to the Toolbox: your user, organisation, membership and host client, the grant strings your organisation gave you, and each capability you may use with its kind and policy class. Call it when a tool you expect is missing.",
  scopes: ["toolbox"],
  input: z.object({}),
  output: z.object({
    user_id: z.uuid(),
    organisation_id: z.uuid(),
    membership_id: z.uuid(),
    client_id: z.string().describe("The OAuth client of the host you are using"),
    grants: z.array(z.string()).describe("Grant strings from your organisation's entitlements: a provider (e2e), a domain (e2e/records) or a capability (e2e/records.list)"),
    capabilities: z.array(z.object({ identity: z.string(), kind, policy_class: policyClass })),
  }),
  async execute(_input, { principal }) {
    const { grants, capabilities } = await caller(principal)
    return {
      user_id: principal.userId, organisation_id: principal.organizationId, membership_id: principal.membershipId, client_id: principal.clientId, grants: [...grants],
      capabilities: capabilities.map(({ tool, policy_class }) => ({ identity: tool.identity, kind: tool.kind, policy_class })),
    }
  },
})
