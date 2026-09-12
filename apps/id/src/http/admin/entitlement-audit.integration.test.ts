import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  createAdminFixture,
  type AdminFixture,
} from "../../__tests__/admin.ts";
import { expectReceipt } from "../../__tests__/operation-receipt.ts";
import { createApp } from "../../app.ts";
import { createAuth } from "../../auth.ts";
import { createDatabase, type DatabaseConnection } from "../../db/client.ts";
import { withDatabaseScope } from "../../db/isolation.ts";
import { configureRuntimeRole } from "../../db/runtime-role.ts";
import {
  adminOperations,
  auditEvents,
  auditEventSubjects,
  entitlements,
  groupMembers,
  groups,
  members,
} from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";
let fixture: AdminFixture;
let runtime: DatabaseConnection;
let app: ReturnType<typeof createApp>;
let role: string;
beforeEach(async () => {
  fixture = await createAdminFixture();
  role = `id_test_ent_audit_${crypto.randomUUID().replaceAll("-", "")}`;
  await configureRuntimeRole(fixture.db, role);
  const password = crypto.randomUUID().replaceAll("-", "");
  await fixture.db.execute(
    sql.raw(`alter role "${role}" login password '${password}'`),
  );
  const url = new URL(fixture.environment.databaseUrl);
  url.username = role;
  url.password = password;
  const environment = {
    ...fixture.environment,
    databaseUrl: url.toString(),
    databasePoolMax: 4,
  };
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

async function command(
  path: string,
  method: string,
  body?: unknown,
  key = crypto.randomUUID(),
) {
  const headers = fixture.headers("root");
  headers.set("Idempotency-Key", key);
  if (method === "PATCH") {
    const current = await app.request(path, { headers });
    headers.set("If-Match", current.headers.get("ETag")!);
  }
  if (body !== undefined) headers.set("Content-Type", "application/json");
  return app.request(path, {
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
    const response = await app.request(
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
  const foreign = await app.request(`${base}/${otherEntitlement!.id}`, {
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

test("subject failure rolls back the entitlement and receipt; the same key then commits once", async () => {
  const rows = await fixture.db.select().from(entitlements);
  const operations = await fixture.db.select().from(adminOperations);
  const key = crypto.randomUUID();
  const path = `/api/admin/v1/organizations/${fixture.tenant.organizationId}/entitlements`;
  const input = {
    memberId: fixture.principals.tenantReader.memberId,
    clientId: "answerable-bootstrap",
    scopes: ["org:read"],
  };
  await fixture.db.execute(
    sql`create function reject_entitlement_subject() returns trigger language plpgsql as $$ begin if NEW.relationship = 'affected' then raise exception 'test subject failure'; end if; return NEW; end $$`,
  );
  await fixture.db.execute(
    sql`create trigger reject_entitlement_subject before insert on audit_event_subjects for each row execute function reject_entitlement_subject()`,
  );
  try {
    expect((await command(path, "POST", input, key)).status).toBe(500);
  } finally {
    await fixture.db.execute(
      sql`drop trigger reject_entitlement_subject on audit_event_subjects`,
    );
    await fixture.db.execute(sql`drop function reject_entitlement_subject()`);
  }
  expect(await fixture.db.select().from(entitlements)).toEqual(rows);
  expect(await fixture.db.select().from(adminOperations)).toEqual(operations);
  expect(
    await fixture.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "entitlement.created")),
  ).toEqual([]);
  const response = await command(path, "POST", input, key);
  expect(response.status).toBe(201);
  const replay = await command(path, "POST", input, key);
  expect(replay.status).toBe(201);
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  await expectReceipt(fixture.db, replay);
  expect(
    await fixture.db
      .select()
      .from(auditEvents)
      .where(
        eq(auditEvents.operationId, response.headers.get("Operation-Id")!),
      ),
  ).toHaveLength(1);
});
for (const principal of ["member", "group", "organisation"] as const) {
  for (const order of ["entitlement-first", "user-first"] as const) {
    test(`${principal} entitlement removal and global user erasure are ordered: ${order}`, async () => {
      const person = fixture.principals.tenantReader;
      const organizationId = fixture.tenant.organizationId;
      let groupId: string | undefined;
      if (principal === "group") {
        const [group] = await fixture.db
          .insert(groups)
          .values({
            id: createId(),
            organizationId,
            slug: "race",
            name: "Race",
          })
          .returning();
        groupId = group!.id;
        await fixture.db.insert(groupMembers).values({
          id: createId(),
          organizationId,
          groupId,
          memberId: person.memberId,
        });
      }
      const created = await command(
        `/api/admin/v1/organizations/${organizationId}/entitlements`,
        "POST",
        {
          ...(principal === "member"
            ? { memberId: person.memberId }
            : principal === "group"
              ? { groupId }
              : {}),
          clientId: "answerable-bootstrap",
          scopes: ["org:read"],
        },
      );
      expect(created.status).toBe(201);
      const entitlement = await created.json();
      const auditAction =
        order === "entitlement-first" ? "entitlement.removed" : "user.erased";
      const gateKey = Math.floor(Math.random() * 1_000_000_000);
      await fixture.db.execute(
        sql.raw(
          `create function pause_entitlement_history() returns trigger language plpgsql as $$ begin if NEW.action = '${auditAction}' then perform pg_advisory_xact_lock(${gateKey}); end if; return NEW; end $$`,
        ),
      );
      await fixture.db.execute(
        sql`create trigger pause_entitlement_history before insert on audit_events for each row execute function pause_entitlement_history()`,
      );
      let entered!: () => void;
      let release!: () => void;
      let blockerPid = 0;
      const held = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const resume = new Promise<void>((resolve) => {
        release = resolve;
      });
      const blocker = fixture.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${gateKey})`);
        blockerPid = Number(
          (await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0]!.pid,
        );
        entered();
        await resume;
      });
      const entitlementHeaders = fixture.headers("root");
      entitlementHeaders.set("Idempotency-Key", crypto.randomUUID());
      const userHeaders = fixture.headers("root");
      userHeaders.set("Idempotency-Key", crypto.randomUUID());
      const removeEntitlement = () =>
        app.request(
          `/api/admin/v1/organizations/${organizationId}/entitlements/${entitlement.id}`,
          { method: "DELETE", headers: entitlementHeaders },
        );
      const eraseUser = () =>
        app.request(
          `/api/admin/v1/users/${person.userId}?confirm=${person.userId}`,
          { method: "DELETE", headers: userHeaders },
        );
      async function waitingOn(pid: number) {
        const deadline = Date.now() + 1500;
        while (true) {
          const waiting = await runtime.db.execute(
            sql`select pid from pg_stat_activity where usename = ${role} and ${pid} = any(pg_blocking_pids(pid))`,
          );
          if (waiting.rows.length) return Number(waiting.rows[0]!.pid);
          if (Date.now() > deadline)
            throw new Error("Expected command did not reach its database lock");
          await Bun.sleep(10);
        }
      }
      let first: ReturnType<typeof app.request> | undefined;
      let second: ReturnType<typeof app.request> | undefined;
      await held;
      try {
        first =
          order === "entitlement-first" ? removeEntitlement() : eraseUser();
        const firstPid = await waitingOn(blockerPid);
        second =
          order === "entitlement-first" ? eraseUser() : removeEntitlement();
        await waitingOn(firstPid);
      } finally {
        release();
        await blocker;
        // Finish both real requests before removing the test barrier or closing pools.
        await Promise.allSettled([first, second]);
        await fixture.db.execute(
          sql`drop trigger pause_entitlement_history on audit_events`,
        );
        await fixture.db.execute(
          sql`drop function pause_entitlement_history()`,
        );
      }
      const firstResponse = await first!;
      const secondResponse = await second!;
      expect(firstResponse.status).toBe(204);
      expect(secondResponse.status).toBe(
        order === "entitlement-first" || principal !== "member" ? 204 : 404,
      );
      const history = await app.request(
        `/api/admin/v1/users/${person.userId}/audit-events?action=entitlement.removed`,
        { headers: fixture.headers("root") },
      );
      if (order === "entitlement-first") {
        expect(history.status).toBe(200);
        const items = (await history.json()).items;
        expect(items).toHaveLength(1);
        expect(items[0]).toMatchObject({
          action: "entitlement.removed",
          schemaVersion: 3,
          organizationId,
          targetId: entitlement.id,
          data: {
            before: { id: entitlement.id },
            after: {
              id: entitlement.id,
              status: "disabled",
              deletedAt: expect.any(String),
            },
          },
        });
        const references = await withDatabaseScope(
          runtime.db,
          { kind: "platform", access: "read" },
          (tx) =>
            tx
              .select()
              .from(auditEventSubjects)
              .where(eq(auditEventSubjects.eventId, items[0].id)),
        );
        expect(references).toContainEqual(
          expect.objectContaining({
            entityType: "user",
            entityId: person.userId,
            relationship: "affected",
            provenance: "recorded",
          }),
        );
        const replay = await removeEntitlement();
        expect(replay.status).toBe(204);
        expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
      } else {
        expect(history.status).toBe(200);
        expect((await history.json()).items).toEqual([]);
        const replay = await removeEntitlement();
        expect(replay.status).toBe(principal === "member" ? 404 : 204);
        const events = await withDatabaseScope(
          runtime.db,
          { kind: "platform", access: "read" },
          (tx) =>
            tx
              .select()
              .from(auditEvents)
              .where(eq(auditEvents.action, "entitlement.removed")),
        );
        if (principal === "member") expect(events).toEqual([]);
        else {
          expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
          expect(events).toHaveLength(1);
          const audience = events[0]!.data!.audience as { userId: string }[];
          expect(
            audience.some((member) => member.userId === person.userId),
          ).toBe(false);
        }
      }
    });
  }
}
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
      const history = await app.request(
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

for (const principal of ["group", "organisation"] as const) {
  test(`${principal} audience failure rolls back creation and permits same-key recovery`, async () => {
    const organizationId = fixture.tenant.organizationId;
    const [group] = await fixture.db
      .insert(groups)
      .values({
        id: createId(),
        organizationId,
        slug: "failure",
        name: "Failure",
      })
      .returning();
    await fixture.db.insert(groupMembers).values({
      id: createId(),
      organizationId,
      groupId: group!.id,
      memberId: fixture.principals.tenantReader.memberId,
    });
    const beforeRows = await fixture.db.select().from(entitlements);
    const beforeOperations = await fixture.db.select().from(adminOperations);
    const path = `/api/admin/v1/organizations/${organizationId}/entitlements`;
    const input = {
      ...(principal === "group" ? { groupId: group!.id } : {}),
      clientId: "answerable-bootstrap",
      scopes: ["org:read"],
    };
    const key = crypto.randomUUID();
    await fixture.db.execute(
      sql`create function reject_audience_subject() returns trigger language plpgsql as $$ begin if NEW.relationship = 'affected' then raise exception 'test audience failure'; end if; return NEW; end $$`,
    );
    await fixture.db.execute(
      sql`create trigger reject_audience_subject before insert on audit_event_subjects for each row execute function reject_audience_subject()`,
    );
    try {
      expect((await command(path, "POST", input, key)).status).toBe(500);
    } finally {
      await fixture.db.execute(
        sql`drop trigger reject_audience_subject on audit_event_subjects`,
      );
      await fixture.db.execute(sql`drop function reject_audience_subject()`);
    }
    expect(await fixture.db.select().from(entitlements)).toEqual(beforeRows);
    expect(await fixture.db.select().from(adminOperations)).toEqual(
      beforeOperations,
    );
    expect(
      await fixture.db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, "entitlement.created")),
    ).toEqual([]);
    const response = await command(path, "POST", input, key);
    expect(response.status).toBe(201);
    const replay = await command(path, "POST", input, key);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    await expectReceipt(fixture.db, replay);
    expect(
      await fixture.db
        .select()
        .from(auditEvents)
        .where(
          eq(auditEvents.operationId, response.headers.get("Operation-Id")!),
        ),
    ).toHaveLength(1);
  });
}
