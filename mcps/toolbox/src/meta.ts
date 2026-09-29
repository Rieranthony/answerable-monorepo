import { defineProvider, defineTool, manifest, ToolError, type Mutation, type PolicyClass, type Provider, type Served, type Tool, type ToolContext, type UserPrincipal } from "@answerable/mcp"
import { z } from "zod"

/** The caller's grant strings and the capabilities they may use, each with its policy class in their organisation (null for a read). */
export type Caller = { grants: readonly string[]; capabilities: readonly { tool: Served<Tool | Mutation>; policy_class: PolicyClass | null }[] }

/** What the Toolbox's own tools ask of the hub. */
export type Hub = {
  /** The mounted providers, whose manifests `toolbox_describe` reads. */
  providers: readonly Provider[]
  caller(principal: UserPrincipal): Promise<Caller>
  /** Rank capabilities by words, best first: identities from `offset`, at most `limit`. */
  search(query: string, tools: readonly Served<Tool | Mutation>[], page: { limit: number; offset: number }): Promise<string[]>
  /** Run a capability as its direct call runs it; the call's evidence and span are that capability's. */
  run(tool: Served<Tool | Mutation>, args: Record<string, unknown>, context: ToolContext): Promise<Record<string, unknown>>
  /** Note that the call named a capability the caller may not use, so its evidence is that capability's denial. */
  refused(identity: string, context: ToolContext): void
}

const kind = z.enum(["read", "mutate"])
const policyClass = z.enum(["agent", "controlled", "human"]).nullable().describe("Who may commit a mutation's intent; null for a read")
const identity = z.string().max(100).describe("A capability's identity, <provider>/<domain>.<operation>, such as e2e/records.list")
const args = z.record(z.string(), z.unknown()).default({}).describe("The capability's input, as toolbox_describe gives its schema")
const firstSentence = (text: string) => /^.*?[.!?](?=\s|$)/s.exec(text)?.[0] ?? text

/**
 * The Toolbox's own provider, `toolbox`: `toolbox_whoami`, in both projections, and the meta tools, with which a caller in the meta projection
 * finds, describes, runs and prepares the capabilities they may use. Every tool reads the caller's capabilities from `hub`, so it reveals and
 * runs only those.
 */
export function createToolboxProvider(hub: Hub) {
  const contracts = new Map(hub.providers.flatMap(provider => manifest(provider).tools).map(entry => [entry.identity, entry]))
  const notFound = (name: string) => new ToolError("NOT_FOUND", `You may use no capability ${name}; find one with toolbox_search`)
  const misused = (message: string) => new ToolError("INVALID_INPUT", message, { details: { field_violations: [{ field: "identity", message }] } })
  async function usable(name: string, context: ToolContext) {
    const found = (await hub.caller(context.principal)).capabilities.find(({ tool }) => tool.identity === name)
    if (found) return found.tool
    hub.refused(name, context)
    throw notFound(name)
  }
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
      capabilities: z.array(z.object({ identity: z.string(), kind, policy_class: policyClass })),
    }),
    async execute(_input, { principal }) {
      const { grants, capabilities } = await hub.caller(principal)
      return {
        user_id: principal.userId, organisation_id: principal.organizationId, membership_id: principal.membershipId, client_id: principal.clientId, grants: [...grants],
        capabilities: capabilities.map(({ tool, policy_class }) => ({ identity: tool.identity, kind: tool.kind, policy_class })),
      }
    },
  })
  const search = defineTool({
    name: "toolbox.search", title: "Search capabilities",
    description: "Search the capabilities you may use by words from their identity, title, description or argument names, best match first. Returns each one's identity, title, first sentence, kind and policy class; then describe it with toolbox_describe, run a read with toolbox_execute or prepare a mutation with toolbox_prepare.",
    scopes: ["toolbox"],
    input: z.object({
      query: z.string().min(1).max(200).describe("Words to look for, such as \"list records\"; any of them may match"),
      limit: z.number().int().min(1).max(20).default(10).describe("Results per page, 1 to 20; default 10"),
      cursor: z.string().regex(/^\d{1,9}$/).optional().describe("next_cursor from the previous page"),
    }),
    output: z.object({
      items: z.array(z.object({ identity: z.string(), title: z.string().nullable(), description: z.string().describe("The first sentence of its description"), kind, policy_class: policyClass })),
      next_cursor: z.string().nullable(),
      has_more: z.boolean(),
    }),
    async execute({ query, limit, cursor }, { principal }) {
      const { capabilities } = await hub.caller(principal)
      const offset = Number(cursor ?? 0)
      const found = await hub.search(query, capabilities.map(({ tool }) => tool), { limit: limit + 1, offset })
      const has_more = found.length > limit
      const items = found.slice(0, limit).map(name => {
        const { tool, policy_class } = capabilities.find(({ tool }) => tool.identity === name)!
        return { identity: name, title: tool.title ?? null, description: firstSentence(tool.description), kind: tool.kind, policy_class }
      })
      return { items, next_cursor: has_more ? String(offset + limit) : null, has_more }
    },
  })
  const describe = defineTool({
    name: "toolbox.describe", title: "Describe capabilities",
    description: "Describe up to 5 capabilities you may use, by identity: the full description, kind, policy class, and the JSON Schemas of the arguments that toolbox_execute or toolbox_prepare takes and of the result. An identity you may not use answers NOT_FOUND.",
    scopes: ["toolbox"],
    input: z.object({ identities: z.array(identity).min(1).max(5).describe("1 to 5 identities, such as those toolbox_search returns") }),
    output: z.object({
      capabilities: z.array(z.object({
        identity: z.string(), kind, policy_class: policyClass, description: z.string(),
        input: z.record(z.string(), z.unknown()).describe("JSON Schema of its arguments"),
        output: z.record(z.string(), z.unknown()).describe("JSON Schema of its result; for a mutation, the results of its receipt"),
      })),
    }),
    async execute({ identities }, { principal }) {
      const { capabilities } = await hub.caller(principal)
      return {
        capabilities: identities.map(name => {
          const found = capabilities.find(({ tool }) => tool.identity === name)
          if (!found) throw notFound(name)
          const { description, input, output } = contracts.get(name)!
          return { identity: name, kind: found.tool.kind, policy_class: found.policy_class, description, input, output }
        }),
      }
    },
  })
  // A capability may take up to 55 seconds, and runs within its own timeout.
  const execute = defineTool({
    name: "toolbox.execute", title: "Run a capability",
    description: "Run a read capability you may use, by identity, with its arguments as toolbox_describe gives them; returns the capability's own result. A mutation answers INVALID_INPUT: prepare it with toolbox_prepare. An identity you may not use answers NOT_FOUND; arguments that fail its schema answer INVALID_INPUT naming the fields.",
    scopes: ["toolbox"], timeoutMs: 55_000,
    input: z.object({ identity, arguments: args }),
    output: z.looseObject({}).describe("The capability's result"),
    async execute({ identity: name, arguments: input }, context) {
      const tool = await usable(name, context)
      if (tool.kind === "mutate") throw misused(`${name} is a mutation; prepare it with toolbox_prepare`)
      return hub.run(tool, input, context)
    },
  })
  const prepare = defineTool({
    name: "toolbox.prepare", title: "Prepare a mutation",
    description: "Prepare a mutation you may use, by identity, with its arguments as toolbox_describe gives them. Changes nothing: returns the intent, with its preview, commit token and commit_tool: toolbox_commit, or toolbox_commit_confirmed once the person has seen the preview's summary. With validate_only true it records nothing. A read answers INVALID_INPUT: run it with toolbox_execute.",
    scopes: ["toolbox"], timeoutMs: 55_000,
    input: z.object({ identity, arguments: args, validate_only: z.boolean().default(false).describe("Return the preview without recording an intent or issuing a commit token; default false") }),
    output: z.looseObject({}).describe("The intent, as the mutation's own prepare tool returns it"),
    async execute({ identity: name, arguments: input, validate_only }, context) {
      const tool = await usable(name, context)
      if (tool.kind === "read") throw misused(`${name} is a read; run it with toolbox_execute`)
      return hub.run(tool, { ...input, validate_only }, context)
    },
  })
  return defineProvider({ id: "toolbox", version: "2026-09-29", tools: [whoami, search, describe, execute, prepare] })
}
