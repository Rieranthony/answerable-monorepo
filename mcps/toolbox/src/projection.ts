import type { Mutation, PolicyClass, Provider, Served } from "@answerable/mcp"
import { z } from "zod"
import { riskClass, type Catalogue } from "./catalogue"

/** Whether a caller may use a capability: its provider is enabled for the organisation, not disabled there, and one of the caller's grant strings covers it. */
export function allowed(grants: readonly string[], catalogue: Catalogue, { identity }: { identity: string }) {
  const [provider, name] = identity.split("/") as [string, string]
  const entry = catalogue.get(provider)
  const domain = `${provider}/${name.split(".")[0]}`
  return !!entry?.enabled && !entry.overrides.disabled.includes(identity) && grants.some(grant => grant === provider || grant === domain || grant === identity)
}

/** A mutation's policy class in an organisation: the organisation's override, else the class its risk gives. */
export const policyClassOf = (catalogue: Catalogue, mutation: Served<Mutation>): PolicyClass =>
  catalogue.get(mutation.identity.split("/")[0]!)?.overrides.policy_class[mutation.identity] ?? riskClass[mutation.risk]

const notice = z.strictObject({ truncated: z.literal(true), message: z.string() })

/** A provider as the Toolbox serves it: its tools by domain then operation, each read's output also admitting the truncation notice. */
export function project(provider: Provider): Provider {
  const tools = provider.tools.toSorted((a, b) => (a.name < b.name ? -1 : 1)).map(tool => tool.kind === "read"
    // A union is not the ZodObject that the SDK's type names, but the SDK only parses with the output and converts it to JSON Schema.
    ? { ...tool, output: z.union([notice, tool.output]) as unknown as typeof tool.output }
    : tool)
  return { ...provider, tools }
}

/** What a caller receives in place of a read's result whose JSON is above 100 KiB. */
export const truncation = Object.freeze({ truncated: true, message: "Narrow the request with limit, cursor or filters." })

/** A result's size as JSON, in bytes, and whether it is above the 100 KiB a read may answer. */
export function measure(data: Record<string, unknown>) {
  const bytes = Buffer.byteLength(JSON.stringify(data))
  return { bytes, tooLarge: bytes > 100 * 1024 }
}
