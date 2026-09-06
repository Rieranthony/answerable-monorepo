import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { testEnvironment } from "../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../db/client.ts";
import { createOrganization } from "../db/queries/organizations.ts";
import { createId } from "../lib/id.ts";
import {
  users,
  members,
  oauthClients,
  oauthResources,
  auditEvents,
} from "../db/schema/index.ts";
import { createGroup, addGroupMember } from "../db/queries/groups.ts";
import { createEntitlement } from "../db/queries/entitlements.ts";
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
import { getMemberAccess, listTargetAccess } from "./access.ts";
test("access service checks organisation, member and target existence without auditing reads", async () => {
  const { db, org, other, ids, resource, clientId } = await seed();
  await createEntitlement(db, {
    organizationId: org.id,
    memberId: ids[0]!,
    resource,
    scopes: ["read"],
  });
  await createEntitlement(db, {
    organizationId: org.id,
    memberId: ids[0]!,
    clientId,
    scopes: ["openid"],
  });
  expect(await getMemberAccess(db, org.id, ids[0]!)).toMatchObject({
    effective: true,
    targets: [
      expect.objectContaining({ id: resource }),
      expect.objectContaining({ id: clientId }),
    ],
  });
  expect(await getMemberAccess(db, org.id, ids[2]!)).toEqual({
    effective: false,
    targets: [],
  });
  expect(await getMemberAccess(db, org.id, ids[1]!)).toEqual({
    effective: true,
    targets: [],
  });
  for (const [organizationId, memberId] of [
    [createId(), ids[0]!],
    [org.id, ids[3]!],
    [other.id, ids[0]!],
    [org.id, createId()],
  ])
    await expect(
      getMemberAccess(db, organizationId!, memberId!),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
  for (const target of [{ resource }, { clientId }]) {
    const page = await listTargetAccess(db, org.id, target, { limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      memberId: ids[0],
      email: "person0@example.com",
      name: "Person 0",
    });
    expect(page.nextCursor).toBeNull();
    expect(await listTargetAccess(db, other.id, target, { limit: 1 })).toEqual({
      items: [],
      nextCursor: null,
    });
    await expect(
      listTargetAccess(db, createId(), target, { limit: 1 }),
    ).rejects.toMatchObject({ status: 404 });
  }
  for (const target of [
    { resource: "https://none.example" },
    { clientId: "missing" },
  ])
    await expect(
      listTargetAccess(db, org.id, target, { limit: 1 }),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
  expect(await db.select().from(auditEvents)).toEqual([]);
});
