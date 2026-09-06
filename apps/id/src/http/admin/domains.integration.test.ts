import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
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
  headers.set("x-request-id", "domains-http-test");
  if (body !== undefined) headers.set("content-type", "application/json");
  return fixture.app.request(
    `/api/admin/v1/organizations/${organizationId}/domains${suffix}`,
    {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
}
import { routes, domainSchema } from "./domains.ts";
import { signInThroughIdp } from "../../__tests__/federation.ts";
import { createOrganizationDomain } from "../../db/queries/organization-domains.ts";
import { createSsoProvider } from "../../db/queries/sso-providers.ts";
test("tenantReader lists only its domains; platformReader can read another organisation", async () => {
  const id = fixture.tenant.organizationId;
  const response = await request(id, "", "GET", undefined, "tenantReader");
  expect(response.status).toBe(200);
  const page = await response.json();
  expect(page.items.length).toBeGreaterThan(0);
  expect(
    page.items.every(
      (row: { organizationId: string }) => row.organizationId === id,
    ),
  ).toBe(true);
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
test("platformAdmin creates, disables and enables; conflicts and validation are problem responses", async () => {
  const id = fixture.tenant.organizationId;
  const response = await request(id, "", "POST", {
    domain: " ADMIN.EXAMPLE.COM ",
  });
  expect(response.status).toBe(201);
  const row = domainSchema.parse(await response.json());
  expect(row.domain).toBe("admin.example.com");
  for (const organizationId of [id, fixture.outsider.organizationId]) {
    const duplicate = await request(organizationId, "", "POST", {
      domain: row.domain,
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ code: "conflict" });
  }
  for (const domain of [
    "localhost",
    "-bad.example",
    "bad_.example",
    "a..example",
    "https://acme.example.com",
  ])
    expect((await request(id, "", "POST", { domain })).status).toBe(400);
  expect((await request("bad-id")).status).toBe(400);
  expect((await request(id, "/bad-id/disable", "POST")).status).toBe(400);
  expect(
    (await request(createId(), "", "POST", { domain: "missing.example.com" }))
      .status,
  ).toBe(404);
  expect((await request(id, `/${row.id}/enable`, "POST")).status).toBe(409);
  expect((await request(id, `/${row.id}/disable`, "POST")).status).toBe(200);
  expect((await request(id, `/${row.id}/disable`, "POST")).status).toBe(409);
  const other = await createOrganizationDomain(fixture.db, {
    organizationId: fixture.outsider.organizationId,
    domain: row.domain,
  });
  const conflict = await request(id, `/${row.id}/enable`, "POST");
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ code: "conflict" });
  expect(
    (
      await request(
        fixture.outsider.organizationId,
        `/${other.id}/disable`,
        "POST",
      )
    ).status,
  ).toBe(200);
  expect((await request(id, `/${row.id}/enable`, "POST")).status).toBe(200);
  const events = await fixture.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.targetId, row.id))
    .orderBy(auditEvents.id);
  expect(events.map((event) => event.action)).toEqual([
    "domain.created",
    "domain.disabled",
    "domain.enabled",
  ]);
  for (const event of events)
    expect(event).toMatchObject({
      actorType: "user",
      actorId: fixture.principals.platformAdmin.userId,
      targetType: "domain",
      organizationId: id,
      requestId: "domains-http-test",
    });
});
test("domain pagination has no gaps and filters disabled rows", async () => {
  const org = await createOrganization(fixture.db, {
    slug: "pages",
    name: "Pages",
  });
  const ids: string[] = [];
  for (const domain of [
    "one.example.com",
    "two.example.com",
    "three.example.com",
  ])
    ids.push(
      (
        await createOrganizationDomain(fixture.db, {
          organizationId: org.id,
          domain,
        })
      ).id,
    );
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const response = await request(
      org.id,
      "?limit=1" + (cursor ? "&cursor=" + cursor : ""),
    );
    expect(response.status).toBe(200);
    const page = await response.json();
    seen.push(...page.items.map((row: { id: string }) => row.id));
    cursor = page.nextCursor;
  } while (cursor);
  expect(seen).toEqual([...ids].reverse());
  await request(org.id, `/${ids[0]}/disable`, "POST");
  expect(
    (await (await request(org.id, "?status=disabled")).json()).items.map(
      (row: { id: string }) => row.id,
    ),
  ).toEqual([ids[0]]);
});
test("disabling a domain refuses the next upstream sign-in and records its audit", async () => {
  const org = await createOrganization(fixture.db, {
    slug: "domain-sign-in",
    name: "Domain sign-in",
  });
  const domain = "domain-sign-in.example.com";
  const row = await createOrganizationDomain(fixture.db, {
    organizationId: org.id,
    domain,
  });
  const issuer = fixture.issuer.origin;
  await createSsoProvider(fixture.db, {
    organizationId: org.id,
    providerId: org.slug,
    issuer,
    domain,
    oidc: {
      clientId: "domain-sign-in-client",
      clientSecret: "secret",
      authorizationEndpoint: issuer + "/authorize",
      tokenEndpoint: issuer + "/token",
      jwksEndpoint: issuer + "/jwks",
    },
  });
  expect((await request(org.id, `/${row.id}/disable`, "POST")).status).toBe(
    200,
  );
  fixture.issuer.enqueue({
    sub: "domain-disabled-subject",
    email: "user@" + domain,
    email_verified: true,
    name: "Domain user",
  });
  const result = await signInThroughIdp(fixture.app, {
    providerId: org.slug,
    callbackURL: fixture.trustedOrigin + "/callback",
  });
  expect(new URL(result.location!).searchParams.get("error")).toBe(
    "domain_not_allowed",
  );
  const events = await fixture.db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.targetId, row.id),
        eq(auditEvents.action, "domain.disabled"),
      ),
    );
  expect(events).toHaveLength(1);
  expect((await request(org.id, `/${row.id}/enable`, "POST")).status).toBe(200);
});
test("machine token performs every domain write", async () => {
  const kind = { bearer: await fixture.mintMachineToken() };
  const id = fixture.tenant.organizationId;
  const response = await request(
    id,
    "",
    "POST",
    { domain: "machine.example.com" },
    kind,
  );
  expect(response.status).toBe(201);
  const row = domainSchema.parse(await response.json());
  for (const action of ["disable", "enable"])
    expect(
      (await request(id, `/${row.id}/${action}`, "POST", undefined, kind))
        .status,
    ).toBe(200);
  expect((await request(id, "", "GET", undefined, kind)).status).toBe(200);
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
});
