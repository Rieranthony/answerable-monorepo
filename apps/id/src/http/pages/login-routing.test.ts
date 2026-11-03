import { describe, expect, test } from "bun:test";

import {
  decideLoginRoute,
  isLoginAddress,
  maxLoginAddressLength,
  pendingOAuthQuery,
} from "./login-routing.ts";

describe("unit: login routing", () => {
  test("automatically routes a valid organization without a login hint", () => {
    expect(decideLoginRoute(new URLSearchParams("organization=acme"))).toEqual({
      mode: "auto",
      organizationSlug: "acme",
    });
    expect(
      decideLoginRoute(new URLSearchParams("organization=answerable-studio")),
    ).toEqual({
      mode: "auto",
      organizationSlug: "answerable-studio",
    });
  });

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
      });
    }
  });

  test("a login hint overrides automatic organization routing", () => {
    expect(
      decideLoginRoute(
        new URLSearchParams({
          organization: "acme",
          login_hint: "staff@answerable.org",
        }),
      ),
    ).toEqual({ mode: "form", email: "staff@answerable.org" });

    expect(
      decideLoginRoute(
        new URLSearchParams({ organization: "acme", login_hint: "" }),
      ),
    ).toEqual({ mode: "form" });
  });

  test("only carries a login hint into the form when it looks like email", () => {
    expect(
      decideLoginRoute(new URLSearchParams("login_hint=user%40example.com")),
    ).toEqual({ mode: "form", email: "user@example.com" });
    expect(
      decideLoginRoute(new URLSearchParams("login_hint=not-an-email")),
    ).toEqual({ mode: "form" });
  });

  test("an address is at most 254 characters", () => {
    const suffix = "@example.com";
    const atBound = "a".repeat(maxLoginAddressLength - suffix.length) + suffix;
    expect(atBound).toHaveLength(254);
    expect(isLoginAddress(atBound)).toBe(true);
    expect(isLoginAddress("a" + atBound)).toBe(false);
    expect(
      decideLoginRoute(new URLSearchParams({ login_hint: atBound })),
    ).toEqual({ mode: "form", email: atBound });
    expect(
      decideLoginRoute(new URLSearchParams({ login_hint: "a" + atBound })),
    ).toEqual({ mode: "form" });
  });

  test("an address has one @ and a dot after it, with no whitespace", () => {
    for (const value of ["person@example.com", "a@b.c", "a.b@c.d.e"])
      expect(isLoginAddress(value)).toBe(true);
    for (const value of [
      "",
      "person",
      "person@",
      "@example.com",
      "person@example",
      "person@@example.com",
      "person @example.com",
      "person@exa mple.com",
    ])
      expect(isLoginAddress(value)).toBe(false);
  });

  test("a long run of dots is judged on its length alone", () => {
    for (const run of [100, 300, 60_000]) {
      const value = "a@" + ".".repeat(run) + " ";
      expect(isLoginAddress(value)).toBe(false);
      expect(
        decideLoginRoute(new URLSearchParams({ login_hint: value })),
      ).toEqual({ mode: "form" });
    }
    // Inside the bound the pattern still decides.
    expect(isLoginAddress("a@" + ".".repeat(250))).toBe(true);
    expect(isLoginAddress("a@" + ".".repeat(250) + " ")).toBe(false);
    expect(isLoginAddress("a@" + ".".repeat(252))).toBe(true);
    expect(isLoginAddress("a@" + ".".repeat(253))).toBe(false);
  });

  test("returns a signed OAuth query only when client_id and sig are present", () => {
    const signed = new URLSearchParams(
      "client_id=cell&scope=openid+email&sig=signature&ba_param=client_id",
    );

    expect(pendingOAuthQuery(signed)).toBe(signed.toString());
    expect(pendingOAuthQuery(new URLSearchParams("client_id=cell"))).toBeNull();
    expect(pendingOAuthQuery(new URLSearchParams("sig=signature"))).toBeNull();
  });
});
