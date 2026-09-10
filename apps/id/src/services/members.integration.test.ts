import { platformWriteService } from "../__tests__/platform-context.ts";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { testEnvironment } from "../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import { createOrganization } from "../__tests__/organization-queries.ts";
import { createId } from "../lib/id.ts";
import {
  users,
  members,
  sessions,
  grantContexts,
  oauthResources,
} from "../db/schema/index.ts";
let connection: DatabaseConnection;
beforeAll(() => {
  connection = createDatabase(testEnvironment());
});
beforeEach(async () => {
  await connection.db.execute(
    sql`truncate table security_identifiers, audit_events, organizations, users cascade`,
  );
});
afterAll(async () => {
  await connection.close();
});
async function seed() {
  const db = connection.db;
  const org = await createOrganization(db, { slug: "alpha", name: "Alpha" });
  const other = await createOrganization(db, { slug: "beta", name: "Beta" });
  const ids: string[] = [];
  for (const [index, organizationId] of [org.id, org.id, other.id].entries()) {
    const userId = createId();
    const id = createId();
    await db.insert(users).values({
      id: userId,
      email: `person${index}@example.com`,
      name: `Person ${index}`,
      status: "active",
    });
    await db.insert(members).values({ id, organizationId, userId });
    ids.push(id);
  }
  return { db, org, other, ids };
}
const past = new Date("2000-01-01T00:00:00Z");
const future = new Date("2100-01-01T00:00:00Z");
import {
  auditEvents,
  entitlements,
  groupMembers,
  oauthClients,
} from "../db/schema/index.ts";
import type { Actor } from "./actor.ts";
import { mapDatabaseError } from "../http/problem.ts";
const actor: Actor = {
  actorType: "system",
  actorId: "root",
  requestId: "service-test",
  ip: "192.0.2.1",
  userAgent: "test",
};
const invalidActor = { ...actor, requestId: "\0" };
async function mapped(promise: Promise<unknown>, status: number, code: string) {
  try {
    await promise;
    throw new Error("Expected a database error");
  } catch (error) {
    expect(mapDatabaseError(error)).toMatchObject({ status, code });
  }
}
async function grant(
  organizationId: string,
  principal: { groupId: string } | { memberId: string },
) {
  const db = connection.db;
  const clientId = createId();
  await db
    .insert(oauthClients)
    .values({ id: createId(), clientId, organizationId, redirectUris: [] });
  const id = createId();
  await db
    .insert(entitlements)
    .values({ id, organizationId, clientId, scopes: ["read"], ...principal });
  return id;
}
import * as memberService from "./members.ts";
import {
  type TenantMemberContext,
  type TenantReadContext,
} from "./tenant-context.ts";
import type { Database, Executor } from "../db/client.ts";
import { inTenant, inTenantRead } from "../__tests__/tenant-command.ts";
const service = {
  ...memberService,
  getMember: (db: Database, org: string, id: string) =>
    inTenantRead(db, org, "directory", (context) =>
      memberService.getMember(context, id),
    ),
  listMembers: (
    db: Database,
    org: string,
    query: Parameters<typeof memberService.listMembers>[1],
  ) =>
    inTenantRead(db, org, "directory", (context) =>
      memberService.listMembers(context, query),
    ),
  updateWindow: (
    db: Executor,
    actor: Actor,
    org: string,
    memberId: string,
    patch: Parameters<typeof memberService.updateWindow>[2],
    expected?: Parameters<typeof memberService.updateWindow>[3],
  ) =>
    inTenant(
      db,
      org,
      (context) =>
        memberService.updateWindow(context, memberId, patch, expected),
      actor,
    ),
  remove: (db: Executor, actor: Actor, org: string, memberId: string) =>
    inTenant(
      db,
      org,
      (context) => memberService.remove(context, memberId),
      actor,
    ),
  reinstate: (db: Executor, actor: Actor, org: string, memberId: string) =>
    inTenant(
      db,
      org,
      (context) => memberService.reinstate(context, memberId),
      actor,
    ),
};

test("member writes reject copied contexts and contexts after callback success or failure", async () => {
  const { db, org, ids } = await seed();
  let escaped!: TenantMemberContext;
  await inTenant(db, org.id, async (context) => {
    escaped = context;
    const copied = { ...context };
    await expect(memberService.remove(copied, ids[0]!)).rejects.toThrow(
      "Invalid or expired",
    );
    await expect(
      memberService.updateWindow(copied, ids[0]!, {}),
    ).rejects.toThrow("Invalid or expired");
    await expect(memberService.reinstate(copied, ids[0]!)).rejects.toThrow(
      "Invalid or expired",
    );
  });
  await expect(memberService.remove(escaped, ids[0]!)).rejects.toThrow(
    "Invalid or expired",
  );
  await expect(
    inTenant(db, org.id, async (context) => {
      escaped = context;
      throw new Error("callback failed");
    }),
  ).rejects.toThrow("callback failed");
  await expect(memberService.reinstate(escaped, ids[0]!)).rejects.toThrow(
    "Invalid or expired",
  );
  expect((await service.getMember(db, org.id, ids[0]!)).membershipStatus).toBe(
    "active",
  );
});
import { createGroup, addGroupMember } from "../__tests__/group-queries.ts";
test("member windows and removal audit, cascade grants and memberships, and retain users", async () => {
  const { db, org, ids } = await seed();
  const row = await service.getMember(db, org.id, ids[0]!);
  expect((await service.listMembers(db, org.id, { limit: 1 })).nextCursor).toBe(
    ids[1]!,
  );
  expect(
    await service.updateWindow(db, actor, org.id, ids[0]!, {
      validFrom: past,
      validUntil: future,
    }),
  ).toMatchObject({ effective: true });
  const group = await createGroup(db, {
    organizationId: org.id,
    slug: "team",
    name: "Team",
  });
  await addGroupMember(db, {
    organizationId: org.id,
    groupId: group.id,
    memberId: ids[0]!,
  });
  const grantId = await grant(org.id, { memberId: ids[0]! });
  await service.remove(db, actor, org.id, ids[0]!);
  expect(await db.select().from(groupMembers)).toEqual([]);
  expect(
    await db.select().from(entitlements).where(eq(entitlements.id, grantId)),
  ).toEqual([]);
  expect(
    await db.select().from(users).where(eq(users.id, row.userId)),
  ).toHaveLength(1);
  const events = await db.select().from(auditEvents).orderBy(auditEvents.id);
  expect(events).toHaveLength(2);
  for (const event of events)
    expect(event).toMatchObject({
      ...actor,
      organizationId: org.id,
      targetType: "member",
      targetId: ids[0],
      outcome: "success",
    });
  expect(events[0]).toMatchObject({
    action: "member.updated",
    data: {
      changes: {
        validFrom: past.toISOString(),
        validUntil: future.toISOString(),
      },
    },
  });
  expect(events[1]).toMatchObject({
    action: "member.removed",
    data: { userId: row.userId },
  });
});
test("member missing rows, CHECK failures and audit failures leave no writes", async () => {
  const { db, org, other, ids } = await seed();
  for (const organizationId of [other.id, createId()]) {
    await expect(
      service.getMember(db, organizationId, ids[0]!),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.updateWindow(db, actor, organizationId, ids[0]!, {
        validUntil: null,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.remove(db, actor, organizationId, ids[0]!),
    ).rejects.toMatchObject({ status: 404 });
  }
  await expect(
    service.listMembers(db, createId(), { limit: 1 }),
  ).rejects.toMatchObject({ status: 404 });
  await mapped(
    service.updateWindow(db, actor, org.id, ids[0]!, {
      validFrom: future,
      validUntil: past,
    }),
    400,
    "constraint_violation",
  );
  await expect(
    service.updateWindow(db, invalidActor, org.id, ids[0]!, {
      validUntil: past,
    }),
  ).rejects.toThrow();
  await expect(
    service.remove(db, invalidActor, org.id, ids[0]!),
  ).rejects.toThrow();
  expect(await service.getMember(db, org.id, ids[0]!)).toMatchObject({
    validUntil: null,
  });
  expect(await db.select().from(auditEvents)).toEqual([]);
});

test("revocation retains identity, denies tenant A, preserves tenant B and requires explicit reinstatement", async () => {
  const { db, org, other, ids } = await seed();
  const original = await service.getMember(db, org.id, ids[0]!);
  const otherMember = createId();
  await db.insert(members).values({
    id: otherMember,
    organizationId: other.id,
    userId: original.userId,
  });
  const aGrant = await grant(org.id, { memberId: original.id });
  await grant(other.id, { memberId: otherMember });
  const [assignment] = await db
    .select()
    .from(entitlements)
    .where(eq(entitlements.id, aGrant));
  const group = await createGroup(db, {
    organizationId: org.id,
    slug: "offboard",
    name: "Offboard",
  });
  await addGroupMember(db, {
    organizationId: org.id,
    memberId: original.id,
    groupId: group.id,
  });
  const queries = await import("../db/queries/access.ts");
  const memberAccess = (
    db: import("../db/client.ts").Database,
    organizationId: string,
    memberId: string,
  ) =>
    inTenantRead(db, organizationId, "memberAccess", (context) =>
      queries.memberAccess(context, memberId),
    );
  const beforeB = await memberAccess(db, other.id, otherMember);
  await service.remove(db, actor, org.id, original.id);
  const revoked = await service.getMember(db, org.id, original.id);
  expect(revoked).toMatchObject({
    id: original.id,
    userId: original.userId,
    membershipStatus: "revoked",
    effective: false,
  });
  expect(revoked.revokedAt).toBeInstanceOf(Date);
  expect(await memberAccess(db, org.id, original.id)).toEqual({
    effective: false,
    targets: [],
  });
  expect(await memberAccess(db, other.id, otherMember)).toEqual(beforeB);
  const { putMember } = await import("./groups.ts");
  await expect(
    platformWriteService(putMember)(
      db,
      actor,
      org.id,
      group.id,
      original.id,
      {},
    ),
  ).rejects.toMatchObject({ code: "membership_revoked" });
  const { createEntitlement } = await import("./entitlements.ts");
  await expect(
    platformWriteService(createEntitlement)(db, actor, org.id, {
      memberId: original.id,
      clientId: assignment!.clientId!,
      scopes: ["read"],
    }),
  ).rejects.toMatchObject({ code: "membership_revoked" });
  await service.remove(db, actor, org.id, original.id);
  expect((await service.getMember(db, org.id, original.id)).revokedAt).toEqual(
    revoked.revokedAt,
  );
  await expect(
    service.reinstate(db, invalidActor, org.id, original.id),
  ).rejects.toThrow();
  expect(
    (await service.getMember(db, org.id, original.id)).membershipStatus,
  ).toBe("revoked");
  expect(await service.reinstate(db, actor, org.id, original.id)).toMatchObject(
    { membershipStatus: "active", revokedAt: null, groups: [] },
  );
  expect(await memberAccess(db, org.id, original.id)).toEqual({
    effective: true,
    targets: [],
  });
  await service.reinstate(db, actor, org.id, original.id);
  const evidence = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.action, "member.removed"));
  expect(evidence[0]!.data).toMatchObject({
    effects: {
      removedGrants: [{ id: aGrant }],
      removedGroups: [{ groupId: group.id }],
    },
  });
  await expect(
    service.reinstate(db, actor, other.id, original.id),
  ).rejects.toMatchObject({ status: 404 });
  for (const patch of [
    { id: createId() },
    { organizationId: other.id },
    { userId: createId() },
  ])
    await expect(
      db
        .update(members)
        .set(patch)
        .where(eq(members.id, original.id))
        .execute(),
    ).rejects.toThrow();
});

test("member readers enforce context provenance, lifetime and projection permission", async () => {
  const { db, org, ids } = await seed();
  let escaped!: TenantReadContext<"directory">;
  await inTenantRead(db, org.id, "directory", async (context) => {
    escaped = context;
    expect((await memberService.getMember(context, ids[0]!)).id).toBe(ids[0]!);
    await expect(
      memberService.getMember({ ...context }, ids[0]!),
    ).rejects.toThrow("Invalid or expired");
    await expect(
      memberService.listMembers({ ...context }, { limit: 1 }),
    ).rejects.toThrow("Invalid or expired");
    // A TypeScript cast cannot turn a read permission into member administration.
    await expect(
      memberService.remove(context as unknown as TenantMemberContext, ids[0]!),
    ).rejects.toThrow("Invalid or expired");
    await expect(
      memberService.getMemberConfiguration(
        context as unknown as TenantMemberContext,
        ids[0]!,
      ),
    ).rejects.toThrow("Invalid or expired");
  });
  await expect(memberService.getMember(escaped, ids[0]!)).rejects.toThrow(
    "Invalid or expired",
  );
  await expect(
    inTenantRead(db, org.id, "directory", async (context) => {
      escaped = context;
      throw new Error("read failed");
    }),
  ).rejects.toThrow("read failed");
  await expect(
    memberService.listMembers(escaped, { limit: 1 }),
  ).rejects.toThrow("Invalid or expired");
  let configuration!: TenantReadContext<"configuration">;
  await inTenantRead(db, org.id, "configuration", async (context) => {
    configuration = context;
    const row = await memberService.getMemberConfiguration(context, ids[0]!);
    expect(row.id).toBe(ids[0]!);
    expect(row).not.toHaveProperty("email");
    await expect(
      memberService.getMember(
        context as unknown as TenantReadContext<"directory">,
        ids[0]!,
      ),
    ).rejects.toThrow("Invalid or expired");
    await expect(
      memberService.getMemberConfiguration({ ...context }, ids[0]!),
    ).rejects.toThrow("Invalid or expired");
  });
  await expect(
    memberService.getMemberConfiguration(configuration, ids[0]!),
  ).rejects.toThrow("Invalid or expired");
  await expect(
    inTenantRead(db, createId(), "configuration", async (context) =>
      memberService.getMemberConfiguration(context, ids[0]!),
    ),
  ).rejects.toMatchObject({ status: 404 });
});

test("tenant actor is immutable and the command runner cannot be reused", async () => {
  const { db, org, ids } = await seed();
  const { authorizeTenantMemberCommand } = await import("./tenant-context.ts");
  const principal: import("../http/principal.ts").Principal = {
    type: "root",
    grants: [],
  };
  const metadata = {
    ...actor,
    actorType: "user" as const,
    actorId: createId(),
  };
  await db.transaction(async (tx) => {
    const authority = await authorizeTenantMemberCommand(tx, {
      principal,
      organizationId: org.id,
      environment: testEnvironment({
        rootAdminSecret: "test",
        rootAdminBreakGlass: true,
      }),
    });
    Object.assign(principal, { type: "user", userId: createId() });
    try {
      await authority.run(async (context) => {
        expect(context.actor).toMatchObject({
          actorType: "system",
          actorId: "root",
          requestId: actor.requestId,
        });
        expect(Object.isFrozen(context.actor)).toBe(true);
        expect(() =>
          Object.assign(context.actor, { actorId: "forged" }),
        ).toThrow();
        metadata.requestId = "changed";
        await expect(authority.run(async () => {}, metadata)).rejects.toThrow(
          "Invalid or expired",
        );
        await memberService.remove(context, ids[0]!);
      }, metadata);
    } finally {
      authority.close();
    }
    await expect(authority.run(async () => {}, metadata)).rejects.toThrow(
      "Invalid or expired",
    );
  });
  expect(await db.select().from(auditEvents)).toMatchObject([
    {
      actorType: "system",
      actorId: "root",
      requestId: actor.requestId,
      organizationId: org.id,
      targetId: ids[0],
    },
  ]);
});

async function seedUserGrants() {
  const state = await seed();
  const { db, org, other, ids } = state;
  const [member] = await db
    .select()
    .from(members)
    .where(eq(members.id, ids[0]!));
  const otherMemberId = createId();
  await db.insert(members).values({
    id: otherMemberId,
    organizationId: other.id,
    userId: member!.userId,
  });
  const authTime = new Date();
  const sessionId = createId();
  await db.insert(sessions).values({
    id: sessionId,
    userId: member!.userId,
    token: createId(),
    createdAt: authTime,
    expiresAt: new Date(Date.now() + 60000),
  });
  const clientInstanceId = createId();
  const clientId = createId();
  await db.insert(oauthClients).values({
    id: clientInstanceId,
    clientId,
    organizationId: org.id,
    redirectUris: [],
    scopes: ["read"],
  });
  const resourceInstanceId = createId();
  const resource = `https://${createId()}.example`;
  await db.insert(oauthResources).values({
    id: resourceInstanceId,
    identifier: resource,
    name: "Shared",
    allowedScopes: ["read"],
  });
  const a = createId(),
    b = createId(),
    alreadyRevoked = createId();
  for (const input of [
    { id: a, organizationId: org.id, memberId: member!.id },
    {
      id: alreadyRevoked,
      organizationId: org.id,
      memberId: member!.id,
      revokedAt: authTime,
    },
    { id: b, organizationId: other.id, memberId: otherMemberId },
  ]) {
    await db.insert(grantContexts).values({
      ...input,
      userId: member!.userId,
      clientInstanceId,
      resourceInstanceId,
      authenticationSessionId: sessionId,
      authTime,
      requestedScopes: ["read"],
      expiresAt: new Date(Date.now() + 60000),
    });
  }
  return { ...state, a, b, alreadyRevoked, authTime };
}

test("member removal irreversibly revokes its grant contexts and audits only newly changed IDs", async () => {
  const { db, org, ids, a, b, alreadyRevoked, authTime } =
    await seedUserGrants();
  expect(await service.remove(db, actor, org.id, ids[0]!)).toBe("applied");
  const [revoked] = await db
    .select()
    .from(grantContexts)
    .where(eq(grantContexts.id, a));
  expect(revoked!.revokedAt).toBeInstanceOf(Date);
  const [previous] = await db
    .select()
    .from(grantContexts)
    .where(eq(grantContexts.id, alreadyRevoked));
  expect(previous!.revokedAt).toEqual(authTime);
  const [event] = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.action, "member.removed"));
  expect(event!.data).toMatchObject({
    effects: { revokedGrantContexts: [{ id: a }] },
  });
  expect(
    (
      await db
        .select({ revokedAt: grantContexts.revokedAt })
        .from(grantContexts)
        .where(eq(grantContexts.id, b))
    )[0]!.revokedAt,
  ).toBeNull();
  await service.reinstate(db, actor, org.id, ids[0]!);
  expect(
    (
      await db
        .select({ revokedAt: grantContexts.revokedAt })
        .from(grantContexts)
        .where(eq(grantContexts.id, a))
    )[0]!.revokedAt,
  ).not.toBeNull();
  expect(
    (
      await db
        .select({ revokedAt: grantContexts.revokedAt })
        .from(grantContexts)
        .where(eq(grantContexts.id, b))
    )[0]!.revokedAt,
  ).toBeNull();
  await service.remove(db, actor, org.id, ids[0]!);
  expect(await service.remove(db, actor, org.id, ids[0]!)).toBe("noop");
  const [noop] = await db
    .select()
    .from(auditEvents)
    .where(eq(auditEvents.action, "member.removal_unchanged"));
  expect(noop!.data).toMatchObject({ effects: { revokedGrantContexts: [] } });
});

test("failed member audit rolls back grant revocation with membership state", async () => {
  const { db, org, ids, a, b } = await seedUserGrants();
  await expect(
    service.remove(db, invalidActor, org.id, ids[0]!),
  ).rejects.toThrow();
  expect(
    (
      await db
        .select({ revokedAt: grantContexts.revokedAt })
        .from(grantContexts)
        .where(eq(grantContexts.id, a))
    )[0]!.revokedAt,
  ).toBeNull();
  expect(
    (
      await db
        .select({ revokedAt: grantContexts.revokedAt })
        .from(grantContexts)
        .where(eq(grantContexts.id, b))
    )[0]!.revokedAt,
  ).toBeNull();
  expect(
    await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "member.removed")),
  ).toHaveLength(0);
  expect(await service.remove(db, actor, org.id, ids[0]!)).toBe("applied");
  expect(
    (
      await db
        .select({ revokedAt: grantContexts.revokedAt })
        .from(grantContexts)
        .where(eq(grantContexts.id, a))
    )[0]!.revokedAt,
  ).not.toBeNull();
});
