import { expect, test } from "bun:test";
import { grantScopes } from "./grant-scopes.ts";

test("defaults are the intersection of every ceiling, never a union", () => {
  expect(
    grantScopes(undefined, [
      ["write", "read", "read"],
      ["read", "delete"],
      ["read"],
    ]),
  ).toEqual(["read"]);
  expect(grantScopes(undefined, [["read"], ["write"]])).toBeNull();
  expect(grantScopes(undefined, [])).toBeNull();
});
test("explicit scopes reject overreach rather than silently narrowing the request", () => {
  expect(
    grantScopes(["read", "write"], [["read", "write"], ["read"]]),
  ).toBeNull();
  expect(grantScopes([], [["read"]])).toBeNull();
  expect(grantScopes(["write", "read", "read"], [["read", "write"]])).toEqual([
    "read",
    "write",
  ]);
});
