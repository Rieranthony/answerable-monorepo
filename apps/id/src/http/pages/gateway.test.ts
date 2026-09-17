import { expect, test } from "bun:test";
import { Hono } from "hono";
import { stubAuth, testEnvironment } from "../../__tests__/support.ts";
import type { AppEnvironment } from "../context.ts";
import { callAuth, applyCookies } from "./gateway.ts";

test("gateway forwards only the required headers and appends every response cookie", async () => {
  for (const withBody of [true, false]) {
    const app = new Hono<AppEnvironment>();
    const auth = stubAuth();
    auth.handler = async (request) => {
      expect(request.url).toBe(
        "http://localhost:47300/auth/" +
          (withBody ? "sign-out" : "get-session"),
      );
      for (const name of ["cookie", "user-agent", "x-forwarded-for"])
        expect(request.headers.get(name)).toBe(
          withBody ? name + "-value" : null,
        );
      expect(request.headers.get("origin")).toBe(
        withBody ? "https://foreign.example" : null,
      );
      expect(request.headers.get("x-request-id")).toBe("request-123");
      expect(request.headers.get("accept")).toBe("application/json");
      expect(request.headers.get("content-type")).toBe(
        withBody ? "application/json" : null,
      );
      expect(await request.text()).toBe(withBody ? "{}" : "");
      return withBody
        ? Response.json(
            { success: true },
            {
              headers: [
                ["set-cookie", "one=1"],
                ["set-cookie", "two=2"],
              ],
            },
          )
        : new Response("not json");
    };
    app.all("/", async (c) => {
      c.set("auth", auth);
      c.set("environment", testEnvironment());
      c.set("requestId", "request-123");
      const result = await callAuth<{ success: boolean }>(c, {
        method: withBody ? "POST" : "GET",
        path: withBody ? "/auth/sign-out" : "/auth/get-session",
        body: withBody ? {} : undefined,
        origin: withBody ? c.req.header("origin")! : null,
      });
      expect(result.data).toEqual(withBody ? { success: true } : null);
      expect(result.status).toBe(200);
      expect(result.ok).toBe(true);
      c.header("set-cookie", "existing=3");
      applyCookies(c, result.setCookies);
      return c.text("ok");
    });
    const response = await app.request("/", {
      headers: withBody
        ? {
            cookie: "cookie-value",
            "user-agent": "user-agent-value",
            "x-forwarded-for": "x-forwarded-for-value",
            origin: "https://foreign.example",
          }
        : {},
    });
    expect(response.headers.getSetCookie()).toEqual(
      withBody ? ["existing=3", "one=1", "two=2"] : ["existing=3"],
    );
  }
});
test("gateway refuses routes that clients cannot reach", async () => {
  const app = new Hono<AppEnvironment>();
  app.get("/", async (c) => {
    await expect(
      callAuth(c, {
        method: "POST",
        path: "/auth/organization/create",
        origin: null,
      }),
    ).rejects.toThrow("non-public");
    return c.text("ok");
  });
  expect((await app.request("/")).status).toBe(200);
});
