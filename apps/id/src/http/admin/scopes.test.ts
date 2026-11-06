import { expect, test } from "bun:test";
import { adminScopes, holdsScope } from "./scopes.ts";

test("org:read holds org:members, and nothing else is widened", () => {
  expect(holdsScope(["org:read"], "org:members")).toBe(true);
  expect(holdsScope(["org:members"], "org:members")).toBe(true);
  expect(holdsScope(["org:members"], "org:read")).toBe(false);
  expect(holdsScope(["org:users"], "org:members")).toBe(false);
  for (const scope of adminScopes.filter((s) => s.startsWith("platform:")))
    expect(holdsScope(["org:read", "org:members", "org:users"], scope)).toBe(
      false,
    );
  for (const scope of adminScopes) {
    expect(holdsScope([], scope)).toBe(false);
    expect(holdsScope([scope], scope)).toBe(true);
  }
});
