import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { describeAdminRoutes } from "../../__tests__/admin-routes.ts";
import { auditEvents } from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";
import { routes } from "./entitlements.ts";
let fixture: AdminFixture;
beforeAll(async () => {
  fixture = await createAdminFixture();
});
afterAll(async () => {
  await fixture?.close();
});
describeAdminRoutes(routes, () => fixture);
type Kind = Parameters<AdminFixture["headers"]>[0];
async function request(
  organizationId: string,
  suffix = "",
  method = "GET",
  body?: unknown,
  kind: Kind = "platformAdmin",
  action?: string,
  targetId?: string,
) {
  const headers = fixture.headers(kind);
  const requestId = createId();
  headers.set("x-request-id", requestId);
  if (body !== undefined) headers.set("content-type", "application/json");
  const response = await fixture.app.request(
    `/api/admin/v1/organizations/${organizationId}/entitlements${suffix}`,
    {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
  if (method !== "GET") {
    const events = await fixture.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.requestId, requestId),
          eq(auditEvents.outcome, "success"),
        ),
      );
    if (response.ok) {
      expect(
        action,
        "Every successful write must specify its expected audit action",
      ).toBeDefined();
      expect(events).toHaveLength(1);
      const event = events[0]!;
      expect(event).toMatchObject({
        action,
        organizationId,
        requestId,
        actorType: typeof kind === "string" ? "user" : "client",
        actorId:
          typeof kind === "string"
            ? fixture.principals[kind].userId
            : fixture.platform.client.clientId,
        targetType: "entitlement",
      });
      const expectedTargetId = targetId ?? (await response.clone().json()).id;
      expect(event.targetId).toBe(expectedTargetId);
    } else expect(events).toHaveLength(0);
  }
  return response;
}
import { createGroup } from "../../db/queries/groups.ts";
import { createResource } from "../../db/queries/oauth-resources.ts";
import { createEntitlement } from "../../db/queries/entitlements.ts";
const past = "2000-01-01T00:00:00.000Z";
const future = "2100-01-01T00:00:00.000Z";
test("platform administrator and machine manage every principal with attributed audits", async () => {
  const id = fixture.tenant.organizationId;
  const kinds: Kind[] = [
    "platformAdmin",
    { bearer: await fixture.mintMachineToken() },
  ];
  for (const [index, kind] of kinds.entries()) {
    const resource = `https://entitlements-${index}.example`;
    await createResource(fixture.db, {
      identifier: resource,
      name: "Tutor",
      allowedScopes: ["tutor:read", "tutor:write", "tutor:admin"],
    });
    const group = await createGroup(fixture.db, {
      organizationId: id,
      slug: `entitlements-${index}`,
      name: "Team",
    });
    const memberId = fixture.principals.tenantReader.memberId;
    const rows: { id: string }[] = [];
    for (const principal of [{}, { groupId: group.id }, { memberId }]) {
      const input = {
        ...principal,
        resource,
        scopes: ["tutor:read"],
        validFrom: past,
        validUntil: future,
      };
      const response = await request(
        id,
        "",
        "POST",
        input,
        kind,
        "entitlement.created",
      );
      expect(response.status).toBe(201);
      rows.push(await response.json());
      const duplicate = await request(id, "", "POST", input, kind);
      expect(duplicate.status).toBe(409);
      expect(await duplicate.json()).toMatchObject({ code: "conflict" });
    }
    expect(
      (await request(id, "", "POST", { resource, scopes: ["forbidden"] }, kind))
        .status,
    ).toBe(400);
    for (const [filter, expected] of [
      [{ resource }, rows.map((row) => row.id).reverse()],
      [{ groupId: group.id }, [rows[1]!.id]],
      [{ memberId, resource }, [rows[2]!.id]],
    ] as const) {
      const query = new URLSearchParams(filter);
      const response = await request(
        id,
        `?${query}`,
        "GET",
        undefined,
        "tenantReader",
      );
      expect(response.status).toBe(200);
      expect(
        (await response.json()).items.map((row: { id: string }) => row.id),
      ).toEqual([...expected]);
    }
    for (const reader of ["tenantReader", "platformReader"] as const) {
      expect(
        (await request(id, `/${rows[0]!.id}`, "GET", undefined, reader)).status,
      ).toBe(200);
      expect((await request(id, "", "GET", undefined, reader)).status).toBe(
        200,
      );
    }
    const row = rows[0]!;
    for (const patch of [
      { scopes: ["tutor:write"] },
      { validFrom: null },
      { validUntil: null },
    ]) {
      expect(
        (
          await request(
            id,
            `/${row.id}`,
            "PATCH",
            patch,
            kind,
            "entitlement.updated",
            row.id,
          )
        ).status,
      ).toBe(200);
    }
    for (const patch of [
      {},
      { scopes: [] },
      { scopes: [""] },
      { scopes: ["forbidden"] },
      { validUntil: "bad" },
      { validFrom: future, validUntil: past },
    ]) {
      expect(
        (await request(id, `/${row.id}`, "PATCH", patch, kind)).status,
      ).toBe(400);
    }
    for (const [operation, status] of [
      ["disable", "disabled"],
      ["enable", "active"],
    ] as const) {
      expect(
        (
          await request(
            id,
            `/${row.id}/${operation}`,
            "POST",
            undefined,
            kind,
            `entitlement.${operation}d`,
            row.id,
          )
        ).status,
      ).toBe(200);
      const repeated = await request(
        id,
        `/${row.id}/${operation}`,
        "POST",
        undefined,
        kind,
      );
      expect(repeated.status).toBe(409);
      expect(await repeated.json()).toMatchObject({
        code: `entitlement_already_${status}`,
      });
      const page = await (
        await request(
          id,
          `?resource=${encodeURIComponent(resource)}&status=${status}`,
        )
      ).json();
      expect(
        page.items.some((item: { id: string }) => item.id === row.id),
      ).toBe(true);
    }
    const first = await (
      await request(id, `?resource=${encodeURIComponent(resource)}&limit=1`)
    ).json();
    expect(first.nextCursor).toBe(rows[2]!.id);
    const second = await (
      await request(
        id,
        `?resource=${encodeURIComponent(resource)}&limit=1&cursor=${first.nextCursor}`,
      )
    ).json();
    expect(second.items[0].id).toBe(rows[1]!.id);
    expect(
      (
        await request(
          id,
          `/${row.id}`,
          "DELETE",
          undefined,
          kind,
          "entitlement.removed",
          row.id,
        )
      ).status,
    ).toBe(204);
    expect(
      (await request(id, `/${row.id}`, "DELETE", undefined, kind)).status,
    ).toBe(404);
    expect((await request(id, `/${row.id}`)).status).toBe(404);
  }
});
test("client filter, foreign references, tenant isolation and request validation", async () => {
  const id = fixture.tenant.organizationId;
  const resource = "https://validation.example";
  await createResource(fixture.db, {
    identifier: resource,
    name: "Validation",
    allowedScopes: ["tutor:read"],
  });
  const foreignGroup = await createGroup(fixture.db, {
    organizationId: fixture.outsider.organizationId,
    slug: "foreign",
    name: "Foreign",
  });
  for (const input of [
    { resource, memberId: fixture.principals.outsider.memberId },
    { resource, groupId: foreignGroup.id },
    { resource: "https://none.example" },
    { clientId: "missing" },
  ])
    expect(
      (await request(id, "", "POST", { ...input, scopes: ["tutor:read"] }))
        .status,
    ).toBe(404);
  for (const input of [
    {
      resource,
      memberId: fixture.principals.tenantReader.memberId,
      groupId: foreignGroup.id,
    },
    { resource, clientId: fixture.platform.client.clientId },
    {},
    { clientId: "" },
    { resource: "bad" },
    { resource, scopes: [] },
    { resource, scopes: [""] },
    { resource, memberId: "bad" },
    { resource, groupId: "bad" },
  ]) {
    const response = await request(id, "", "POST", {
      scopes: ["tutor:read"],
      ...input,
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "validation_failed",
      errors: expect.any(Array),
    });
  }
  expect(
    (
      await request(createId(), "", "POST", {
        resource,
        scopes: ["tutor:read"],
      })
    ).status,
  ).toBe(404);
  for (const suffix of [
    "/bad",
    "?status=bad",
    "?resource=bad",
    "?memberId=bad",
    "?groupId=bad",
    "?cursor=bad",
  ])
    expect((await request(id, suffix)).status).toBe(400);
  expect((await request("bad")).status).toBe(400);
  const created = await request(
    id,
    "",
    "POST",
    { clientId: fixture.platform.client.clientId, scopes: ["openid"] },
    "platformAdmin",
    "entitlement.created",
  );
  expect(created.status).toBe(201);
  const clientRow = await created.json();
  const filtered = await request(
    id,
    `?client=${fixture.platform.client.clientId}`,
  );
  expect(
    (await filtered.json()).items.map((row: { id: string }) => row.id),
  ).toEqual([clientRow.id]);
  const foreign = await createEntitlement(fixture.db, {
    organizationId: fixture.outsider.organizationId,
    resource,
    scopes: ["tutor:read"],
  });
  for (const suffix of ["", `/${foreign.id}`])
    expect(
      (
        await request(
          fixture.outsider.organizationId,
          suffix,
          "GET",
          undefined,
          "tenantReader",
        )
      ).status,
    ).toBe(404);
  expect((await request(id, `/${foreign.id}`)).status).toBe(404);
});
