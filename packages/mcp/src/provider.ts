import { schemaOf } from "./database"
import { isDate, type Prompt, type Resource, type View } from "./definitions"
import type { Mutation } from "./mutation"
import { checkDescription, checkProviderId } from "./rules"
import type { Tool } from "./tool"

type Scoped = Readonly<{ scopes: readonly string[] }>
/** A tool or mutation as its provider serves it: with its `identity` (`<provider id>/<name>`), `version` and `scopes` filled in. */
export type Served<Definition extends Tool | Mutation> = Definition & Scoped & Readonly<{ identity: string; version: string }>
/** An MCP's database, as its provider declares it: the drizzle schema module its tables are in, and the folder of its migrations. */
export type ProviderDatabase = Readonly<{
  /** The MCP's drizzle schema module, `import * as schema from "./db/schema"`: its `pgSchema("<id>")` tables. */
  schema: Record<string, unknown>
  /** The folder drizzle-kit writes its migrations to, as a URL: `new URL("../drizzle", import.meta.url)`. */
  migrations: URL
}>

/** A validated, frozen provider: its definitions with identity, version and scopes filled in. */
export type Provider = Readonly<{
  id: string
  version: string
  /** What the MCP is for, in a sentence or two. */
  description: string
  /** The MCP's database; absent when it has none. */
  database?: ProviderDatabase
  /** Read tools (`kind: "read"`) and mutations (`kind: "mutate"`), in definition order. */
  tools: readonly Served<Tool | Mutation>[]
  prompts: readonly (Prompt & Scoped)[]
  resources: readonly (Resource & Scoped)[]
}>

function once(provider: string, kind: string, keys: readonly string[]) {
  const seen = new Set<string>()
  for (const key of keys) {
    if (seen.has(key)) throw new Error(`Provider ${provider} defines ${kind} ${key} twice; rename one`)
    seen.add(key)
  }
}

/**
 * Define a provider: a named, dated set of tools, mutations, prompts and resources, served alone or mounted in a hub, with what it is for and,
 * when it has one, its database. It fills in each definition's identity, version and scopes, and refuses a bad id, a description outside 40 to
 * 1,000 characters, duplicates, conflicting views, a deprecation whose replacement is not a current tool, and a declared error that does not
 * start with the provider's id in capitals.
 *
 * @example
 * ```ts
 * import { defineProvider } from "@answerable/mcp"
 * import { identityGet } from "./tools"
 *
 * export const provider = defineProvider({
 *   id: "example",
 *   description: "Tells you who you are to Answerable ID: your user and the organisation you signed in to.",
 *   version: "2026-09-29",
 *   tools: [identityGet],
 * })
 * ```
 */
export function defineProvider(provider: {
  /** A lowercase letter, then up to 11 lowercase letters or digits, for example `acme`. It prefixes identities, scopes, commit tools and custom error codes. */
  id: string
  /** What the MCP is for, in a sentence or two: 40 to 1,000 characters. The manifest and the Toolbox's catalogue carry it. */
  description: string
  /** A date, `YYYY-MM-DD`: the default version of every definition. Change it when the provider's contract changes. */
  version: string
  /** The MCP's database: its drizzle `schema` module and its `migrations` folder. The server that serves the provider then needs its `db`. Default: none. */
  database?: ProviderDatabase
  /** Read tools from `defineTool` and mutations from `defineMutation`. */
  tools: readonly (Tool | Mutation)[]
  /** Prompts from `definePrompt`. Default: none. */
  prompts?: readonly Prompt[]
  /** Fixed-URI resources from `defineResource`. Default: none. */
  resources?: readonly Resource[]
}): Provider {
  const { id, description, version, database } = provider
  const named = checkProviderId(id)
  if (named) throw new Error(`Provider id ${named}`)
  const described = checkDescription(description)
  if (described) throw new Error(`Provider ${id}: the description ${described}`)
  if (!isDate(version)) throw new Error(`Provider ${id}: version "${version}" must be a date, YYYY-MM-DD`)
  for (const tool of provider.tools) {
    const schema = schemaOf(tool)
    if (schema && schema !== database?.schema) {
      throw new Error(`Provider ${id}: ${tool.name} is defined with withDatabase, so the provider needs database: { schema, migrations }, with the schema src/mcp.ts gives withDatabase`)
    }
  }
  const scopes = Object.freeze([`${id}:read`])
  const writes = Object.freeze([`${id}:write`])
  const tools = provider.tools.map(tool => Object.freeze({
    ...tool, identity: `${id}/${tool.name}`, version: tool.version ?? version, scopes: tool.scopes ?? (tool.kind === "read" ? scopes : writes),
  }))
  const prompts = (provider.prompts ?? []).map(prompt => Object.freeze({ ...prompt, scopes: prompt.scopes ?? scopes }))
  const resources = (provider.resources ?? []).map(resource => Object.freeze({ ...resource, scopes: resource.scopes ?? scopes }))
  const prefix = `${id.toUpperCase()}_`
  for (const { name, errors } of tools) {
    const foreign = errors.find(code => !code.startsWith(prefix))
    if (foreign !== undefined) throw new Error(`Provider ${id}: ${name} declares error "${foreign}"; a custom code of this provider starts with ${prefix}`)
  }
  once(id, "tool", tools.map(tool => tool.name))
  once(id, "prompt", prompts.map(prompt => prompt.name))
  const views = new Map<string, View>()
  for (const tool of tools) {
    if (tool.kind !== "read" || !tool.view) continue
    if ((views.get(tool.view.uri) ?? tool.view) !== tool.view) throw new Error(`Provider ${id} defines two different views at ${tool.view.uri}; share one defineView result, or rename one view`)
    views.set(tool.view.uri, tool.view)
  }
  once(id, "resource", [...views.keys(), ...resources.map(resource => resource.uri)])
  const current = new Set(tools.filter(tool => !tool.deprecated).map(tool => tool.name))
  for (const { name, deprecated } of tools) {
    if (deprecated?.replacement !== undefined && !current.has(deprecated.replacement)) {
      throw new Error(`Provider ${id}: tool ${name} is deprecated in favour of ${deprecated.replacement}, which is not a current tool of this provider`)
    }
  }
  return Object.freeze({
    id, version, description, ...(database ? { database: Object.freeze({ ...database }) } : {}),
    tools: Object.freeze(tools), prompts: Object.freeze(prompts), resources: Object.freeze(resources),
  })
}
