import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { describeAdminRoutes } from "../../__tests__/admin-routes.ts";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { createOrganizationDomain } from "../../__tests__/domain-queries.ts";
import { signInThroughIdp } from "../../__tests__/federation.ts";
import { createSsoProvider } from "../../__tests__/sso-queries.ts";
import {
  auditEvents,
  entitlements,
  members,
  oauthClients,
  organizations,
  users,
} from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";
import { routes } from "./organizations.ts";
import { responseSchema } from "../../__tests__/openapi-response.ts";
const organizationSchema = responseSchema("getOrganization", 200);

let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture({}, { restrictedRole: true });
});
afterAll(async () => {
  await fixture?.close();
});
describeAdminRoutes(routes, () => fixture);

async function request(
  path = "",
  method = "GET",
  body?: unknown,
  kind: Parameters<AdminFixture["headers"]>[0] = "platformAdmin",
) {
  if (
    method === "DELETE" &&
    typeof body === "object" &&
    body !== null &&
    "confirm" in body
  ) {
    path += "?" + new URLSearchParams({ confirm: String(body.confirm) });
    body = undefined;
  }
  const headers = fixture.headers(kind);
  if (method === "PATCH") {
    const current = await fixture.app.request(
      "/api/admin/v1/organizations" + path,
      { headers },
    );
    headers.set(
      "If-Match",
      current.headers.get("ETag") ?? '"00000000-0000-7000-8000-000000000000:1"',
    );
  }

  headers.set("x-request-id", "organizations-http-test");
  headers.set("x-forwarded-for", "192.0.2.55");
  headers.set("user-agent", "organisation-test");
  if (body !== undefined) headers.set("content-type", "application/json");
  return fixture.app.request("/api/admin/v1/organizations" + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function create(slug: string) {
  const response = await request("", "POST", { slug, name: slug });
  expect(response.status).toBe(201);
  return organizationSchema.parse(await response.json());
}

test("listOrganizations: platform admin pagination has no gaps and filters name, slug and status", async () => {
  const a = await create("pagination-a");
  await create("pagination-b");
  await create("pagination-c");
  const expected = await fixture.db
    .select()
    .from(organizations)
    .orderBy(desc(organizations.id));
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const response = await request(
      "?limit=2" + (cursor ? "&cursor=" + cursor : ""),
    );
    expect(response.status).toBe(200);
    const page = (await response.json()) as {
      items: { id: string }[];
      nextCursor: string | null;
    };
    expect(page.items.length).toBeLessThanOrEqual(2);
    ids.push(...page.items.map((r) => r.id));
    cursor = page.nextCursor;
  } while (cursor);
  expect(ids).toEqual(expected.map((r) => r.id));
  await request("/" + a.id, "PATCH", { name: "Distinctive Name" });
  expect(
    (await (await request("?q=DISTINCTIVE")).json()).items.map(
      (r: { id: string }) => r.id,
    ),
  ).toEqual([a.id]);
  await request("/" + a.id + "/disable", "POST");
  expect(
    (await (await request("?q=PAGINATION&status=disabled")).json()).items.map(
      (r: { id: string }) => r.id,
    ),
  ).toEqual([a.id]);
});

test("createOrganization: cookie and machine writes return 201 and attributed audit with request ID", async () => {
  const token = await fixture.mintMachineToken();
  for (const kind of ["platformAdmin", { bearer: token }] as const) {
    const slug =
      typeof kind === "string" ? "created-cookie" : "created-machine";
    const response = await request(
      "",
      "POST",
      {
        slug,
        name: "Created",
      },
      kind,
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("x-request-id")).toBe(
      "organizations-http-test",
    );
    const row = organizationSchema.parse(await response.json());
    const events = await fixture.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.targetId, row.id));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "organization.created",
      actorType: typeof kind === "string" ? "user" : "client",
      actorId:
        typeof kind === "string"
          ? fixture.principals.platformAdmin.userId
          : fixture.platform.client.clientId,
      requestId: "organizations-http-test",
      ip: "192.0.2.55",
      userAgent: "organisation-test",
      organizationId: row.id,
      targetType: "organization",
      targetId: row.id,
    });
  }
  const duplicate = await request("", "POST", {
    slug: "created-cookie",
    name: "Duplicate",
  });
  expect(duplicate.status).toBe(409);
  expect(await duplicate.json()).toMatchObject({ code: "conflict" });
});

test("getOrganization: own tenant reader succeeds and outsider is hidden; platform reader succeeds", async () => {
  const response = await request(
    "/" + fixture.tenant.organizationId,
    "GET",
    undefined,
    "tenantReader",
  );
  expect(response.status).toBe(200);
  expect(organizationSchema.parse(await response.json()).id).toBe(
    fixture.tenant.organizationId,
  );
  expect(
    (
      await request(
        "/" + fixture.outsider.organizationId,
        "GET",
        undefined,
        "tenantReader",
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await request(
        "/" + fixture.tenant.organizationId,
        "GET",
        undefined,
        "platformReader",
      )
    ).status,
  ).toBe(200);
});

test("updateOrganization: renames and audits the change", async () => {
  const row = await create("patch-me");
  const patch = { name: "Patched" };
  const response = await request("/" + row.id, "PATCH", patch);
  expect(response.status).toBe(200);
  expect(organizationSchema.parse(await response.json())).toMatchObject(patch);
  const [event] = await fixture.db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.targetId, row.id),
        eq(auditEvents.action, "organization.updated"),
      ),
    );
  expect(event?.data).toMatchObject({
    before: { name: "patch-me" },
    after: { name: "Patched" },
  });
  expect(event?.data).not.toHaveProperty("changes");
  expect((await request("/" + row.id, "PATCH", {})).status).toBe(400);
});

test("disableOrganization and enableOrganization: global browser session survives while organisation access is disabled", async () => {
  const row = await create("fresh-tenant");
  const domain = "fresh-tenant.example.com";
  await createOrganizationDomain(fixture.db, {
    organizationId: row.id,
    domain,
  });
  const issuer = fixture.issuer.origin;
  await createSsoProvider(fixture.db, {
    organizationId: row.id,
    providerId: row.slug,
    domain,
    issuer,
    oidc: {
      clientId: "fresh-sso",
      clientSecret: "secret",
      authorizationEndpoint: issuer + "/authorize",
      tokenEndpoint: issuer + "/token",
      jwksEndpoint: issuer + "/jwks",
    },
  });
  fixture.issuer.enqueue({
    sub: "fresh-admin",
    email: "admin@" + domain,
    email_verified: true,
    name: "Fresh admin",
  });
  const signedIn = await signInThroughIdp(fixture.app, {
    providerId: row.slug,
    callbackURL: fixture.trustedOrigin + "/callback",
  });
  expect(signedIn.location).toBe(fixture.trustedOrigin + "/callback");
  expect(signedIn.cookies.length).toBeGreaterThan(0);
  const [member] = await fixture.db
    .select({ id: members.id })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(
      and(
        eq(members.organizationId, row.id),
        eq(users.email, "admin@" + domain),
      ),
    );
  await fixture.db.insert(entitlements).values({
    id: createId(),
    organizationId: row.id,
    memberId: member!.id,
    resource: fixture.platform.adminResource,
    scopes: ["org:read", "org:write"],
  });
  const headers = {
    Cookie: signedIn.cookies.map((value) => value.split(";", 1)[0]).join("; "),
    Origin: fixture.trustedOrigin,
  };
  expect(
    (await fixture.app.request("/api/admin/v1/me", { headers })).status,
  ).toBe(200);
  const disabled = await request("/" + row.id + "/disable", "POST");
  expect(disabled.status).toBe(200);
  expect(organizationSchema.parse(await disabled.json())).toMatchObject({
    status: "disabled",
    disabledAt: expect.any(String),
  });
  expect(
    (await fixture.app.request("/api/admin/v1/me", { headers })).status,
  ).toBe(200);
  expect((await request("/" + row.id + "/disable", "POST")).status).toBe(200);
  const enabled = await request("/" + row.id + "/enable", "POST");
  expect(enabled.status).toBe(200);
  expect(organizationSchema.parse(await enabled.json())).toMatchObject({
    status: "active",
    disabledAt: null,
  });
  expect(
    (await fixture.app.request("/api/admin/v1/me", { headers })).status,
  ).toBe(200);
  expect((await request("/" + row.id + "/enable", "POST")).status).toBe(200);
});

test("eraseOrganization: confirmation, owned client conflict and successful erasure retains audit", async () => {
  const row = await create("erase-me");
  const wrong = await request("/" + row.id, "DELETE", { confirm: createId() });
  expect(wrong.status).toBe(400);
  expect(await wrong.json()).toMatchObject({ code: "confirmation_mismatch" });
  await fixture.db.insert(oauthClients).values({
    id: createId(),
    clientId: "erase-owned",
    organizationId: row.id,
    redirectUris: [],
  });
  const blocked = await request("/" + row.id, "DELETE", { confirm: row.id });
  expect(blocked.status).toBe(409);
  expect(await blocked.json()).toMatchObject({
    code: "organization_has_clients",
  });
  await fixture.db
    .delete(oauthClients)
    .where(eq(oauthClients.clientId, "erase-owned"));
  const erased = await request("/" + row.id, "DELETE", { confirm: row.id });
  expect(erased.status).toBe(204);
  expect(await erased.text()).toBe("");
  expect(
    await fixture.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, row.id)),
  ).toMatchObject([{ status: "disabled", deletedAt: expect.any(Date) }]);
  const events = await fixture.db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.targetId, row.id),
        eq(auditEvents.action, "organization.erased"),
      ),
    );
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ targetId: row.id, organizationId: row.id });
});

test("organisation paths validate UUIDs and platform writes return 404 for missing rows", async () => {
  for (const [method, suffix, body] of [
    ["GET", "", undefined],
    ["PATCH", "", { name: "Missing" }],
    ["POST", "/disable", undefined],
    ["POST", "/enable", undefined],
    ["DELETE", "", { confirm: createId() }],
  ] as const) {
    expect((await request("/invalid" + suffix, method, body)).status).toBe(400);
    const id = createId();
    const response = await request(
      "/" + id + suffix,
      method,
      method === "DELETE" ? { confirm: id } : body,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
  }
  for (const body of [
    { slug: "Bad_slug", name: "Bad" },
    { slug: "valid", name: "" },
  ]) {
    expect((await request("", "POST", body)).status).toBe(400);
  }
});
