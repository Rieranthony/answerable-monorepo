import { afterBrokerRead } from "../../__tests__/after-broker-read.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { describeAdminRoutes } from "../../__tests__/admin-routes.ts";
import { createOrganization } from "../../__tests__/organization-queries.ts";
import {
  auditEvents,
  adminOperations,
  adminOperationResults,
  members,
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
async function request(
  organizationId: string,
  suffix = "",
  method = "GET",
  body?: unknown,
  kind: Parameters<AdminFixture["headers"]>[0] = "platformAdmin",
) {
  const headers = fixture.headers(kind);
  if (method === "PUT") {
    const current = await fixture.app.request(
      `/api/admin/v1/organizations/${organizationId}/sso-provider`,
      { headers },
    );
    const tag = current.headers.get("ETag");
    headers.set(tag ? "If-Match" : "If-None-Match", tag ?? "*");
  }
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
import { findSsoProviderByOrganization } from "../../__tests__/sso-queries.ts";
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

import { createSsoProvider } from "../../__tests__/sso-queries.ts";
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

const preconditions = new Map<string, { name: string; value: string }>();
async function command(
  org: string,
  key: string,
  method: string,
  body?: unknown,
) {
  const headers = fixture.headers("platformAdmin");
  headers.set("Idempotency-Key", key);
  if (method === "PUT") {
    if (!preconditions.has(key)) {
      const current = await fixture.app.request(
        `/api/admin/v1/organizations/${org}/sso-provider`,
        { headers },
      );
      const tag = current.headers.get("ETag");
      preconditions.set(key, {
        name: tag ? "If-Match" : "If-None-Match",
        value: tag ?? "*",
      });
    }
    const precondition = preconditions.get(key)!;
    headers.set(precondition.name, precondition.value);
  }
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return fixture.app.request(
    `/api/admin/v1/organizations/${org}/sso-provider`,
    {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
}
test("SSO retries recover historical redacted results without replacing later credentials", async () => {
  const org = await createOrganization(fixture.db, {
    slug: "sso-replay",
    name: "SSO replay",
  });
  const first = await command(org.id, "sso-create", "PUT", {
    ...input,
    oidc: { ...input.oidc, scopes: ["profile", "openid", "profile"] },
  });
  expect(first.status).toBe(201);
  expect(first.headers.get("Operation-Id")).toBeString();
  const original = await first.json();
  expectRedacted(original);
  const replacement = {
    ...input,
    oidc: { clientId: "later-client", clientSecret: "later-secret" },
  };
  expect(
    (await command(org.id, "sso-replace", "PUT", replacement)).status,
  ).toBe(200);
  const replay = await command(org.id, "sso-create", "PUT", {
    ...input,
    domain: "acme.example.com",
    oidc: {
      ...input.oidc,
      scopes: ["openid", "profile"],
      pkce: true,
      tokenEndpointAuthentication: "client_secret_post",
    },
  });
  expect(replay.status).toBe(201);
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  expect(await replay.json()).toEqual(original);
  expect(
    JSON.parse(
      (await findSsoProviderByOrganization(fixture.db, org.id))!.oidcConfig!,
    ),
  ).toMatchObject({ clientId: "later-client", clientSecret: "later-secret" });
  expect((await command(org.id, "sso-create", "PUT", replacement)).status).toBe(
    409,
  );
  const removed = await command(org.id, "sso-delete", "DELETE");
  expect(removed.status).toBe(204);
  expect(
    (await command(org.id, "sso-recreate", "PUT", replacement)).status,
  ).toBe(201);
  const current = await findSsoProviderByOrganization(fixture.db, org.id);
  expect(current!.id).not.toBe(original.id);
  const deleteReplay = await command(org.id, "sso-delete", "DELETE");
  expect(deleteReplay.status).toBe(204);
  expect(deleteReplay.headers.get("Idempotency-Replayed")).toBe("true");
  expect((await findSsoProviderByOrganization(fixture.db, org.id))!.id).toBe(
    current!.id,
  );
  const events = await fixture.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.operationId, first.headers.get("Operation-Id")!));
  expect(events).toHaveLength(1);
  expectRedacted(events);
});

test("SSO noops preserve timestamps and credentials while secret changes remain fingerprinted", async () => {
  const org = await createOrganization(fixture.db, {
    slug: "sso-noop",
    name: "Noop",
  });
  const first = await command(org.id, "sso-noop-create", "PUT", input);
  const original = await first.json();
  const noop = await command(org.id, "sso-noop", "PUT", {
    ...input,
    oidc: { clientId: input.oidc.clientId },
  });
  expect(noop.status).toBe(200);
  expect(await noop.json()).toEqual(original);
  const [receipt] = await fixture.db
    .select()
    .from(adminOperations)
    .where(eq(adminOperations.id, noop.headers.get("Operation-Id")!));
  expect(receipt?.outcome).toBe("noop");
  expect(receipt?.fingerprint).toStartWith("hmac-v1.");
  const [event] = await fixture.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.operationId, receipt!.id));
  expect(event).toMatchObject({
    action: "sso_provider.update_unchanged",
    data: {
      before: { issuer: input.issuer },
      after: { issuer: input.issuer },
      credentialsChanged: false,
    },
  });
  expectRedacted(event);
  const rotateInput = {
    ...input,
    oidc: { ...input.oidc, clientSecret: "replacement-secret" },
  };
  const rotation = await command(org.id, "sso-rotate", "PUT", rotateInput);
  expect(rotation.status).toBe(200);
  const [rotationEvent] = await fixture.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.operationId, rotation.headers.get("Operation-Id")!));
  expect(rotationEvent?.data).toMatchObject({ credentialsChanged: true });
  expect(JSON.stringify(rotationEvent)).not.toContain("replacement-secret");
  expect(
    (
      await command(org.id, "sso-rotate", "PUT", {
        ...rotateInput,
        oidc: { ...rotateInput.oidc, clientSecret: "different-secret" },
      })
    ).status,
  ).toBe(409);
  expect(
    (await command(org.id, "sso-rotate", "PUT", rotateInput)).headers.get(
      "Idempotency-Replayed",
    ),
  ).toBe("true");
  const [stored] = await fixture.db
    .select()
    .from(adminOperationResults)
    .where(
      eq(
        adminOperationResults.operationId,
        rotation.headers.get("Operation-Id")!,
      ),
    );
  expect(stored!.ciphertext).not.toContain("replacement-secret");
});

test("SSO audit failure rolls back credentials and the command reservation", async () => {
  const org = await createOrganization(fixture.db, {
    slug: "sso-rollback",
    name: "Rollback",
  });
  await command(org.id, "sso-rollback-create", "PUT", input);
  const before = await findSsoProviderByOrganization(fixture.db, org.id);
  const receipts = await fixture.db.select().from(adminOperations);
  await fixture.db.execute(
    sql`alter table audit_events add constraint sso_replay_fault check (action <> 'sso_provider.updated') not valid`,
  );
  const changed = {
    ...input,
    oidc: { clientId: "changed", clientSecret: "failed-secret" },
  };
  try {
    expect(
      (await command(org.id, "sso-rollback", "PUT", changed)).status,
    ).toBeGreaterThanOrEqual(400);
  } finally {
    await fixture.db.execute(
      sql`alter table audit_events drop constraint sso_replay_fault`,
    );
  }
  expect(await findSsoProviderByOrganization(fixture.db, org.id)).toEqual(
    before,
  );
  expect(await fixture.db.select().from(adminOperations)).toEqual(receipts);
  expect((await command(org.id, "sso-rollback", "PUT", changed)).status).toBe(
    200,
  );
  expect(
    (await command(org.id, "sso-rollback", "PUT", changed)).headers.get(
      "Idempotency-Replayed",
    ),
  ).toBe("true");
});

test("concurrent SSO creation has one mutation and a recoverable result", async () => {
  const org = await createOrganization(fixture.db, {
    slug: "sso-concurrent",
    name: "Concurrent",
  });
  preconditions.set("sso-concurrent", { name: "If-None-Match", value: "*" });
  const responses = await Promise.all([
    command(org.id, "sso-concurrent", "PUT", input),
    command(org.id, "sso-concurrent", "PUT", input),
  ]);
  expect(responses.some((response) => response.status === 201)).toBe(true);
  for (const response of responses) {
    expect([201, 409]).toContain(response.status);
    if (response.status === 409)
      expect(await response.json()).toMatchObject({
        code: "operation_in_progress",
      });
  }
  const replay = await command(org.id, "sso-concurrent", "PUT", input);
  expect(replay.status).toBe(201);
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  expect(
    await fixture.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.operationId, replay.headers.get("Operation-Id")!)),
  ).toHaveLength(1);
});

test("SSO replay rechecks current platform authority", async () => {
  const org = await createOrganization(fixture.db, {
    slug: "sso-authority",
    name: "Authority",
  });
  const first = await command(org.id, "sso-authority", "PUT", input);
  expect(first.status).toBe(201);
  const original = fixture.db.transaction.bind(fixture.db);
  const actor = fixture.principals.platformAdmin;
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
    const denied = await command(org.id, "sso-authority", "PUT", input);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "insufficient_scope" });
  } finally {
    fixture.db.transaction = original;
    await fixture.db
      .update(members)
      .set({ status: "active", revokedAt: null })
      .where(eq(members.id, actor.memberId));
  }
  expect(
    await fixture.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.operationId, first.headers.get("Operation-Id")!)),
  ).toHaveLength(1);
});
