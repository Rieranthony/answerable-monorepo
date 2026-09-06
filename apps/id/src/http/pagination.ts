import { lt, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";

export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.uuid().optional(),
});

export type PageQuery = z.output<typeof pageQuerySchema>;

export function cursorPage<T extends { id: string }>(
  rows: T[],
  limit: number,
): { items: T[]; nextCursor: string | null } {
  const items = rows.slice(0, limit);
  return {
    items,
    nextCursor: rows.length > limit ? items[items.length - 1].id : null,
  };
}

export function beforeCursor(
  column: PgColumn,
  cursor: string | undefined,
): SQL | undefined {
  return cursor === undefined ? undefined : lt(column, cursor);
}
