import { organisationIsolation } from "@answerable/mcp-postgres"
import * as pg from "drizzle-orm/pg-core"

/** A fixture MCP's tables, as `bun mcp new` writes them: schema pltfix, its notes limited to the caller's organisation. */
const pltfixSchema = pg.pgSchema("pltfix")
export const notes = pltfixSchema.table("notes", {
  id: pg.uuid().primaryKey().$defaultFn(() => Bun.randomUUIDv7()),
  organisation_id: pg.uuid().notNull(),
  title: pg.text().notNull(),
}, table => [organisationIsolation(table.organisation_id)]).enableRLS()
