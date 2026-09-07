import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { describeAdminRoutes } from "../../__tests__/admin-routes.ts";
import { createOrganization } from "../../db/queries/organizations.ts";
import { auditEvents } from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";
let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture();
});
afterAll(async () => {
  await fixture?.close();
});
describeAdminRoutes(routes, () => fixture);
function request(
  organizationId: string,
  suffix = "",
  method = "GET",
  body?: unknown,
  kind: Parameters<AdminFixture["headers"]>[0] = "platformAdmin",
) {
  const headers = fixture.headers(kind);
  headers.set("x-request-id", "sso-provider-http-test");
  if (body !== undefined) headers.set("content-type", "application/json");
  return fixture.app.request(
    `/api/admin/v1/organizations/${organizationId}/sso-provider${suffix}`,
    {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
}
import { routes, ssoProviderSchema } from "./sso-providers.ts";
import { findSsoProviderByOrganization } from "../../db/queries/sso-providers.ts";
const input = {
  issuer: "https://login.example.com",
  domain: " ACME.EXAMPLE.COM ",
  oidc: { clientId: "acme-client", clientSecret: "private-http-secret" },
};
function expectRedacted(value: unknown) {
  expect(JSON.stringify(value)).not.toContain('"clientSecret"');
  expect(JSON.stringify(value)).not.toContain("private-http-secret");
  expect(value).not.toHaveProperty("oidcConfig");
}
test("tenantReader reads the redacted provider only for its organisation", async () => {
  const response = await request(
    fixture.tenant.organizationId,
    "",
    "GET",
    undefined,
    "tenantReader",
  );
  expect(response.status).toBe(200);
  const raw = await response.json();
  expectRedacted(raw);
  const row = ssoProviderSchema.parse(raw);
  expect(row.oidc.hasClientSecret).toBe(true);
  expectRedacted(row);
  expect(
    (
      await request(
        fixture.outsider.organizationId,
        "",
        "GET",
        undefined,
        "tenantReader",
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await request(
        fixture.outsider.organizationId,
        "",
        "GET",
        undefined,
        "platformReader",
      )
    ).status,
  ).toBe(200);
});
test("platformAdmin creates and updates without replacing the secret, then deletes", async () => {
  const org = await createOrganization(fixture.db, {
    slug: "fresh-provider",
    name: "Fresh provider",
  });
  const response = await request(org.id, "", "PUT", input);
  expect(response.status).toBe(201);
  const raw = await response.json();
  expectRedacted(raw);
  const row = ssoProviderSchema.parse(raw);
  expect(row).toMatchObject({
    providerId: org.slug,
    domain: "acme.example.com",
    oidc: { hasClientSecret: true },
  });
  expectRedacted(row);
  const updated = await request(org.id, "", "PUT", {
    ...input,
    oidc: { clientId: "changed" },
  });
  expect(updated.status).toBe(200);
  const body = await updated.json();
  expect(body.oidc).toMatchObject({
    clientId: "changed",
    hasClientSecret: true,
  });
  expectRedacted(body);
  expect(
    JSON.parse(
      (await findSsoProviderByOrganization(fixture.db, org.id))!.oidcConfig!,
    ).clientSecret,
  ).toBe(input.oidc.clientSecret);
  expect((await request(org.id, "", "DELETE")).status).toBe(204);
  expect((await request(org.id)).status).toBe(404);
  expect((await request(org.id, "", "DELETE")).status).toBe(404);
  const events = await fixture.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.targetId, row.id))
    .orderBy(auditEvents.id);
  expect(events.map((event) => event.action)).toEqual([
    "sso_provider.created",
    "sso_provider.updated",
    "sso_provider.deleted",
  ]);
  for (const event of events)
    expect(event).toMatchObject({
      actorType: "user",
      actorId: fixture.principals.platformAdmin.userId,
      organizationId: org.id,
      targetType: "sso_provider",
      requestId: "sso-provider-http-test",
      data: {},
    });
  expectRedacted(events);
});
test("provider validation and missing organisation writes", async () => {
  const id = fixture.tenant.organizationId;
  for (const body of [
    { ...input, issuer: "invalid" },
    { ...input, domain: "localhost" },
    { ...input, oidc: { clientId: "" } },
    { ...input, oidc: { clientId: "client", clientSecret: "" } },
    {
      ...input,
      oidc: { clientId: "client", tokenEndpointAuthentication: "none" },
    },
    { ...input, oidc: { clientId: "client", tokenEndpoint: "invalid" } },
  ])
    expect((await request(id, "", "PUT", body)).status).toBe(400);
  for (const method of ["GET", "PUT", "DELETE"])
    expect(
      (
        await request(
          "bad-id",
          "",
          method,
          method === "PUT" ? input : undefined,
        )
      ).status,
    ).toBe(400);
  expect((await request(createId(), "", "PUT", input)).status).toBe(404);
  expect((await request(createId(), "", "DELETE")).status).toBe(404);
});
test("machine token creates, updates and deletes the provider", async () => {
  const org = await createOrganization(fixture.db, {
    slug: "machine-provider",
    name: "Machine provider",
  });
  const kind = { bearer: await fixture.mintMachineToken() };
  const response = await request(org.id, "", "PUT", input, kind);
  expect(response.status).toBe(201);
  const row = await response.json();
  expectRedacted(row);
  expect(
    (
      await request(
        org.id,
        "",
        "PUT",
        { ...input, oidc: { clientId: "machine" } },
        kind,
      )
    ).status,
  ).toBe(200);
  expect((await request(org.id, "", "GET", undefined, kind)).status).toBe(200);
  expect((await request(org.id, "", "DELETE", undefined, kind)).status).toBe(
    204,
  );
  const events = await fixture.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.targetId, row.id));
  expect(events).toHaveLength(3);
  for (const event of events)
    expect(event).toMatchObject({
      actorType: "client",
      actorId: fixture.platform.client.clientId,
    });
  expectRedacted(events);
});

import { createSsoProvider } from "../../db/queries/sso-providers.ts";
import { ssoTestSchema } from "./sso-providers.ts";
test("platform admins, readers and a machine test the in-process SSO issuer", async () => {
  for (const kind of [
    "platformAdmin",
    "platformReader",
    { bearer: await fixture.mintMachineToken(["platform:read"]) },
  ] as const) {
    const response = await request(
      fixture.tenant.organizationId,
      "/test",
      "GET",
      undefined,
      kind,
    );
    expect(response.status).toBe(200);
    const result = ssoTestSchema.parse(await response.json());
    expect(result.discovery).toMatchObject({
      reachable: true,
      issuerMatches: true,
    });
    expect(result.jwks.reachable).toBe(true);
    expect(result.jwks.keys).toBeGreaterThanOrEqual(1);
    expect(result.problems).toEqual([]);
  }
});
test("SSO test reports a missing provider and an unreachable issuer", async () => {
  const org = await createOrganization(fixture.db, {
    slug: "test-provider",
    name: "Test provider",
  });
  const missing = await request(org.id, "/test");
  expect(missing.status).toBe(404);
  expect(await missing.json()).toMatchObject({ code: "provider_not_found" });
  expect((await request(createId(), "/test")).status).toBe(404);
  expect((await request("bad-id", "/test")).status).toBe(400);
  await createSsoProvider(fixture.db, {
    organizationId: org.id,
    providerId: org.slug,
    issuer: "http://127.0.0.1:1",
    domain: "test.example.com",
    oidc: { clientId: "test" },
  });
  const unreachable = await request(org.id, "/test");
  expect(unreachable.status).toBe(200);
  expect(
    ssoTestSchema
      .parse(await unreachable.json())
      .problems.map((problem) => problem.code),
  ).toEqual(["discovery_unreachable"]);
});
