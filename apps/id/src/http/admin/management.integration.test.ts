import { afterEach, beforeEach, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { createId } from "../../lib/id.ts";
import {
  auditEvents,
  oauthAccessTokens,
  oauthRefreshTokens,
  oauthConsents,
} from "../../db/schema/index.ts";
import { listClientResources } from "../../db/queries/oauth-clients.ts";
import * as auditService from "../../services/audit.ts";
let fixture: AdminFixture;
beforeEach(async () => {
  fixture = await createAdminFixture();
});
afterEach(async () => {
  await fixture?.close();
});
type Kind = Parameters<AdminFixture["headers"]>[0];
function request(kind: Kind, path: string, method = "GET", body?: unknown) {
  const headers = fixture.headers(kind);
  if (body !== undefined) headers.set("content-type", "application/json");
  return fixture.app.request(`/api/admin/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function read(kind: Kind, path: string) {
  const response = await request(kind, path);
  expect(response.status).toBe(200);
  return response.json();
}
async function create(kind: Kind, path: string, body: unknown) {
  const response = await request(kind, path, "POST", body);
  expect(response.status).toBe(201);
  return response.json();
}
for (const machine of [false, true]) {
  test(`${machine ? "machine" : "platformAdmin"} erases a client, its cascades and former owner, and deletes domains`, async () => {
    const kind: Kind = machine
      ? { bearer: await fixture.mintMachineToken() }
      : "platformAdmin";
    const suffix = machine ? "machine" : "human";
    const org = await create(kind, "/organizations", {
      slug: `erase-${suffix}`,
      name: "Erase",
    });
    const domain = await create(kind, `/organizations/${org.id}/domains`, {
      domain: `${suffix}.erase.example.com`,
    });
    const domainPath = `/organizations/${org.id}/domains/${domain.id}`;
    expect((await request(kind, domainPath, "DELETE")).status).toBe(204);
    expect((await request(kind, domainPath, "DELETE")).status).toBe(404);
    const client = await create(kind, "/clients", {
      clientId: `erase-${suffix}`,
      name: "Erase",
      organizationId: org.id,
      tokenEndpointAuthMethod: "client_secret_basic",
      grantTypes: ["client_credentials"],
      clientCredentialsScopes: ["read"],
      redirectUris: [],
    });
    const resource = `https://${suffix}.erase.example.com`;
    await create(kind, "/resources", {
      identifier: resource,
      name: "Erase",
      allowedScopes: ["read"],
    });
    expect(
      (
        await request(
          kind,
          `/clients/${client.clientId}/resources/${encodeURIComponent(resource)}`,
          "PUT",
        )
      ).status,
    ).toBe(201);
    expect((await read(kind, `/clients/${client.clientId}`)).resources).toEqual(
      [resource],
    );
    expect(
      (await read(kind, `/resources/${encodeURIComponent(resource)}`)).clients,
    ).toEqual([client.clientId]);
    expect(
      (await read(kind, `/clients?q=${client.clientId}`)).items[0],
    ).not.toHaveProperty("resources");
    expect(
      (await read(kind, `/resources?q=${encodeURIComponent(resource)}`))
        .items[0],
    ).not.toHaveProperty("clients");
    const tokenResponse = await fixture.app.request("/auth/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        resource,
        scope: "read",
      }),
    });
    expect(tokenResponse.status).toBe(200);
    await fixture.db.insert(oauthAccessTokens).values({
      id: createId(),
      token: createId(),
      clientId: client.clientId,
      scopes: ["read"],
      expiresAt: new Date(Date.now() + 60000),
    });
    const userId = fixture.principals.tenantReader.userId;
    await fixture.db.insert(oauthRefreshTokens).values({
      id: createId(),
      token: createId(),
      userId,
      clientId: client.clientId,
      scopes: ["read"],
      expiresAt: new Date(Date.now() + 60000),
    });
    await fixture.db.insert(oauthConsents).values({
      id: createId(),
      userId,
      clientId: client.clientId,
      scopes: ["read"],
    });
    const grant = await create(kind, `/organizations/${org.id}/entitlements`, {
      clientId: client.clientId,
      scopes: ["read"],
    });
    const erasePath = `/clients/${client.clientId}?confirm=${client.clientId}`;
    expect(
      (await request(kind, "/clients/missing?confirm=wrong", "DELETE")).status,
    ).toBe(404);
    expect(
      await (
        await request(
          kind,
          `/clients/${client.clientId}?confirm=wrong`,
          "DELETE",
        )
      ).json(),
    ).toMatchObject({ status: 400, code: "confirmation_mismatch" });
    expect(
      (await request(kind, `/clients/${client.clientId}`, "DELETE")).status,
    ).toBe(400);
    expect(
      await (await request(kind, erasePath, "DELETE")).json(),
    ).toMatchObject({ status: 409, code: "client_has_entitlements" });
    expect(
      (
        await request(
          kind,
          `/organizations/${org.id}?confirm=${org.id}`,
          "DELETE",
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await request(
          kind,
          `/organizations/${org.id}/entitlements/${grant.id}`,
          "DELETE",
        )
      ).status,
    ).toBe(204);
    expect((await request(kind, erasePath, "DELETE")).status).toBe(204);
    expect((await request(kind, erasePath, "DELETE")).status).toBe(404);
    expect(await listClientResources(fixture.db, client.clientId)).toEqual([]);
    for (const table of [oauthAccessTokens, oauthRefreshTokens, oauthConsents])
      expect(
        await fixture.db
          .select()
          .from(table)
          .where(eq(table.clientId, client.clientId)),
      ).toEqual([]);
    for (const [action, targetType, targetId] of [
      ["client.erased", "client", client.clientId],
      ["domain.deleted", "domain", domain.id],
    ]) {
      const events = await fixture.db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.action, action!),
            eq(auditEvents.targetId, targetId),
          ),
        );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        organizationId: org.id,
        targetType,
        targetId,
        outcome: "success",
        actorType: machine ? "client" : "user",
        actorId: machine
          ? fixture.platform.client.clientId
          : fixture.principals.platformAdmin.userId,
      });
    }
    expect(
      (
        await request(
          kind,
          `/organizations/${org.id}?confirm=${org.id}`,
          "DELETE",
        )
      ).status,
    ).toBe(204);
  });
  test(`${machine ? "machine" : "platformAdmin"} reviews exact emails, cross-organisation entitlements and personal audit trails`, async () => {
    const kind: Kind = machine
      ? { bearer: await fixture.mintMachineToken() }
      : "platformAdmin";
    const person = fixture.principals.tenantReader;
    const email = "TENANTREADER@TENANT.EXAMPLE.COM";
    for (const path of [
      "/users",
      `/organizations/${person.organizationId}/members`,
    ]) {
      const page = await read(kind, `${path}?email=${email}&q=tenantreader`);
      expect(page.items).toHaveLength(1);
      expect(page.items[0].email).toBe(email.toLowerCase());
      expect(
        (await read(kind, `${path}?email=${email}&q=outsider`)).items,
      ).toEqual([]);
    }
    const resource = `https://${machine ? "machine" : "human"}.review.example.com`;
    await create(kind, "/resources", {
      identifier: resource,
      name: "Review",
      allowedScopes: ["read"],
    });
    const grants = [];
    for (const org of [fixture.tenant, fixture.outsider])
      grants.push(
        await create(
          kind,
          `/organizations/${org.organizationId}/entitlements`,
          { resource, scopes: ["read"] },
        ),
      );
    const base = `/entitlements?resource=${encodeURIComponent(resource)}&status=active`;
    const all = await read(kind, base);
    expect(
      all.items.map(
        (row: { organization: { slug: string } }) => row.organization.slug,
      ),
    ).toEqual(["outsider", "tenant"]);
    expect(all.items.map((row: { id: string }) => row.id)).toEqual(
      grants.toReversed().map((row) => row.id),
    );
    const first = await read(kind, `${base}&limit=1`);
    expect(first.items).toHaveLength(1);
    const second = await read(
      kind,
      `${base}&limit=1&cursor=${first.nextCursor}`,
    );
    expect(second.items).toEqual([all.items[1]]);
    expect(second.nextCursor).toBeNull();
    expect((await request("tenantReader", "/clients")).status).toBe(403);
    expect(
      (
        await request(
          "tenantUsersOnly",
          `/organizations/${person.organizationId}/audit-events`,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          kind,
          `/organizations/${person.organizationId}/members/${person.memberId}`,
          "PATCH",
          { validUntil: null },
        )
      ).status,
    ).toBe(200);
    expect(
      (await request(kind, `/users/${person.userId}/sessions`, "DELETE"))
        .status,
    ).toBe(200);
    const trailPath = `/users/${person.userId}/audit-events`;
    const trail = await read(kind, `${trailPath}?limit=200`);
    for (const action of [
      "auth.signin.succeeded",
      "admin.denied",
      "member.updated",
      "session.revoked_all",
    ])
      expect(
        trail.items.some((row: { action: string }) => row.action === action),
      ).toBe(true);
    expect(
      trail.items.every(
        (row: {
          actorId: string;
          targetId: string;
          targetType: string;
          data: { userId?: string } | null;
        }) =>
          row.actorId === person.userId ||
          (row.targetType === "user" && row.targetId === person.userId) ||
          (["member", "group_member"].includes(row.targetType) &&
            row.targetId === person.memberId) ||
          (row.targetType === "session" && row.data?.userId === person.userId),
      ),
    ).toBe(true);
    for (const path of [
      "/audit-events",
      `/organizations/${person.organizationId}/audit-events`,
      trailPath,
    ]) {
      const page = await read(kind, `${path}?outcome=denied&limit=200`);
      expect(page.items.length).toBeGreaterThan(0);
      expect(
        page.items.every(
          (row: { outcome: string }) => row.outcome === "denied",
        ),
      ).toBe(true);
    }
    const filtered = await read(
      kind,
      `${trailPath}?action=member.updated&outcome=success&from=2000-01-01T00:00:00Z&to=2100-01-01T00:00:00Z&limit=1`,
    );
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0].action).toBe("member.updated");
    const page = await read(kind, `${trailPath}?limit=1`);
    const next = await read(
      kind,
      `${trailPath}?limit=200&cursor=${page.nextCursor}`,
    );
    expect([...page.items, ...next.items]).toEqual(trail.items);
    expect(
      (await request(kind, `/users/${createId()}/audit-events`)).status,
    ).toBe(404);
    await expect(
      auditService.listUserAuditEvents(
        fixture.db,
        createId(),
        {},
        { limit: 1 },
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (
        await auditService.listUserAuditEvents(
          fixture.db,
          person.userId,
          { outcome: "denied" },
          { limit: 200 },
        )
      ).items.every((row) => row.outcome === "denied"),
    ).toBe(true);
  });
}

test("new review filters reject invalid email, outcome, status, dates and cursors", async () => {
  const userId = fixture.principals.tenantReader.userId;
  for (const path of [
    "/users?email=invalid",
    `/organizations/${fixture.tenant.organizationId}/members?email=invalid`,
    "/audit-events?outcome=invalid",
    `/organizations/${fixture.tenant.organizationId}/audit-events?outcome=invalid`,
    `/users/${userId}/audit-events?outcome=invalid`,
    `/users/${userId}/audit-events?from=invalid`,
    `/users/${userId}/audit-events?cursor=invalid`,
    "/entitlements?status=invalid",
    "/entitlements?resource=invalid",
    "/entitlements?limit=0",
    "/entitlements?cursor=invalid",
  ]) {
    const response = await request("platformAdmin", path);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "validation_failed" });
  }
});
