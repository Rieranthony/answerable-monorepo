import { describe, expect, test } from "bun:test";

import { parseScope, uniqueSorted } from "./scopes.ts";

describe("unit: scopes", () => {
  test("deduplicates and sorts a scope set", () => {
    expect(uniqueSorted(["write", "read", "write"])).toEqual(["read", "write"]);
    expect(uniqueSorted(new Set(["b", "a"]))).toEqual(["a", "b"]);
    expect(uniqueSorted([])).toEqual([]);
  });
  test("splits a scope parameter and drops empty entries", () => {
    expect(parseScope("openid  read write")).toEqual([
      "openid",
      "read",
      "write",
    ]);
    expect(parseScope("")).toEqual([]);
    expect(parseScope(null)).toEqual([]);
    expect(parseScope(undefined)).toEqual([]);
  });
});
