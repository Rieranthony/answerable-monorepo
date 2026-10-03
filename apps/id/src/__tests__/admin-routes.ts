import { and, eq, isNull } from "drizzle-orm";
import {
  auditEvents,
  entitlements,
  groups,
  organizationCapabilities,
  organizationDomains,
} from "../db/schema/index.ts";
import { createId } from "../lib/id.ts";
import { expect, test } from "bun:test";
import type { AdminRoute, AdminRouteTable } from "../http/admin/route-table.ts";
import type { AdminFixture } from "./admin.ts";

/** Live child rows of one fixture organisation, keyed by path parameter. */
async function childIds(f: AdminFixture, organizationId: string) {
  const first = async (rows: Promise<{ id: string }[]>) => (await rows)[0]?.id;
  let groupId = await first(
    f.db
      .select({ id: groups.id })
      .from(groups)
      .where(
        and(
          eq(groups.organizationId, organizationId),
          isNull(groups.deletedAt),
        ),
      ),
  );
  if (!groupId) {
    groupId = createId();
    await f.db
      .insert(groups)
      .values({ id: groupId, organizationId, slug: groupId, name: "Matrix" });
  }
  const own = organizationId === f.tenant.organizationId;
  const ids: Record<string, string | undefined> = {
    memberId: f.principals[own ? "tenantReader" : "outsider"].memberId,
    groupId,
    capabilityId: await first(
      f.db
        .select({ id: organizationCapabilities.id })
        .from(organizationCapabilities)
        .where(eq(organizationCapabilities.organizationId, organizationId)),
    ),
    entitlementId: await first(
      f.db
        .select({ id: entitlements.id })
        .from(entitlements)
        .where(eq(entitlements.organizationId, organizationId)),
    ),
    domainId: await first(
      f.db
        .select({ id: organizationDomains.id })
        .from(organizationDomains)
        .where(
          and(
            eq(organizationDomains.organizationId, organizationId),
            isNull(organizationDomains.deletedAt),
          ),
        ),
    ),
  };
  return ids;
}

export function describeAdminRoutes(
  table: AdminRouteTable,
  fixture: () => AdminFixture,
  options: { params?: (route: AdminRoute) => Record<string, string> } = {},
) {
  for (const route of Object.values(table)) {
    type Kind = Parameters<AdminFixture["headers"]>[0] | "root";
    type RequestOptions = {
      origin?: boolean | string;
      body?: unknown;
      query?: Record<string, string>;
      unknownIds?: boolean;
      childIds?: Record<string, string | undefined>;
    };
    function request(kind?: Kind, input: RequestOptions = {}) {
      const f = fixture();
      const overrides = options.params?.(route) ?? {};
      const path = route.path.replace(
        /:([A-Za-z_][A-Za-z0-9_]*)/g,
        (_, name: string) => {
          if (input.childIds && name !== "organizationId") {
            expect(input.childIds[name], name).toBeString();
            return input.childIds[name]!;
          }
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
      if (route.kind === "erase" && !input.query)
        query.set("confirm", decodeURIComponent(path.split("/").at(-1)!));
      const headers = kind
        ? f.headers(kind, { origin: input.origin })
        : new Headers({ Origin: f.trustedOrigin });
      if (
        route.parameters?.some(
          (parameter) => "name" in parameter && parameter.name === "If-Match",
        )
      )
        headers.set("If-Match", '"00000000-0000-7000-8000-000000000000:1"');
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
    entry("root is admitted by authorisation", async () => {
      const f = fixture();
      const before = new Set(
        (
          await f.db
            .select()
            .from(auditEvents)
            .where(eq(auditEvents.action, "admin.root_request"))
        ).map((row) => row.id),
      );
      // Exercise authorisation without changing the shared fixture on writes.
      const response = await request(
        "root",
        route.kind === "read"
          ? {}
          : {
              unknownIds: true,
              ...(route.requestBody ? { body: "nope" } : {}),
            },
      );
      expect([401, 403]).not.toContain(response.status);
      const rows = (
        await f.db
          .select()
          .from(auditEvents)
          .where(eq(auditEvents.action, "admin.root_request"))
      ).filter((row) => !before.has(row.id));
      // Open routes skip authorisation but still audit a root request.
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        outcome: "success",
        targetId: route.operationId,
      });
    });
    // Proves that no route escapes the principal middleware.
    entry("no credentials", async () => {
      const response = await request();
      await problem(response, 401, "unauthenticated");
      expect(response.headers.get("WWW-Authenticate")).toBeTruthy();
    });
    // The principal middleware refuses these before any route code runs, so
    // one write route stands for every route.
    const once = route.operationId === "createOrganization";
    if (once) {
      entry("foreign bearer", async () => {
        await problem(
          await request({ bearer: await fixture().foreignBearer() }),
          401,
          "invalid_token",
        );
      });
      entry("missing origin", async () => {
        await problem(
          await request("platformAdmin", { origin: false }),
          403,
          "origin_required",
        );
      });
      entry("untrusted origin", async () => {
        await problem(
          await request("platformAdmin", { origin: "https://evil.example" }),
          403,
          "untrusted_origin",
        );
      });
      entry("disabled user", async () => {
        await problem(await request("disabledUser"), 403, "user_disabled");
      });
    }
    if (route.open) {
      entry("no grant is admitted", async () => {
        const response = await request("noGrant");
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ grants: [] });
      });
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
        // The same scope fact as the reader; only the challenge header differs.
        if (once)
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
    if (!route.open)
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
    const children = params
      .map((param) => param[1]!)
      .filter((name) => name !== "organizationId");
    if (params.some((param) => param[1] === "organizationId"))
      for (const child of children)
        // A real child id of the second tenant under this tenant's path; any
        // other child id is the tenant's own, so each lookup is tested alone.
        entry(
          `foreign child id${children.length > 1 ? ` (${child})` : ""}`,
          async () => {
            const f = fixture();
            const successes = async () =>
              (
                await f.db
                  .select({ id: auditEvents.id })
                  .from(auditEvents)
                  .where(eq(auditEvents.outcome, "success"))
              ).map((row) => row.id);
            const before = new Set(await successes());
            const ids = await childIds(f, f.tenant.organizationId);
            ids[child] = (await childIds(f, f.outsider.organizationId))[child];
            await problem(
              await request("platformAdmin", { childIds: ids }),
              404,
              "not_found",
            );
            expect((await successes()).filter((id) => !before.has(id))).toEqual(
              [],
            );
          },
        );
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
  }
}
