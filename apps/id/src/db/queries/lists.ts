import { lt, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

/** List queries order by a descending key and fetch `limit + 1` rows; these
 * helpers build the cursor predicate and cut the extra row into the page. */

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
