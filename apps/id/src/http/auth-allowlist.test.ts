import { expect, test } from "bun:test";
import {
  allowedTokenGrantTypes,
  inspectTokenRequest,
  isAllowedAuthRoute,
} from "./auth-allowlist.ts";

test("only POST is allowlisted for the token endpoint", () => {
  expect(isAllowedAuthRoute("post", "/auth/oauth2/token")).toBe(true);
  expect(isAllowedAuthRoute("GET", "/auth/oauth2/token")).toBe(false);
  expect(isAllowedAuthRoute("POST", "/auth/oauth2/token/extra")).toBe(false);
  expect([...allowedTokenGrantTypes]).toEqual(["client_credentials"]);
});

test("unsupported and empty form grants receive an uncached OAuth error", async () => {
  for (const grant of ["authorization_code", "refresh_token", "unknown", ""]) {
    const request = new Request("http://localhost/auth/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
      body: new URLSearchParams({ grant_type: grant }),
    });
    const response = await inspectTokenRequest(request);
    expect(response?.status).toBe(400);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(await response?.json()).toEqual({
      error: "unsupported_grant_type",
      error_description: "Only client_credentials is available.",
    });
    expect((await request.formData()).get("grant_type")).toBe(grant);
  }
});

test("allowed and missing grants pass through without consuming the body", async () => {
  for (const body of [
    "grant_type=client_credentials",
    "scope=platform%3Aread",
  ]) {
    const request = new Request("http://localhost/auth/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    expect(await inspectTokenRequest(request)).toBeNull();
    expect(await request.text()).toBe(body);
  }
});

test("other media types and absent content type are left to Better Auth", async () => {
  for (const contentType of [undefined, "application/json", "text/plain"]) {
    const request = new Request("http://localhost/auth/oauth2/token", {
      method: "POST",
      headers: contentType ? { "Content-Type": contentType } : {},
      body: new TextEncoder().encode('{"grant_type":"authorization_code"}'),
    });
    expect(await inspectTokenRequest(request)).toBeNull();
  }
});

test("an unreadable form body is left to Better Auth", async () => {
  const request = new Request("http://localhost/auth/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new ReadableStream({
      start(controller) {
        controller.error(new Error("unreadable body"));
      },
    }),
  });
  expect(await inspectTokenRequest(request)).toBeNull();
});
