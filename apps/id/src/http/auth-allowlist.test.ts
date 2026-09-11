import { expect, test } from "bun:test";
import { isAllowedAuthRoute } from "./auth-allowlist.ts";

test("only POST is allowlisted for the token endpoint", () => {
  expect(isAllowedAuthRoute("post", "/auth/oauth2/token")).toBe(true);
  expect(isAllowedAuthRoute("GET", "/auth/oauth2/token")).toBe(false);
  expect(isAllowedAuthRoute("POST", "/auth/oauth2/token/extra")).toBe(false);
});
