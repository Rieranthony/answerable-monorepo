import type { z } from "zod"
import { commitTools, receipt } from "./commit-tools"
import type { Effect, Risk } from "./mutation"
import type { Provider } from "./provider"
import { readAnnotations, wireDescription, wireName, type Tool } from "./tool"

type JsonSchema = Record<string, unknown>
type Annotations = Readonly<{ readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }>
type Definition = {
  identity: string
  name: string
  version: string
  title?: string
  description: string
  deprecated?: Tool["deprecated"]
  scopes: readonly string[]
  annotations: Annotations
  /** The definition's input; a mutation's prepare tool adds `validate_only`. */
  input: JsonSchema
  /** A read tool's result; the `results` of a mutation's receipt. */
  output: JsonSchema
}
/** A provider's contract as plain JSON: every definition as the wire carries it, and no code. */
export type Manifest = {
  id: string
  version: string
  tools: (
    | (Definition & { kind: "read" })
    | (Definition & { kind: "mutate"; risk: Risk; effects: readonly Effect[] })
    /** A commit tool: listed when the caller can use at least one mutation; `scopes` is the union of the mutations' scopes. */
    | { identity: string; name: string; kind: "commit"; description: string; scopes: readonly string[]; annotations: Annotations; input: JsonSchema; output: JsonSchema }
  )[]
  prompts: { name: string; description: string; scopes: readonly string[]; input: JsonSchema }[]
  resources: { name: string; uri: string; description: string; mime_type: string; scopes: readonly string[] }[]
}

// The same conversion the MCP SDK applies for tools/list.
const jsonSchema = (schema: z.ZodType, io: "input" | "output") => schema["~standard"].jsonSchema[io]({ target: "draft-2020-12" })

/** Serialise a provider for review and for the hub; commit it and test it for drift. */
export function manifest(provider: Provider): Manifest {
  const mutations = provider.tools.filter(tool => tool.kind === "mutate")
  const writes = [...new Set(mutations.flatMap(mutation => mutation.scopes))].sort()
  const tools: Manifest["tools"] = provider.tools.map(tool => ({
    identity: tool.identity,
    name: wireName(tool.name),
    version: tool.version,
    kind: tool.kind,
    ...(tool.title === undefined ? {} : { title: tool.title }),
    description: wireDescription(tool),
    ...(tool.deprecated ? { deprecated: tool.deprecated } : {}),
    scopes: tool.scopes,
    ...(tool.kind === "mutate" ? { risk: tool.risk, effects: tool.effects } : {}),
    annotations: readAnnotations,
    input: jsonSchema(tool.input, "input"),
    output: jsonSchema(tool.output, "output"),
  }) as Manifest["tools"][number])
  const commits = mutations.length ? commitTools(provider.id) : []
  for (const { identity, name, description, annotations, input } of commits) {
    tools.push({ identity, name, kind: "commit", description, scopes: writes, annotations, input: jsonSchema(input, "input"), output: jsonSchema(receipt, "output") })
  }
  return {
    id: provider.id,
    version: provider.version,
    tools: tools.sort((a, b) => (a.identity < b.identity ? -1 : 1)),
    prompts: provider.prompts.map(({ name, description, scopes, input }) => ({ name, description, scopes, input: jsonSchema(input, "input") })),
    resources: provider.resources.map(({ name, uri, description, mimeType, scopes }) => ({ name, uri, description, mime_type: mimeType, scopes })),
  }
}
