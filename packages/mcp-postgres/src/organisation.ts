import { sql, type SQL } from "drizzle-orm"
import { pgPolicy, type PgColumn, type PgPolicy } from "drizzle-orm/pg-core"

/** The setting that carries the caller's organisation on a borrowed connection: `mcpDatabase` sets it, or resets it, on every borrow. */
export const organisationSetting = "answerable.organisation_id"

/**
 * The row-level security policy that limits a table to the caller's organisation (D19): permissive, for every command, with `using` and
 * `with check` both `<column> = nullif(current_setting('answerable.organisation_id', true), '')::uuid`. An unset or reset setting matches
 * no row, and a write for another organisation is refused. Put it in the table's extra-config array, beside `.enableRLS()`:
 *
 * ```ts
 * export const notes = acme.table("notes", { id: uuid().primaryKey(), organisation_id: uuid().notNull() }, notes => [organisationIsolation(notes.organisation_id)]).enableRLS()
 * ```
 */
export function organisationIsolation(column: PgColumn): PgPolicy {
  // An unset setting reads as NULL and a reset one as '', so both become NULL, which equals nothing.
  const match: SQL = sql`${column} = nullif(current_setting('${sql.raw(organisationSetting)}', true), '')::uuid`
  return pgPolicy("organisation_isolation", { as: "permissive", for: "all", using: match, withCheck: match })
}
