import { organisationIsolation } from "@answerable/mcp-postgres"
import * as pg from "drizzle-orm/pg-core"

// The tables of the e2e MCP, in its own Postgres schema, e2e. After a change here, bun mcp db e2e generate writes the migration.
//
// Every table has organisation_id and the organisationIsolation policy, with .enableRLS(): Postgres then limits every query to the
// caller's organisation, even one that forgets to filter.
export const e2eSchema = pg.pgSchema("e2e")

// The test records: each organisation's own. The id is a UUID v7, so ids sort by creation; version starts at 1 and grows with every change,
// and records.delete binds it as its target's version.
export const records = e2eSchema.table("records", {
  id: pg.uuid().primaryKey().$defaultFn(() => Bun.randomUUIDv7()),
  organisation_id: pg.uuid().notNull(),
  creator_id: pg.uuid().notNull(),
  title: pg.text().notNull(),
  created_at: pg.timestamp({ withTimezone: true }).notNull().defaultNow(),
  version: pg.integer().notNull().default(1),
}, table => [organisationIsolation(table.organisation_id)]).enableRLS()
