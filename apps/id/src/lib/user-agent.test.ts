import { expect, test } from "bun:test";
import { boundedUserAgent } from "./user-agent.ts";

test("user-agent is bounded printable metadata, never a partial value", () => {
  for (const value of [
    undefined,
    null,
    "",
    "x".repeat(513),
    "x\ty",
    "x\ny",
    "x\n",
    "x\r",
    "x\x7fy",
    "🚀",
  ])
    expect(boundedUserAgent(value)).toBeNull();
  for (const value of ["Mozilla/5.0 (compatible; client/1.2)", "x".repeat(512)])
    expect(boundedUserAgent(value)).toBe(value);
});
