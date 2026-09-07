import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { describeAdminRoutes } from "../../__tests__/admin-routes.ts";
import { auditEvents } from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";
import { createGroup, addGroupMember } from "../../db/queries/groups.ts";
import { createResource } from "../../db/queries/oauth-resources.ts";
import { routes } from "./access.ts";
let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture();
});
afterAll(async () => {
  await fixture?.close();
});
describeAdminRoutes(routes, () => fixture);
type Kind = Parameters<AdminFixture["headers"]>[0];
async function read(
  suffix: string,
  kind: Kind,
  organizationId = fixture.tenant.organizationId,
) {
  const headers = fixture.headers(kind);
  const requestId = createId();
  headers.set("x-request-id", requestId);
  const response = await fixture.app.request(
    `/api/admin/v1/organizations/${organizationId}${suffix}`,
    { headers },
  );
  if (response.ok)
    expect(
      await fixture.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.requestId, requestId)),
    ).toEqual([]);
  return response;
}
test("tenant users review all three sources, readers review resource and client access, and machines read both", async () => {
  const organizationId = fixture.tenant.organizationId;
  const memberId = fixture.principals.tenantUsersOnly.memberId;
  const resource = "https://access.example";
  await createResource(fixture.db, {
    identifier: resource,
    name: "Access",
    allowedScopes: ["tutor:read", "tutor:write", "tutor:admin"],
  });
  const group = await createGroup(fixture.db, {
    organizationId,
    slug: "review",
    name: "Review",
  });
  await addGroupMember(fixture.db, {
    organizationId,
    memberId,
    groupId: group.id,
  });
  const entitlementIds: string[] = [];
  for (const input of [
    { resource, scopes: ["tutor:read"] },
    { resource, groupId: group.id, scopes: ["tutor:write", "tutor:read"] },
    { resource, memberId, scopes: ["tutor:admin"] },
    {
      clientId: fixture.platform.client.clientId,
      memberId,
      scopes: ["openid"],
    },
  ]) {
    const headers = fixture.headers("platformAdmin");
    const requestId = createId();
    headers.set("x-request-id", requestId);
    headers.set("content-type", "application/json");
    const response = await fixture.app.request(
      `/api/admin/v1/organizations/${organizationId}/entitlements`,
      { method: "POST", headers, body: JSON.stringify(input) },
    );
    expect(response.status).toBe(201);
    const row = await response.json();
    entitlementIds.push(row.id);
    const events = await fixture.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.requestId, requestId));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "entitlement.created",
      targetType: "entitlement",
      targetId: row.id,
      organizationId,
      actorId: fixture.principals.platformAdmin.userId,
      actorType: "user",
      outcome: "success",
      data: { scopes: input.scopes },
    });
  }
  const machine: Kind = { bearer: await fixture.mintMachineToken() };
  for (const kind of ["tenantUsersOnly", "platformReader", machine] as const) {
    const response = await read(`/members/${memberId}/access`, kind);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.effective).toBe(true);
    expect(
      body.targets.find((target: { id: string }) => target.id === resource),
    ).toEqual({
      kind: "resource",
      id: resource,
      scopes: ["tutor:admin", "tutor:read", "tutor:write"],
      via: [
        {
          entitlementId: entitlementIds[0],
          principal: "organization",
          groupId: null,
        },
        {
          entitlementId: entitlementIds[1],
          principal: "group",
          groupId: group.id,
        },
        {
          entitlementId: entitlementIds[2],
          principal: "member",
          groupId: null,
        },
      ],
    });
  }
  const expectedMembers = [
    "tenantAdmin",
    "tenantReader",
    "tenantUsersOnly",
    "noGrant",
    "disabledUser",
  ] as const;
  const expectedIds = expectedMembers
    .map((name) => fixture.principals[name].memberId)
    .sort()
    .reverse();
  for (const kind of ["tenantReader", "platformReader", machine] as const) {
    const response = await read(
      `/access?resource=${encodeURIComponent(resource)}`,
      kind,
    );
    expect(response.status).toBe(200);
    const page = await response.json();
    expect(
      page.items.map((item: { memberId: string }) => item.memberId),
    ).toEqual(expectedIds);
    expect(
      page.items.find(
        (item: { memberId: string }) => item.memberId === memberId,
      ).scopes,
    ).toEqual(["tutor:admin", "tutor:read", "tutor:write"]);
    const clientResponse = await read(
      `/access?clientId=${fixture.platform.client.clientId}`,
      kind,
    );
    expect(clientResponse.status).toBe(200);
    expect((await clientResponse.json()).items).toEqual([
      expect.objectContaining({ memberId, scopes: ["openid"] }),
    ]);
  }
  const first = await (
    await read(
      `/access?resource=${encodeURIComponent(resource)}&limit=1`,
      "tenantReader",
    )
  ).json();
  expect(first.nextCursor).toBe(expectedIds[0]);
  const second = await (
    await read(
      `/access?resource=${encodeURIComponent(resource)}&limit=1&cursor=${first.nextCursor}`,
      "tenantReader",
    )
  ).json();
  expect(second.items[0].memberId).toBe(expectedIds[1]);
  const expired = await read(
    `/members/${fixture.principals.expiredMember.memberId}/access`,
    "tenantUsersOnly",
  );
  expect(await expired.json()).toEqual({ effective: false, targets: [] });
  for (const suffix of [
    "/access",
    `/access?clientId=x&resource=${encodeURIComponent(resource)}`,
    "/access?resource=bad",
    "/access?clientId=x&limit=0",
    "/members/bad/access",
  ]) {
    const response = await read(suffix, "platformReader");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "validation_failed" });
  }
  for (const suffix of [
    "/access?clientId=missing",
    "/access?resource=https://none.example",
    `/members/${createId()}/access`,
    `/members/${fixture.principals.outsider.memberId}/access`,
  ])
    expect((await read(suffix, "platformReader")).status).toBe(404);
  expect(
    (
      await read(
        `/access?resource=${encodeURIComponent(resource)}`,
        "tenantReader",
        fixture.outsider.organizationId,
      )
    ).status,
  ).toBe(404);
  expect(
    (
      await read(
        `/members/${fixture.principals.outsider.memberId}/access`,
        "tenantUsersOnly",
        fixture.outsider.organizationId,
      )
    ).status,
  ).toBe(404);
});
