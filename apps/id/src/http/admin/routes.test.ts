import { expect, test } from "bun:test";
import { createApp } from "../../app.ts";
import {
  stubAuth,
  stubDatabase,
  testEnvironment,
} from "../../__tests__/support.ts";
import { adminRouteTables } from "./index.ts";
import { tierOf } from "./route-table.ts";

test("admin route tables equal the OpenAPI operation union", async () => {
  const app = createApp({
    auth: stubAuth(),
    db: stubDatabase(),
    environment: testEnvironment(),
  });
  const response = await app.request("/api/admin/openapi.json");
  expect(response.status).toBe(200);
  const document = (await response.json()) as {
    paths: Record<
      string,
      Record<
        string,
        {
          operationId?: string;
          description?: string;
          security?: unknown;
          "x-tier"?: string;
          "x-kind"?: string;
          "x-scopes"?: unknown;
          parameters?: {
            in: string;
            name: string;
            required?: boolean;
            example?: unknown;
          }[];
          requestBody?: {
            content: { "application/json": { example?: unknown } };
          };
          responses: Record<
            string,
            {
              content?: {
                "application/json"?: {
                  schema?: { properties?: Record<string, unknown> };
                };
              };
            }
          >;
        }
      >
    >;
  };
  const methods = new Set([
    "get",
    "post",
    "put",
    "patch",
    "delete",
    "head",
    "options",
    "trace",
  ]);
  const actual = Object.entries(document.paths).flatMap(([path, operations]) =>
    Object.keys(operations)
      .filter((method) => methods.has(method))
      .map((method) => `${method.toUpperCase()} ${path}`),
  );
  const expected: string[] = [];
  const ids = new Set<string>();
  for (const table of adminRouteTables) {
    for (const route of Object.values(table)) {
      const label = route.operationId;
      if (route.open) expect(label).toBe("getAdminMe");
      expect(ids.has(label), `${label}: duplicate operationId`).toBe(false);
      ids.add(label);
      const path = `/api/admin/v1${route.path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}")}`;
      const key = `${route.method.toUpperCase()} ${path}`;
      expect(
        expected.includes(key),
        `${label}: duplicate operation ${key}`,
      ).toBe(false);
      expected.push(key);
      const operation = document.paths[path]?.[route.method];
      expect(operation, `${label}: missing OpenAPI operation`).toBeDefined();
      expect(operation?.operationId, label).toBe(label);
      expect(operation?.security, `${label}: security`).toEqual([
        { cookieAuth: [] },
        { bearerAuth: [] },
      ]);
      expect(operation?.["x-tier"], `${label}: tier`).toBe(tierOf(route));
      expect(operation?.description?.trim().length, label).toBeGreaterThan(0);
      expect(operation?.description, label).toBe(route.description);
      expect(["read", "write", "erase"], label).toContain(
        operation?.["x-kind"] ?? "",
      );
      expect(operation?.["x-kind"], label).toBe(route.kind);
      expect(operation?.["x-scopes"], label).toEqual({
        platform: route.platformScope,
        ...(route.orgScope ? { org: route.orgScope } : {}),
      });
      const query =
        operation?.parameters?.filter(
          (parameter) => parameter.in === "query",
        ) ?? [];
      if (
        operation?.responses["200"]?.content?.["application/json"]?.schema
          ?.properties?.nextCursor
      ) {
        expect(
          query.map((parameter) => parameter.name),
          label,
        ).toEqual(expect.arrayContaining(["limit", "cursor"]));
      }
      if (route.kind === "erase") {
        expect(query, label).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: "confirm", required: true }),
          ]),
        );
        expect(operation?.requestBody, label).toBeUndefined();
      }
      for (const [name, example] of Object.entries(
        route.example?.query ?? {},
      )) {
        expect(
          query.find((parameter) => parameter.name === name)?.example,
          label,
        ).toEqual(example);
      }
      if (operation?.requestBody) {
        expect(
          operation.requestBody.content["application/json"].example,
          label,
        ).not.toBeUndefined();
      }
      if (route.requestBody) {
        expect(
          operation?.requestBody?.content["application/json"].example,
          label,
        ).toEqual(route.example?.body);
        expect(
          route.example?.body,
          `${label}: requestBody requires example.body`,
        ).not.toBeUndefined();
      }
      for (const [, name] of route.path.matchAll(
        /:([A-Za-z_][A-Za-z0-9_]*)/g,
      )) {
        expect(
          route.parameters?.some(
            (parameter) =>
              "in" in parameter &&
              parameter.in === "path" &&
              parameter.name === name &&
              parameter.required === true,
          ),
          `${label}: missing required path parameter ${name}`,
        ).toBe(true);
      }
      for (const status of route.orgScope
        ? ["401", "403", "404"]
        : ["401", "403"]) {
        expect(
          route.responses,
          `${label}: missing response ${status}`,
        ).toHaveProperty(status);
      }
    }
  }
  expect(
    actual.sort(),
    "OpenAPI operations disagree with the admin route tables",
  ).toEqual(expected.sort());
});
