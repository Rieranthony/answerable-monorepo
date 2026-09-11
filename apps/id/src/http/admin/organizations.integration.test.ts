import { afterBrokerRead } from "../../__tests__/after-broker-read.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { describeAdminRoutes } from "../../__tests__/admin-routes.ts";
import { signInThroughIdp } from "../../__tests__/federation.ts";
import { createOrganizationDomain } from "../../__tests__/domain-queries.ts";
import { createSsoProvider } from "../../__tests__/sso-queries.ts";
import {
  auditEvents,
  adminOperations,
  entitlements,
  members,
  oauthClients,
  oauthResources,
  organizations,
  users,
} from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";
import {
  organizationSchema,
  organizationSummarySchema,
  routes,
} from "./organizations.ts";

let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture();
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

test("getOrganizationSummary: tenant reader, platform reader and machine see counts; outsider is hidden", async () => {
  const token = await fixture.mintMachineToken(["platform:read"]);
  for (const kind of [
    "tenantReader",
    "platformReader",
    { bearer: token },
  ] as const) {
    const response = await request(
      "/" + fixture.tenant.organizationId + "/summary",
      "GET",
      undefined,
      kind,
    );
    expect(response.status).toBe(200);
    const summary = organizationSummarySchema.parse(await response.json());
    expect(summary).toMatchObject({
      organization: { id: fixture.tenant.organizationId },
      domains: { active: 1, disabled: 0 },
      ssoProvider: {
        configured: true,
        kind: "oidc",
        issuer: fixture.issuer.origin,
      },
      members: {
        total: 6,
        effective: 5,
        byStatus: { inert: 0, active: 5, disabled: 1 },
      },
      groups: { active: 0, disabled: 0 },
      entitlements: {
        active: 5,
        disabled: 0,
        targets: [
          { kind: "resource", id: fixture.platform.adminResource, rows: 5 },
        ],
      },
      clients: { owned: 0 },
      signIns7d: { succeeded: 6, lastSucceededAt: expect.any(String) },
    });
  }
  expect(
    (
      await request(
        "/" + fixture.outsider.organizationId + "/summary",
        "GET",
        undefined,
        "tenantReader",
      )
    ).status,
  ).toBe(404);
  expect((await request("/invalid/summary")).status).toBe(400);
});

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
        logo: "https://example.com/logo",
        metadata: "{}",
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

test("updateOrganization: nullable fields and audit changes", async () => {
  const row = await create("patch-me");
  const patch = { name: "Patched", logo: null, metadata: null };
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
    after: { name: "Patched", logo: null },
    metadataChanged: false,
  });
  expect(event?.data).not.toHaveProperty("changes");
  expect(event?.data).not.toHaveProperty("after.metadata");
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
    { slug: "valid", name: "Bad", logo: "not-url" },
    { slug: "valid", name: "Bad", metadata: "x".repeat(4001) },
  ]) {
    expect((await request("", "POST", body)).status).toBe(400);
  }
});

test("erase requires a query confirmation and checks existence before mismatch", async () => {
  const id = crypto.randomUUID();
  const path = `/api/admin/v1/organizations/${id}`;
  for (const [query, status, code] of [
    ["", 400, "validation_failed"],
    ["?confirm=invalid", 400, "validation_failed"],
    ["?" + new URLSearchParams({ confirm: id }), 404, "not_found"],
    [
      "?" + new URLSearchParams({ confirm: crypto.randomUUID() }),
      404,
      "not_found",
    ],
  ] as const) {
    const response = await fixture.app.request(path + query, {
      method: "DELETE",
      headers: fixture.headers("platformAdmin"),
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
  }
  const headers = fixture.headers("platformAdmin");
  headers.set("content-type", "application/json");
  const response = await fixture.app.request(path, {
    method: "DELETE",
    headers,
    body: JSON.stringify({ confirm: id }),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ code: "validation_failed" });
});

test("organisation commands recover committed results across lifecycle changes and erasure", async () => {
  const input = { slug: "organisation-replay", name: "Replay" };
  const first = await command("org-create", "", "POST", input);
  expect(first.status).toBe(201);
  const original = await first.json();
  expect(first.headers.get("Operation-Id")).toBeString();
  const duplicate = await command("org-create", "", "POST", input);
  expect(duplicate.headers.get("Idempotency-Replayed")).toBe("true");
  expect(await duplicate.json()).toEqual(original);
  expect(
    (await command("org-create", "", "POST", { ...input, name: "Other" }))
      .status,
  ).toBe(409);
  for (const [suffix, method, body] of [
    ["", "PATCH", { name: "Changed" }],
    ["/disable", "POST", undefined],
    ["/enable", "POST", undefined],
  ] as const) {
    const key = `org-${method}-${suffix}`;
    const path = `/${original.id}${suffix}`;
    const changed = await command(key, path, method, body);
    expect(changed.status).toBe(200);
    const saved = await changed.json();
    const repeated = await command(key, path, method, body);
    expect(repeated.headers.get("Operation-Id")).toBe(
      changed.headers.get("Operation-Id"),
    );
    expect(repeated.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await repeated.json()).toEqual(saved);
    expect(
      await fixture.db
        .select()
        .from(auditEvents)
        .where(
          eq(auditEvents.operationId, changed.headers.get("Operation-Id")!),
        ),
    ).toHaveLength(1);
    const noop = await command(`${key}-noop`, path, method, body);
    expect(noop.status).toBe(200);
    expect(await noop.json()).toEqual(saved);
    const [receipt] = await fixture.db
      .select()
      .from(adminOperations)
      .where(eq(adminOperations.id, noop.headers.get("Operation-Id")!));
    expect(receipt?.outcome).toBe("noop");
  }
  const erasePath = `/${original.id}?confirm=${original.id}`;
  const erased = await command("org-erase", erasePath, "DELETE");
  expect(erased.status).toBe(204);
  const eraseReplay = await command("org-erase", erasePath, "DELETE");
  expect(eraseReplay.status).toBe(204);
  expect(eraseReplay.headers.get("Idempotency-Replayed")).toBe("true");
  expect(
    await fixture.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, original.id)),
  ).toMatchObject([{ status: "disabled", deletedAt: expect.any(Date) }]);
  const creationReplay = await command("org-create", "", "POST", input);
  expect(creationReplay.headers.get("Idempotency-Replayed")).toBe("true");
  expect(await creationReplay.json()).toEqual(original);
});

const patchTags = new Map<string, string>();
async function command(
  key: string,
  path: string,
  method: string,
  body?: unknown,
) {
  const headers = fixture.headers("platformAdmin");
  headers.set("Idempotency-Key", key);
  if (method === "PATCH") {
    if (!patchTags.has(key)) {
      const current = await fixture.app.request(
        `/api/admin/v1/organizations${path}`,
        { headers },
      );
      patchTags.set(key, current.headers.get("ETag")!);
    }
    headers.set("If-Match", patchTags.get(key)!);
  }
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return fixture.app.request(`/api/admin/v1/organizations${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("organisation audit failure rolls back both creation and its replay reservation", async () => {
  const input = { slug: "org-atomic-replay", name: "Atomic" };
  const before = await fixture.db.select().from(adminOperations);
  await fixture.db.execute(
    sql`alter table audit_events add constraint org_replay_fault check (action <> 'organization.created') not valid`,
  );
  try {
    expect(
      (await command("org-atomic", "", "POST", input)).status,
    ).toBeGreaterThanOrEqual(400);
  } finally {
    await fixture.db.execute(
      sql`alter table audit_events drop constraint org_replay_fault`,
    );
  }
  expect(await fixture.db.select().from(adminOperations)).toEqual(before);
  expect(
    await fixture.db
      .select()
      .from(organizations)
      .where(eq(organizations.slug, input.slug)),
  ).toHaveLength(0);
  expect((await command("org-atomic", "", "POST", input)).status).toBe(201);
  expect(
    (await command("org-atomic", "", "POST", input)).headers.get(
      "Idempotency-Replayed",
    ),
  ).toBe("true");
});

test("concurrent organisation creation commits once", async () => {
  const input = { slug: "org-concurrent-replay", name: "Concurrent" };
  const responses = await Promise.all([
    command("org-concurrent", "", "POST", input),
    command("org-concurrent", "", "POST", input),
  ]);
  expect(responses.some((response) => response.status === 201)).toBe(true);
  for (const response of responses) {
    expect([201, 409]).toContain(response.status);
    if (response.status === 409)
      expect(await response.json()).toMatchObject({
        code: "operation_in_progress",
      });
  }
  const replay = await command("org-concurrent", "", "POST", input);
  expect(replay.status).toBe(201);
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  expect(
    await fixture.db
      .select()
      .from(organizations)
      .where(eq(organizations.slug, input.slug)),
  ).toHaveLength(1);
  expect(
    await fixture.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.operationId, replay.headers.get("Operation-Id")!)),
  ).toHaveLength(1);
});

test("organisation replay rechecks platform authority after middleware admission", async () => {
  const input = { slug: "org-authority-replay", name: "Authority" };
  const first = await command("org-authority", "", "POST", input);
  expect(first.status).toBe(201);
  const actor = fixture.principals.platformAdmin;
  const original = fixture.db.transaction.bind(fixture.db);
  fixture.db.transaction = afterBrokerRead(original, (async (
    ...args: Parameters<typeof original>
  ) => {
    fixture.db.transaction = original;
    await fixture.db
      .update(members)
      .set({ status: "revoked", revokedAt: new Date() })
      .where(eq(members.id, actor.memberId));
    return original(...args);
  }) as typeof original);
  try {
    const denied = await command("org-authority", "", "POST", input);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "insufficient_scope" });
    expect(
      await fixture.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.operationId, first.headers.get("Operation-Id")!)),
    ).toHaveLength(1);
  } finally {
    fixture.db.transaction = original;
    await fixture.db
      .update(members)
      .set({ status: "active", revokedAt: null })
      .where(eq(members.id, actor.memberId));
  }
});

test("getOrganizationSummary: exact pairs retain both identifiers in the HTTP contract", async () => {
  const organization = await create("summary-pairs");
  const clientId = createId();
  const resource = `https://${createId()}.example`;
  await fixture.db
    .insert(oauthClients)
    .values({ id: createId(), clientId, redirectUris: [] });
  await fixture.db
    .insert(oauthResources)
    .values({ id: createId(), identifier: resource, name: "Summary" });
  await fixture.db.insert(entitlements).values({
    id: createId(),
    organizationId: organization.id,
    clientId,
    resource,
    scopes: ["read"],
  });
  const response = await request(`/${organization.id}/summary`);
  expect(response.status).toBe(200);
  const summary = organizationSummarySchema.parse(await response.json());
  expect(summary.entitlements.targets).toEqual([
    { kind: "client_resource", id: clientId, resource, rows: 1 },
  ]);
});
