import {
  eq,
  ilike,
  lt,
  or,
  type Column,
  type GetColumnData,
  type SQL,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/** List queries filter on what the caller gave, order by a descending key
 * and fetch `limit + 1` rows; these helpers build the filters and the cursor
 * predicate and cut the extra row into the page. */

/** Equality on the column when a value is given; no condition otherwise. */
export function optionalEq<C extends Column>(
  column: C,
  value: GetColumnData<C, "raw"> | undefined,
): SQL | undefined {
  return value === undefined ? undefined : eq(column, value);
}

/** Case-insensitive substring match on any of the columns. `%`, `_` and `\`
 * in `q` match themselves. */
export function contains(
  q: string | undefined,
  ...columns: PgColumn[]
): SQL | undefined {
  if (q === undefined) return undefined;
  const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  return or(...columns.map((column) => ilike(column, pattern)));
}

export function beforeCursor(
  column: PgColumn,
  cursor: string | undefined,
): SQL | undefined {
  return cursor === undefined ? undefined : lt(column, cursor);
}

/** The first `limit` rows, and the key of the last one when more follow. */
export function cursorPage<
  K extends PropertyKey = "id",
  T extends Record<K, string> = Record<K, string>,
>(
  rows: T[],
  limit: number,
  key: K = "id" as K,
): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  return {
    items,
    nextCursor: rows.length > limit ? items[items.length - 1]![key] : null,
  };
}
