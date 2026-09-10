import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { describeAdminRoutes } from "../../__tests__/admin-routes.ts";
import { createOrganization } from "../../__tests__/organization-queries.ts";
import {
  auditEvents,
  adminOperations,
  organizationDomains,
} from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";
let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture();
});
afterAll(async () => {
  await fixture?.close();
});
describeAdminRoutes(routes, () => fixture);
test("domain creation and deletion recover their committed result without adopting another target", async () => {
  const headers = fixture.headers("platformAdmin");
  headers.set("content-type", "application/json");
  const path = `/api/admin/v1/organizations/${fixture.tenant.organizationId}/domains`;
  const create = (domain: string) =>
    fixture.app.request(path, {
      method: "POST",
      headers,
      body: JSON.stringify({ domain }),
    });
  const first = await create(" REPLAY.EXAMPLE.COM ");
  expect(first.status).toBe(201);
  const row = await first.json();
  const operationId = first.headers.get("Operation-Id");
  expect(operationId).toBeTruthy();
  const replay = await create("replay.example.com");
  expect(replay.status).toBe(201);
  expect(await replay.json()).toEqual(row);
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  expect((await create("different.example.com")).status).toBe(409);
  expect(
    await fixture.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.operationId, operationId!)),
  ).toHaveLength(1);
  headers.set("Idempotency-Key", createId());
  const remove = () =>
    fixture.app.request(`${path}/${row.id}`, { method: "DELETE", headers });
  const deleted = await remove();
  expect(deleted.status).toBe(204);
  expect((await remove()).headers.get("Idempotency-Replayed")).toBe("true");
  expect(
    await fixture.db
      .select()
      .from(organizationDomains)
      .where(eq(organizationDomains.id, row.id)),
  ).toMatchObject([{ status: "disabled", deletedAt: expect.any(Date) }]);
  const [receipt] = await fixture.db
    .select()
    .from(adminOperations)
    .where(eq(adminOperations.id, deleted.headers.get("Operation-Id")!));
  expect(receipt!.resultReference).toEqual({ type: "domain", id: row.id });
});

test("domain lifecycle replay preserves original state while new keys record noops", async () => {
  const created = await request(fixture.tenant.organizationId, "", "POST", {
    domain: "lifecycle-replay.example.com",
  });
  const row = await created.json();
  const headers = fixture.headers("platformAdmin");
  for (const verb of ["disable", "enable"]) {
    headers.set("Idempotency-Key", createId());
    const send = () =>
      fixture.app.request(
        `/api/admin/v1/organizations/${fixture.tenant.organizationId}/domains/${row.id}/${verb}`,
        { method: "POST", headers },
      );
    const first = await send();
    expect(first.status).toBe(200);
    const body = await first.json();
    const replay = await send();
    expect(await replay.json()).toEqual(body);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(
      await fixture.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.operationId, first.headers.get("Operation-Id")!)),
    ).toHaveLength(1);
    headers.set("Idempotency-Key", createId());
    const unchanged = await send();
    expect(await unchanged.json()).toEqual(body);
    const [receipt] = await fixture.db
      .select()
      .from(adminOperations)
      .where(eq(adminOperations.id, unchanged.headers.get("Operation-Id")!));
    expect(receipt!.outcome).toBe("noop");
  }
});

test("a failed domain audit rolls back its assignment and command reservation", async () => {
  const headers = fixture.headers("platformAdmin");
  headers.set("content-type", "application/json");
  const send = () =>
    fixture.app.request(
      `/api/admin/v1/organizations/${fixture.tenant.organizationId}/domains`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ domain: "audit-retry.example.com" }),
      },
    );
  const before = await fixture.db.select().from(adminOperations);
  await fixture.db.execute(
    sql`alter table audit_events add constraint domain_replay_fault check (action <> 'domain.created') not valid`,
  );
  try {
    expect((await send()).status).toBeGreaterThanOrEqual(400);
  } finally {
    await fixture.db.execute(
      sql`alter table audit_events drop constraint domain_replay_fault`,
    );
  }
  expect(await fixture.db.select().from(adminOperations)).toEqual(before);
  expect(
    await fixture.db
      .select()
      .from(organizationDomains)
      .where(eq(organizationDomains.domain, "audit-retry.example.com")),
  ).toHaveLength(0);
  expect((await send()).status).toBe(201);
  expect((await send()).headers.get("Idempotency-Replayed")).toBe("true");
});
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
import { createOrganizationDomain } from "../../__tests__/domain-queries.ts";
import { createSsoProvider } from "../../__tests__/sso-queries.ts";
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
  expect((await request(id, `/${row.id}/enable`, "POST")).status).toBe(200);
  expect((await request(id, `/${row.id}/disable`, "POST")).status).toBe(200);
  expect((await request(id, `/${row.id}/disable`, "POST")).status).toBe(200);
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
    "domain.enable_unchanged",
    "domain.disabled",
    "domain.disable_unchanged",
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
