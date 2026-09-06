import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { testEnvironment } from "../../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../client.ts";
import { createOrganization } from "./organizations.ts";
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
import { createGroup, addGroupMember } from "./groups.ts";
import { createEntitlement } from "./entitlements.ts";
let connection: DatabaseConnection;
beforeAll(() => {
  connection = createDatabase(testEnvironment());
});
beforeEach(async () => {
  await connection.db.execute(
    sql`truncate table audit_events, organizations, users, oauth_clients, oauth_resources cascade`,
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
import { memberAccess, targetAccess } from "./access.ts";
test("access uses the grant policy, unions scopes and keeps every effective source", async () => {
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
  ).toEqual([
    {
      organizationId: org.id,
      organizationSlug: org.slug,
      scopes: ["admin", "read", "write"],
    },
  ]);
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
