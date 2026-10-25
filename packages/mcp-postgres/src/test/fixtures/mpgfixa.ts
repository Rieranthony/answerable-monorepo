import { pgSchema, serial, text, uuid } from "drizzle-orm/pg-core"
import { organisationIsolation } from "../../organisation"

/** A fixture MCP's tables, as `bun mcp new` writes them: a schema named after the MCP, each table limited to the caller's organisation. */
export const mpgfixa = pgSchema("mpgfixa")
export const projects = mpgfixa.table("projects", { id: uuid().primaryKey().defaultRandom(), organisation_id: uuid().notNull(), name: text().notNull() }, projects => [organisationIsolation(projects.organisation_id)]).enableRLS()
export const notes = mpgfixa.table("notes", {
  id: serial().primaryKey(),
  organisation_id: uuid().notNull(),
  project_id: uuid().notNull().references(() => projects.id),
  body: text().notNull(),
}, notes => [organisationIsolation(notes.organisation_id)]).enableRLS()
