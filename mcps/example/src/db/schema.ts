import { organisationIsolation } from "@answerable/mcp-postgres"
import * as pg from "drizzle-orm/pg-core"

// The tables of the example MCP, in its own Postgres schema, example. After a change here, bun mcp db example generate writes the
// migration; bun mcp add tool adds the table a new domain needs.
//
// Every table has organisation_id and the organisationIsolation policy, with .enableRLS(): Postgres then limits every query to the
// caller's organisation, even one that forgets to filter. A table without them is shared by every organisation: a reviewed exception,
// with a comment above it saying why.
//
//   export const projects = exampleSchema.table("projects", {
//     id: pg.uuid().primaryKey().$defaultFn(() => Bun.randomUUIDv7()),
//     organisation_id: pg.uuid().notNull(),
//     name: pg.text().notNull(),
//   }, table => [organisationIsolation(table.organisation_id)]).enableRLS()
export const exampleSchema = pg.pgSchema("example")

//#region notes
// The notes table: each organisation's rows. The id is a UUID v7, so ids sort by creation.
export const notes = exampleSchema.table("notes", {
  id: pg.uuid().primaryKey().$defaultFn(() => Bun.randomUUIDv7()),
  organisation_id: pg.uuid().notNull(),
  title: pg.text().notNull(),
  created_at: pg.timestamp({ withTimezone: true }).notNull().defaultNow(),
}, table => [organisationIsolation(table.organisation_id)]).enableRLS()
//#endregion
