import { sql } from "drizzle-orm";
import { check, timestamp, uuid, type PgColumn } from "drizzle-orm/pg-core";

/**
 * Application-generated UUIDv7 with no database default, so a raw insert
 * without an id fails instead of silently minting a UUIDv4.
 */
export const id = () => uuid("id").primaryKey();

export const timestampColumn = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });

/**
 * The created_at/updated_at pair. Drizzle writes updated_at on every update
 * it issues, including those from Better Auth's adapter, so there is no
 * trigger and no per-query bookkeeping.
 */
export const timestamps = () => ({
  createdAt: timestampColumn("created_at").defaultNow().notNull(),
  updatedAt: timestampColumn("updated_at")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

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
) =>
  check(name, sql`(${status} = 'disabled') = (${disabledAt} is not null)`);

/** Lowercase labels separated by single hyphens: `contoso`, `omni-chat`. */
export const slugCheck = (name: string, column: PgColumn) =>
  check(name, sql`${column} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`);
