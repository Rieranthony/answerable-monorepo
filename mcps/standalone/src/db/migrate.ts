import { fileURLToPath } from "node:url"
import { migrate as apply, type Database } from "@answerable/mcp-postgres"

/** The standalone server's drizzle folder, `mcps/standalone/drizzle`: `0000_initial.sql` makes `@answerable/mcp-postgres`'s tables, `0001_evidence_chain.sql` the chain's triggers. */
export const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url))

/** Apply the standalone server's pending migrations. */
export const migrate = (db: Database): Promise<void> => apply(db, { folder: migrationsFolder })
