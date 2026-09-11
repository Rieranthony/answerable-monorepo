import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { describeAdminRoutes } from "../../__tests__/admin-routes.ts";
import { platformScopes } from "../../bootstrap.ts";
import { meSchema, routes } from "./me.ts";

let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture();
});
afterAll(async () => {
  await fixture?.close();
});

describeAdminRoutes(routes, () => fixture);

test("getAdminMe: platform admin cookie", async () => {
  const response = await fixture.app.request("/api/admin/v1/me", {
    headers: fixture.headers("platformAdmin"),
  });
  expect(response.status).toBe(200);
  expect(meSchema.parse(await response.json())).toEqual({
    principal: {
      type: "user",
      userId: fixture.principals.platformAdmin.userId,
      email: "platformadmin@answerable.example.com",
      sessionId: expect.any(String),
    },
    grants: [
      {
        organizationId: fixture.platform.organizationId,
        organizationSlug: fixture.platform.slug,
        isPlatform: true,
        scopes: [...platformScopes],
      },
    ],
  });
});

test("getAdminMe: tenant reader cookie", async () => {
  const response = await fixture.app.request("/api/admin/v1/me", {
    headers: fixture.headers("tenantReader"),
  });
  expect(response.status).toBe(200);
  expect(meSchema.parse(await response.json())).toEqual({
    principal: {
      type: "user",
      userId: fixture.principals.tenantReader.userId,
      email: "tenantreader@tenant.example.com",
      sessionId: expect.any(String),
    },
    grants: [
      {
        organizationId: fixture.tenant.organizationId,
        organizationSlug: fixture.tenant.slug,
        isPlatform: false,
        scopes: ["org:read"],
      },
    ],
  });
});

test("getAdminMe: machine token", async () => {
  const response = await fixture.app.request("/api/admin/v1/me", {
    headers: fixture.headers({ bearer: await fixture.mintMachineToken() }),
  });
  expect(response.status).toBe(200);
  expect(meSchema.parse(await response.json())).toEqual({
    principal: {
      type: "client",
      clientId: fixture.platform.client.clientId,
      organizationId: fixture.platform.organizationId,
    },
    grants: [
      {
        organizationId: fixture.platform.organizationId,
        organizationSlug: fixture.platform.slug,
        isPlatform: true,
        scopes: [...platformScopes],
      },
    ],
  });
});

test("getAdminMe: every fixture cookie resolves", async () => {
  for (const [name, principal] of Object.entries(fixture.principals)) {
    const response = await fixture.app.request("/api/admin/v1/me", {
      headers: { Cookie: principal.cookie, Origin: fixture.trustedOrigin },
    });
    expect([200, 403], name).toContain(response.status);
  }
});

test("platform authority and root lockout follow the binding after slugs change", async () => {
  const { organizations, entitlements } =
    await import("../../db/schema/index.ts");
  const { eq } = await import("drizzle-orm");
  const token = await fixture.mintMachineToken();
  const originalSlug = fixture.environment.platformOrganizationSlug;
  try {
    await fixture.db
      .update(organizations)
      .set({ slug: "renamed-platform" })
      .where(eq(organizations.id, fixture.platform.organizationId));
    await fixture.db
      .update(organizations)
      .set({ slug: originalSlug })
      .where(eq(organizations.id, fixture.tenant.organizationId));
    await fixture.db
      .update(entitlements)
      .set({ scopes: [...platformScopes] })
      .where(
        eq(entitlements.memberId, fixture.principals.tenantAdmin.memberId),
      );
    fixture.environment.platformOrganizationSlug = originalSlug;
    fixture.environment.rootAdminBreakGlass = false;
    for (const headers of [
      fixture.headers("platformAdmin"),
      fixture.headers({ bearer: token }),
    ])
      expect(
        (
          await fixture.app.request("/api/admin/v1/organizations", {
            headers,
          })
        ).status,
      ).toBe(200);
    expect(
      (
        await fixture.app.request("/api/admin/v1/organizations", {
          headers: fixture.headers("tenantAdmin"),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fixture.app.request("/api/admin/v1/me", {
          headers: {
            Authorization: `Bearer ${fixture.environment.rootAdminSecret}`,
          },
        })
      ).status,
    ).toBe(403);
  } finally {
    fixture.environment.rootAdminBreakGlass = true;
    await fixture.db
      .update(organizations)
      .set({ slug: fixture.tenant.slug })
      .where(eq(organizations.id, fixture.tenant.organizationId));
    await fixture.db
      .update(organizations)
      .set({ slug: fixture.platform.slug })
      .where(eq(organizations.id, fixture.platform.organizationId));
  }
});
