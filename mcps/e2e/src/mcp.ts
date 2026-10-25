// Written by bun mcp new; never edited. Every tool imports defineTool or defineMutation from here.
import { withDatabase } from "@answerable/mcp"
import * as schema from "./db/schema"

/** This MCP's definitions: every handler's context.db is typed by src/db/schema.ts. */
export const { defineTool, defineMutation } = withDatabase({ schema })

/** This MCP's database, which src/provider.ts declares: its tables, and the migrations bun mcp db generate writes into drizzle/. */
export const database = { schema, migrations: new URL("../drizzle", import.meta.url) }
