import { isDate, type Prompt, type Resource, type View } from "./definitions"
import type { Mutation } from "./mutation"
import type { Tool } from "./tool"

type Scoped = Readonly<{ scopes: readonly string[] }>
/** A tool or mutation as its provider serves it: identity, version and scopes filled in. */
export type Served<Definition extends Tool | Mutation> = Definition & Scoped & Readonly<{ identity: string; version: string }>
/** A validated, frozen provider: its definitions with identity, version and scopes filled in. */
export type Provider = Readonly<{
  id: string
  version: string
  /** Read tools (`kind: "read"`) and mutations (`kind: "mutate"`), in definition order. */
  tools: readonly Served<Tool | Mutation>[]
  prompts: readonly (Prompt & Scoped)[]
  resources: readonly (Resource & Scoped)[]
}>

function once(provider: string, kind: string, keys: readonly string[]) {
  const seen = new Set<string>()
  for (const key of keys) {
    if (seen.has(key)) throw new Error(`Provider ${provider} defines ${kind} ${key} twice`)
    seen.add(key)
  }
}

/** Define a provider: a named, dated set of tools, mutations, prompts and resources, served alone or mounted in a hub. */
export function defineProvider(provider: { id: string; version: string; tools: readonly (Tool | Mutation)[]; prompts?: readonly Prompt[]; resources?: readonly Resource[] }): Provider {
  const { id, version } = provider
  if (!/^[a-z][a-z0-9]{0,11}$/.test(id)) throw new Error(`Provider id "${id}" must be a lowercase letter then up to 11 lowercase letters or digits, for example acme`)
  if (!isDate(version)) throw new Error(`Provider ${id}: version "${version}" must be a date, YYYY-MM-DD`)
  const scopes = Object.freeze([`${id}:read`])
  const writes = Object.freeze([`${id}:write`])
  const tools = provider.tools.map(tool => Object.freeze({
    ...tool, identity: `${id}/${tool.name}`, version: tool.version ?? version, scopes: tool.scopes ?? (tool.kind === "read" ? scopes : writes),
  }))
  const prompts = (provider.prompts ?? []).map(prompt => Object.freeze({ ...prompt, scopes: prompt.scopes ?? scopes }))
  const resources = (provider.resources ?? []).map(resource => Object.freeze({ ...resource, scopes: resource.scopes ?? scopes }))
  once(id, "tool", tools.map(tool => tool.name))
  once(id, "prompt", prompts.map(prompt => prompt.name))
  const views = new Map<string, View>()
  for (const tool of tools) {
    if (tool.kind !== "read" || !tool.view) continue
    if ((views.get(tool.view.uri) ?? tool.view) !== tool.view) throw new Error(`Provider ${id} defines two different views at ${tool.view.uri}`)
    views.set(tool.view.uri, tool.view)
  }
  once(id, "resource", [...views.keys(), ...resources.map(resource => resource.uri)])
  const current = new Set(tools.filter(tool => !tool.deprecated).map(tool => tool.name))
  for (const { name, deprecated } of tools) {
    if (deprecated?.replacement !== undefined && !current.has(deprecated.replacement)) {
      throw new Error(`Provider ${id}: tool ${name} is deprecated in favour of ${deprecated.replacement}, which is not a current tool of this provider`)
    }
  }
  return Object.freeze({ id, version, tools: Object.freeze(tools), prompts: Object.freeze(prompts), resources: Object.freeze(resources) })
}
