import { defineProvider, defineTool, type PolicyClass, type UserPrincipal } from "@answerable/mcp"
import { z } from "zod"

/** What `toolbox_whoami` reports beyond the token: the caller's grant strings and each capability they may use. */
export type Caller = {
  grants: readonly string[]
  capabilities: { identity: string; kind: "read" | "mutate"; policy_class: PolicyClass | null }[]
}

/** The Toolbox's own provider, `toolbox`, with `toolbox_whoami`. `describe` reads the caller's grants and capabilities. */
export function createToolboxProvider(describe: (principal: UserPrincipal) => Promise<Caller>) {
  const whoami = defineTool({
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
      capabilities: z.array(z.object({
        identity: z.string(),
        kind: z.enum(["read", "mutate"]),
        policy_class: z.enum(["agent", "controlled", "human"]).nullable().describe("Who may commit a mutation's intent; null for a read"),
      })),
    }),
    async execute(_input, { principal }) {
      const { grants, capabilities } = await describe(principal)
      return { user_id: principal.userId, organisation_id: principal.organizationId, membership_id: principal.membershipId, client_id: principal.clientId, grants: [...grants], capabilities }
    },
  })
  return defineProvider({ id: "toolbox", version: "2026-09-29", tools: [whoami] })
}
