import type { SQL } from "bun"
import { migrate as migrateFiles, migrations, runtimeGrants as evidenceGrants, type Grant } from "@answerable/mcp-postgres"

const toolbox = { name: "toolbox", url: new URL("../../migrations/", import.meta.url) }

/** Apply `@answerable/mcp-postgres`'s migrations, then the Toolbox's own, `0001_initial.sql`, and return the names applied. */
export const migrate = (db: SQL): Promise<string[]> => migrateFiles(db, [migrations, toolbox])

/**
 * What the Toolbox's runtime role may do, for `configureRuntimeRole` after every migration: `@answerable/mcp-postgres`'s grants, and on its own
 * tables what the boot's ingest, each request's catalogue read and the admin API's writes need. A provider row is only ever added (its
 * `on conflict` reads the key); capabilities and catalogue rows are added and updated, never deleted; host clients are also removed.
 */
export const runtimeGrants: readonly Grant[] = [
  ...evidenceGrants,
  { table: "providers", privileges: ["select", "insert"] },
  { table: "capabilities", privileges: ["select", "insert", "update"] },
  { table: "organisation_catalogue", privileges: ["select", "insert", "update"] },
  { table: "host_clients", privileges: ["select", "insert", "update", "delete"] },
]
