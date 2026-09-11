import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
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
  auditEventSubjects,
  entitlements,
  grantContexts,
  groupMembers,
  groups,
  invitations,
  members,
  oauthClients,
  organizationCapabilities,
  organizationDomains,
  organizations,
  sessions,
  ssoProviders,
  users,
} from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";
let fixture: AdminFixture;
let runtime: DatabaseConnection;
let app: ReturnType<typeof createApp>;
let role: string;
beforeEach(async () => {
  fixture = await createAdminFixture();
  role = `id_test_org_audit_${crypto.randomUUID().replaceAll("-", "")}`;
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

async function seed() {
  const organizationId = fixture.tenant.organizationId;
  const [group] = await fixture.db
    .insert(groups)
    .values({
      id: createId(),
      organizationId,
      slug: "erasure",
      name: "Erasure",
    })
    .returning();
  await fixture.db.insert(groupMembers).values({
    id: createId(),
    organizationId,
    groupId: group!.id,
    memberId: fixture.principals.tenantReader.memberId,
    validUntil: new Date("2000-01-01"),
  });
  await fixture.db.insert(entitlements).values({
    id: createId(),
    organizationId,
    groupId: group!.id,
    clientId: "answerable-bootstrap",
    scopes: ["org:read"],
    status: "disabled",
  });
  await fixture.db.insert(invitations).values({
    id: createId(),
    organizationId,
    inviterId: fixture.principals.tenantReader.userId,
    email: "private-invite@example.com",
    expiresAt: new Date("2100-01-01"),
  });
  // Same global user, independent membership in B.
  await fixture.db.insert(members).values({
    id: createId(),
    organizationId: fixture.outsider.organizationId,
    userId: fixture.principals.tenantReader.userId,
  });
  return organizationId;
}
async function state() {
  return {
    organizations: await fixture.db
      .select()
      .from(organizations)
      .orderBy(organizations.id),
    members: await fixture.db.select().from(members).orderBy(members.id),
    groups: await fixture.db.select().from(groups).orderBy(groups.id),
    assignments: await fixture.db
      .select()
      .from(groupMembers)
      .orderBy(groupMembers.id),
    entitlements: await fixture.db
      .select()
      .from(entitlements)
      .orderBy(entitlements.id),
    capabilities: await fixture.db
      .select()
      .from(organizationCapabilities)
      .orderBy(organizationCapabilities.id),
    domains: await fixture.db
      .select()
      .from(organizationDomains)
      .orderBy(organizationDomains.id),
    providers: await fixture.db
      .select()
      .from(ssoProviders)
      .orderBy(ssoProviders.id),
    invitations: await fixture.db
      .select()
      .from(invitations)
      .orderBy(invitations.id),
    users: await fixture.db.select().from(users).orderBy(users.id),
    sessions: await fixture.db.select().from(sessions).orderBy(sessions.id),
    operations: await fixture.db
      .select()
      .from(adminOperations)
      .orderBy(adminOperations.id),
  };
}
function erase(id: string, key: string) {
  const headers = fixture.headers("root");
  headers.set("Idempotency-Key", key);
  return app.request(`/api/admin/v1/organizations/${id}?confirm=${id}`, {
    method: "DELETE",
    headers,
  });
}

test("organisation erasure records removed tenant configuration and member history without issued grants", async () => {
  const id = await seed();
  const before = await state();
  const key = createId();
  const response = await erase(id, key);
  expect(response.status).toBe(204);
  const [event] = await fixture.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.operationId, response.headers.get("Operation-Id")!));
  expect(event!.schemaVersion).toBe(3);
  const effects = event!.data!.effects as Record<
    string,
    Array<{ id: string; organizationId: string }>
  >;
  for (const [name, rows] of Object.entries({
    softDeletedMembers: before.members,
    softDeletedGroups: before.groups,
    softDeletedAssignments: before.assignments,
    softDeletedEntitlements: before.entitlements,
    softDeletedCapabilities: before.capabilities,
    softDeletedDomains: before.domains,
    softDeletedSsoProviders: before.providers,
    softDeletedInvitations: before.invitations,
  })) {
    expect(effects[name]!.map((row) => row.id).sort()).toEqual(
      rows
        .filter((row) => row.organizationId === id)
        .map((row) => row.id)
        .sort(),
    );
    expect(effects[name]!.every((row) => row.organizationId === id)).toBe(true);
  }
  expect(effects.softDeletedMembers).toContainEqual(
    expect.objectContaining({
      userId: fixture.principals.tenantReader.userId,
      revision: 2,
      status: "revoked",
      deletedAt: expect.any(String),
    }),
  );
  expect(effects.softDeletedEntitlements).toContainEqual(
    expect.objectContaining({ status: "disabled", scopes: ["org:read"] }),
  );
  expect(JSON.stringify(event!.data)).not.toContain(
    "private-invite@example.com",
  );
  expect(JSON.stringify(effects.softDeletedSsoProviders)).not.toContain(
    "oidcConfig",
  );
  expect(JSON.stringify(effects.softDeletedSsoProviders)).not.toContain(
    "samlConfig",
  );
  const after = await state();
  for (const name of [
    "members",
    "groups",
    "assignments",
    "entitlements",
    "capabilities",
    "domains",
    "providers",
    "invitations",
  ] as const) {
    expect(after[name]).toHaveLength(before[name].length);
    expect(after[name].filter((row) => row.organizationId !== id)).toEqual(
      before[name].filter((row) => row.organizationId !== id),
    );
    expect(
      after[name]
        .filter((row) => row.organizationId === id)
        .every((row) => row.deletedAt instanceof Date),
    ).toBe(true);
  }
  expect(after.organizations.find((row) => row.id === id)).toMatchObject({
    status: "disabled",
    deletedAt: expect.any(Date),
  });
  expect(after.users).toEqual(before.users);
  expect(after.sessions).toEqual(
    before.sessions.map((row) =>
      row.activeOrganizationId === id
        ? { ...row, activeOrganizationId: null }
        : row,
    ),
  );
  expect(effects.clearedSessionSelections!.map((row) => row.id).sort()).toEqual(
    before.sessions
      .filter((row) => row.activeOrganizationId === id)
      .map((row) => row.id)
      .sort(),
  );
  const replay = await erase(id, key);
  expect(replay.status).toBe(204);
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  expect(await state()).toEqual(after);
  await fixture.db
    .delete(users)
    .where(eq(users.id, fixture.principals.tenantReader.userId));
  const history = await app.request(
    `/api/admin/v1/users/${fixture.principals.tenantReader.userId}/audit-events?action=organization.erased`,
    { headers: fixture.headers("root") },
  );
  expect(history.status).toBe(200);
  expect(
    (await history.json()).items.map((item: { id: string }) => item.id),
  ).toEqual([event!.id]);
  const subjects = await fixture.db
    .select()
    .from(auditEventSubjects)
    .where(eq(auditEventSubjects.eventId, event!.id));
  expect(subjects).toContainEqual(
    expect.objectContaining({
      entityType: "user",
      entityId: fixture.principals.tenantReader.userId,
      relationship: "affected",
      organizationId: id,
    }),
  );
});

test("organisation erasure rolls back configuration and receipt when subject capture fails, then recovers the same key", async () => {
  const id = await seed();
  const before = await state();
  const key = createId();
  await fixture.db.execute(
    sql`alter table audit_event_subjects add constraint org_erasure_fault check (relationship <> 'affected') not valid`,
  );
  try {
    expect((await erase(id, key)).status).toBe(400);
  } finally {
    await fixture.db.execute(
      sql`alter table audit_event_subjects drop constraint org_erasure_fault`,
    );
  }
  expect(await state()).toEqual(before);
  expect((await erase(id, key)).status).toBe(204);
  const [event] = await fixture.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.action, "organization.erased"));
  expect(event!.schemaVersion).toBe(3);
  expect((await erase(id, key)).headers.get("Idempotency-Replayed")).toBe(
    "true",
  );
});

for (const order of ["organisation-first", "user-first"] as const) {
  test(`organisation erasure and global user erasure retain actual membership effects: ${order}`, async () => {
    const organizationId = await seed();
    const person = fixture.principals.tenantReader;
    const auditAction =
      order === "organisation-first" ? "organization.erased" : "user.erased";
    const gateKey = Math.floor(Math.random() * 1_000_000_000);
    await fixture.db.execute(
      sql.raw(
        `create function pause_org_erasure() returns trigger language plpgsql as $$ begin if NEW.action = '${auditAction}' then perform pg_advisory_xact_lock(${gateKey}); end if; return NEW; end $$`,
      ),
    );
    await fixture.db.execute(
      sql`create trigger pause_org_erasure before insert on audit_events for each row execute function pause_org_erasure()`,
    );
    let entered!: () => void, release!: () => void;
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
    const key = createId();
    const headers = fixture.headers("root");
    headers.set("Idempotency-Key", createId());
    const eraseUser = () =>
      app.request(
        `/api/admin/v1/users/${person.userId}?confirm=${person.userId}`,
        { method: "DELETE", headers },
      );
    async function waitingOn(pid: number) {
      const deadline = Date.now() + 1500;
      while (true) {
        const waiting = await runtime.db.execute(
          sql`select pid from pg_stat_activity where usename = ${role} and ${pid} = any(pg_blocking_pids(pid))`,
        );
        if (waiting.rows.length) return Number(waiting.rows[0]!.pid);
        if (Date.now() > deadline)
          throw new Error("Erasure did not reach its database lock");
        await Bun.sleep(10);
      }
    }
    let first: ReturnType<typeof app.request> | undefined,
      second: ReturnType<typeof app.request> | undefined;
    await held;
    try {
      first =
        order === "organisation-first"
          ? erase(organizationId, key)
          : eraseUser();
      const firstPid = await waitingOn(blockerPid);
      second =
        order === "organisation-first"
          ? eraseUser()
          : erase(organizationId, key);
      await waitingOn(firstPid);
    } finally {
      release();
      await blocker;
      await Promise.allSettled([first, second]);
      await fixture.db.execute(
        sql`drop trigger pause_org_erasure on audit_events`,
      );
      await fixture.db.execute(sql`drop function pause_org_erasure()`);
    }
    expect((await first!).status).toBe(204);
    expect((await second!).status).toBe(204);
    const [event] = await fixture.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "organization.erased"));
    const effects = event!.data!.effects as {
      softDeletedMembers: Array<{ userId: string }>;
    };
    expect(
      effects.softDeletedMembers.some((row) => row.userId === person.userId),
    ).toBe(order === "organisation-first");
    const subjects = await fixture.db
      .select()
      .from(auditEventSubjects)
      .where(eq(auditEventSubjects.eventId, event!.id));
    expect(
      subjects.some(
        (row) =>
          row.entityType === "user" &&
          row.entityId === person.userId &&
          row.relationship === "affected",
      ),
    ).toBe(order === "organisation-first");
    expect(
      (await erase(organizationId, key)).headers.get("Idempotency-Replayed"),
    ).toBe("true");
  });
}

test("organisation erasure records each deleted grant with its stored tenant identity", async () => {
  const person = fixture.principals.tenantReader;
  const [session] = await fixture.db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, person.userId));
  const id = createId();
  const clientInstanceId = createId();
  await fixture.db.insert(oauthClients).values({
    id: clientInstanceId,
    clientId: createId(),
    organizationId: fixture.outsider.organizationId,
    redirectUris: [],
    scopes: ["org:read"],
  });
  await fixture.db.insert(grantContexts).values({
    id,
    organizationId: person.organizationId,
    memberId: person.memberId,
    userId: person.userId,
    clientInstanceId,
    authenticationSessionId: session!.id,
    authTime: sql`(select created_at from sessions where id = ${session!.id}::uuid)`,
    requestedScopes: ["org:read"],
    expiresAt: new Date("2100-01-01"),
  });
  const response = await erase(person.organizationId, createId());
  expect(response.status).toBe(204);
  const [event] = await fixture.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.operationId, response.headers.get("Operation-Id")!));
  expect(event!.data!.revokedGrantContexts).toEqual([
    { id, userId: person.userId, organizationId: person.organizationId },
  ]);
});
