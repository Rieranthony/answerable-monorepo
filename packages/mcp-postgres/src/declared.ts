import { z } from "zod"
import { assertMcpName } from "./names"

const validName = (name: string) => {
  try {
    assertMcpName(name)
    return true
  } catch {
    return false
  }
}

const declaredMcp = z.object({
  name: z.string().refine(validName, "Expected an MCP's name: a lowercase letter then up to 11 lowercase letters or digits"),
  serve: z.enum(["toolbox", "standalone", "both"]),
  database: z.enum(["shared", "own"]),
  /** Its manifest's scopes, which its resource in ID allows when the Toolbox serves it alone. */
  scopes: z.array(z.string().min(1)),
})

/** An MCP as `charts/answerable/mcps.json` declares it, which the chart hands the ops Jobs and the migration Job: other keys are dropped. */
export type DeclaredMcp = z.output<typeof declaredMcp>

/**
 * A variable holding the chart's list as JSON, `[{ "name", "serve", "database", "scopes" }]`, other keys ignored: each name an MCP's, none listed
 * twice. For a `defineConfig` field's `schema`: the ops Jobs' `OPS_MCPS` and the migration Job's `MCPS_DECLARED`.
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
  .pipe(z.array(declaredMcp).refine(mcps => new Set(mcps.map(({ name }) => name)).size === mcps.length, "An MCP is listed twice"))
