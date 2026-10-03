import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { expectReceipt } from "../../__tests__/operation-receipt.ts";
import {
  auditEvents,
  entitlements,
  groupMembers,
  groups,
  members,
} from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";
let fixture: AdminFixture;
beforeEach(async () => {
  fixture = await createAdminFixture(
    { databasePoolMax: 4 },
    { restrictedRole: true },
  );
});
afterEach(async () => {
  await fixture?.close();
});

async function command(
  path: string,
  method: string,
  body?: unknown,
  key = crypto.randomUUID(),
) {
  const headers = fixture.headers("root");
  headers.set("Idempotency-Key", key);
  if (method === "PATCH") {
    const current = await fixture.app.request(path, { headers });
    headers.set("If-Match", current.headers.get("ETag")!);
  }
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return fixture.app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("member entitlement commands retain affected-user history through removal and global erasure", async () => {
  const person = fixture.principals.tenantReader;
  const [otherMember] = await fixture.db
    .insert(members)
    .values({
      id: createId(),
      userId: person.userId,
      organizationId: fixture.outsider.organizationId,
    })
    .returning();
  const [otherEntitlement] = await fixture.db
    .insert(entitlements)
    .values({
      id: createId(),
      organizationId: fixture.outsider.organizationId,
      memberId: otherMember!.id,
      clientId: "answerable-bootstrap",
      scopes: ["org:read"],
    })
    .returning();
  const base = `/api/admin/v1/organizations/${fixture.tenant.organizationId}/entitlements`;
  const created = await command(base, "POST", {
    memberId: person.memberId,
    clientId: "answerable-bootstrap",
    scopes: ["org:read"],
  });
  expect(created.status).toBe(201);
  const row = await created.json();
  const path = `${base}/${row.id}`;
  const eventIds: string[] = [];
  async function remember(response: Response) {
    const [event] = await fixture.db
      .select()
      .from(auditEvents)
      .where(
        eq(auditEvents.operationId, response.headers.get("Operation-Id")!),
      );
    expect(event).toBeDefined();
    eventIds.push(event!.id);
  }
  await remember(created);
  for (const [suffix, method, body] of [
    ["", "PATCH", { validUntil: "2100-01-01T00:00:00Z" }],
    ["", "PATCH", { validUntil: "2100-01-01T00:00:00Z" }],
    ["/disable", "POST", undefined],
    ["/disable", "POST", undefined],
    ["/enable", "POST", undefined],
    ["/enable", "POST", undefined],
    ["", "DELETE", undefined],
  ] as const) {
    const response = await command(path + suffix, method, body);
    expect(response.status).toBe(method === "DELETE" ? 204 : 200);
    await remember(response);
  }
  async function history() {
    const response = await fixture.app.request(
      `/api/admin/v1/users/${person.userId}/audit-events?limit=100`,
      { headers: fixture.headers("root") },
    );
    expect(response.status).toBe(200);
    return (await response.json()).items
      .filter((event: { targetId: string }) => event.targetId === row.id)
      .map((event: { id: string }) => event.id)
      .sort();
  }
  expect(await history()).toEqual([...eventIds].sort());
  expect(
    await fixture.db
      .select()
      .from(entitlements)
      .where(eq(entitlements.id, otherEntitlement!.id)),
  ).toEqual([otherEntitlement!]);
  const foreign = await fixture.app.request(`${base}/${otherEntitlement!.id}`, {
    headers: fixture.headers("tenantReader"),
  });
  expect(foreign.status).toBe(404);
  const erase = await command(
    `/api/admin/v1/users/${person.userId}?confirm=${person.userId}`,
    "DELETE",
  );
  expect(erase.status).toBe(204);
  expect(await history()).toEqual([...eventIds].sort());
});
for (const principal of ["group", "organisation"] as const) {
  test(`${principal} entitlement changes retain their historical audience`, async () => {
    const person = fixture.principals.tenantReader;
    const organizationId = fixture.tenant.organizationId;
    const [group] = await fixture.db
      .insert(groups)
      .values({
        id: createId(),
        organizationId,
        slug: "audience",
        name: "Audience",
      })
      .returning();
    const assignments = await fixture.db
      .insert(groupMembers)
      .values([
        {
          id: createId(),
          organizationId,
          groupId: group!.id,
          memberId: person.memberId,
          validUntil: new Date("2000-01-01"),
        },
        {
          id: createId(),
          organizationId,
          groupId: group!.id,
          memberId: fixture.principals.tenantAdmin.memberId,
        },
      ])
      .returning();
    const [other] = await fixture.db
      .insert(members)
      .values({
        id: createId(),
        organizationId: fixture.outsider.organizationId,
        userId: person.userId,
      })
      .returning();
    const tenantMembers = await fixture.db
      .select()
      .from(members)
      .where(eq(members.organizationId, organizationId))
      .orderBy(members.id);
    const expected = tenantMembers
      .filter(
        (member) =>
          principal === "organisation" ||
          assignments.some((a) => a.memberId === member.id),
      )
      .map((member) => {
        const assignment = assignments.find((a) => a.memberId === member.id);
        return {
          memberId: member.id,
          userId: member.userId,
          organizationId,
          revision: member.revision,
          status: member.status,
          validFrom: member.validFrom?.toISOString() ?? null,
          validUntil: member.validUntil?.toISOString() ?? null,
          groupAssignment:
            principal === "group"
              ? {
                  id: assignment!.id,
                  revision: assignment!.revision,
                  groupId: assignment!.groupId,
                  validFrom: assignment!.validFrom?.toISOString() ?? null,
                  validUntil: assignment!.validUntil?.toISOString() ?? null,
                }
              : null,
        };
      });
    const base = `/api/admin/v1/organizations/${organizationId}/entitlements`;
    const create = await command(base, "POST", {
      ...(principal === "group" ? { groupId: group!.id } : {}),
      clientId: "answerable-bootstrap",
      scopes: ["org:read"],
    });
    expect(create.status).toBe(201);
    const row = await create.json();
    const events: (typeof auditEvents.$inferSelect)[] = [];
    async function remember(response: Response) {
      const [event] = await fixture.db
        .select()
        .from(auditEvents)
        .where(
          eq(auditEvents.operationId, response.headers.get("Operation-Id")!),
        );
      expect(event!.schemaVersion).toBe(
        event!.action === "entitlement.removed" ? 3 : 2,
      );
      expect(event!.data!.audience).toEqual(expected);
      events.push(event!);
    }
    await remember(create);
    for (const [suffix, method, body] of [
      ["", "PATCH", { validUntil: "2100-01-01T00:00:00Z" }],
      ["/disable", "POST", undefined],
      ["/enable", "POST", undefined],
      ["", "DELETE", undefined],
    ] as const) {
      const key = crypto.randomUUID();
      const response = await command(
        `${base}/${row.id}${suffix}`,
        method,
        body,
        key,
      );
      expect(response.status).toBe(method === "DELETE" ? 204 : 200);
      await remember(response);
      if (method === "POST") {
        const replay = await command(
          `${base}/${row.id}${suffix}`,
          method,
          body,
          key,
        );
        expect(replay.status).toBe(200);
        expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
        await expectReceipt(fixture.db, replay);
      }
      if (method !== "DELETE") {
        const noop = await command(`${base}/${row.id}${suffix}`, method, body);
        expect(noop.status).toBe(200);
        const [event] = await fixture.db
          .select()
          .from(auditEvents)
          .where(
            eq(auditEvents.operationId, noop.headers.get("Operation-Id")!),
          );
        expect(event!.schemaVersion).toBe(1);
        expect(event!.data!.audience).toBeUndefined();
      }
    }
    expect(
      await fixture.db.select().from(members).where(eq(members.id, other!.id)),
    ).toEqual([other!]);
    expect(
      (
        await command(
          `/api/admin/v1/users/${person.userId}?confirm=${person.userId}`,
          "DELETE",
        )
      ).status,
    ).toBe(204);
    for (const event of events) {
      const history = await fixture.app.request(
        `/api/admin/v1/users/${person.userId}/audit-events?action=${event.action}`,
        { headers: fixture.headers("root") },
      );
      expect(history.status).toBe(200);
      expect((await history.json()).items).toEqual([
        JSON.parse(JSON.stringify(event)),
      ]);
    }
  });
}
