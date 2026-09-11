import { expect, test } from "bun:test";
import { createApp } from "../../app.ts";
import {
  stubAuth,
  stubDatabase,
  testEnvironment,
} from "../../__tests__/support.ts";
import { adminRouteTables } from "./index.ts";
import { tierOf } from "./route-table.ts";

// Temporary F3 backlog, not exemptions from the final command contract.
// Remove entries only when the route's replay/revision integration tests pass.
const pendingReplay: string[] = [];
const pendingRevision: string[] = [];

test("administrative command contract gaps cannot grow unnoticed", () => {
  const mutations = adminRouteTables
    .flatMap((table) => Object.values(table))
    .filter((route) => route.kind !== "read");
  const missingReplay: string[] = [];
  const missingRevision: string[] = [];
  for (const route of mutations) {
    const headers =
      route.parameters?.filter(
        (parameter) => "in" in parameter && parameter.in === "header",
      ) ?? [];
    const requiredHeader = (name: string) =>
      headers.some(
        (parameter) =>
          "name" in parameter &&
          parameter.name === name &&
          parameter.required === true,
      );
    if (!requiredHeader("Idempotency-Key"))
      missingReplay.push(route.operationId);
    else {
      const success = Object.entries(route.responses ?? {}).filter(([status]) =>
        /^2\d\d$/.test(status),
      );
      expect(success.length, route.operationId).toBeGreaterThan(0);
      for (const [, response] of success) {
        expect(response, route.operationId).toHaveProperty(
          "headers.Operation-Id",
        );
        expect(response, route.operationId).toHaveProperty(
          "headers.Idempotency-Replayed",
        );
      }
      for (const status of ["400", "409", "410", "503"])
        expect(route.responses, route.operationId).toHaveProperty(status);
    }
    // These PUT commands verify immutable ownership or ensure one link exists;
    // they do not replace mutable configuration read by another administrator.
    const desiredStatePut = ["setClientOwner", "linkClientResource"].includes(
      route.operationId,
    );
    if (
      route.method === "patch" ||
      (route.method === "put" && !desiredStatePut)
    ) {
      const conditionalPut = ["putSsoProvider", "putGroupMember"].includes(
        route.operationId,
      );
      if (conditionalPut) {
        for (const name of ["If-Match", "If-None-Match"])
          expect(
            headers.find(
              (parameter) => "name" in parameter && parameter.name === name,
            ),
            name,
          ).toMatchObject({ required: false });
      }
      if (
        !headers.some(
          (parameter) =>
            "name" in parameter &&
            parameter.name === "If-Match" &&
            parameter.required === false,
        )
      )
        missingRevision.push(route.operationId);
      else
        for (const status of ["412"])
          expect(route.responses, route.operationId).toHaveProperty(status);
    }
  }
  expect(missingReplay.sort()).toEqual(pendingReplay);
  expect(missingRevision.sort()).toEqual(pendingRevision);
});

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
          "x-scope-alternatives"?: unknown;
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
      if (route.open)
        expect(["getAdminMe", "getMyOperationStatus"]).toContain(label);
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
      expect(operation?.["x-scope-alternatives"], label).toEqual(
        "scopeAlternatives" in route ? route.scopeAlternatives : undefined,
      );
      expect(operation?.["x-scopes"], label).toEqual(
        route.open
          ? {}
          : {
              platform: route.platformScope,
              ...(route.orgScope ? { org: route.orgScope } : {}),
            },
      );
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
