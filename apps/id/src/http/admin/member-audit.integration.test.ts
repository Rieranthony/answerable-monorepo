import { afterEach, beforeEach, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { createApp } from "../../app.ts";
import { createAuth } from "../../auth.ts";
import { createDatabase, type DatabaseConnection } from "../../db/client.ts";
import { configureRuntimeRole } from "../../db/runtime-role.ts";
import {
  adminOperations,
  auditEvents,
  entitlements,
  members,
  organizationCapabilities,
  sessions,
} from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";
import type { MemberAccess } from "../../db/queries/access.ts";

let fixture: AdminFixture;
let runtime: DatabaseConnection;
let app: ReturnType<typeof createApp>;
let role: string;
beforeEach(async () => {
  fixture = await createAdminFixture();
  role = `id_test_member_audit_${crypto.randomUUID().replaceAll("-", "")}`;
  await configureRuntimeRole(fixture.db, role);
  const password = crypto.randomUUID().replaceAll("-", "");
  await fixture.db.execute(
    sql.raw(`alter role "${role}" login password '${password}'`),
  );
  const url = new URL(fixture.environment.databaseUrl);
  url.username = role;
  url.password = password;
  const environment = { ...fixture.environment, databaseUrl: url.toString() };
  runtime = createDatabase(environment);
  app = createApp({
    db: runtime.db,
    auth: createAuth(runtime.db, environment),
    environment,
  });
});
afterEach(async () => {
  await runtime?.close();
  if (fixture) {
    await fixture.db.execute(sql`drop owned by ${sql.identifier(role)}`);
    await fixture.db.execute(sql`drop role ${sql.identifier(role)}`);
    await fixture.close();
  }
});

const path = () =>
  `/api/admin/v1/organizations/${fixture.tenant.organizationId}/members/${fixture.principals.tenantReader.memberId}`;
async function configuration() {
  const response = await app.request(`${path()}/configuration`, {
    headers: fixture.headers("tenantUsersOnly"),
  });
  expect(response.status).toBe(200);
  return { tag: response.headers.get("ETag")!, body: await response.json() };
}
function change(
  key: string,
  tag: string,
  kind: "window" | "reinstate" | "remove",
  validUntil: string | null = "2000-01-01T00:00:00.000Z",
) {
  const headers = fixture.headers("tenantUsersOnly");
  headers.set("Idempotency-Key", key);
  headers.set("Content-Type", "application/json");
  headers.set("If-Match", tag);
  return app.request(path() + (kind === "reinstate" ? "/reinstate" : ""), {
    method: kind === "window" ? "PATCH" : kind === "remove" ? "DELETE" : "POST",
    headers,
    ...(kind === "window" ? { body: JSON.stringify({ validUntil }) } : {}),
  });
}
async function eventFor(response: Response) {
  const [event] = await fixture.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.operationId, response.headers.get("Operation-Id")!));
  expect(event).toBeDefined();
  return event!;
}
const approvedRead = () => ({
  effective: true,
  targets: expect.arrayContaining([
    expect.objectContaining({
      kind: "resource",
      id: fixture.platform.adminResource,
      permission: expect.objectContaining({
        allowed: true,
        scopes: ["org:read"],
        organization: expect.objectContaining({
          id: fixture.tenant.organizationId,
        }),
        subject: {
          userId: fixture.principals.tenantReader.userId,
          memberId: fixture.principals.tenantReader.memberId,
        },
      }),
    }),
  ]),
});

test("window audit observes lost and restored access, preserves another tenant and replays once", async () => {
  const person = fixture.principals.tenantReader;
  await fixture.db
    .update(entitlements)
    .set({ scopes: ["org:read", "org:write"] })
    .where(eq(entitlements.memberId, person.memberId));
  await fixture.db
    .update(organizationCapabilities)
    .set({ scopes: ["org:read", "org:users"] })
    .where(
      and(
        eq(
          organizationCapabilities.organizationId,
          fixture.tenant.organizationId,
        ),
        eq(organizationCapabilities.grantKind, "admin_session"),
      ),
    );
  const [other] = await fixture.db
    .insert(members)
    .values({
      id: createId(),
      organizationId: fixture.outsider.organizationId,
      userId: person.userId,
    })
    .returning();
  const [otherGrant] = await fixture.db
    .insert(entitlements)
    .values({
      id: createId(),
      organizationId: fixture.outsider.organizationId,
      memberId: other!.id,
      resource: fixture.platform.adminResource,
      scopes: ["org:read"],
    })
    .returning();
  const sessionRows = await fixture.db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, person.userId));
  const initial = await configuration();
  const key = createId();
  const expired = await change(key, initial.tag, "window");
  expect(expired.status).toBe(200);
  const event = await eventFor(expired);
  const observed = event.data!.before as { access: MemberAccess };
  expect(observed.access.targets[0]!.scopes).toEqual(["org:read", "org:write"]);
  expect(observed.access.targets[0]!.permission).toMatchObject({
    allowed: true,
    scopes: ["org:read"],
  });
  expect(structuredClone(event)).toMatchObject({
    schemaVersion: 2,
    action: "member.updated",
    organizationId: fixture.tenant.organizationId,
    targetId: person.memberId,
    data: {
      before: { revision: initial.body.revision, access: approvedRead() },
      after: {
        revision: initial.body.revision + 1,
        access: { effective: false, targets: [] },
      },
    },
  });
  expect(
    (await change(key, initial.tag, "window")).headers.get(
      "Idempotency-Replayed",
    ),
  ).toBe("true");
  expect(
    await fixture.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.operationId, event.operationId!)),
  ).toHaveLength(1);
  const current = await configuration();
  const restored = await change(createId(), current.tag, "window", null);
  expect(restored.status).toBe(200);
  expect(await eventFor(restored)).toMatchObject({
    data: {
      before: { access: { effective: false, targets: [] } },
      after: { access: approvedRead() },
    },
  });
  expect(
    await fixture.db.select().from(members).where(eq(members.id, other!.id)),
  ).toEqual([other!]);
  expect(
    await fixture.db
      .select()
      .from(entitlements)
      .where(eq(entitlements.id, otherGrant!.id)),
  ).toEqual([otherGrant!]);
  expect(
    await fixture.db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, person.userId)),
  ).toEqual(sessionRows);
  expect(JSON.stringify(event.data)).not.toContain(
    fixture.outsider.organizationId,
  );
  expect(JSON.stringify(event.data)).not.toContain(person.cookie);
  const erased = await app.request(
    `/api/admin/v1/users/${person.userId}?confirm=${person.userId}`,
    { method: "DELETE", headers: fixture.headers("root") },
  );
  expect(erased.status).toBe(204);
  const history = await app.request(
    `/api/admin/v1/users/${person.userId}/audit-events`,
    { headers: fixture.headers("root") },
  );
  expect(history.status).toBe(200);
  expect((await history.json()).items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: event.id, data: event.data }),
    ]),
  );
});

test("reinstatement observes surviving organisation permission without recreating removed direct grants", async () => {
  const person = fixture.principals.tenantReader;
  const [broad] = await fixture.db
    .insert(entitlements)
    .values({
      id: createId(),
      organizationId: fixture.tenant.organizationId,
      resource: fixture.platform.adminResource,
      scopes: ["org:read"],
    })
    .returning();
  const removed = await app.request(path(), {
    method: "DELETE",
    headers: fixture.headers("tenantUsersOnly"),
  });
  expect(removed.status).toBe(204);
  expect(await eventFor(removed)).toMatchObject({
    schemaVersion: 3,
    action: "member.removed",
    data: {
      before: { access: approvedRead() },
      after: {
        membershipStatus: "revoked",
        access: { effective: false, targets: [] },
      },
    },
  });
  const noop = await app.request(path(), {
    method: "DELETE",
    headers: fixture.headers("tenantUsersOnly"),
  });
  expect(noop.status).toBe(204);
  expect(await eventFor(noop)).toMatchObject({
    schemaVersion: 3,
    action: "member.removal_unchanged",
    data: {
      before: { access: { effective: false, targets: [] } },
      after: { access: { effective: false, targets: [] } },
    },
  });
  const afterRemoval = await fixture.db
    .select()
    .from(entitlements)
    .where(eq(entitlements.memberId, person.memberId));
  expect(afterRemoval).not.toHaveLength(0);
  expect(
    afterRemoval.every(
      (row) => row.deletedAt !== null && row.status === "disabled",
    ),
  ).toBe(true);
  const initial = await configuration();
  const key = createId();
  const restored = await change(key, initial.tag, "reinstate");
  expect(restored.status).toBe(200);
  const event = await eventFor(restored);
  expect(structuredClone(event)).toMatchObject({
    schemaVersion: 2,
    action: "member.reinstated",
    data: {
      before: {
        membershipStatus: "revoked",
        access: { effective: false, targets: [] },
      },
      after: { membershipStatus: "active", access: approvedRead() },
    },
  });
  const observed = event.data!.after as { access: MemberAccess };
  expect(
    observed.access.targets.find(
      (target) => target.id === fixture.platform.adminResource,
    )!.via,
  ).toEqual([
    { entitlementId: broad!.id, principal: "organization", groupId: null },
  ]);
  expect(
    await fixture.db
      .select()
      .from(entitlements)
      .where(eq(entitlements.memberId, person.memberId)),
  ).toEqual(afterRemoval);
  expect(
    (await change(key, initial.tag, "reinstate")).headers.get(
      "Idempotency-Replayed",
    ),
  ).toBe("true");
  const unchanged = await change(
    createId(),
    (await configuration()).tag,
    "reinstate",
  );
  expect(unchanged.status).toBe(200);
  expect(await eventFor(unchanged)).toMatchObject({
    action: "member.reinstatement_unchanged",
    schemaVersion: 2,
    data: {
      before: { access: approvedRead() },
      after: { access: approvedRead() },
    },
  });
});

for (const kind of ["window", "reinstate", "remove"] as const) {
  test(`${kind} evidence subject failure rolls back the member and receipt before same-key recovery`, async () => {
    const person = fixture.principals.tenantReader;
    if (kind === "reinstate") {
      await fixture.db
        .update(members)
        .set({ status: "revoked", revokedAt: new Date() })
        .where(eq(members.id, person.memberId));
    }
    const before = await fixture.db
      .select()
      .from(members)
      .where(eq(members.id, person.memberId));
    const operations = await fixture.db
      .select()
      .from(adminOperations)
      .orderBy(adminOperations.id);
    const assignments = await fixture.db
      .select()
      .from(entitlements)
      .orderBy(entitlements.id);
    const initial = await configuration();
    const key = createId();
    await fixture.db.execute(
      sql`alter table audit_event_subjects add constraint member_audit_subject_fault check (relationship <> 'affected') not valid`,
    );
    try {
      expect((await change(key, initial.tag, kind)).status).toBe(400);
      expect(
        await fixture.db
          .select()
          .from(members)
          .where(eq(members.id, person.memberId)),
      ).toEqual(before);
      expect(
        await fixture.db
          .select()
          .from(adminOperations)
          .orderBy(adminOperations.id),
      ).toEqual(operations);
      expect(
        await fixture.db.select().from(entitlements).orderBy(entitlements.id),
      ).toEqual(assignments);
      expect(
        await fixture.db
          .select()
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.targetId, person.memberId),
              eq(
                auditEvents.action,
                kind === "window"
                  ? "member.updated"
                  : kind === "remove"
                    ? "member.removed"
                    : "member.reinstated",
              ),
            ),
          ),
      ).toHaveLength(0);
    } finally {
      await fixture.db.execute(
        sql`alter table audit_event_subjects drop constraint member_audit_subject_fault`,
      );
    }
    const recovered = await change(key, initial.tag, kind);
    expect(recovered.status).toBe(kind === "remove" ? 204 : 200);
    expect(await eventFor(recovered)).toMatchObject({
      schemaVersion: kind === "remove" ? 3 : 2,
    });
    expect(
      (await change(key, initial.tag, kind)).headers.get(
        "Idempotency-Replayed",
      ),
    ).toBe("true");
  });
}
