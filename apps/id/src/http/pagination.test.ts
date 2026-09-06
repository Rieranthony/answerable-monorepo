import { describe, expect, test } from "bun:test";
import { PgDialect, pgTable, uuid } from "drizzle-orm/pg-core";
import { beforeCursor, cursorPage, pageQuerySchema } from "./pagination.ts";

const cursor = "01900000-0000-7000-8000-000000000001";
describe("unit: pagination", () => {
  test("parses defaults and valid bounds", () => {
    expect(pageQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(pageQuerySchema.parse({ limit: "1", cursor })).toEqual({
      limit: 1,
      cursor,
    });
    expect(pageQuerySchema.parse({ limit: "200" })).toEqual({ limit: 200 });
  });
  test("rejects invalid limits and cursors", () => {
    for (const limit of [0, -1, 201, 1.5, "bad"])
      expect(pageQuerySchema.safeParse({ limit }).success).toBe(false);
    expect(pageQuerySchema.safeParse({ cursor: "bad" }).success).toBe(false);
  });
  test("returns empty, partial, full and continuing pages", () => {
    const rows = [
      { id: "c", name: "C" },
      { id: "b", name: "B" },
      { id: "a", name: "A" },
    ];
    expect(cursorPage([], 2)).toEqual({ items: [], nextCursor: null });
    expect(cursorPage(rows.slice(0, 1), 2)).toEqual({
      items: rows.slice(0, 1),
      nextCursor: null,
    });
    expect(cursorPage(rows.slice(0, 2), 2)).toEqual({
      items: rows.slice(0, 2),
      nextCursor: null,
    });
    expect(cursorPage(rows, 2)).toEqual({
      items: rows.slice(0, 2),
      nextCursor: "b",
    });
    expect(rows).toHaveLength(3);
  });
  test("renders a parameterised descending cursor predicate", () => {
    const table = pgTable("items", { id: uuid().primaryKey() });
    expect(beforeCursor(table.id, undefined)).toBeUndefined();
    expect(
      new PgDialect().sqlToQuery(beforeCursor(table.id, cursor)!),
    ).toMatchObject({ sql: '"items"."id" < $1', params: [cursor] });
  });
});
