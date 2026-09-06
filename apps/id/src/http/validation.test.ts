import { describe, expect, expectTypeOf, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { generateSpecs } from "hono-openapi";
import { z } from "zod";
import type { AppEnvironment } from "./context.ts";
import { problemHandler } from "./problem.ts";
import { validate } from "./validation.ts";

const schema = z.object({
  people: z.array(z.object({ name: z.string().min(1, "Name is required") })),
});
const query = z.object({
  count: z.coerce.number().int().min(1, "Count must be positive"),
});
function validationApp() {
  const app = new Hono<AppEnvironment>();
  app.use("*", async (c, next) => {
    c.set("requestId", "validation-request");
    await next();
  });
  app.onError(problemHandler);
  app.post("/json", validate("json", schema), (c) => {
    const value = c.req.valid("json");
    expectTypeOf(value).toEqualTypeOf<z.output<typeof schema>>();
    return c.json(value);
  });
  app.get("/query", validate("query", query), (c) => {
    const value = c.req.valid("query");
    expectTypeOf(value).toEqualTypeOf<{ count: number }>();
    return c.json(value);
  });
  app.post("/root", validate("json", z.string()), (c) =>
    c.json(c.req.valid("json")),
  );
  return app;
}
describe("unit: validation", () => {
  test("passes typed JSON and coerced query output to handlers", async () => {
    const app = validationApp();
    const response = await app.request("/json", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ people: [{ name: "Ada" }] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ people: [{ name: "Ada" }] });
    const result = await app.request("/query?count=2");
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ count: 2 });
  });
  test("returns nested JSON issue paths and messages", async () => {
    const response = await validationApp().request("/json", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ people: [{ name: "" }] }),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    expect(await response.json()).toEqual({
      type: "about:blank",
      title: "The request is invalid",
      status: 400,
      code: "validation_failed",
      request_id: "validation-request",
      errors: [{ path: "people.0.name", message: "Name is required" }],
    });
  });
  test("returns query and root issues", async () => {
    const response = await validationApp().request("/query?count=0");
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    expect(await response.json()).toMatchObject({
      errors: [{ path: "count", message: "Count must be positive" }],
    });
    const root = await validationApp().request("/root", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(await root.json()).toMatchObject({
      errors: [{ path: "", message: expect.any(String) }],
    });
  });
  test("formats standard validation issues without a path", async () => {
    const rootSchema = z.string();
    const validation = spyOn(
      rootSchema["~standard"],
      "validate",
    ).mockReturnValue({ issues: [{ message: "Invalid root" }] });
    try {
      const app = new Hono<AppEnvironment>();
      app.use("*", async (c, next) => {
        c.set("requestId", "root-request");
        await next();
      });
      app.post("/", validate("json", rootSchema));
      const response = await app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        errors: [{ path: "", message: "Invalid root" }],
      });
    } finally {
      validation.mockRestore();
    }
  });

  test("registers JSON and query schemas in OpenAPI", async () => {
    const document = await generateSpecs(validationApp());
    expect(document.paths["/json"]?.post?.requestBody).toMatchObject({
      content: {
        "application/json": {
          schema: { type: "object", required: ["people"] },
        },
      },
    });
    expect(document.paths["/query"]?.get?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "count", in: "query" }),
      ]),
    );
  });
});
