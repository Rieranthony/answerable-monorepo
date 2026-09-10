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
  members,
  users,
} from "../../db/schema/index.ts";
import { createId } from "../../lib/id.ts";
import { signInThroughIdp } from "../../__tests__/federation.ts";
import {
  accounts,
  sessions,
  groups,
  groupMembers,
  entitlements,
  oauthClients,
  oauthResources,
  oauthClientResources,
  oauthConsents,
  organizationDomains,
  ssoProviders,
} from "../../db/schema/index.ts";

let fixture: AdminFixture;
let runtime: DatabaseConnection;
let app: ReturnType<typeof createApp>;
let role: string;
beforeEach(async () => {
  fixture = await createAdminFixture();
  role = `id_test_soft_delete_${crypto.randomUUID().replaceAll("-", "")}`;
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
    databasePoolMax: 3,
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
function request(path: string, method = "GET", key = createId()) {
  const headers = fixture.headers("root");
  headers.set("Idempotency-Key", key);
  return app.request(`/api/admin/v1${path}`, { method, headers });
}

test("user deletion retains identity, hides ordinary reads and cannot be enabled; replay keeps one transition", async () => {
  const person = fixture.principals.tenantReader;
  const before = (
    await fixture.db.select().from(users).where(eq(users.id, person.userId))
  )[0]!;
  const key = createId();
  const path = `/users/${person.userId}?confirm=${person.userId}`;
  const deleted = await request(path, "DELETE", key);
  expect(deleted.status).toBe(204);
  const retained = await fixture.db.execute(
    sql`select to_jsonb(u) as row from users u where id = ${person.userId}::uuid`,
  );
  expect(retained.rows).toHaveLength(1);
  expect(retained.rows[0]!.row).toMatchObject({
    id: person.userId,
    name: before.name,
    status: "disabled",
  });
  expect(
    (retained.rows[0]!.row as Record<string, unknown>).deleted_at,
  ).toBeTruthy();
  expect((await request(`/users/${person.userId}`)).status).toBe(404);
  expect((await request(`/users/${person.userId}/enable`, "POST")).status).toBe(
    404,
  );
  const replay = await request(path, "DELETE", key);
  expect(replay.status).toBe(204);
  expect(replay.headers.get("Idempotency-Replayed")).toBe("true");
  const operationId = deleted.headers.get("Operation-Id")!;
  expect(
    await fixture.db
      .select()
      .from(adminOperations)
      .where(eq(adminOperations.id, operationId)),
  ).toHaveLength(1);
  expect(
    await fixture.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.operationId, operationId)),
  ).toHaveLength(1);
  expect((await request(`/users/${person.userId}/audit-events`)).status).toBe(
    200,
  );
  const [profile] = await fixture.db
    .select()
    .from(users)
    .where(eq(users.id, person.userId));
  expect(profile!.retiredEmail).toBe(before.email);
  expect(profile!.email).toBe(`${person.userId}@retired.invalid`);
  expect(
    await fixture.db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, person.userId)),
  ).toEqual([]);
  expect(
    await fixture.db
      .select()
      .from(accounts)
      .where(eq(accounts.userId, person.userId)),
  ).toMatchObject([
    {
      deletedAt: expect.any(Date),
      accessToken: null,
      refreshToken: null,
      idToken: null,
      password: null,
    },
  ]);
  await expect(
    runtime.db
      .update(users)
      .set({ deletedAt: null })
      .where(eq(users.id, person.userId))
      .execute(),
  ).rejects.toThrow();
  await expect(
    runtime.db.delete(users).where(eq(users.id, person.userId)).execute(),
  ).rejects.toThrow();
  fixture.issuer.enqueue({
    sub: "tenantReader-subject",
    email: before.email,
    email_verified: true,
    name: before.name,
  });
  const signIn = await signInThroughIdp(app, {
    providerId: fixture.tenant.slug,
    callbackURL: `${fixture.trustedOrigin}/callback`,
    errorCallbackURL: `${fixture.trustedOrigin}/error`,
  });
  expect(signIn.location).toContain("user_disabled");
  expect(
    await fixture.db
      .select()
      .from(users)
      .where(eq(users.retiredEmail, before.email)),
  ).toHaveLength(1);
});

test("membership removal remains reversible but deleting its organisation is terminal and preserves the other tenant", async () => {
  const person = fixture.principals.tenantReader;
  const otherId = createId();
  await fixture.db
    .insert(members)
    .values({
      id: otherId,
      userId: person.userId,
      organizationId: fixture.outsider.organizationId,
    });
  const path = `/organizations/${fixture.tenant.organizationId}/members/${person.memberId}`;
  expect((await request(path, "DELETE")).status).toBe(204);
  expect((await request(`${path}/reinstate`, "POST")).status).toBe(200);
  const row = (
    await fixture.db
      .select()
      .from(members)
      .where(eq(members.id, person.memberId))
  )[0]!;
  expect(row.status).toBe("active");
  const org = fixture.tenant.organizationId;
  expect(
    (await request(`/organizations/${org}?confirm=${org}`, "DELETE")).status,
  ).toBe(204);
  const retained = await fixture.db.execute(
    sql`select to_jsonb(m) as row from members m where id = ${person.memberId}::uuid`,
  );
  expect(retained.rows).toHaveLength(1);
  expect(
    (retained.rows[0]!.row as Record<string, unknown>).deleted_at,
  ).toBeTruthy();
  expect((await request(`${path}/reinstate`, "POST")).status).toBe(404);
  expect(
    (await fixture.db.select().from(members).where(eq(members.id, otherId)))[0]!
      .status,
  ).toBe("active");
});

test("group deletion retains only newly retired assignment effects, denies reuse and keeps UUID history", async () => {
  const organizationId = fixture.tenant.organizationId;
  const person = fixture.principals.tenantReader;
  const id = createId();
  const assignmentId = createId();
  const entitlementId = createId();
  await fixture.db
    .insert(groups)
    .values({
      id,
      organizationId,
      slug: "retained-team",
      name: "Retained team",
    });
  await fixture.db
    .insert(groupMembers)
    .values({
      id: assignmentId,
      organizationId,
      groupId: id,
      memberId: person.memberId,
    });
  await fixture.db
    .insert(entitlements)
    .values({
      id: entitlementId,
      organizationId,
      groupId: id,
      resource: fixture.environment.adminResourceIdentifier,
      scopes: ["org:read"],
    });
  const path = `/organizations/${organizationId}/groups/${id}`;
  const response = await request(`${path}?confirm=${id}`, "DELETE");
  expect(response.status).toBe(204);
  expect((await request(path)).status).toBe(404);
  expect((await request(`${path}/enable`, "POST")).status).toBe(404);
  expect(
    (await fixture.db.select().from(groups).where(eq(groups.id, id)))[0],
  ).toMatchObject({ status: "disabled", deletedAt: expect.any(Date) });
  expect(
    (
      await fixture.db
        .select()
        .from(groupMembers)
        .where(eq(groupMembers.id, assignmentId))
    )[0],
  ).toMatchObject({ deletedAt: expect.any(Date) });
  expect(
    (
      await fixture.db
        .select()
        .from(entitlements)
        .where(eq(entitlements.id, entitlementId))
    )[0],
  ).toMatchObject({ status: "disabled", deletedAt: expect.any(Date) });
  await expect(
    fixture.db
      .update(groups)
      .set({ status: "active" })
      .where(eq(groups.id, id))
      .execute(),
  ).rejects.toThrow();
  await expect(
    fixture.db
      .insert(groupMembers)
      .values({
        id: createId(),
        organizationId,
        groupId: id,
        memberId: person.memberId,
      })
      .execute(),
  ).rejects.toThrow();
  const [event] = await fixture.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.operationId, response.headers.get("Operation-Id")!));
  expect(event).toMatchObject({
    schemaVersion: 3,
    data: {
      deletionMode: "soft",
      after: { id, deletedAt: expect.any(String) },
      effects: {
        softDeletedAssignments: [
          { id: assignmentId, deletedAt: expect.any(String) },
        ],
        softDeletedEntitlements: [
          { id: entitlementId, deletedAt: expect.any(String) },
        ],
      },
    },
  });
  const history = await request(`/users/${person.userId}/audit-events`);
  expect(
    (await history.json()).items.map((row: { id: string }) => row.id),
  ).toContain(event!.id);
});

test("unlink and explicit relink allocate a new relationship; client deletion retains registration and consent without credentials", async () => {
  const clientId = `retained-${createId()}`;
  const resourceId = `https://retained.example/${createId()}`;
  const linkId = createId();
  const consentId = createId();
  await fixture.db
    .insert(oauthClients)
    .values({
      id: createId(),
      clientId,
      organizationId: fixture.tenant.organizationId,
      clientSecret: "retired-test-digest",
      redirectUris: [],
    });
  await fixture.db
    .insert(oauthResources)
    .values({
      id: createId(),
      identifier: resourceId,
      name: "Retained resource",
      allowedScopes: ["read"],
    });
  await fixture.db
    .insert(oauthClientResources)
    .values({ id: linkId, clientId, resourceId });
  await fixture.db
    .insert(oauthConsents)
    .values({
      id: consentId,
      clientId,
      userId: fixture.principals.tenantReader.userId,
      scopes: ["read"],
    });
  const linkPath = `/clients/${clientId}/resources/${encodeURIComponent(resourceId)}`;
  const unlink = await request(linkPath, "DELETE");
  expect(unlink.status).toBe(204);
  const [unlinkEvent] = await fixture.db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.operationId, unlink.headers.get("Operation-Id")!));
  expect(unlinkEvent).toMatchObject({
    schemaVersion: 3,
    data: { relationship: { id: linkId, deletedAt: expect.any(String) } },
  });
  expect((await request(linkPath, "PUT")).status).toBe(201);
  const links = await fixture.db
    .select()
    .from(oauthClientResources)
    .where(eq(oauthClientResources.clientId, clientId));
  expect(links).toHaveLength(2);
  expect(links.find((row) => row.id === linkId)!.deletedAt).toBeInstanceOf(
    Date,
  );
  expect(links.find((row) => row.deletedAt === null)!.id).not.toBe(linkId);
  const result = await request(
    `/clients/${clientId}?confirm=${clientId}`,
    "DELETE",
  );
  expect(result.status).toBe(204);
  expect((await request(`/clients/${clientId}`)).status).toBe(404);
  const [client] = await fixture.db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId));
  expect(client).toMatchObject({
    disabled: true,
    clientSecret: null,
    deletedAt: expect.any(Date),
  });
  expect(
    (
      await fixture.db
        .select()
        .from(oauthConsents)
        .where(eq(oauthConsents.id, consentId))
    )[0]!.deletedAt,
  ).toBeInstanceOf(Date);
  const adapter = (await createAuth(runtime.db, fixture.environment).$context)
    .adapter;
  expect(
    await adapter.findOne({
      model: "oauthClient",
      where: [{ field: "clientId", value: clientId }],
    }),
  ).toBeNull();
  expect(
    await adapter.findMany({
      model: "oauthConsent",
      where: [{ field: "clientId", value: clientId }],
    }),
  ).toEqual([]);
  expect(
    await adapter.count({
      model: "oauthConsent",
      where: [{ field: "clientId", value: clientId }],
    }),
  ).toBe(0);
  await adapter.transaction(async (bound) => {
    expect(
      await bound.findOne({
        model: "oauthClient",
        where: [{ field: "clientId", value: clientId }],
      }),
    ).toBeNull();
    expect(
      await bound.count({
        model: "oauthConsent",
        where: [{ field: "clientId", value: clientId }],
      }),
    ).toBe(0);
  });
  await expect(
    fixture.db
      .insert(oauthClients)
      .values({ id: createId(), clientId, redirectUris: [] })
      .execute(),
  ).rejects.toThrow();
});

test("domain and provider deletion remove native discovery while retaining their identifiers", async () => {
  const organizationId = fixture.tenant.organizationId;
  const [provider] = await fixture.db
    .select()
    .from(ssoProviders)
    .where(eq(ssoProviders.organizationId, organizationId));
  const [domain] = await fixture.db
    .select()
    .from(organizationDomains)
    .where(eq(organizationDomains.organizationId, organizationId));
  expect(
    (await request(`/organizations/${organizationId}/sso-provider`, "DELETE"))
      .status,
  ).toBe(204);
  expect(
    (
      await request(
        `/organizations/${organizationId}/domains/${domain!.id}`,
        "DELETE",
      )
    ).status,
  ).toBe(204);
  expect(
    (
      await fixture.db
        .select()
        .from(ssoProviders)
        .where(eq(ssoProviders.id, provider!.id))
    )[0],
  ).toMatchObject({
    deletedAt: expect.any(Date),
    oidcConfig: null,
    samlConfig: null,
  });
  const adapter = (await createAuth(runtime.db, fixture.environment).$context)
    .adapter;
  expect(await adapter.findMany({ model: "ssoProvider" })).not.toContainEqual(
    expect.objectContaining({ id: provider!.id }),
  );
  expect(
    await adapter.findOne({
      model: "organizationDomain",
      where: [{ field: "id", value: domain!.id }],
    }),
  ).toBeNull();
  await expect(
    fixture.db
      .update(ssoProviders)
      .set({ deletedAt: null })
      .where(eq(ssoProviders.id, provider!.id))
      .execute(),
  ).rejects.toThrow();
});

import { inPlatformWrite } from "../../__tests__/platform-context.ts";
import {
  linkClientResource,
  unlinkClientResource,
} from "../../db/queries/oauth-clients.ts";
import { recordAuditEvent } from "../../db/queries/audit.ts";
import { auditEventSubjects } from "../../db/schema/index.ts";
import { assertRuntimeRole } from "../../db/runtime-role.ts";

test("live uniqueness permits repeated replacements at one database timestamp and rejects duplicate null principals", async () => {
  const clientId = fixture.platform.client.clientId;
  const resourceId = `https://replacement.example/${createId()}`;
  await fixture.db
    .insert(oauthResources)
    .values({ id: createId(), identifier: resourceId, name: "Replacement" });
  await inPlatformWrite(runtime.db, async (context) => {
    const retired = [];
    for (let index = 0; index < 3; index++) {
      expect(
        (await linkClientResource(context, clientId, resourceId)).created,
      ).toBe(true);
      retired.push(
        (await unlinkClientResource(context, clientId, resourceId))!,
      );
    }
    expect(new Set(retired.map((row) => row.id)).size).toBe(3);
    expect(new Set(retired.map((row) => row.deletedAt!.getTime())).size).toBe(
      1,
    );
    expect(
      (await linkClientResource(context, clientId, resourceId)).created,
    ).toBe(true);
    const input = {
      organizationId: fixture.tenant.organizationId,
      resource: resourceId,
      scopes: ["read"],
    };
    const [first] = await context.tx
      .insert(entitlements)
      .values({ ...input, id: createId() })
      .returning();
    await expect(
      context.tx.transaction((tx) =>
        tx.insert(entitlements).values({ ...input, id: createId() }),
      ),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
    await context.tx
      .update(entitlements)
      .set({ status: "disabled", deletedAt: sql`now()` })
      .where(eq(entitlements.id, first!.id));
    const [replacement] = await context.tx
      .insert(entitlements)
      .values({ ...input, id: createId() })
      .returning();
    expect(replacement!.id).not.toBe(first!.id);
  });
  const rows = await fixture.db
    .select()
    .from(oauthClientResources)
    .where(eq(oauthClientResources.resourceId, resourceId));
  expect(rows).toHaveLength(4);
  expect(rows.filter((row) => row.deletedAt === null)).toHaveLength(1);
});

test("parent deletion committed first denies a waiting SQL relationship creation", async () => {
  const organizationId = fixture.tenant.organizationId;
  const groupId = createId();
  await fixture.db
    .insert(groups)
    .values({
      id: groupId,
      organizationId,
      slug: groupId,
      name: "Retiring parent",
    });
  const held = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let parentPid = 0;
  const deletion = fixture.db.transaction(async (tx) => {
    await tx
      .update(groups)
      .set({ status: "disabled", deletedAt: sql`now()` })
      .where(eq(groups.id, groupId));
    parentPid = Number(
      (await tx.execute(sql`select pg_backend_pid() as pid`)).rows[0]!.pid,
    );
    held.resolve();
    await resume.promise;
  });
  await held.promise;
  const insertedId = createId();
  const creation = inPlatformWrite(runtime.db, (context) =>
    Promise.resolve(
      context.tx
        .insert(groupMembers)
        .values({
          id: insertedId,
          organizationId,
          groupId,
          memberId: fixture.principals.tenantReader.memberId,
        }),
    ),
  );
  const settled = creation.then(
    () => null,
    (error) => error,
  );
  try {
    const deadline = Date.now() + 2000;
    let blocked = false;
    while (Date.now() < deadline) {
      const waiting = await runtime.db.execute(
        sql`select 1 from pg_stat_activity where ${parentPid} = any(pg_blocking_pids(pid))`,
      );
      if (waiting.rows.length) {
        blocked = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(blocked).toBe(true);
  } finally {
    resume.resolve();
    await deletion;
  }
  expect(await settled).toMatchObject({ cause: { code: "23503" } });
  expect(
    await fixture.db
      .select()
      .from(groupMembers)
      .where(eq(groupMembers.id, insertedId)),
  ).toEqual([]);
});

test("startup refuses domain DELETE privileges even when audit permissions are protected", async () => {
  await fixture.db.execute(
    sql`grant delete on groups to ${sql.identifier(role)}`,
  );
  try {
    await expect(assertRuntimeRole(runtime.db)).rejects.toThrow(
      "Unsafe database runtime role",
    );
  } finally {
    await fixture.db.execute(
      sql`revoke delete on groups from ${sql.identifier(role)}`,
    );
  }
  await assertRuntimeRole(runtime.db);
});

for (const targetType of ["user", "organization", "group"] as const) {
  test(`${targetType} soft-deletion subjects require the complete new event envelope`, async () => {
    const id = createId(),
      userId = createId(),
      organizationId =
        targetType === "user"
          ? null
          : targetType === "organization"
            ? id
            : createId();
    const field =
      targetType === "user"
        ? "deletedAccessTokens"
        : targetType === "organization"
          ? "softDeletedMembers"
          : "softDeletedAssignments";
    const effect = { id: createId(), userId, organizationId, groupId: id };
    const data = {
      deletionMode: "soft",
      before: { id },
      after: { id, deletedAt: new Date().toISOString() },
      effects: { [field]: [effect] },
    };
    const base = {
      schemaVersion: 3 as const,
      actorType: "system" as const,
      actorId: "contract-test",
      organizationId,
      action: `${targetType}.erased`,
      targetType,
      targetId: id,
      outcome: "success" as const,
      data,
    };
    const valid = await recordAuditEvent(runtime.db, base);
    for (const patch of [
      { outcome: "failure" as const },
      { data: { ...data, deletionMode: "physical" } },
      { data: { ...data, after: { id } } },
      {
        data: {
          ...data,
          after: { id: createId(), deletedAt: data.after.deletedAt },
        },
      },
      { data: { ...data, effects: { [field]: effect } } },
    ])
      await recordAuditEvent(runtime.db, { ...base, ...patch });
    expect(
      await runtime.db
        .select()
        .from(auditEventSubjects)
        .where(eq(auditEventSubjects.entityId, userId)),
    ).toEqual([
      expect.objectContaining({
        eventId: valid.id,
        relationship: "affected",
        organizationId,
      }),
    ]);
  });
}
