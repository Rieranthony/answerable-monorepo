import { afterBrokerRead } from "../../__tests__/after-broker-read.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { describeAdminRoutes } from "../../__tests__/admin-routes.ts";
import { auditEvents, members } from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";
import { createGroup, addGroupMember } from "../../__tests__/group-queries.ts";
import { createResource } from "../../__tests__/resource-queries.ts";
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
      operationId: response.headers.get("Operation-Id"),
      data: { before: null, after: { id: row.id, scopes: row.scopes } },
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
      permission: { allowed: false, reason: "capability" },
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
  const disabledAccess = await read(
    `/members/${fixture.principals.disabledUser.memberId}/access`,
    "platformReader",
  );
  expect(disabledAccess.status).toBe(200);
  expect(await disabledAccess.json()).toEqual({
    effective: false,
    targets: [],
  });
  const expectedMembers = [
    "tenantAdmin",
    "tenantReader",
    "tenantUsersOnly",
    "noGrant",
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
    `/access?clientId=missing&resource=${encodeURIComponent(resource)}`,
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

test("access reads recheck current tenant authority after middleware admission", async () => {
  const resource = "https://access-context.example";
  await createResource(fixture.db, {
    identifier: resource,
    name: "Context",
    allowedScopes: ["read"],
  });
  const target = fixture.principals.tenantReader.memberId;
  for (const [suffix, kind] of [
    [`/members/${target}/access`, "tenantUsersOnly"],
    [`/access?resource=${encodeURIComponent(resource)}`, "tenantReader"],
  ] as const) {
    const path = `/api/admin/v1/organizations/${fixture.tenant.organizationId}${suffix}`;
    const headers = fixture.headers(kind);
    const send = () => fixture.app.request(path, { headers });
    const accepted = await send();
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("Cache-Control")).toBe("no-store");
    const original = fixture.db.transaction.bind(fixture.db);
    fixture.db.transaction = afterBrokerRead(original, (async (
      ...args: Parameters<typeof original>
    ) => {
      fixture.db.transaction = original;
      await fixture.db
        .update(members)
        .set({ status: "revoked", revokedAt: new Date() })
        .where(eq(members.id, fixture.principals[kind].memberId));
      return original(...args);
    }) as typeof original);
    try {
      const denied = await send();
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: "insufficient_scope" });
    } finally {
      fixture.db.transaction = original;
      await fixture.db
        .update(members)
        .set({ status: "active", revokedAt: null })
        .where(eq(members.id, fixture.principals[kind].memberId));
    }
  }
  // Platform read remains sufficient for member access despite the tenant users requirement.
  expect(
    (await read(`/members/${target}/access`, "platformReader")).status,
  ).toBe(200);
  expect((await read(`/members/${target}/access`, "tenantReader")).status).toBe(
    403,
  );
});

test("HTTP pair creation and reads preserve both targets without granting direct admin access", async () => {
  const actor = fixture.principals.tenantReader;
  const input = {
    memberId: actor.memberId,
    clientId: fixture.platform.client.clientId,
    resource: fixture.platform.adminResource,
    scopes: ["platform:write"],
  };
  const headers = fixture.headers("platformAdmin");
  headers.set("Content-Type", "application/json");
  const created = await fixture.app.request(
    `/api/admin/v1/organizations/${fixture.tenant.organizationId}/entitlements`,
    { method: "POST", headers, body: JSON.stringify(input) },
  );
  expect(created.status).toBe(201);
  const assignment = await created.json();
  expect(assignment).toMatchObject(input);
  const evidence = await fixture.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.operationId, created.headers.get("Operation-Id")!));
  expect(evidence).toMatchObject([
    { data: { after: { clientId: input.clientId, resource: input.resource } } },
  ]);
  const view = await (
    await read(`/members/${actor.memberId}/access`, "tenantAdmin")
  ).json();
  expect(view.targets).toContainEqual({
    kind: "client_resource",
    id: input.clientId,
    resource: input.resource,
    scopes: input.scopes,
    permission: { allowed: false, reason: "context" },
    via: [{ entitlementId: assignment.id, principal: "member", groupId: null }],
  });
  const paired = await read(
    `/access?clientId=${encodeURIComponent(input.clientId)}&resource=${encodeURIComponent(input.resource)}`,
    "tenantReader",
  );
  expect(paired.status).toBe(200);
  expect((await paired.json()).items).toMatchObject([
    {
      memberId: actor.memberId,
      scopes: input.scopes,
      permission: { allowed: false, reason: "context" },
    },
  ]);
  expect(
    (
      await read(
        `/access?clientId=${encodeURIComponent(input.clientId)}&resource=https://missing.example`,
        "platformReader",
      )
    ).status,
  ).toBe(404);
  const { effectiveGrants } = await import("../../db/queries/grants.ts");
  const grants = await effectiveGrants(
    fixture.db,
    { userId: actor.userId },
    input.resource,
  );
  expect(grants.flatMap((grant) => grant.scopes)).not.toContain(
    "platform:write",
  );
});

test("target access hides foreign private resource existence", async () => {
  const resource = `https://${createId()}.example`;
  const own = `https://${createId()}.example`;
  for (const [identifier, organizationId] of [
    [resource, fixture.outsider.organizationId],
    [own, fixture.tenant.organizationId],
  ] as const)
    await createResource(fixture.db, {
      identifier,
      name: "Private",
      classification: "tenant_owned",
      organizationId,
      allowedScopes: ["read"],
    });
  for (const kind of ["tenantReader", "platformReader"] as const) {
    for (const target of [resource, "https://missing-private.example"])
      for (const client of [
        "",
        `&clientId=${encodeURIComponent(fixture.platform.client.clientId)}`,
      ])
        expect(
          (
            await read(
              `/access?resource=${encodeURIComponent(target)}${client}`,
              kind,
            )
          ).status,
        ).toBe(404);
    for (const target of [own, fixture.platform.adminResource])
      expect(
        (await read(`/access?resource=${encodeURIComponent(target)}`, kind))
          .status,
      ).toBe(200);
  }
});

test("HTTP pair explanations expose only approved scopes and contributing source evidence", async () => {
  const {
    oauthClients,
    oauthResources,
    oauthClientResources,
    organizationCapabilities,
    entitlements,
  } = await import("../../db/schema/index.ts");
  const organizationId = fixture.tenant.organizationId;
  const memberId = fixture.principals.tenantUsersOnly.memberId;
  const clientId = createId(),
    resource = `https://${createId()}.example`;
  await fixture.db.insert(oauthClients).values({
    id: createId(),
    clientId,
    redirectUris: [],
    grantTypes: ["authorization_code"],
    scopes: ["openid", "read", "write"],
  });
  await fixture.db.insert(oauthResources).values({
    id: createId(),
    identifier: resource,
    name: "Explained",
    allowedScopes: ["read", "write"],
  });
  await fixture.db
    .insert(oauthClientResources)
    .values({ id: createId(), clientId, resourceId: resource });
  const capabilityIds = [createId(), createId()];
  await fixture.db.insert(organizationCapabilities).values([
    {
      id: capabilityIds[0]!,
      organizationId,
      clientId,
      grantKind: "authorization_code",
      scopes: ["openid"],
    },
    {
      id: capabilityIds[1]!,
      organizationId,
      clientId,
      resource,
      grantKind: "authorization_code",
      scopes: ["read"],
    },
  ]);
  const assignmentIds = [createId(), createId()];
  await fixture.db.insert(entitlements).values([
    {
      id: assignmentIds[0]!,
      organizationId,
      clientId,
      memberId,
      scopes: ["openid"],
    },
    {
      id: assignmentIds[1]!,
      organizationId,
      clientId,
      resource,
      memberId,
      scopes: ["read", "write"],
    },
  ]);
  for (const suffix of [
    `/members/${memberId}/access`,
    `/access?clientId=${clientId}&resource=${encodeURIComponent(resource)}`,
  ]) {
    const response = await read(suffix, "tenantAdmin");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    const result = body.targets
      ? body.targets.find(
          (target: { kind: string; id: string }) =>
            target.kind === "client_resource" && target.id === clientId,
        )
      : body.items[0];
    expect(result.scopes).toEqual(["read", "write"]);
    expect(result.permission).toMatchObject({
      allowed: true,
      scopes: ["read"],
      evidence: { policyVersion: 1, membership: { id: memberId } },
    });
    expect(
      result.permission.evidence.capabilities.map(
        (source: { id: string }) => source.id,
      ),
    ).toEqual(capabilityIds);
    expect(
      result.permission.evidence.assignments.map(
        (source: { id: string }) => source.id,
      ),
    ).toEqual(assignmentIds);
    expect(JSON.stringify(result)).not.toContain("clientSecret");
  }
  const loginResponse = await read(
    `/access?clientId=${clientId}`,
    "tenantAdmin",
  );
  expect(loginResponse.status).toBe(200);
  expect((await loginResponse.json()).items).toMatchObject([
    {
      memberId,
      permission: {
        allowed: true,
        scopes: ["openid"],
        evidence: {
          capabilities: [{ id: capabilityIds[0] }],
          assignments: [{ id: assignmentIds[0] }],
        },
      },
    },
  ]);
  const adminMember = fixture.principals.tenantReader.memberId;
  const adminView = await (
    await read(`/members/${adminMember}/access`, "tenantAdmin")
  ).json();
  const administration = adminView.targets.find(
    (target: { kind: string; id: string }) =>
      target.kind === "resource" &&
      target.id === fixture.platform.adminResource,
  );
  expect(administration.permission).toMatchObject({
    allowed: true,
    scopes: ["org:read"],
    evidence: { capabilities: [{ grantKind: "admin_session" }] },
  });
  expect(administration.permission.evidence.membership.id).toBe(adminMember);
});
