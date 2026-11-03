import { expect, test } from "bun:test";
import { Hono } from "hono";

import { testEnvironment } from "../../__tests__/support.ts";
import type { AppEnvironment } from "../context.ts";
import { holdSignInCookie, readSignInCookie } from "./sign-in-cookie.ts";

function app(betterAuthUrl: string) {
  const app = new Hono<AppEnvironment>();
  app.use("*", async (context, next) => {
    context.set("environment", testEnvironment({ betterAuthUrl }));
    await next();
  });
  app.post("/hold", (context) => context.text(holdSignInCookie(context)));
  app.get("/read", (context) =>
    context.json({ value: readSignInCookie(context) }),
  );
  return app;
}

const held = "a".repeat(43);

test("on https it is a __Host- cookie: Secure, Path=/, HttpOnly, Lax and ten minutes", async () => {
  const response = await app("https://id.example.com").request("/hold", {
    method: "POST",
  });
  const value = await response.text();
  expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(Buffer.from(value, "base64url")).toHaveLength(32);
  expect(response.headers.getSetCookie()).toEqual([
    `__Host-answerable-sign-in=${value}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`,
  ]);
});

test("on plain http it drops the prefix and Secure, and nothing else", async () => {
  const response = await app("http://localhost:47300").request("/hold", {
    method: "POST",
  });
  const value = await response.text();
  expect(response.headers.getSetCookie()).toEqual([
    `answerable-sign-in=${value}; Max-Age=600; Path=/; HttpOnly; SameSite=Lax`,
  ]);
});

test("a well-formed cookie keeps its value and has its ten minutes renewed", async () => {
  for (const [url, name] of [
    ["https://id.example.com", "__Host-answerable-sign-in"],
    ["http://localhost:47300", "answerable-sign-in"],
  ] as const) {
    const response = await app(url).request("/hold", {
      method: "POST",
      headers: { cookie: `${name}=${held}` },
    });
    expect(await response.text()).toBe(held);
    expect(response.headers.getSetCookie()[0]).toContain(
      `${name}=${held}; Max-Age=600;`,
    );
  }
});

test("a malformed cookie is replaced and reads as none", async () => {
  for (const malformed of [
    "short",
    `${held}a`,
    `${held.slice(1)}!`,
    `${held.slice(1)}%20`,
  ]) {
    const headers = { cookie: `answerable-sign-in=${malformed}` };
    const service = app("http://localhost:47300");
    const replaced = await service.request("/hold", {
      method: "POST",
      headers,
    });
    expect(await replaced.text()).not.toBe(malformed);
    const read = await service.request("/read", { headers });
    expect(await read.json()).toEqual({ value: null });
  }
});

test("each form reads only its own name", async () => {
  const read = async (url: string, cookie: string) =>
    (await app(url).request("/read", { headers: { cookie } })).json();
  expect(
    await read("https://id.example.com", `__Host-answerable-sign-in=${held}`),
  ).toEqual({ value: held });
  // A subdomain or a plain-http page can set this name, but not __Host-.
  expect(
    await read("https://id.example.com", `answerable-sign-in=${held}`),
  ).toEqual({ value: null });
  expect(
    await read("http://localhost:47300", `answerable-sign-in=${held}`),
  ).toEqual({ value: held });
  expect(await read("http://localhost:47300", "other=1")).toEqual({
    value: null,
  });
});
