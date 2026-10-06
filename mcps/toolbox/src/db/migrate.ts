import type { SQL } from "bun"
import { migrate as migrateFiles, migrations } from "@answerable/mcp-postgres"

const toolbox = { name: "toolbox", url: new URL("../../migrations/", import.meta.url) }

/** Apply `@answerable/mcp-postgres`'s migrations, then the Toolbox's own, `0001_initial.sql`, and return the names applied. */
export const migrate = (db: SQL): Promise<string[]> => migrateFiles(db, [migrations, toolbox])
