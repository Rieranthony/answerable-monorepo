import { fileURLToPath } from "node:url"
import { legacyBaseline as shared, migrate as apply, runtimeGrants as evidenceGrants, type Database, type Grant, type LegacyBaseline } from "@answerable/mcp-postgres"

/** The Toolbox's drizzle folder, `mcps/toolbox/drizzle`: `0000_initial.sql` makes the package's tables and the Toolbox's own, `0001_evidence_chain.sql` the chain's triggers. */
export const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url))

/**
 * What the file migrator recorded for a Toolbox database it built before drizzle: `@answerable/mcp-postgres`'s file and the Toolbox's own,
 * `toolbox/0001_initial.sql`, which the folder's first two migrations reproduce. The checksum is the SHA-256 of `src/test/legacy/0001_initial.sql`.
 */
export const legacyBaseline: LegacyBaseline = {
  records: { ...shared.records, "toolbox/0001_initial.sql": "12b832831cb814bf77d2841be02ba4bfdd76a3f43f23bcd92bc183c33c1cb3c0" },
  entries: shared.entries,
}

/** Apply the Toolbox's pending migrations, after adopting a database the file migrator built. */
export const migrate = (db: Database): Promise<void> => apply(db, { folder: migrationsFolder, legacy: legacyBaseline })

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
