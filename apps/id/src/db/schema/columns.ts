import { sql, type SQL } from "drizzle-orm";
import {
  boolean,
  check,
  timestamp,
  uuid,
  type PgColumn,
} from "drizzle-orm/pg-core";

/**
 * Application-generated UUIDv7 with no database default, so a raw insert
 * without an id fails instead of silently minting a UUIDv4.
 */
export const id = () => uuid("id").primaryKey();

export const timestampColumn = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

/**
 * Soft deletion for the live foreign keys. `live` is true while `deleted_at`
 * is null and null once the row is deleted, so a parent's `(id, live)` key
 * vanishes on deletion and a deleted child's `(parent_id, live)` is not
 * checked (MATCH SIMPLE). One column serves both roles. The deletion trigger
 * assigns it from `deleted_at`, so writers never set it, and the CHECK
 * refuses any other value. A plain column, not a generated one: Postgres
 * locks every update of a table with a BEFORE UPDATE trigger and a stored
 * generated column in a unique key as a key update, which would block every
 * concurrent foreign-key check on the row. A live foreign key repeats its
 * plain foreign key's delete action: Postgres fires the two in no fixed order,
 * so a NO ACTION live key beside a cascading plain key could refuse a hard
 * delete the plain key would cascade.
 *
 * A deleted row also holds no authority or credentials: `whenDeleted` names
 * what must hold once `deleted_at` is set.
 */
export const softDeletion = () => ({
  deletedAt: timestampColumn("deleted_at"),
  live: boolean("live").default(true),
});

export const softDeletionChecks = (
  table: string,
  columns: { deletedAt: PgColumn; live: PgColumn },
  whenDeleted?: SQL,
) => [
  check(
    `${table}_live_check`,
    sql`${columns.live} is not distinct from case when ${columns.deletedAt} is null then true end`,
  ),
  ...(whenDeleted
    ? [
        check(
          `${table}_deleted_check`,
          sql`${columns.deletedAt} is null or (${whenDeleted})`,
        ),
      ]
    : []),
];

/**
 * The created_at/updated_at pair. Drizzle writes updated_at on every update
 * it issues, including those from Better Auth's adapter. Both defaults and
 * automatic updates use the database clock, without a trigger or per-query code.
 */
export const timestamps = () => ({
  createdAt: timestampColumn("created_at").defaultNow().notNull(),
  updatedAt: timestampColumn("updated_at")
    .defaultNow()
    .notNull()
    .$onUpdate(() => sql`statement_timestamp()`),
});

export const effectiveWindow = () => ({
  validFrom: timestampColumn("valid_from"),
  validUntil: timestampColumn("valid_until"),
});

export const windowCheck = (
  name: string,
  validFrom: PgColumn,
  validUntil: PgColumn,
) => check(name, sql`${validFrom} < ${validUntil}`);

const quoteLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

/**
 * CHECK constraint restricting a column to a vocabulary. The values are
 * compile-time constants, so they are inlined as literals.
 */
export const vocabularyCheck = (
  name: string,
  column: PgColumn,
  values: readonly string[],
) =>
  check(
    name,
    sql`${column} in (${sql.raw(values.map(quoteLiteral).join(", "))})`,
  );

/** A status column and its disabled_at timestamp must agree. */
export const disabledCheck = (
  name: string,
  status: PgColumn,
  disabledAt: PgColumn,
) => check(name, sql`(${status} = 'disabled') = (${disabledAt} is not null)`);

/** Lowercase labels separated by single hyphens: `contoso`, `omni-chat`. */
export const slugCheck = (name: string, column: PgColumn) =>
  check(name, sql`${column} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`);

/** A lowercase ASCII host name with at least two labels (IDNs as punycode). */
export const hostnamePattern =
  "^[a-z0-9]([a-z0-9-]*[a-z0-9])?([.][a-z0-9]([a-z0-9-]*[a-z0-9])?)+$";

export const hostnameCheck = (name: string, column: PgColumn) =>
  check(name, sql`${column} ~ ${sql.raw(quoteLiteral(hostnamePattern))}`);
