// The connection budget of docs/12-deployment.md (Database), as numbers: what the servers can open at their autoscalers' ceilings in each
// environment, against the database's limit. bun mcp check warns from these when MCPs with a database of their own would pass it.
import type { Declaration } from "./workspace"

export const budget = {
  /** The connections the database accepts: PostgreSQL's default max_connections, an assumption until B7a measures Civo's (docs/12). */
  maxConnections: 100,
  /** Each server's replicas at its autoscaler's ceiling, as charts/answerable/values-civo-<environment>.yaml sets them. */
  replicas: {
    staging: { id: 4, toolbox: 3, adminMcp: 3 },
    production: { id: 6, toolbox: 4, adminMcp: 4 },
  },
  /** ID's pool, DATABASE_POOL_MAX; every other pool is pg's default size. */
  pool: { id: 20, other: 10 },
} as const

type Environment = keyof typeof budget.replicas

/**
 * What an environment's servers open at their autoscalers' ceilings, with `mcps` declared: ID's pool; the admin MCP's; the Toolbox's two (its own
 * database and answerable_mcps) and one per own MCP, since it serves every MCP. `own` is the own MCPs' share.
 */
export function connectionsAtCeilings(mcps: readonly Pick<Declaration, "database">[], environment: Environment): { total: number; own: number } {
  const { id, toolbox, adminMcp } = budget.replicas[environment]
  const own = budget.pool.other * toolbox * mcps.filter(mcp => mcp.database === "own").length
  const shared = id * budget.pool.id + adminMcp * budget.pool.other + toolbox * 2 * budget.pool.other
  return { total: shared + own, own }
}
