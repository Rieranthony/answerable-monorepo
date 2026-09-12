import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { describeAdminRoutes } from "../../__tests__/admin-routes.ts";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { addGroupMember, createGroup } from "../../__tests__/group-queries.ts";
import { expectReceipt } from "../../__tests__/operation-receipt.ts";
import {
  adminOperations,
  auditEvents,
  groupMembers,
} from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";
import { routes } from "./groups.ts";
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
  if (
    method === "DELETE" &&
    typeof body === "object" &&
    body !== null &&
    "confirm" in body
  ) {
    suffix += "?" + new URLSearchParams({ confirm: String(body.confirm) });
    body = undefined;
  }
  const headers = fixture.headers(kind);
  if (method === "PATCH" || method === "PUT") {
    const current = await fixture.app.request(
      `/api/admin/v1/organizations/${organizationId}/groups${suffix}`,
      { headers },
    );
    if (method === "PUT" && current.status === 404)
      headers.set("If-None-Match", "*");
    else
      headers.set(
        "If-Match",
        current.headers.get("ETag") ??
          '"00000000-0000-7000-8000-000000000000:1"',
      );
  }
  const requestId = createId();
  headers.set("x-request-id", requestId);
  if (body !== undefined) headers.set("content-type", "application/json");
  const response = await fixture.app.request(
    `/api/admin/v1/organizations/${organizationId}/groups${suffix}`,
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
        targetType: action!.startsWith("group_member.")
          ? "group_member"
          : "group",
      });
      const expectedTargetId = targetId ?? (await response.clone().json()).id;
      expect(event.targetId).toBe(expectedTargetId);
    } else expect(events).toHaveLength(0);
  }
  return response;
}
const past = "2000-01-01T00:00:00.000Z";
const future = "2100-01-01T00:00:00.000Z";
test("tenant and platform readers read groups and memberships with organisation isolation", async () => {
  for (const org of [fixture.tenant, fixture.outsider]) {
    const group = await createGroup(fixture.db, {
      organizationId: org.organizationId,
      slug: "read-team",
      name: "Read team",
    });
    for (const suffix of ["", `/${group.id}`, `/${group.id}/members`]) {
      expect(
        (
          await request(
            org.organizationId,
            suffix,
            "GET",
            undefined,
            "tenantReader",
          )
        ).status,
      ).toBe(org === fixture.tenant ? 200 : 404);
      expect(
        (
          await request(
            org.organizationId,
            suffix,
            "GET",
            undefined,
            "platformReader",
          )
        ).status,
      ).toBe(200);
    }
  }
});
test("platform administrator and machine perform the complete group lifecycle with attributed audits", async () => {
  const id = fixture.tenant.organizationId;
  const memberId = fixture.principals.tenantReader.memberId;
  const kinds: Kind[] = [
    "platformAdmin",
    { bearer: await fixture.mintMachineToken() },
  ];
  for (const [index, kind] of kinds.entries()) {
    const input = { slug: `finance-${index}`, name: "Finance" };
    const created = await request(id, "", "POST", input, kind, "group.created");
    expect(created.status).toBe(201);
    const row = await created.json();
    expect((await request(id, "", "POST", input, kind)).status).toBe(409);
    expect(
      (
        await request(
          id,
          `/${row.id}`,
          "PATCH",
          { name: "Finance team" },
          kind,
          "group.updated",
          row.id,
        )
      ).status,
    ).toBe(200);
    const suffix = `/${row.id}/members/${memberId}`;
    expect(
      (
        await request(
          id,
          suffix,
          "PUT",
          { validFrom: past, validUntil: future },
          kind,
          "group_member.added",
          memberId,
        )
      ).status,
    ).toBe(201);
    expect(
      (
        await request(
          id,
          suffix,
          "PUT",
          { validUntil: null },
          kind,
          "group_member.updated",
          memberId,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          id,
          suffix,
          "PUT",
          { validFrom: null },
          kind,
          "group_member.updated",
          memberId,
        )
      ).status,
    ).toBe(200);
    const page = await (await request(id, `/${row.id}/members`)).json();
    expect(page.items).toEqual([
      expect.objectContaining({
        memberId,
        validFrom: null,
        validUntil: null,
        effective: true,
      }),
    ]);
    const invalid = await request(
      id,
      suffix,
      "PUT",
      { validFrom: future, validUntil: past },
      kind,
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      code: "constraint_violation",
    });
    expect(
      (
        await request(
          id,
          suffix,
          "DELETE",
          undefined,
          kind,
          "group_member.removed",
          memberId,
        )
      ).status,
    ).toBe(204);
    expect((await request(id, suffix, "DELETE", undefined, kind)).status).toBe(
      404,
    );
    expect(
      (
        await request(
          id,
          `/${row.id}/disable`,
          "POST",
          undefined,
          kind,
          "group.disabled",
          row.id,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          id,
          `/${row.id}/disable`,
          "POST",
          undefined,
          kind,
          "group.disable_unchanged",
          row.id,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          id,
          `/${row.id}/enable`,
          "POST",
          undefined,
          kind,
          "group.enabled",
          row.id,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          id,
          `/${row.id}/enable`,
          "POST",
          undefined,
          kind,
          "group.enable_unchanged",
          row.id,
        )
      ).status,
    ).toBe(200);
    expect(
      (await request(id, `/${row.id}`, "DELETE", { confirm: createId() }, kind))
        .status,
    ).toBe(400);
    expect(
      (
        await request(
          id,
          `/${row.id}`,
          "DELETE",
          { confirm: row.id },
          kind,
          "group.erased",
          row.id,
        )
      ).status,
    ).toBe(204);
    expect((await request(id, `/${row.id}`)).status).toBe(404);
  }
});
test("directory groups reject both membership edits and external IDs are unique", async () => {
  const id = fixture.tenant.organizationId;
  const created = await request(
    id,
    "",
    "POST",
    { slug: "directory", name: "Directory", externalId: "upstream" },
    "platformAdmin",
    "group.created",
  );
  expect(created.status).toBe(201);
  const group = await created.json();
  expect(
    (
      await request(id, "", "POST", {
        slug: "duplicate-external",
        name: "Duplicate",
        externalId: "upstream",
      })
    ).status,
  ).toBe(409);
  const memberId = fixture.principals.tenantReader.memberId;
  await addGroupMember(fixture.db, {
    organizationId: id,
    groupId: group.id,
    memberId,
  });
  for (const method of ["PUT", "DELETE"]) {
    const response = await request(
      id,
      `/${group.id}/members/${memberId}`,
      method,
      method === "PUT" ? {} : undefined,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "group_directory_managed",
    });
  }
  expect(
    (
      await request(
        id,
        `/${group.id}`,
        "PATCH",
        { externalId: null },
        "platformAdmin",
        "group.updated",
        group.id,
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await request(
        id,
        `/${group.id}/members/${memberId}`,
        "PUT",
        {},
        "platformAdmin",
        "group_member.update_unchanged",
        memberId,
      )
    ).status,
  ).toBe(200);
});
test("group validation, filters and membership cursors", async () => {
  const id = fixture.tenant.organizationId;
  for (const slug of ["UPPER", "bad--slug", "-bad", "bad_"])
    expect((await request(id, "", "POST", { slug, name: "Bad" })).status).toBe(
      400,
    );
  const group = await createGroup(fixture.db, {
    organizationId: id,
    slug: "pagination",
    name: "Pagination",
  });
  for (const body of [{}, { name: "" }, { externalId: "" }])
    expect((await request(id, `/${group.id}`, "PATCH", body)).status).toBe(400);
  expect((await request("bad-id")).status).toBe(400);
  expect((await request(id, "/bad-id")).status).toBe(400);
  expect(
    (await request(id, `/${group.id}/members/bad-id`, "PUT", {})).status,
  ).toBe(400);
  expect((await request(id, "?status=bad")).status).toBe(400);
  expect(
    (
      await request(createId(), "", "POST", {
        slug: "missing",
        name: "Missing",
      })
    ).status,
  ).toBe(404);
  expect(
    (await (await request(id, "?q=PAGINATION")).json()).items.map(
      (r: { id: string }) => r.id,
    ),
  ).toEqual([group.id]);
  const ids = [
    fixture.principals.tenantReader.memberId,
    fixture.principals.tenantAdmin.memberId,
  ]
    .sort()
    .reverse();
  for (const memberId of ids)
    await addGroupMember(fixture.db, {
      organizationId: id,
      groupId: group.id,
      memberId,
    });
  const first = await (
    await request(id, `/${group.id}/members?limit=1`)
  ).json();
  expect(first.nextCursor).toBe(ids[0]);
  const second = await (
    await request(id, `/${group.id}/members?limit=1&cursor=${first.nextCursor}`)
  ).json();
  expect(second.items.map((r: { memberId: string }) => r.memberId)).toEqual([
    ids[1],
  ]);
  expect(second.nextCursor).toBeNull();
  expect(
    (
      await request(
        id,
        `/${group.id}/members/${fixture.principals.outsider.memberId}`,
        "PUT",
        {},
      )
    ).status,
  ).toBe(404);
  const page = await (await request(id, "?limit=1&status=active")).json();
  expect(page.items).toHaveLength(1);
  expect(page.nextCursor).toBe(page.items[0].id);
  expect((await request(id, `?limit=1&cursor=${page.nextCursor}`)).status).toBe(
    200,
  );
});

const patchTags = new Map<string, string>();
async function command(
  org: string,
  key: string,
  path: string,
  method: string,
  body?: unknown,
) {
  const headers = fixture.headers("platformAdmin");
  headers.set("Idempotency-Key", key);
  if (method === "PATCH" || method === "PUT") {
    if (!patchTags.has(key)) {
      const current = await fixture.app.request(
        `/api/admin/v1/organizations/${org}/groups${path}`,
        { headers },
      );
      patchTags.set(key, current.headers.get("ETag") ?? "*");
    }
    const tag = patchTags.get(key)!;
    headers.set(tag === "*" ? "If-None-Match" : "If-Match", tag);
  }
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return fixture.app.request(
    `/api/admin/v1/organizations/${org}/groups${path}`,
    {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
}
test("group commands return receipts without repeating membership or erasure effects", async () => {
  const org = fixture.tenant.organizationId;
  const input = { slug: "group-replay", name: "Replay" };
  const created = await command(org, "group-create", "", "POST", input);
  expect(created.status).toBe(201);
  expect(created.headers.get("Operation-Id")).toBeString();
  const group = await created.json();
  const memberId = fixture.principals.tenantReader.memberId;
  for (const [key, path, method, body, status] of [
    ["group-create", "", "POST", input, 201],
    ["group-update", `/${group.id}`, "PATCH", { name: "Changed" }, 200],
    ["group-disable", `/${group.id}/disable`, "POST", undefined, 200],
    ["group-enable", `/${group.id}/enable`, "POST", undefined, 200],
    ["group-add", `/${group.id}/members/${memberId}`, "PUT", {}, 201],
    [
      "group-remove",
      `/${group.id}/members/${memberId}`,
      "DELETE",
      undefined,
      204,
    ],
    [
      "group-erase",
      `/${group.id}?confirm=${group.id}`,
      "DELETE",
      undefined,
      204,
    ],
  ] as const) {
    const first = await command(org, key, path, method, body);
    expect(first.status).toBe(status);
    const retry = await command(org, key, path, method, body);
    expect(retry.status).toBe(status);
    await expectReceipt(fixture.db, retry);
    expect(retry.headers.get("Idempotency-Replayed")).toBe("true");
    expect(retry.headers.get("Operation-Id")).toBe(
      first.headers.get("Operation-Id"),
    );
    expect(
      await fixture.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.operationId, first.headers.get("Operation-Id")!)),
    ).toHaveLength(1);
  }
  expect(
    (
      await command(org, "group-create", "", "POST", {
        ...input,
        name: "Different",
      })
    ).status,
  ).toBe(409);
});

test("group noops preserve state and old removal replay does not remove a new assignment", async () => {
  const org = fixture.tenant.organizationId;
  const created = await command(org, "noop-create", "", "POST", {
    slug: "group-noops",
    name: "Noops",
  });
  const group = await created.json();
  const member = fixture.principals.tenantReader.memberId;
  for (const [path, method, body] of [
    [`/${group.id}`, "PATCH", { name: "Noops" }],
    [`/${group.id}/enable`, "POST", undefined],
    [`/${group.id}/members/${member}`, "PUT", {}],
  ] as const) {
    const first = await command(org, `first-${path}`, path, method, body);
    const before = await first.json();
    const next = await command(org, `noop-${path}`, path, method, body);
    expect(next.status).toBe(200);
    expect(await next.json()).toEqual(before);
    const [receipt] = await fixture.db
      .select()
      .from(adminOperations)
      .where(eq(adminOperations.id, next.headers.get("Operation-Id")!));
    expect(receipt?.outcome).toBe("noop");
  }
  const path = `/${group.id}/members/${member}`;
  expect((await command(org, "remove-original", path, "DELETE")).status).toBe(
    204,
  );
  expect((await command(org, "readd", path, "PUT", {})).status).toBe(201);
  const retry = await command(org, "remove-original", path, "DELETE");
  expect(retry.headers.get("Idempotency-Replayed")).toBe("true");
  expect(
    await fixture.db
      .select()
      .from(groupMembers)
      .where(
        and(
          eq(groupMembers.groupId, group.id),
          eq(groupMembers.memberId, member),
          sql`${groupMembers.deletedAt} is null`,
        ),
      ),
  ).toHaveLength(1);
});
