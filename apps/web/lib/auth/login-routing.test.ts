import { describe, expect, test } from "bun:test"

import { decideLoginRoute, pendingOAuthQuery } from "./login-routing"

describe("unit: login routing", () => {
  test("automatically routes a valid organization without a login hint", () => {
    expect(decideLoginRoute(new URLSearchParams("organization=acme"))).toEqual({
      mode: "auto",
      organizationSlug: "acme",
    })
    expect(
      decideLoginRoute(new URLSearchParams("organization=answerable-studio")),
    ).toEqual({
      mode: "auto",
      organizationSlug: "answerable-studio",
    })
  })

  test("shows the form for invalid organization slugs", () => {
    for (const organization of [
      "",
      "Acme",
      "acme_uk",
      "-acme",
      "acme-",
      "acme--uk",
    ]) {
      expect(decideLoginRoute(new URLSearchParams({ organization }))).toEqual({
        mode: "form",
      })
    }
  })

  test("a login hint overrides automatic organization routing", () => {
    expect(
      decideLoginRoute(
        new URLSearchParams({
          organization: "acme",
          login_hint: "staff@answerable.org",
        }),
      ),
    ).toEqual({ mode: "form", email: "staff@answerable.org" })

    expect(
      decideLoginRoute(
        new URLSearchParams({ organization: "acme", login_hint: "" }),
      ),
    ).toEqual({ mode: "form" })
  })

  test("only carries a login hint into the form when it looks like email", () => {
    expect(
      decideLoginRoute(new URLSearchParams("login_hint=user%40example.com")),
    ).toEqual({ mode: "form", email: "user@example.com" })
    expect(
      decideLoginRoute(new URLSearchParams("login_hint=not-an-email")),
    ).toEqual({ mode: "form" })
  })

  test("returns a signed OAuth query only when client_id and sig are present", () => {
    const signed = new URLSearchParams(
      "client_id=cell&scope=openid+email&sig=signature&ba_param=client_id",
    )

    expect(pendingOAuthQuery(signed)).toBe(signed.toString())
    expect(pendingOAuthQuery(new URLSearchParams("client_id=cell"))).toBeNull()
    expect(pendingOAuthQuery(new URLSearchParams("sig=signature"))).toBeNull()
  })
})
