import { describe, expect, spyOn, test } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describeRoute, generateSpecs } from "hono-openapi";
import type { AppEnvironment } from "./context.ts";
import {
  mapDatabaseError,
  ProblemError,
  problemHandler,
  problemResponses,
  problemSchema,
} from "./problem.ts";

function errorApp(error: Error) {
  const app = new Hono<AppEnvironment>();
  app.use("*", async (c, next) => {
    c.set("requestId", "request-123");
    c.header("x-request-id", "request-123");
    await next();
  });
  app.get("/", () => {
    throw error;
  });
  app.onError(problemHandler);
  return app;
}

function databaseError(code: string, constraint?: string) {
  return new DrizzleQueryError(
    "secret query",
    [],
    Object.assign(new Error("driver secret"), { code, constraint }),
  );
}

describe("unit: HTTP problems", () => {
  test("serialises a problem with details and extensions", async () => {
    const error = new ProblemError(
      403,
      "custom_scope",
      "The principal is not allowed",
      "Missing scope",
      { required_scope: "platform:read" },
    );
    expect(error.name).toBe("ProblemError");
    const response = await errorApp(error).request("/");
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    expect(response.headers.get("x-request-id")).toBe("request-123");
    expect(problemSchema.parse(await response.json())).toEqual({
      type: "about:blank",
      title: error.title,
      status: 403,
      code: "custom_scope",
      detail: "Missing scope",
      request_id: "request-123",
      required_scope: "platform:read",
    });
  });

  test("converts HTTP exceptions", async () => {
    const response = await errorApp(
      new HTTPException(401, { message: "Sign in first" }),
    ).request("/");
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    expect(await response.json()).toEqual({
      type: "about:blank",
      title: "Authentication is required",
      status: 401,
      code: "http_error",
      detail: "Sign in first",
      request_id: "request-123",
    });
    const other = await errorApp(
      new HTTPException(418, { message: "Tea" }),
    ).request("/");
    expect(await other.json()).toMatchObject({
      title: "HTTP error",
      status: 418,
      detail: "Tea",
    });
  });

  test.each([
    ["23505", 409, "conflict"],
    ["23503", 409, "reference_violation"],
    ["23514", 400, "constraint_violation"],
    ["57014", 503, "database_busy"],
    ["55P03", 503, "database_busy"],
    ["40P01", 503, "database_busy"],
  ] as const)("maps database code %s", async (code, status, problemCode) => {
    const error = databaseError(code, "organisations_slug_unique");
    expect(mapDatabaseError(error)).toMatchObject({
      status,
      code: problemCode,
    });
    const response = await errorApp(error).request("/");
    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    expect(await response.json()).toMatchObject({
      status,
      code: problemCode,
      request_id: "request-123",
    });
  });

  test("names unique constraints and handles missing constraints", () => {
    for (const constraint of [
      "security_identifiers_kind_identifier_pk",
      "security_identifiers_kind_instance_unique",
    ])
      expect(
        mapDatabaseError(databaseError("23505", constraint)),
      ).toMatchObject({ status: 409, code: "identifier_reserved" });
    expect(
      mapDatabaseError(databaseError("23505", "slug_unique"))?.detail,
    ).toContain("slug_unique");
    expect(
      mapDatabaseError(new Error("wrapped", { cause: { code: "23505" } }))
        ?.detail,
    ).toBeUndefined();
  });

  test("omits unique constraint details when the driver does not name one", () => {
    expect(mapDatabaseError(databaseError("23505"))?.detail).toBeUndefined();
  });

  test("ignores unrelated and malformed errors", () => {
    for (const error of [
      null,
      undefined,
      "error",
      {},
      new Error("ordinary"),
      { cause: null },
      { cause: "bad" },
      { cause: {} },
      databaseError("08006"),
    ]) {
      expect(mapDatabaseError(error)).toBeUndefined();
    }
  });

  test("logs unexpected errors and hides internal details", async () => {
    const log = spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await errorApp(new Error("private credentials")).request(
        "/",
      );
      expect(response.status).toBe(500);
      expect(response.headers.get("content-type")).toBe(
        "application/problem+json",
      );
      expect(await response.json()).toEqual({
        type: "about:blank",
        title: "Unexpected error",
        status: 500,
        code: "internal_error",
        request_id: "request-123",
      });
      expect(log).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(
        "[id] error",
        JSON.stringify({
          requestId: "request-123",
          event: "unexpected_error",
        }),
      );
    } finally {
      log.mockRestore();
    }
  });

  test("describes problem responses with an extensible OpenAPI schema", async () => {
    const responses = problemResponses(400, 404);
    expect(Object.keys(responses)).toEqual(["400", "404"]);
    expect(responses[400]?.description).toBe("The request is invalid");
    expect(responses[404]?.description).toBe("Not found");
    expect(
      responses[400]?.content["application/problem+json"].schema,
    ).toHaveProperty("toOpenAPISchema");
    expect(problemResponses(418)[418]?.description).toBe("HTTP error");
    expect(problemResponses()).toEqual({});
    const app = new Hono().get("/", describeRoute({ responses }), (c) =>
      c.text("ok"),
    );
    const document = await generateSpecs(app);
    expect(document.paths["/"]?.get?.responses?.[400]).toMatchObject({
      content: {
        "application/problem+json": {
          schema: { type: "object", additionalProperties: {} },
        },
      },
    });
  });
});

test.each([
  "timeout exceeded when trying to connect",
  "Connection terminated due to connection timeout",
])(
  "pool timeout %s has the same safe response for checkout and query failures",
  async (message) => {
    for (const error of [
      new Error(message),
      new DrizzleQueryError("private query", [], new Error(message)),
    ]) {
      const response = await errorApp(error).request("/");
      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("1");
      const body = await response.json();
      expect(body).toMatchObject({ code: "database_busy", retryable: true });
      expect(JSON.stringify(body)).not.toContain(message);
      expect(JSON.stringify(body)).not.toContain("private query");
    }
  },
);
