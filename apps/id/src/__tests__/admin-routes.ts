import { expect, test } from "bun:test";
import type { AdminRoute, AdminRouteTable } from "../http/admin/route-table.ts";
import type { AdminFixture } from "./admin.ts";

export function describeAdminRoutes(
  table: AdminRouteTable,
  fixture: () => AdminFixture,
  options: { params?: (route: AdminRoute) => Record<string, string> } = {},
) {
  for (const route of Object.values(table)) {
    type Kind = Parameters<AdminFixture["headers"]>[0];
    type RequestOptions = {
      origin?: boolean | string;
      body?: unknown;
      query?: Record<string, string>;
      unknownIds?: boolean;
    };
    function request(kind?: Kind, input: RequestOptions = {}) {
      const f = fixture();
      const overrides = options.params?.(route) ?? {};
      const path = route.path.replace(
        /:([A-Za-z_][A-Za-z0-9_]*)/g,
        (_, name: string) => {
          if (!input.unknownIds && overrides[name] !== undefined)
            return overrides[name];
          if (name === "organizationId" && !input.unknownIds)
            return f.tenant.organizationId;
          if (name === "clientId") return "missing-client";
          if (name === "resource")
            return encodeURIComponent("https://none.example");
          return crypto.randomUUID();
        },
      );
      const query = new URLSearchParams({
        ...route.example?.query,
        ...input.query,
      });
      const headers = kind
        ? f.headers(kind, { origin: input.origin })
        : new Headers({ Origin: f.trustedOrigin });
      const body = Object.hasOwn(input, "body")
        ? input.body
        : route.example?.body;
      if (body !== undefined) headers.set("Content-Type", "application/json");
      return f.app.request(
        `/api/admin/v1${path}${query.size ? `?${query}` : ""}`,
        {
          method: route.method.toUpperCase(),
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        },
      );
    }
    async function problem(response: Response, status: number, code: string) {
      expect(response.status).toBe(status);
      expect(response.headers.get("content-type")).toContain(
        "application/problem+json",
      );
      const body = await response.json();
      expect(body).toMatchObject({ code });
      return body;
    }
    async function denied(
      kind: Kind,
      status = 403,
      code = "insufficient_scope",
      hidden = false,
    ) {
      const f = fixture();
      const before = new Set((await f.deniedEvents()).map((event) => event.id));
      const response = await request(kind);
      await problem(response, status, code);
      const events = (await f.deniedEvents()).filter(
        (event) => !before.has(event.id),
      );
      expect(events).toHaveLength(1);
      // The path's organisation is attributed by id only when the principal
      // holds a grant there; otherwise it is kept in data (see authorize.ts).
      const names = route.path.includes(":organizationId");
      const known = names && !hidden;
      expect(events[0]).toMatchObject({
        targetId: route.operationId,
        targetType: "route",
        outcome: "denied",
        organizationId: known ? f.tenant.organizationId : null,
        ...(names && !known
          ? { data: { organizationId: f.tenant.organizationId } }
          : {}),
      });
      return response;
    }
    function entry(name: string, run: () => Promise<unknown>) {
      test(`${route.operationId}: ${name}`, run);
    }
    entry("no credentials", async () => {
      const response = await request();
      await problem(response, 401, "unauthenticated");
      expect(response.headers.get("WWW-Authenticate")).toBeTruthy();
    });
    entry("foreign bearer", async () => {
      await problem(
        await request({ bearer: await fixture().foreignBearer() }),
        401,
        "invalid_token",
      );
    });
    if (route.method !== "get") {
      entry("missing origin", async () => {
        await problem(
          await request("platformAdmin", { origin: false }),
          403,
          "origin_required",
        );
      });
    }
    entry("untrusted origin", async () => {
      await problem(
        await request("platformAdmin", { origin: "https://evil.example" }),
        403,
        "untrusted_origin",
      );
    });
    if (route.anyGrant) {
      entry("no grant", () => denied("noGrant"));
    } else {
      entry("insufficient scope", () =>
        denied(
          route.orgScope
            ? route.orgScope === "org:read"
              ? "tenantUsersOnly"
              : "tenantReader"
            : "tenantAdmin",
        ),
      );
      if (route.platformScope !== "platform:read") {
        entry("platform reader insufficient scope", async () => {
          await problem(
            await request("platformReader"),
            403,
            "insufficient_scope",
          );
        });
        entry("machine insufficient scope", async () => {
          const response = await request({
            bearer: await fixture().mintMachineToken(["platform:read"]),
          });
          await problem(response, 403, "insufficient_scope");
          expect(response.headers.get("WWW-Authenticate")).toBe(
            'Bearer error="insufficient_scope"',
          );
        });
      }
    }
    if (route.orgScope) {
      entry("outsider organisation", () =>
        denied("outsider", 404, "not_found", true),
      );
    }
    entry("disabled user", async () => {
      await problem(await request("disabledUser"), 403, "user_disabled");
    });
    entry("expired member", async () => {
      await problem(
        await request("expiredMember"),
        route.orgScope ? 404 : 403,
        route.orgScope ? "not_found" : "insufficient_scope",
      );
    });
    const params = [...route.path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)];
    if (
      route.orgScope ||
      params.some((param) => param[1] !== "organizationId")
    ) {
      entry("unknown ids", async () => {
        await problem(
          await request("platformAdmin", { unknownIds: true }),
          404,
          "not_found",
        );
      });
    }
    if (route.requestBody) {
      entry("invalid body", async () => {
        const body = await problem(
          await request("platformAdmin", { body: "nope" }),
          400,
          "validation_failed",
        );
        expect(Array.isArray(body.errors)).toBe(true);
        expect(body.errors.length).toBeGreaterThan(0);
      });
    }
    if (route.paginated) {
      entry("invalid pagination", async () => {
        await problem(
          await request("platformAdmin", { query: { limit: "0" } }),
          400,
          "validation_failed",
        );
      });
    }
  }
}
