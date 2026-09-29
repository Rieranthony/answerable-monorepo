import { riskClass, type Mutation, type PolicyClass, type Provider, type Served } from "@answerable/mcp"
import type { Catalogue } from "./catalogue"

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

/** A provider as the Toolbox serves it: its tools by domain, then operation. */
export const project = (provider: Provider): Provider => ({ ...provider, tools: provider.tools.toSorted((a, b) => (a.name < b.name ? -1 : 1)) })
