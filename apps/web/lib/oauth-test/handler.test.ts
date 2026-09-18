import { expect, test } from "bun:test"
import { handleOAuthTest } from "./handler"
import { OAuthTestClient } from "./client"
const client = new OAuthTestClient({
  issuer: "http://localhost:47300",
  clientId: "test",
  clientSecret: "secret",
  redirectUri: "http://localhost:47100/api/oauth-test/callback",
})
test("all OAuth test actions are inaccessible outside development", async () => {
  for (const action of ["login", "callback", "refresh", "revoke", "logout"]) {
    const r = await handleOAuthTest(
      new Request(`http://localhost:47100/api/oauth-test/${action}`),
      action,
      false,
      () => {
        throw new Error("must not load credentials")
      },
    )
    expect(r.status).toBe(404)
  }
})
test("mutations require POST from the configured app origin", async () => {
  for (const origin of [undefined, "null", "http://evil.example"]) {
    const r = await handleOAuthTest(
      new Request("http://localhost:47100/api/oauth-test/logout", {
        method: "POST",
        headers: origin ? { origin } : {},
      }),
      "logout",
      true,
      () => client,
    )
    expect(r.status).toBe(403)
  }
  expect(
    (
      await handleOAuthTest(
        new Request("http://localhost:47100/api/oauth-test/logout"),
        "logout",
        true,
        () => client,
      )
    ).status,
  ).toBe(405)
})
test("local logout clears the app cookie and never calls ID", async () => {
  const r = await handleOAuthTest(
    new Request("http://localhost:47100/api/oauth-test/logout", {
      method: "POST",
      headers: { origin: "http://localhost:47100" },
    }),
    "logout",
    true,
    () => client,
  )
  expect(r.status).toBe(303)
  expect(r.headers.get("set-cookie")).toContain(
    "HttpOnly; SameSite=Lax; Max-Age=0",
  )
})
test("callback errors do not expose code or provider error descriptions", async () => {
  const r = await handleOAuthTest(
    new Request(
      "http://localhost:47100/api/oauth-test/callback?code=secret&error_description=private",
    ),
    "callback",
    true,
    () => client,
  )
  expect(r.headers.get("location")).toBe(
    "http://localhost:47100/oauth-test?result=callback-failed",
  )
})
