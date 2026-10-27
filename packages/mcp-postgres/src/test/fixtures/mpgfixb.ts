import { pgSchema, text, uuid } from "drizzle-orm/pg-core"
import { organisationIsolation } from "../../organisation"

/** A second fixture MCP, whose rows the first must never reach. */
export const mpgfixb = pgSchema("mpgfixb")
export const secrets = mpgfixb.table("secrets", { id: uuid().primaryKey().defaultRandom(), organisation_id: uuid().notNull(), value: text().notNull() }, secrets => [organisationIsolation(secrets.organisation_id)]).enableRLS()
