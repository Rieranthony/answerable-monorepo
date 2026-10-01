import type { SQL } from "bun"
import { migrate as migrateFiles, migrations } from "@answerable/mcp-postgres"

const directory = new URL("../../migrations/", import.meta.url)

/** Apply the Toolbox's own migrations, `0001_catalogue.sql` and `0003_host_clients.sql`, and `@answerable/mcp-postgres`'s, in the order of their names, and return the names applied. */
export const migrate = (db: SQL): Promise<string[]> => migrateFiles(db, [directory, migrations])
