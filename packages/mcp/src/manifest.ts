import type { z } from "zod"
import type { Provider } from "./provider"
import { readAnnotations, wireDescription, wireName, type Tool } from "./tool"

type JsonSchema = Record<string, unknown>
/** A provider's contract as plain JSON: what the wire carries for every definition, and no code. */
export type Manifest = {
  id: string
  version: string
  tools: {
    identity: string
    name: string
    version: string
    kind: "read"
    title?: string
    description: string
    deprecated?: Tool["deprecated"]
    scopes: readonly string[]
    annotations: typeof readAnnotations
    input: JsonSchema
    output: JsonSchema
  }[]
  prompts: { name: string; description: string; scopes: readonly string[]; input: JsonSchema }[]
  resources: { name: string; uri: string; description: string; mime_type: string; scopes: readonly string[] }[]
}

// The same conversion the MCP SDK applies for tools/list.
const jsonSchema = (schema: z.ZodObject, io: "input" | "output") => schema["~standard"].jsonSchema[io]({ target: "draft-2020-12" })

/** Serialise a provider for review and for the hub; commit it and test it for drift. */
export function manifest(provider: Provider): Manifest {
  return {
    id: provider.id,
    version: provider.version,
    tools: [...provider.tools].sort((a, b) => (a.identity < b.identity ? -1 : 1)).map(tool => ({
      identity: tool.identity,
      name: wireName(tool.name),
      version: tool.version,
      kind: "read",
      ...(tool.title === undefined ? {} : { title: tool.title }),
      description: wireDescription(tool),
      ...(tool.deprecated ? { deprecated: tool.deprecated } : {}),
      scopes: tool.scopes,
      annotations: readAnnotations,
      input: jsonSchema(tool.input, "input"),
      output: jsonSchema(tool.output, "output"),
    })),
    prompts: provider.prompts.map(({ name, description, scopes, input }) => ({ name, description, scopes, input: jsonSchema(input, "input") })),
    resources: provider.resources.map(({ name, uri, description, mimeType, scopes }) => ({ name, uri, description, mime_type: mimeType, scopes })),
  }
}
