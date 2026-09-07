import { expect, test } from "bun:test";
import { secretMatches } from "./root-secret.ts";

test.each([
  ["secret", "secret", true],
  ["secret", "secrex", false],
  ["secret", "short", false],
  ["secret", "", false],
] as const)("compares digests: %s / %s", (expected, candidate, matches) => {
  expect(secretMatches(expected, candidate)).toBe(matches);
});
