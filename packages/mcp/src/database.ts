import type { NodePgDatabase } from "drizzle-orm/node-postgres"
import type { z } from "zod"
import type { ToolContext } from "./definitions"
import { defineMutation, type Mutation, type MutationDefinition } from "./mutation"
import { defineTool, type Tool, type ToolDefinition } from "./tool"

// The schema each definition made with `withDatabase` is typed by, so that its provider can check it declares that database.
const schemas = new WeakMap<object, Record<string, unknown>>()

/** The schema a tool or mutation made with `withDatabase` is typed by; `undefined` for one made with the plain `defineTool` or `defineMutation`. */
export const schemaOf = (definition: object) => schemas.get(definition)

function typedBy<Definition extends object>(definition: Definition, schema: Record<string, unknown>) {
  schemas.set(definition, schema)
  return definition
}

/** What a handler made with `withDatabase` receives: every field of `ToolContext`, and `db`. */
export type DatabaseContext<Schema extends Record<string, unknown>> = ToolContext & Readonly<{
  /**
   * This MCP's drizzle database, typed by its schema, with `db.query.<table>` for relational reads. The server makes it once for the process and
   * shares it with every call; a query borrows a connection only while it runs, inside the caller's organisation.
   */
  db: NodePgDatabase<Schema>
}>

/**
 * `defineTool` and `defineMutation` for an MCP with a database: every handler's context also has `db`, the MCP's drizzle database typed by
 * `schema`, with `db.query.<table>` for relational reads. The server that serves the provider supplies `db`, and `defineProvider` refuses these
 * definitions unless its `database.schema` is this `schema`. An MCP calls it once, in `src/mcp.ts`, and its tools import the two from there.
 *
 * @example
 * ```ts
 * import { withDatabase } from "@answerable/mcp"
 * import * as schema from "./db/schema"
 *
 * export const { defineTool, defineMutation } = withDatabase({ schema })
 * ```
 */
export function withDatabase<Schema extends Record<string, unknown>>({ schema }: { schema: Schema }) {
  return {
    /** `defineTool`, whose `execute` receives the MCP's `db`. */
    defineTool: <Input extends z.ZodObject, Output extends z.ZodObject>(tool: ToolDefinition<Input, Output, DatabaseContext<Schema>>): Tool<Input, Output, DatabaseContext<Schema>> =>
      typedBy(defineTool(tool), schema),
    /** `defineMutation`, whose `prepare` and `commit` receive the MCP's `db`. */
    defineMutation: <Input extends z.ZodObject, Output extends z.ZodObject, Data = unknown>(
      mutation: MutationDefinition<Input, Output, Data, DatabaseContext<Schema>>,
    ): Mutation<Input, Output, Data, DatabaseContext<Schema>> => typedBy(defineMutation(mutation), schema),
  }
}
