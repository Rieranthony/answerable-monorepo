import { organizationCapabilities, systemBindings } from "../schema/index.ts";
import { hasPlatformWriter } from "./grants.ts";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { testEnvironment } from "../../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../client.ts";
import { createOrganization } from "../../__tests__/organization-queries.ts";
import { createId } from "../../lib/id.ts";
import {
  users,
  members,
  groups,
  groupMembers,
  organizations,
  entitlements,
  oauthClients,
  oauthResources,
} from "../schema/index.ts";
import { createGroup, addGroupMember } from "../../__tests__/group-queries.ts";
import { createEntitlement } from "../../__tests__/entitlement-queries.ts";
let connection: DatabaseConnection;
beforeAll(() => {
  connection = createDatabase(testEnvironment());
});
beforeEach(async () => {
  await connection.db.execute(
    sql`truncate table security_identifiers, audit_events, organizations, users, oauth_clients, oauth_resources cascade`,
  );
});
afterAll(async () => {
  await connection.close();
});
const past = new Date("2000-01-01T00:00:00Z");
const future = new Date("2100-01-01T00:00:00Z");
async function seed() {
  const db = connection.db;
  const org = await createOrganization(db, { slug: "alpha", name: "Alpha" });
  const other = await createOrganization(db, { slug: "beta", name: "Beta" });
  const ids: string[] = [];
  for (const [index, organizationId] of [
    org.id,
    org.id,
    org.id,
    other.id,
  ].entries()) {
    const userId = createId();
    const id = createId();
    await db.insert(users).values({
      id: userId,
      email: `person${index}@example.com`,
      name: `Person ${index}`,
      status: "active",
    });
    await db.insert(members).values({
      id,
      organizationId,
      userId,
      validUntil: index === 2 ? past : null,
    });
    ids.push(id);
  }
  const group = await createGroup(db, {
    organizationId: org.id,
    slug: "team",
    name: "Team",
  });
  const foreignGroup = await createGroup(db, {
    organizationId: other.id,
    slug: "team",
    name: "Team",
  });
  await addGroupMember(db, {
    organizationId: org.id,
    groupId: group.id,
    memberId: ids[0]!,
  });
  const resource = "https://tutor.example";
  const clientId = "test-client";
  await db.insert(oauthResources).values({
    id: createId(),
    identifier: resource,
    name: "Tutor",
    allowedScopes: ["read", "write", "admin"],
  });
  await db
    .insert(oauthClients)
    .values({ id: createId(), clientId, redirectUris: [], scopes: ["openid"] });
  return { db, org, other, ids, group, foreignGroup, resource, clientId };
}
import { effectiveGrants } from "./grants.ts";
import * as accessQueries from "./access.ts";
import { inTenantRead } from "../../__tests__/tenant-command.ts";
import type { Database } from "../client.ts";
const memberAccess = (db: Database, organizationId: string, memberId: string) =>
  inTenantRead(db, organizationId, "memberAccess", (context) =>
    accessQueries.memberAccess(context, memberId),
  );
const targetAccess = (
  db: Database,
  organizationId: string,
  target: accessQueries.AccessTarget,
  page: import("../../http/pagination.ts").PageQuery,
) =>
  inTenantRead(db, organizationId, "directory", (context) =>
    accessQueries.targetAccess(context, target, page),
  );
test("access projects assignment sources without granting unrelated resource rows administrator authority", async () => {
  const { db, org, other, group, ids, resource, clientId } = await seed();
  expect(await memberAccess(db, org.id, ids[0]!)).toEqual({
    effective: true,
    targets: [],
  });
  const common = { organizationId: org.id, resource };
  const a = await createEntitlement(db, { ...common, scopes: ["read"] });
  const b = await createEntitlement(db, {
    ...common,
    groupId: group.id,
    scopes: ["write", "read"],
  });
  const c = await createEntitlement(db, {
    ...common,
    memberId: ids[0]!,
    scopes: ["admin"],
  });
  const client = await createEntitlement(db, {
    organizationId: org.id,
    clientId,
    scopes: ["openid"],
  });
  const disabledGroup = await createGroup(db, {
    organizationId: org.id,
    slug: "disabled",
    name: "Disabled",
  });
  await db
    .update(groups)
    .set({ status: "disabled" })
    .where(eq(groups.id, disabledGroup.id));
  await addGroupMember(db, {
    organizationId: org.id,
    groupId: disabledGroup.id,
    memberId: ids[0]!,
  });
  await createEntitlement(db, {
    ...common,
    groupId: disabledGroup.id,
    scopes: ["excluded"],
  });
  const expiredGroup = await createGroup(db, {
    organizationId: org.id,
    slug: "expired",
    name: "Expired",
  });
  await db.insert(groupMembers).values({
    id: createId(),
    organizationId: org.id,
    groupId: expiredGroup.id,
    memberId: ids[0]!,
    validUntil: past,
  });
  await createEntitlement(db, {
    ...common,
    groupId: expiredGroup.id,
    scopes: ["excluded"],
  });
  for (const [slug, window] of [
    ["expired", { validUntil: past }],
    ["future", { validFrom: future }],
    ["disabled", { status: "disabled" as const }],
  ] as const) {
    const row = await createEntitlement(db, {
      organizationId: org.id,
      memberId: ids[0]!,
      clientId: (
        await db
          .insert(oauthClients)
          .values({ id: createId(), clientId: slug, redirectUris: [] })
          .returning()
      )[0]!.clientId,
      scopes: ["excluded"],
    });
    await db
      .update(entitlements)
      .set(window)
      .where(eq(entitlements.id, row.id));
  }
  await createEntitlement(db, {
    organizationId: other.id,
    resource,
    scopes: ["foreign"],
  });
  const [member] = await db
    .select()
    .from(members)
    .where(eq(members.id, ids[0]!));
  expect(
    await effectiveGrants(db, { userId: member!.userId }, resource),
  ).toEqual([]);
  for (const clientId of ["expired", "future", "disabled"]) {
    expect(await targetAccess(db, org.id, { clientId }, { limit: 10 })).toEqual(
      { items: [], nextCursor: null },
    );
  }
  const access = await memberAccess(db, org.id, ids[0]!);
  expect(access).toEqual({
    effective: true,
    targets: [
      {
        kind: "resource",
        id: resource,
        permission: { allowed: false, reason: "capability" },
        scopes: ["admin", "read", "write"],
        via: [
          { entitlementId: a.id, principal: "organization", groupId: null },
          { entitlementId: b.id, principal: "group", groupId: group.id },
          { entitlementId: c.id, principal: "member", groupId: null },
        ],
      },
      {
        kind: "client",
        id: clientId,
        permission: { allowed: false, reason: "context" },
        scopes: ["openid"],
        via: [
          {
            entitlementId: client.id,
            principal: "organization",
            groupId: null,
          },
        ],
      },
    ],
  });
  expect((await memberAccess(db, org.id, ids[1]!)).targets[0]!.scopes).toEqual([
    "read",
  ]);
  for (const memberId of [ids[2]!, ids[3]!, createId()])
    expect(await memberAccess(db, org.id, memberId)).toEqual({
      effective: false,
      targets: [],
    });
  expect(
    (await memberAccess(db, other.id, ids[3]!)).targets[0]!.scopes,
  ).toEqual(["foreign"]);
  const first = await targetAccess(db, org.id, { resource }, { limit: 1 });
  expect(first.items).toEqual([
    expect.objectContaining({
      memberId: ids[1],
      email: "person1@example.com",
      name: "Person 1",
      scopes: ["read"],
    }),
  ]);
  expect(first.nextCursor).toBe(ids[1]!);
  const second = await targetAccess(
    db,
    org.id,
    { resource },
    { limit: 1, cursor: first.nextCursor! },
  );
  expect(second.items[0]).toMatchObject({
    memberId: ids[0],
    scopes: ["admin", "read", "write"],
  });
  expect(second.nextCursor).toBeNull();
  expect(
    (await targetAccess(db, org.id, { clientId }, { limit: 10 })).items.map(
      (row) => row.memberId,
    ),
  ).toEqual([ids[1]!, ids[0]!]);
  expect(await targetAccess(db, other.id, { clientId }, { limit: 10 })).toEqual(
    { items: [], nextCursor: null },
  );
  await db
    .update(organizations)
    .set({ status: "disabled", disabledAt: new Date() })
    .where(eq(organizations.id, org.id));
  expect(await memberAccess(db, org.id, ids[0]!)).toEqual({
    effective: false,
    targets: [],
  });
  expect(await targetAccess(db, org.id, { resource }, { limit: 10 })).toEqual({
    items: [],
    nextCursor: null,
  });
});

test("exact pairs never union with client-only, resource-only, other pairs or another tenant", async () => {
  const { db, org, other, ids, resource, clientId, group } = await seed();
  const otherClient = createId();
  const otherResource = `https://${createId()}.example/resource`;
  await db
    .insert(oauthClients)
    .values({ id: createId(), clientId: otherClient, redirectUris: [] });
  await db
    .insert(oauthResources)
    .values({ id: createId(), identifier: otherResource, name: "Other" });
  const common = { organizationId: org.id };
  const pair = await createEntitlement(db, {
    ...common,
    clientId,
    resource,
    scopes: ["pair", "platform:write"],
  });
  await createEntitlement(db, {
    ...common,
    clientId,
    resource,
    memberId: ids[0]!,
    scopes: ["member"],
  });
  await createEntitlement(db, {
    ...common,
    clientId,
    resource,
    groupId: group.id,
    scopes: ["group"],
  });
  await createEntitlement(db, {
    ...common,
    clientId,
    resource: otherResource,
    scopes: ["other-resource"],
  });
  await createEntitlement(db, {
    ...common,
    clientId: otherClient,
    resource,
    scopes: ["other-client"],
  });
  await createEntitlement(db, { ...common, clientId, scopes: ["login"] });
  const direct = await createEntitlement(db, {
    ...common,
    resource,
    scopes: ["direct"],
  });
  await createEntitlement(db, {
    organizationId: other.id,
    clientId,
    resource,
    scopes: ["foreign"],
  });
  const view = await memberAccess(db, org.id, ids[0]!);
  expect(view.targets).toHaveLength(5);
  const paired = view.targets.find(
    (target) =>
      target.kind === "client_resource" &&
      target.id === clientId &&
      target.resource === resource,
  );
  expect(paired).toMatchObject({
    scopes: ["group", "member", "pair", "platform:write"],
    via: expect.arrayContaining([
      { entitlementId: pair.id, principal: "organization", groupId: null },
    ]),
  });
  const exact = await targetAccess(
    db,
    org.id,
    { clientId, resource },
    { limit: 10 },
  );
  expect(exact.items.find((item) => item.memberId === ids[0]!)?.scopes).toEqual(
    ["group", "member", "pair", "platform:write"],
  );
  expect(exact.items.some((item) => item.memberId === ids[3])).toBe(false);
  expect(
    (await targetAccess(db, org.id, { clientId }, { limit: 10 })).items[0]
      ?.scopes,
  ).toEqual(["login"]);
  expect(
    (await targetAccess(db, org.id, { resource }, { limit: 10 })).items[0]
      ?.scopes,
  ).toEqual(["direct"]);
  const [member] = await db
    .select()
    .from(members)
    .where(eq(members.id, ids[0]!));
  expect(
    (await effectiveGrants(db, { userId: member!.userId }, resource))[0]
      ?.scopes,
  ).toBeUndefined();
  const [row] = await db
    .select()
    .from(oauthResources)
    .where(eq(oauthResources.identifier, resource));
  await db.insert(systemBindings).values({
    name: "platform",
    organizationId: org.id,
    resourceId: row!.id,
    groupId: group.id,
  });
  await db
    .update(oauthResources)
    .set({ allowedScopes: ["direct", "platform:write"] })
    .where(eq(oauthResources.identifier, resource));
  await db.insert(organizationCapabilities).values({
    id: createId(),
    organizationId: org.id,
    resource,
    grantKind: "admin_session",
    scopes: ["direct", "platform:write"],
  });
  expect(
    (await effectiveGrants(db, { userId: member!.userId }, resource))[0]
      ?.scopes,
  ).toEqual(["direct"]);
  expect(await hasPlatformWriter(db, { resource })).toBe(false);
  await db
    .update(entitlements)
    .set({ scopes: ["platform:write"] })
    .where(eq(entitlements.id, direct.id));
  expect(await hasPlatformWriter(db, { resource })).toBe(true);
});

test("inactive global users disappear from every effective target projection", async () => {
  const { db, org, ids, resource, clientId } = await seed();
  const memberId = ids[0]!;
  const [member] = await db
    .select()
    .from(members)
    .where(eq(members.id, memberId));
  const targets = [{ clientId }, { resource }, { clientId, resource }];
  for (const target of targets)
    await createEntitlement(db, {
      organizationId: org.id,
      memberId,
      ...target,
      scopes: ["read"],
    });
  for (const status of ["active", "inert", "disabled", "active"] as const) {
    await db
      .update(users)
      .set({ status, disabledAt: status === "disabled" ? new Date() : null })
      .where(eq(users.id, member!.userId));
    const view = await memberAccess(db, org.id, memberId);
    expect(view.effective).toBe(status === "active");
    expect(view.targets).toHaveLength(status === "active" ? 3 : 0);
    for (const target of targets)
      expect(
        (await targetAccess(db, org.id, target, { limit: 10 })).items,
      ).toHaveLength(status === "active" ? 1 : 0);
  }
});

test("pair access distinguishes assigned scopes from current permission", async () => {
  const { db, org, ids, resource, clientId } = await seed();
  const memberId = ids[0]!;
  await createEntitlement(db, {
    organizationId: org.id,
    memberId,
    clientId,
    resource,
    scopes: ["read"],
  });
  const view = await memberAccess(db, org.id, memberId);
  expect(view.targets[0]).toMatchObject({
    kind: "client_resource",
    scopes: ["read"],
    permission: { allowed: false, reason: "context" },
  });
  const page = await targetAccess(
    db,
    org.id,
    { clientId, resource },
    { limit: 10 },
  );
  expect(page.items[0]).toMatchObject({
    memberId,
    scopes: ["read"],
    permission: { allowed: false, reason: "context" },
  });
});

test("pair diagnostics use live ceilings, endpoint state and tenant-local sources", async () => {
  const { db, org, other, ids, resource, clientId } = await seed();
  const { oauthClientResources } = await import("../schema/index.ts");
  const memberId = ids[0]!;
  await db
    .update(oauthClients)
    .set({
      scopes: ["openid", "read", "write"],
      grantTypes: ["authorization_code", "refresh_token"],
    })
    .where(eq(oauthClients.clientId, clientId));
  await db
    .insert(oauthClientResources)
    .values({ id: createId(), clientId, resourceId: resource });
  const login = await createEntitlement(db, {
    organizationId: org.id,
    clientId,
    scopes: ["openid"],
  });
  const pair = await createEntitlement(db, {
    organizationId: org.id,
    clientId,
    resource,
    scopes: ["read", "write"],
  });
  await createEntitlement(db, {
    organizationId: other.id,
    clientId,
    resource,
    scopes: ["read", "write"],
  });
  async function check(expected: object) {
    const view = await memberAccess(db, org.id, memberId);
    const paired = view.targets.find(
      (target) => target.kind === "client_resource",
    )!;
    expect(paired.scopes).toEqual(["read", "write"]);
    expect(paired.permission).toMatchObject(expected);
    const page = await targetAccess(
      db,
      org.id,
      { clientId, resource },
      { limit: 1 },
    );
    expect(page.items[0]?.permission).toMatchObject(expected);
    expect(page.nextCursor).not.toBeNull();
    const next = await targetAccess(
      db,
      org.id,
      { clientId, resource },
      { limit: 1, cursor: page.nextCursor! },
    );
    expect(next.items[0]?.permission).toMatchObject(expected);
    expect(next.nextCursor).toBeNull();
  }
  await check({ allowed: false, reason: "login" });
  const [loginCap] = await db
    .insert(organizationCapabilities)
    .values({
      id: createId(),
      organizationId: org.id,
      clientId,
      grantKind: "authorization_code",
      scopes: ["openid"],
    })
    .returning();
  await check({ allowed: false, reason: "capability" });
  const [pairCap] = await db
    .insert(organizationCapabilities)
    .values({
      id: createId(),
      organizationId: org.id,
      clientId,
      resource,
      grantKind: "authorization_code",
      scopes: ["read"],
    })
    .returning();
  const allowed = {
    allowed: true,
    scopes: ["read"],
    evidence: {
      policyVersion: 1,
      capabilities: [
        expect.objectContaining({ id: loginCap!.id }),
        expect.objectContaining({ id: pairCap!.id }),
      ],
      assignments: expect.arrayContaining([
        expect.objectContaining({ id: login.id }),
        expect.objectContaining({ id: pair.id }),
      ]),
    },
  };
  await check(allowed);
  const foreign = await memberAccess(db, other.id, ids[3]!);
  expect(foreign.targets[0]?.permission).toEqual({
    allowed: false,
    reason: "login",
  });
  for (const values of [
    { status: "disabled" as const },
    { status: "active" as const, validUntil: past },
    { validUntil: null, validFrom: future },
  ]) {
    await db
      .update(organizationCapabilities)
      .set(values)
      .where(eq(organizationCapabilities.id, pairCap!.id));
    await check({ allowed: false, reason: "capability" });
  }
  await db
    .update(organizationCapabilities)
    .set({ validFrom: null })
    .where(eq(organizationCapabilities.id, pairCap!.id));
  await check(allowed);
  await db
    .update(oauthResources)
    .set({ allowedScopes: ["write"] })
    .where(eq(oauthResources.identifier, resource));
  await check({ allowed: false, reason: "scope" });
  await db
    .update(oauthResources)
    .set({ allowedScopes: ["read", "write"], disabled: true })
    .where(eq(oauthResources.identifier, resource));
  await check({ allowed: false, reason: "context" });
  await db
    .update(oauthResources)
    .set({ disabled: false })
    .where(eq(oauthResources.identifier, resource));
  await db
    .update(oauthClients)
    .set({ disabled: true })
    .where(eq(oauthClients.clientId, clientId));
  await check({ allowed: false, reason: "context" });
  await db
    .update(oauthClients)
    .set({ disabled: false })
    .where(eq(oauthClients.clientId, clientId));
  await db
    .delete(oauthClientResources)
    .where(eq(oauthClientResources.clientId, clientId));
  await check({ allowed: false, reason: "context" });
});

test("single-target explanations deny registrations without approved admission", async () => {
  const { db, org, ids, clientId, resource } = await seed();
  for (const target of [{ clientId }, { resource }]) {
    await createEntitlement(db, {
      organizationId: org.id,
      memberId: ids[0]!,
      ...target,
      scopes: ["read"],
    });
    const page = await targetAccess(db, org.id, target, { limit: 10 });
    expect(page.items[0]?.permission).toEqual({
      allowed: false,
      reason: "clientId" in target ? "context" : "capability",
    });
  }
  const view = await memberAccess(db, org.id, ids[0]!);
  expect(view.targets.map((target) => target.permission)).toEqual([
    { allowed: false, reason: "context" },
    { allowed: false, reason: "capability" },
  ]);
});

test("client login explanations intersect only effective client-only sources", async () => {
  const { db, org, ids, clientId, resource, group } = await seed();
  const memberId = ids[0]!;
  const login = await createEntitlement(db, {
    organizationId: org.id,
    clientId,
    scopes: ["openid", "unapproved"],
  });
  const grouped = await createEntitlement(db, {
    organizationId: org.id,
    clientId,
    groupId: group.id,
    scopes: ["email"],
  });
  await createEntitlement(db, {
    organizationId: org.id,
    clientId,
    resource,
    scopes: ["read"],
  });
  await db.insert(organizationCapabilities).values({
    id: createId(),
    organizationId: org.id,
    clientId,
    resource,
    grantKind: "authorization_code",
    scopes: ["read"],
  });
  async function check(expected: object) {
    const view = await memberAccess(db, org.id, memberId);
    expect(
      view.targets.find((target) => target.kind === "client")!.permission,
    ).toMatchObject(expected);
    const page = await targetAccess(db, org.id, { clientId }, { limit: 10 });
    expect(
      page.items.find((item) => item.memberId === memberId)!.permission,
    ).toMatchObject(expected);
  }
  await check({ allowed: false, reason: "context" });
  await db
    .update(oauthClients)
    .set({
      grantTypes: ["authorization_code"],
      scopes: ["openid", "email", "read"],
    })
    .where(eq(oauthClients.clientId, clientId));
  await check({ allowed: false, reason: "login" });
  const [capability] = await db
    .insert(organizationCapabilities)
    .values({
      id: createId(),
      organizationId: org.id,
      clientId,
      grantKind: "authorization_code",
      scopes: ["openid"],
    })
    .returning();
  const [registered] = await db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId));
  const [subject] = await db
    .select()
    .from(members)
    .where(eq(members.id, memberId));
  await check({
    allowed: true,
    reason: "approved",
    grantType: "authorization_code",
    subjectType: "user",
    organization: {
      id: org.id,
      authorizationVersion: org.authorizationVersion,
    },
    subject: { userId: subject!.userId, memberId },
    client: {
      id: registered!.id,
      clientId,
      revision: registered!.revision,
      authorizationVersion: registered!.authorizationVersion,
      scopeCeiling: registered!.scopes,
    },
    resource: null,
    requestedScopes: null,
    scopes: ["openid"],
    evidence: {
      capabilities: [expect.objectContaining({ id: capability!.id })],
      assignments: [expect.objectContaining({ id: login.id })],
    },
  });
  await db
    .update(organizationCapabilities)
    .set({ scopes: ["openid", "email"] })
    .where(eq(organizationCapabilities.id, capability!.id));
  await check({
    allowed: true,
    scopes: ["email", "openid"],
    evidence: {
      assignments: [
        expect.objectContaining({ id: login.id }),
        expect.objectContaining({
          id: grouped.id,
          groupMembership: expect.objectContaining({ groupRevision: 1 }),
        }),
      ],
    },
  });
  await db
    .update(groupMembers)
    .set({ validUntil: past })
    .where(eq(groupMembers.groupId, group.id));
  await check({
    allowed: true,
    scopes: ["openid"],
    evidence: { assignments: [expect.objectContaining({ id: login.id })] },
  });
  for (const values of [
    { validUntil: past },
    { validUntil: null, validFrom: future },
    { validFrom: null, status: "disabled" as const },
  ]) {
    await db
      .update(organizationCapabilities)
      .set(values)
      .where(eq(organizationCapabilities.id, capability!.id));
    await check({ allowed: false, reason: "login" });
  }
  await db
    .update(organizationCapabilities)
    .set({ status: "active" })
    .where(eq(organizationCapabilities.id, capability!.id));
  await db
    .update(oauthClients)
    .set({ disabled: true })
    .where(eq(oauthClients.clientId, clientId));
  await check({ allowed: false, reason: "context" });
});

test("direct administrator explanations agree with actual grants and root writer detection", async () => {
  const { db, org, other, ids, resource, group } = await seed();
  const [endpoint] = await db
    .select()
    .from(oauthResources)
    .where(eq(oauthResources.identifier, resource));
  await db.insert(systemBindings).values({
    name: "platform",
    organizationId: org.id,
    resourceId: endpoint!.id,
    groupId: group.id,
  });
  const memberId = ids[0]!;
  const [member] = await db
    .select()
    .from(members)
    .where(eq(members.id, memberId));
  const common = await createEntitlement(db, {
    organizationId: org.id,
    resource,
    scopes: ["read"],
  });
  const grouped = await createEntitlement(db, {
    organizationId: org.id,
    resource,
    groupId: group.id,
    scopes: ["write", "platform:write"],
  });
  await createEntitlement(db, {
    organizationId: other.id,
    resource,
    scopes: ["platform:write"],
  });
  async function check(expected: {
    allowed: boolean;
    scopes?: string[];
    reason?: string;
  }) {
    const view = await memberAccess(db, org.id, memberId);
    const permission = view.targets[0]!.permission;
    expect(permission).toMatchObject(expected);
    const page = await targetAccess(db, org.id, { resource }, { limit: 10 });
    expect(
      page.items.find((item) => item.memberId === memberId)!.permission,
    ).toMatchObject(expected);
    const grants = await effectiveGrants(
      db,
      { userId: member!.userId },
      resource,
    );
    expect(grants.flatMap((grant) => grant.scopes)).toEqual(
      expected.scopes ?? [],
    );
    expect(await hasPlatformWriter(db, { resource })).toBe(
      expected.scopes?.includes("platform:write") ?? false,
    );
    const foreign = await memberAccess(db, other.id, ids[3]!);
    expect(foreign.targets[0]!.permission).toEqual({
      allowed: false,
      reason: endpoint!.disabled ? "context" : "capability",
    });
    return permission;
  }
  await check({ allowed: false, reason: "capability" });
  const [capability] = await db
    .insert(organizationCapabilities)
    .values({
      id: createId(),
      organizationId: org.id,
      resource,
      grantKind: "admin_session",
      scopes: ["read", "write", "platform:write"],
    })
    .returning();
  const permission = await check({ allowed: true, scopes: ["read", "write"] });
  if (!permission.allowed) throw new Error("Expected direct admin permission");
  expect(permission).toMatchObject({
    reason: "approved",
    grantType: "admin_session",
    subjectType: "user",
    organization: { id: org.id },
    subject: { userId: member!.userId, memberId },
    client: null,
    resource: {
      id: endpoint!.id,
      identifier: resource,
      revision: endpoint!.revision,
      scopeCeiling: endpoint!.allowedScopes,
    },
    requestedScopes: null,
  });
  expect(permission.evidence.capabilities).toMatchObject([
    { id: capability!.id, grantKind: "admin_session" },
  ]);
  expect(permission.evidence.assignments).toMatchObject([
    { id: common.id },
    { id: grouped.id, groupMembership: { groupRevision: 1 } },
  ]);
  await db
    .update(oauthResources)
    .set({ allowedScopes: ["read", "write", "platform:write"] })
    .where(eq(oauthResources.id, endpoint!.id));
  await check({ allowed: true, scopes: ["platform:write", "read", "write"] });
  for (const values of [
    { validUntil: past },
    { validUntil: null, validFrom: future },
    { validFrom: null, status: "disabled" as const },
  ]) {
    await db
      .update(organizationCapabilities)
      .set(values)
      .where(eq(organizationCapabilities.id, capability!.id));
    await check({ allowed: false, reason: "capability" });
  }
  await db
    .update(organizationCapabilities)
    .set({ status: "active", scopes: ["admin"] })
    .where(eq(organizationCapabilities.id, capability!.id));
  await check({ allowed: false, reason: "scope" });
  await db
    .update(oauthResources)
    .set({ disabled: true })
    .where(eq(oauthResources.id, endpoint!.id));
  endpoint!.disabled = true;
  await check({ allowed: false, reason: "context" });
});
