// The connection budget of docs/12-deployment.md (Database), as numbers: what the servers can open at their autoscalers' ceilings in each
// environment, against the database's limit. bun mcp check warns from these when MCPs with a database of their own would pass it.
import type { Declaration } from "./workspace"

export const budget = {
  /** The connections the database accepts: PostgreSQL's default max_connections, an assumption until B7a measures Civo's (docs/12). */
  maxConnections: 100,
  /** Each server's replicas at its autoscaler's ceiling, as charts/answerable/values-civo-<environment>.yaml sets them. */
  replicas: {
    staging: { id: 4, toolbox: 3, adminMcp: 3, standalone: 3 },
    production: { id: 6, toolbox: 4, adminMcp: 4, standalone: 4 },
  },
  /** ID's pool, DATABASE_POOL_MAX; every other pool is pg's default size. */
  pool: { id: 20, other: 10 },
} as const

type Environment = keyof typeof budget.replicas

/**
 * What an environment's servers open at their autoscalers' ceilings, with `mcps` declared: ID's pool; the admin MCP's; the Toolbox's two
 * (its own database and answerable_mcps) and one per own MCP it mounts; the same for the standalone server while it serves an MCP. `own` is
 * the own MCPs' share.
 */
export function connectionsAtCeilings(mcps: readonly Pick<Declaration, "serve" | "database">[], environment: Environment): { total: number; own: number } {
  const { id, toolbox, adminMcp, standalone } = budget.replicas[environment]
  // The MCPs each server serves: the Toolbox those not standalone, the standalone server those not toolbox.
  const ownOf = (other: Declaration["serve"]) => mcps.filter(mcp => mcp.database === "own" && mcp.serve !== other).length
  const standaloneRuns = mcps.some(mcp => mcp.serve !== "toolbox")
  const own = budget.pool.other * (toolbox * ownOf("standalone") + standalone * ownOf("toolbox"))
  const shared = id * budget.pool.id + adminMcp * budget.pool.other + toolbox * 2 * budget.pool.other + (standaloneRuns ? standalone * 2 * budget.pool.other : 0)
  return { total: shared + own, own }
}
