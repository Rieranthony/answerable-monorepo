import { describe, expect, test } from "bun:test";
import { pageQuerySchema } from "./pagination.ts";

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
});
