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
