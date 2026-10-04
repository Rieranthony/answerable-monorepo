import { expect, test } from "bun:test";

import { describeError, describeSSOError, ERRORS } from "./error-copy.ts";

test("describes every known error without exposing its code and falls back otherwise", () => {
  const fallback = describeError(null);
  for (const code of Object.keys(ERRORS)) {
    const description = describeSSOError(code);
    expect(description, code).toBe(ERRORS[code]!);
    expect(description, code).not.toEqual(fallback);
    expect(description.title.length, code).toBeGreaterThan(0);
    expect(description.body.length, code).toBeGreaterThan(0);
    expect(`${description.title} ${description.body}`).not.toContain(code);
  }
  for (const code of [undefined, "unexpected_server_detail"])
    expect(describeSSOError(code)).toBe(fallback);
});
