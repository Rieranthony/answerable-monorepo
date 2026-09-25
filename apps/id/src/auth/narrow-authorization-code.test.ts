import { expect, test } from "bun:test";
import { narrowAuthorizationCode } from "./narrow-authorization-code.ts";

test("only authorisation codes bound to the grant can be narrowed", () => {
  const invalid = () => new Error("invalid flow");
  const code = {
    type: "authorization_code",
    referenceId: "grant",
    query: { scope: "openid read write", state: "state" },
    userId: "user",
  };
  expect(
    JSON.parse(
      narrowAuthorizationCode(
        JSON.stringify(code),
        "grant",
        ["openid", "read"],
        invalid,
      ),
    ),
  ).toEqual({ ...code, query: { ...code.query, scope: "openid read" } });
  const other = JSON.stringify({ type: "other" });
  for (const value of [other, "plain verification", "null", "42"]) {
    expect(narrowAuthorizationCode(value, "grant", ["read"], invalid)).toBe(
      value,
    );
  }
  expect(() =>
    narrowAuthorizationCode(
      JSON.stringify({ ...code, query: {} }),
      "grant",
      ["read"],
      invalid,
    ),
  ).toThrow("invalid flow");
  expect(() =>
    narrowAuthorizationCode(JSON.stringify(code), "other", ["read"], invalid),
  ).toThrow("invalid flow");
  expect(() =>
    narrowAuthorizationCode(JSON.stringify(code), "grant", ["absent"], invalid),
  ).toThrow("invalid flow");
});
