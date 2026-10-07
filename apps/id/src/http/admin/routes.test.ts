import { expect, test } from "bun:test";
import { createApp } from "../../app.ts";
import {
  stubAuth,
  stubDatabase,
  testEnvironment,
} from "../../__tests__/support.ts";
import { adminRouteTables } from "./index.ts";
import { tierOf } from "./route-table.ts";

type Parameter = {
  in: string;
  name: string;
  required?: boolean;
  example?: unknown;
};
type Operation = {
  operationId?: string;
  description?: string;
  security?: unknown;
  "x-tier"?: string;
  "x-kind"?: string;
  "x-scopes"?: unknown;
  parameters?: Parameter[];
  requestBody?: {
    content: { "application/json": { example?: unknown } };
  };
  responses: Record<
    string,
    {
      headers?: Record<string, unknown>;
      content?: {
        "application/json"?: {
          schema?: {
            properties?: Record<string, unknown>;
            anyOf?: { properties?: Record<string, unknown> }[];
          };
        };
      };
    }
  >;
};

async function adminDocument() {
  const app = createApp({
    auth: stubAuth(),
    db: stubDatabase(),
    environment: testEnvironment(),
  });
  const response = await app.request("/api/admin/openapi.json");
  expect(response.status).toBe(200);
  return (await response.json()) as {
    paths: Record<string, Record<string, Operation>>;
  };
}
const documentPath = (path: string) =>
  `/api/admin/v1${path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}")}`;

test("administrative command contract gaps cannot grow unnoticed", async () => {
  const document = await adminDocument();
  const mutations = adminRouteTables
    .flatMap((table) => Object.values(table))
    .filter((route) => route.kind !== "read");
  const missingReplay: string[] = [];
  const missingRevision: string[] = [];
  for (const route of mutations) {
    const operation = document.paths[documentPath(route.path)]![route.method]!;
    const headers =
      operation.parameters?.filter((parameter) => parameter.in === "header") ??
      [];
    if (
      !headers.some(
        (parameter) =>
          parameter.name === "Idempotency-Key" && parameter.required === true,
      )
    )
      missingReplay.push(route.operationId);
    else {
      const success = Object.entries(operation.responses).filter(([status]) =>
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
      for (const status of ["400", "409", "503"])
        expect(operation.responses, route.operationId).toHaveProperty(status);
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
            headers.find((parameter) => parameter.name === name),
            name,
          ).toMatchObject({ required: false });
      }
      if (
        !headers.some(
          (parameter) =>
            parameter.name === "If-Match" && parameter.required === false,
        )
      )
        missingRevision.push(route.operationId);
      else expect(operation.responses, route.operationId).toHaveProperty("412");
    }
  }
  expect(missingReplay).toEqual([]);
  expect(missingRevision).toEqual([]);
});

test("admin route tables equal the OpenAPI operation union", async () => {
  const document = await adminDocument();
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
      const path = documentPath(route.path);
      const key = `${route.method.toUpperCase()} ${path}`;
      expect(
        expected.includes(key),
        `${label}: duplicate operation ${key}`,
      ).toBe(false);
      expected.push(key);
      const operation = document.paths[path]?.[route.method];
      expect(operation, `${label}: missing OpenAPI operation`).toBeDefined();
      expect(operation?.operationId, label).toBe(label);
      if (route.kind !== "read") {
        expect(operation?.description, label).toStartWith(
          "Requires Idempotency-Key. ",
        );
        expect(operation?.responses).not.toHaveProperty("410");
        for (const [status, response] of Object.entries(operation!.responses)) {
          if (!/^2\d\d$/.test(status) || status === "204") continue;
          const variants =
            response.content?.["application/json"]?.schema?.anyOf;
          expect(variants, `${label}: receipt response`).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                properties: expect.objectContaining({
                  operationId: expect.anything(),
                  outcome: expect.anything(),
                  statusCode: expect.anything(),
                  resultReference: expect.anything(),
                }),
              }),
            ]),
          );
        }
      }

      expect(operation?.security, `${label}: security`).toEqual([
        { cookieAuth: [] },
        { bearerAuth: [] },
      ]);
      expect(operation?.["x-tier"], `${label}: tier`).toBe(tierOf(route));
      expect(operation?.description?.trim().length, label).toBeGreaterThan(0);
      expect(operation?.description, label).toEndWith(route.description);
      expect(["read", "write", "erase"], label).toContain(
        operation?.["x-kind"] ?? "",
      );
      expect(operation?.["x-kind"], label).toBe(route.kind);

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
        ? ["401", "403", "404", "503"]
        : ["401", "403", "503"]) {
        expect(
          operation?.responses,
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
