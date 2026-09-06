import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { describeAdminRoutes } from "../../__tests__/admin-routes.ts";
import { auditEvents } from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";
import { routes } from "./members.ts";
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
    `/api/admin/v1/organizations/${organizationId}/members${suffix}`,
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
          : "member",
      });
      const expectedTargetId = targetId ?? (await response.clone().json()).id;
      expect(event.targetId).toBe(expectedTargetId);
    } else expect(events).toHaveLength(0);
  }
  return response;
}
const past = "2000-01-01T00:00:00.000Z";
const future = "2100-01-01T00:00:00.000Z";
import { signInThroughIdp } from "../../__tests__/federation.ts";
import { members, users } from "../../db/schema/index.ts";
async function freshMember() {
  const subject = createId();
  const email = `${subject}@tenant.example.com`;
  fixture.issuer.enqueue({
    sub: subject,
    email,
    email_verified: true,
    name: "Fresh member",
  });
  const callbackURL = fixture.trustedOrigin + "/callback";
  const result = await signInThroughIdp(fixture.app, {
    providerId: fixture.tenant.slug,
    callbackURL,
  });
  expect(result.location).toBe(callbackURL);
  const [member] = await fixture.db
    .select({ id: members.id, userId: users.id })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(
      and(
        eq(members.organizationId, fixture.tenant.organizationId),
        eq(users.email, email),
      ),
    );
  expect(member).toBeDefined();
  return member!;
}
test("tenant and platform readers read members with organisation isolation", async () => {
  for (const principal of [
    fixture.principals.tenantReader,
    fixture.principals.outsider,
  ]) {
    for (const suffix of ["", `/${principal.memberId}`]) {
      expect(
        (
          await request(
            principal.organizationId,
            suffix,
            "GET",
            undefined,
            "tenantReader",
          )
        ).status,
      ).toBe(principal === fixture.principals.tenantReader ? 200 : 404);
      expect(
        (
          await request(
            principal.organizationId,
            suffix,
            "GET",
            undefined,
            "platformReader",
          )
        ).status,
      ).toBe(200);
    }
  }
  const row = await (
    await request(
      fixture.tenant.organizationId,
      `/${fixture.principals.tenantReader.memberId}`,
    )
  ).json();
  expect(row).not.toHaveProperty("role");
  expect(row.groups).toBeArray();
  expect(row.effective).toBe(true);
});
test("tenant administrator, users-only tenant, platform administrator and machine change windows and remove fresh members", async () => {
  const id = fixture.tenant.organizationId;
  const kinds: Kind[] = [
    "tenantAdmin",
    "tenantUsersOnly",
    "platformAdmin",
    { bearer: await fixture.mintMachineToken() },
  ];
  for (const kind of kinds) {
    const member = await freshMember();
    const suffix = `/${member.id}`;
    expect(
      (
        await request(
          id,
          suffix,
          "PATCH",
          { validUntil: null },
          kind,
          "member.updated",
          member.id,
        )
      ).status,
    ).toBe(200);
    const updated = await request(
      id,
      suffix,
      "PATCH",
      { validFrom: past, validUntil: future },
      kind,
      "member.updated",
      member.id,
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      validFrom: past,
      validUntil: future,
      effective: true,
    });
    expect(
      (
        await request(
          id,
          suffix,
          "PATCH",
          { validFrom: null },
          kind,
          "member.updated",
          member.id,
        )
      ).status,
    ).toBe(200);
    const invalid = await request(
      id,
      suffix,
      "PATCH",
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
          "member.removed",
          member.id,
        )
      ).status,
    ).toBe(204);
    expect((await request(id, suffix)).status).toBe(404);
    const [event] = await fixture.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.targetId, member.id),
          eq(auditEvents.action, "member.removed"),
        ),
      );
    expect(event!.data).toEqual({ userId: member.userId });
    expect((await request(id, suffix, "DELETE", undefined, kind)).status).toBe(
      404,
    );
  }
});
test("member filters, pagination and validation", async () => {
  const id = fixture.tenant.organizationId;
  const member = await freshMember();
  expect((await request(id, `/${member.id}`, "PATCH", {})).status).toBe(400);
  expect(
    (await request(id, `/${member.id}`, "PATCH", { validFrom: "bad" })).status,
  ).toBe(400);
  expect((await request(id, "/bad-id")).status).toBe(400);
  expect((await request(id, "?effective=yes")).status).toBe(400);
  expect(
    (await (await request(id, "?q=FRESH%20MEMBER")).json()).items.map(
      (r: { id: string }) => r.id,
    ),
  ).toEqual([member.id]);
  expect(
    (
      await request(
        id,
        `/${member.id}`,
        "PATCH",
        { validUntil: past },
        "tenantAdmin",
        "member.updated",
        member.id,
      )
    ).status,
  ).toBe(200);
  expect(
    (await (await request(id, "?effective=false")).json()).items.map(
      (r: { id: string }) => r.id,
    ),
  ).toContain(member.id);
  expect(
    (await (await request(id, "?effective=true")).json()).items.map(
      (r: { id: string }) => r.id,
    ),
  ).not.toContain(member.id);
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await (
      await request(id, "?limit=1" + (cursor ? `&cursor=${cursor}` : ""))
    ).json();
    seen.push(...page.items.map((row: { id: string }) => row.id));
    cursor = page.nextCursor;
  } while (cursor);
  const expected = await fixture.db
    .select({ id: members.id })
    .from(members)
    .where(eq(members.organizationId, id));
  expect(seen).toEqual(
    expected
      .map((row) => row.id)
      .sort()
      .reverse(),
  );
});
