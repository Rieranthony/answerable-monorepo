import { locally } from "@answerable/config"
import { ownMcpDatabase } from "@answerable/mcp-postgres"
import { z } from "zod"
import type { Declared } from "./databases"

/**
 * What a server's typed configuration (`defineConfig`) reads for the own MCPs of its generated list: `fields`, each one's database URL as its
 * runtime login, from the variable its entry names, with the local database as the development and test default; and `urls(data)`, the parsed
 * values by variable, for `mcpDatabases`' `own`.
 */
export function ownDatabases(declared: readonly Declared[]) {
  const fields = Object.fromEntries(declared.flatMap(entry => {
    if (entry.database !== "own") return []
    const { database, runtime } = ownMcpDatabase(entry.provider.id)
    const field = {
      schema: z.url(),
      secret: true,
      defaults: locally(`postgres://${runtime}:answerable@localhost:47432/${database}`),
      doc: `The database of the ${entry.provider.id} MCP, its own, as its runtime login`,
      source: "cluster",
    } as const
    return [[entry.variable, field]]
  }))
  return { fields, urls: (data: Readonly<Record<string, unknown>>) => Object.fromEntries(Object.keys(fields).map(name => [name, String(data[name])])) }
}
