import { z } from "zod"
import { assertMcpName } from "./names"

/** An MCP as `charts/answerable/mcps.json` declares it, which the chart hands the bootstrap and the migration Job. */
export type DeclaredMcp = z.output<typeof declaredMcps>[number]

const validName = (name: string) => {
  try {
    assertMcpName(name)
    return true
  } catch {
    return false
  }
}

/**
 * A variable holding the chart's list as JSON, `[{ "name", "serve", "database" }]`, other keys ignored: each name an MCP's, none listed twice.
 * For a `defineConfig` field's `schema`.
 */
export const declaredMcps = z.string()
  .transform((text, context) => {
    try {
      return JSON.parse(text) as unknown
    } catch {
      context.addIssue({ code: "custom", message: "Expected the chart's list of MCPs as JSON" })
      return z.NEVER
    }
  })
  .pipe(z.array(z.object({
    name: z.string().refine(validName, "Expected an MCP's name: a lowercase letter then up to 11 lowercase letters or digits"),
    serve: z.enum(["toolbox", "standalone", "both"]),
    database: z.enum(["shared", "own"]),
  })).refine(mcps => new Set(mcps.map(({ name }) => name)).size === mcps.length, "An MCP is listed twice"))
