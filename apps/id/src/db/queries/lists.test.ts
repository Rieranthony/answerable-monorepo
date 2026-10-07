import { describe, expect, test } from "bun:test";
import { PgDialect, pgTable, uuid } from "drizzle-orm/pg-core";
import { beforeCursor, cursorPage } from "./lists.ts";

const cursor = "01900000-0000-7000-8000-000000000001";
describe("unit: list helpers", () => {
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
  test("pages by another key when the list orders by it", () => {
    const rows = [{ memberId: "c" }, { memberId: "b" }, { memberId: "a" }];
    expect(cursorPage(rows, 2, "memberId")).toEqual({
      items: rows.slice(0, 2),
      nextCursor: "b",
    });
  });
  test("renders a parameterised descending cursor predicate", () => {
    const table = pgTable("items", { id: uuid().primaryKey() });
    expect(beforeCursor(table.id, undefined)).toBeUndefined();
    expect(
      new PgDialect().sqlToQuery(beforeCursor(table.id, cursor)!),
    ).toMatchObject({ sql: '"items"."id" < $1', params: [cursor] });
  });
});
