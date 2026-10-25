import { locally } from "@answerable/config"
import { z } from "zod"
import type { Declared } from "./databases"

/**
 * What a server's typed configuration (`defineConfig`) reads for the own MCPs of its generated list: `fields`, each one's database URL as its
 * runtime login, from the variable its entry names, with the local database as the development and test default; and `urls(data)`, the parsed
 * values by variable, for `mcpDatabases`' `own`.
 */
export function ownDatabases(declared: readonly Declared[]) {
  const fields = Object.fromEntries(declared.flatMap(entry => (entry.database === "own" ? [[entry.variable, {
    schema: z.url(),
    secret: true,
    defaults: locally(`postgres://answerable_mcp_${entry.provider.id}_runtime:answerable@localhost:47432/answerable_mcp_${entry.provider.id}`),
    doc: `The database of the ${entry.provider.id} MCP, its own, as its runtime login`,
    source: "cluster",
  } as const]] : [])))
  return { fields, urls: (data: Readonly<Record<string, unknown>>) => Object.fromEntries(Object.keys(fields).map(name => [name, String(data[name])])) }
}
