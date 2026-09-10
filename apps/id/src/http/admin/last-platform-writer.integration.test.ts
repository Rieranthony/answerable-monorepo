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
  entitlements,
  groupMembers,
  groups,
  members,
  users,
  sessions,
  accounts,
  organizations,
  oauthResources,
} from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";
import { hasPlatformWriter } from "../../db/queries/grants.ts";
let fixture: AdminFixture;
let runtime: DatabaseConnection;
let app: ReturnType<typeof createApp>;
let role: string;
beforeEach(async () => {
  fixture = await createAdminFixture();
  role = `id_test_last_member_${crypto.randomUUID().replaceAll("-", "")}`;
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
function path(memberId: string) {
  return `/api/admin/v1/organizations/${fixture.platform.organizationId}/members/${memberId}`;
}
function remove(memberId: string, key: string) {
  const headers = fixture.headers("root");
  headers.set("Idempotency-Key", key);
  return app.request(path(memberId), { method: "DELETE", headers });
}
async function secondWriter() {
  await fixture.db
    .update(entitlements)
    .set({ scopes: ["platform:read", "platform:users", "platform:write"] })
    .where(
      eq(entitlements.memberId, fixture.principals.platformReader.memberId),
    );
}
async function snapshot() {
  return {
    organizations: await fixture.db
      .select()
      .from(organizations)
      .orderBy(organizations.id),
    resources: await fixture.db
      .select()
      .from(oauthResources)
      .orderBy(oauthResources.id),
    systemAudit: await fixture.db
      .select()
      .from(auditEvents)
      .where(
        sql`${auditEvents.action} like 'organization.%' or ${auditEvents.action} like 'resource.%'`,
      )
      .orderBy(auditEvents.id),
    users: await fixture.db
      .select({
        id: users.id,
        status: users.status,
        disabledAt: users.disabledAt,
      })
      .from(users)
      .orderBy(users.id),
    sessions: await fixture.db
      .select({ id: sessions.id, userId: sessions.userId })
      .from(sessions)
      .orderBy(sessions.id),
    accounts: await fixture.db
      .select({ id: accounts.id, userId: accounts.userId })
      .from(accounts)
      .orderBy(accounts.id),
    disabled: await fixture.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "user.disabled")),
    erased: await fixture.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "user.erased")),
    members: await fixture.db.select().from(members).orderBy(members.id),
    groupRows: await fixture.db.select().from(groups).orderBy(groups.id),
    policyAudit: await fixture.db
      .select()
      .from(auditEvents)
      .where(
        sql`${auditEvents.action} like 'group%' or ${auditEvents.action} like 'entitlement%'`,
      )
      .orderBy(auditEvents.id),
    groups: await fixture.db
      .select()
      .from(groupMembers)
      .orderBy(groupMembers.id),
    entitlements: await fixture.db
      .select()
      .from(entitlements)
      .orderBy(entitlements.id),
    operations: await fixture.db
      .select()
      .from(adminOperations)
      .orderBy(adminOperations.id),
    removed: await fixture.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "member.removed")),
    updated: await fixture.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "member.updated")),
  };
}
test("last platform member removal rolls back and the same key succeeds only after a replacement exists", async () => {
  const target = fixture.principals.platformAdmin.memberId;
  const key = crypto.randomUUID();
  const before = await snapshot();
  const denied = await remove(target, key);
  expect(denied.status).toBe(409);
  expect(await denied.json()).toMatchObject({
    code: "last_platform_administrator",
  });
  expect(await snapshot()).toEqual(before);
  await secondWriter();
  expect((await remove(target, key)).status).toBe(204);
  const committed = await snapshot();
  const replay = await remove(target, key);
  expect(replay.status).toBe(204);
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  expect(await snapshot()).toEqual(committed);
  expect(
    (
      await remove(
        fixture.principals.platformReader.memberId,
        crypto.randomUUID(),
      )
    ).status,
  ).toBe(409);
  expect(
    await hasPlatformWriter(runtime.db, {
      resource: fixture.platform.adminResource,
    }),
  ).toBe(true);
});
test.each([
  { validFrom: "2100-01-01T00:00:00.000Z" },
  { validUntil: "2000-01-01T00:00:00.000Z" },
])(
  "ineligible last-writer window rolls back revision, audit and receipt (%#)",
  async (window) => {
    const target = fixture.principals.platformAdmin.memberId;
    const headers = fixture.headers("root");
    const read = await app.request(path(target) + "/configuration", {
      headers,
    });
    expect(read.status).toBe(200);
    headers.set("If-Match", read.headers.get("ETag")!);
    headers.set("Idempotency-Key", crypto.randomUUID());
    headers.set("Content-Type", "application/json");
    const before = await snapshot();
    const patch = () =>
      app.request(path(target), {
        method: "PATCH",
        headers,
        body: JSON.stringify(window),
      });
    const denied = await patch();
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({
      code: "last_platform_administrator",
    });
    expect(await snapshot()).toEqual(before);
    await secondWriter();
    expect((await patch()).status).toBe(200);
    expect(
      await hasPlatformWriter(runtime.db, {
        resource: fixture.platform.adminResource,
      }),
    ).toBe(true);
  },
);
test("concurrent removals cannot each rely on the other platform writer", async () => {
  await secondWriter();
  const before = await snapshot();
  const responses = await Promise.all([
    remove(fixture.principals.platformAdmin.memberId, crypto.randomUUID()),
    remove(fixture.principals.platformReader.memberId, crypto.randomUUID()),
  ]);
  expect(responses.map((response) => response.status).sort()).toEqual([
    204, 409,
  ]);
  const after = await snapshot();
  expect(after.removed.length).toBe(before.removed.length + 1);
  expect(after.operations.length).toBe(before.operations.length + 1);
  expect(
    await hasPlatformWriter(runtime.db, {
      resource: fixture.platform.adminResource,
    }),
  ).toBe(true);
});

test("an unrelated tenant member command does not wait for the platform writer lock", async () => {
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocker = fixture.db.transaction(async (tx) => {
    await tx.execute(
      sql`select id from organizations where id = ${fixture.platform.organizationId} for update`,
    );
    entered();
    await resume;
  });
  await held;
  try {
    const response = await app.request(
      `/api/admin/v1/organizations/${fixture.tenant.organizationId}/members/${fixture.principals.tenantReader.memberId}`,
      {
        method: "DELETE",
        headers: fixture.headers("root"),
      },
    );
    expect(response.status).toBe(204);
  } finally {
    release();
    await blocker;
  }
});

test("a writerless platform can reinstate a previously revoked writer", async () => {
  const target = fixture.principals.platformAdmin.memberId;
  await fixture.db
    .update(members)
    .set({ status: "revoked", revokedAt: new Date() })
    .where(eq(members.id, target));
  expect(
    await hasPlatformWriter(runtime.db, {
      resource: fixture.platform.adminResource,
    }),
  ).toBe(false);
  const response = await app.request(path(target) + "/reinstate", {
    method: "POST",
    headers: fixture.headers("root"),
  });
  expect(response.status).toBe(200);
  expect(
    await hasPlatformWriter(runtime.db, {
      resource: fixture.platform.adminResource,
    }),
  ).toBe(true);
});

function changeUser(kind: "disable" | "erase", userId: string, key: string) {
  const headers = fixture.headers("root");
  headers.set("Idempotency-Key", key);
  return app.request(
    `/api/admin/v1/users/${userId}${kind === "disable" ? "/disable" : `?confirm=${userId}`}`,
    {
      method: kind === "disable" ? "POST" : "DELETE",
      headers,
    },
  );
}
for (const kind of ["disable", "erase"] as const) {
  test(`global ${kind} preserves the last writer and retries/replays after replacement`, async () => {
    const target = fixture.principals.platformAdmin.userId;
    const key = crypto.randomUUID();
    const before = await snapshot();
    const denied = await changeUser(kind, target, key);
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({
      code: "last_platform_administrator",
    });
    expect(await snapshot()).toEqual(before);
    await secondWriter();
    expect((await changeUser(kind, target, key)).status).toBe(
      kind === "disable" ? 200 : 204,
    );
    const committed = await snapshot();
    const replay = await changeUser(kind, target, key);
    expect(replay.status).toBe(kind === "disable" ? 200 : 204);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await snapshot()).toEqual(committed);
    expect(
      await hasPlatformWriter(runtime.db, {
        resource: fixture.platform.adminResource,
      }),
    ).toBe(true);
  });
  test(`concurrent global ${kind} commands retain a writer and a refused key remains retryable`, async () => {
    await secondWriter();
    const targets = [
      fixture.principals.platformAdmin.userId,
      fixture.principals.platformReader.userId,
    ];
    const keys = [crypto.randomUUID(), crypto.randomUUID()];
    const before = await snapshot();
    const responses = await Promise.all(
      targets.map((id, index) => changeUser(kind, id, keys[index]!)),
    );
    expect(
      responses.filter(
        (response) => response.status === (kind === "disable" ? 200 : 204),
      ),
    ).toHaveLength(1);
    const rejected = responses.findIndex(
      (response) => response.status !== (kind === "disable" ? 200 : 204),
    );
    expect([409, 503]).toContain(responses[rejected]!.status);
    const retry = await changeUser(kind, targets[rejected]!, keys[rejected]!);
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({
      code: "last_platform_administrator",
    });
    expect((await snapshot()).operations.length).toBe(
      before.operations.length + 1,
    );
    expect(
      await hasPlatformWriter(runtime.db, {
        resource: fixture.platform.adminResource,
      }),
    ).toBe(true);
  });
}

test("an unrelated user's disable does not acquire the platform organisation lock", async () => {
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocker = fixture.db.transaction(async (tx) => {
    await tx.execute(
      sql`select id from organizations where id = ${fixture.platform.organizationId} for update`,
    );
    entered();
    await resume;
  });
  await held;
  try {
    expect(
      (
        await changeUser(
          "disable",
          fixture.principals.tenantReader.userId,
          crypto.randomUUID(),
        )
      ).status,
    ).toBe(200);
  } finally {
    release();
    await blocker;
  }
});

test("a platform membership committed during the user lock wait is included in last-writer protection", async () => {
  const target = fixture.principals.tenantReader.userId;
  let release!: () => void;
  let entered!: () => void;
  let pid = 0;
  const held = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  const before = await snapshot();
  const blocker = fixture.db.transaction(async (tx) => {
    await tx.execute(sql`select id from users where id = ${target} for update`);
    pid = Number(
      (await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0]!.pid,
    );
    entered();
    await resume;
    const [member] = await tx
      .insert(members)
      .values({
        id: createId(),
        userId: target,
        organizationId: fixture.platform.organizationId,
      })
      .returning();
    await tx.insert(entitlements).values({
      id: createId(),
      organizationId: fixture.platform.organizationId,
      memberId: member!.id,
      resource: fixture.platform.adminResource,
      scopes: ["platform:write"],
    });
    await tx
      .update(users)
      .set({ status: "disabled", disabledAt: new Date() })
      .where(eq(users.id, fixture.principals.platformAdmin.userId));
  });
  await held;
  const request = changeUser("disable", target, crypto.randomUUID());
  try {
    const deadline = Date.now() + 1500;
    while (true) {
      const blocked = await runtime.db.execute(
        sql`select pid from pg_stat_activity where usename = ${role} and ${pid} = any(pg_blocking_pids(pid))`,
      );
      if (blocked.rows.length) break;
      if (Date.now() > deadline)
        throw new Error("User command did not reach its row lock");
      await Bun.sleep(10);
    }
  } finally {
    release();
    await blocker;
  }
  const response = await request;
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    code: "last_platform_administrator",
  });
  const after = await snapshot();
  expect(after.users.find((user) => user.id === target)?.status).toBe("active");
  expect(after.operations).toEqual(before.operations);
  expect(after.disabled).toEqual(before.disabled);
  expect(
    await hasPlatformWriter(runtime.db, {
      resource: fixture.platform.adminResource,
    }),
  ).toBe(true);
});

async function customWriterGroup() {
  const [group] = await fixture.db
    .insert(groups)
    .values({
      id: createId(),
      organizationId: fixture.platform.organizationId,
      slug: "replacement-writer-group",
      name: "Writer group",
    })
    .returning();
  const oldAssignments = await fixture.db
    .delete(groupMembers)
    .where(eq(groupMembers.groupId, fixture.platform.groupId))
    .returning();
  await fixture.db.insert(groupMembers).values(
    oldAssignments.map((row) => ({
      ...row,
      id: createId(),
      groupId: group!.id,
      revision: 1,
    })),
  );
  const oldEntitlements = await fixture.db
    .delete(entitlements)
    .where(eq(entitlements.groupId, fixture.platform.groupId))
    .returning();
  const [entitlement] = await fixture.db
    .insert(entitlements)
    .values(
      oldEntitlements.map((row) => ({
        ...row,
        id: createId(),
        groupId: group!.id,
        revision: 1,
      })),
    )
    .returning();
  expect(entitlement).toBeDefined();
  return { group: group!, entitlement: entitlement! };
}
const policyChanges = [
  {
    name: "group disable",
    target: "group",
    suffix: "/disable",
    method: "POST",
    status: 200,
  },
  {
    name: "group erasure",
    target: "group",
    suffix: "erase",
    method: "DELETE",
    status: 204,
  },
  {
    name: "assignment removal",
    target: "assignment",
    suffix: "",
    method: "DELETE",
    status: 204,
  },
  {
    name: "assignment future window",
    target: "assignment",
    suffix: "",
    method: "PUT",
    status: 200,
    body: { validFrom: "2100-01-01T00:00:00.000Z" },
  },
  {
    name: "assignment expired window",
    target: "assignment",
    suffix: "",
    method: "PUT",
    status: 200,
    body: { validUntil: "2000-01-01T00:00:00.000Z" },
  },
  {
    name: "entitlement disable",
    target: "entitlement",
    suffix: "/disable",
    method: "POST",
    status: 200,
  },
  {
    name: "entitlement removal",
    target: "entitlement",
    suffix: "",
    method: "DELETE",
    status: 204,
  },
  {
    name: "entitlement scopes",
    target: "entitlement",
    suffix: "",
    method: "PATCH",
    status: 200,
    body: { scopes: ["platform:read"] },
  },
  {
    name: "entitlement future window",
    target: "entitlement",
    suffix: "",
    method: "PATCH",
    status: 200,
    body: { validFrom: "2100-01-01T00:00:00.000Z" },
  },
  {
    name: "entitlement expired window",
    target: "entitlement",
    suffix: "",
    method: "PATCH",
    status: 200,
    body: { validUntil: "2000-01-01T00:00:00.000Z" },
  },
] as const;
for (const change of policyChanges) {
  test(`${change.name} preserves the last writer with rollback, recovery and replay`, async () => {
    const { group, entitlement } = await customWriterGroup();
    const base = `/api/admin/v1/organizations/${fixture.platform.organizationId}`;
    const target =
      change.target === "entitlement"
        ? `${base}/entitlements/${entitlement.id}`
        : `${base}/groups/${group.id}${change.target === "assignment" ? `/members/${fixture.principals.platformAdmin.memberId}` : ""}`;
    const headers = fixture.headers("root");
    headers.set("Idempotency-Key", crypto.randomUUID());
    let body: string | undefined;
    if ("body" in change) {
      const read = await app.request(target, { headers });
      expect(read.status).toBe(200);
      headers.set("If-Match", read.headers.get("ETag")!);
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(change.body);
    }
    const url =
      target +
      (change.suffix === "erase" ? `?confirm=${group.id}` : change.suffix);
    const run = () =>
      app.request(url, { method: change.method, headers, body });
    const before = await snapshot();
    const denied = await run();
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({
      code: "last_platform_administrator",
    });
    expect(await snapshot()).toEqual(before);
    await secondWriter();
    expect((await run()).status).toBe(change.status);
    const committed = await snapshot();
    const replay = await run();
    expect(replay.status).toBe(change.status);
    expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await snapshot()).toEqual(committed);
    expect(
      await hasPlatformWriter(runtime.db, {
        resource: fixture.platform.adminResource,
      }),
    ).toBe(true);
  });
}

test("concurrent group and entitlement restrictions cannot each rely on the other writer", async () => {
  const { group } = await customWriterGroup();
  await secondWriter();
  const [other] = await fixture.db
    .select()
    .from(entitlements)
    .where(
      eq(entitlements.memberId, fixture.principals.platformReader.memberId),
    );
  expect(other).toBeDefined();
  const base = `/api/admin/v1/organizations/${fixture.platform.organizationId}`;
  const before = await snapshot();
  const responses = await Promise.all(
    [
      `${base}/groups/${group.id}/disable`,
      `${base}/entitlements/${other!.id}/disable`,
    ].map((url) => {
      const headers = fixture.headers("root");
      headers.set("Idempotency-Key", crypto.randomUUID());
      return app.request(url, { method: "POST", headers });
    }),
  );
  expect(responses.map((response) => response.status).sort()).toEqual([
    200, 409,
  ]);
  const after = await snapshot();
  expect(after.operations.length).toBe(before.operations.length + 1);
  expect(after.policyAudit.length).toBe(before.policyAudit.length + 1);
  expect(
    await hasPlatformWriter(runtime.db, {
      resource: fixture.platform.adminResource,
    }),
  ).toBe(true);
});

test("an unrelated group disable progresses while the platform organisation is locked", async () => {
  const [group] = await fixture.db
    .insert(groups)
    .values({
      id: createId(),
      organizationId: fixture.tenant.organizationId,
      slug: "tenant-local-group",
      name: "Tenant group",
    })
    .returning();
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocker = fixture.db.transaction(async (tx) => {
    await tx.execute(
      sql`select id from organizations where id = ${fixture.platform.organizationId} for update`,
    );
    entered();
    await resume;
  });
  await held;
  try {
    const headers = fixture.headers("root");
    headers.set("Idempotency-Key", crypto.randomUUID());
    const response = await app.request(
      `/api/admin/v1/organizations/${fixture.tenant.organizationId}/groups/${group!.id}/disable`,
      { method: "POST", headers },
    );
    expect(response.status).toBe(200);
  } finally {
    release();
    await blocker;
  }
});

test("a writerless platform can recover by enabling its writer group", async () => {
  const { group } = await customWriterGroup();
  await fixture.db
    .update(groups)
    .set({ status: "disabled" })
    .where(eq(groups.id, group.id));
  expect(
    await hasPlatformWriter(runtime.db, {
      resource: fixture.platform.adminResource,
    }),
  ).toBe(false);
  const headers = fixture.headers("root");
  headers.set("Idempotency-Key", crypto.randomUUID());
  const response = await app.request(
    `/api/admin/v1/organizations/${fixture.platform.organizationId}/groups/${group.id}/enable`,
    { method: "POST", headers },
  );
  expect(response.status).toBe(200);
  expect(
    await hasPlatformWriter(runtime.db, {
      resource: fixture.platform.adminResource,
    }),
  ).toBe(true);
});

function resourcePath(identifier: string) {
  return `/api/admin/v1/resources/${encodeURIComponent(identifier)}`;
}
async function resourcePatch(identifier: string, scopes: string[]) {
  const headers = fixture.headers("root");
  const read = await app.request(resourcePath(identifier), { headers });
  expect(read.status).toBe(200);
  headers.set("If-Match", read.headers.get("ETag")!);
  headers.set("Idempotency-Key", crypto.randomUUID());
  headers.set("Content-Type", "application/json");
  return () =>
    app.request(resourcePath(identifier), {
      method: "PATCH",
      headers,
      body: JSON.stringify({ allowedScopes: scopes }),
    });
}

test("platform organisation disable preserves the current writer and leaves a refused key unused", async () => {
  const headers = fixture.headers("root");
  headers.set("Idempotency-Key", crypto.randomUUID());
  const before = await snapshot();
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await app.request(
      `/api/admin/v1/organizations/${fixture.platform.organizationId}/disable`,
      { method: "POST", headers },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "last_platform_administrator",
    });
    expect(await snapshot()).toEqual(before);
  }
});

test("admin resource scope narrowing preserves current writers but permits a safe restriction and replay", async () => {
  const deny = await resourcePatch(fixture.platform.adminResource, [
    "platform:read",
  ]);
  const before = await snapshot();
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await deny();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "last_platform_administrator",
    });
    expect(await snapshot()).toEqual(before);
  }
  const allow = await resourcePatch(fixture.platform.adminResource, [
    "platform:read",
    "platform:write",
  ]);
  expect((await allow()).status).toBe(200);
  const committed = await snapshot();
  const replay = await allow();
  expect(replay.status).toBe(200);
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  expect(await snapshot()).toEqual(committed);
  expect(
    await hasPlatformWriter(runtime.db, {
      resource: fixture.platform.adminResource,
    }),
  ).toBe(true);
});

test("resource lifecycle protection follows the persisted binding rather than the configured name", async () => {
  const decoy = "https://ordinary-resource.example.com";
  await fixture.db.insert(oauthResources).values({
    id: createId(),
    identifier: decoy,
    name: "Ordinary resource",
    allowedScopes: ["read"],
  });
  // Bypass startup deliberately: this proves the service boundary does not trust
  // a caller's configured name. Production startup separately checks its binding.
  const environment = {
    ...fixture.environment,
    adminResourceIdentifier: decoy,
  };
  app = createApp({
    db: runtime.db,
    auth: createAuth(runtime.db, environment),
    environment,
  });
  for (const method of ["POST", "DELETE"] as const) {
    const headers = fixture.headers("root");
    headers.set("Idempotency-Key", crypto.randomUUID());
    const before = await snapshot();
    const suffix =
      method === "POST"
        ? "/disable"
        : `?confirm=${encodeURIComponent(fixture.platform.adminResource)}`;
    const denied = await app.request(
      resourcePath(fixture.platform.adminResource) + suffix,
      { method, headers },
    );
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({ code: "resource_protected" });
    expect(await snapshot()).toEqual(before);
    headers.set("Idempotency-Key", crypto.randomUUID());
    const ordinary = await app.request(
      resourcePath(decoy) +
        (method === "POST"
          ? "/disable"
          : `?confirm=${encodeURIComponent(decoy)}`),
      { method, headers },
    );
    expect(ordinary.status).toBe(method === "POST" ? 200 : 204);
  }
});

test("admin resource scope changes wait for the platform before taking the resource lock", async () => {
  const run = await resourcePatch(fixture.platform.adminResource, [
    "platform:read",
  ]);
  let release!: () => void;
  let entered!: () => void;
  let pid = 0;
  const held = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  const before = await snapshot();
  const blocker = fixture.db.transaction(async (tx) => {
    await tx.execute(
      sql`select id from organizations where id = ${fixture.platform.organizationId} for update`,
    );
    pid = Number(
      (await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0]!.pid,
    );
    entered();
    await resume;
    // The waiting command must not already hold the resource in the reverse order.
    await tx.execute(
      sql`select id from oauth_resources where identifier = ${fixture.platform.adminResource} for update nowait`,
    );
  });
  await held;
  const request = run();
  try {
    const deadline = Date.now() + 1500;
    while (true) {
      const blocked = await runtime.db.execute(
        sql`select pid from pg_stat_activity where usename = ${role} and ${pid} = any(pg_blocking_pids(pid))`,
      );
      if (blocked.rows.length) break;
      if (Date.now() > deadline)
        throw new Error("Resource command did not reach the platform lock");
      await Bun.sleep(10);
    }
  } finally {
    release();
    await blocker;
  }
  const response = await request;
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    code: "last_platform_administrator",
  });
  expect(await snapshot()).toEqual(before);
});

test("unrelated organisation disable and resource scopes do not wait for the platform lock", async () => {
  const resource = "https://tenant-resource.example.com";
  await fixture.db
    .insert(oauthResources)
    .values({
      id: createId(),
      identifier: resource,
      name: "Tenant resource",
      allowedScopes: ["read", "write"],
    });
  const patch = await resourcePatch(resource, ["read"]);
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocker = fixture.db.transaction(async (tx) => {
    await tx.execute(
      sql`select id from organizations where id = ${fixture.platform.organizationId} for update`,
    );
    entered();
    await resume;
  });
  await held;
  try {
    expect((await patch()).status).toBe(200);
    const headers = fixture.headers("root");
    headers.set("Idempotency-Key", crypto.randomUUID());
    expect(
      (
        await app.request(
          `/api/admin/v1/organizations/${fixture.tenant.organizationId}/disable`,
          { method: "POST", headers },
        )
      ).status,
    ).toBe(200);
  } finally {
    release();
    await blocker;
  }
});

test("an already disabled platform organisation remains recoverable", async () => {
  await fixture.db
    .update(organizations)
    .set({ status: "disabled", disabledAt: new Date() })
    .where(eq(organizations.id, fixture.platform.organizationId));
  expect(
    await hasPlatformWriter(runtime.db, {
      resource: fixture.platform.adminResource,
    }),
  ).toBe(false);
  const headers = fixture.headers("root");
  headers.set("Idempotency-Key", crypto.randomUUID());
  const response = await app.request(
    `/api/admin/v1/organizations/${fixture.platform.organizationId}/enable`,
    { method: "POST", headers },
  );
  expect(response.status).toBe(200);
  expect(
    await hasPlatformWriter(runtime.db, {
      resource: fixture.platform.adminResource,
    }),
  ).toBe(true);
});
