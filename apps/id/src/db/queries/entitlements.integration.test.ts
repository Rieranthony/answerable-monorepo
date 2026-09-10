import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { testEnvironment } from "../../__tests__/support.ts";
import { createDatabase, type DatabaseConnection } from "../client.ts";
import { createOrganization } from "../../__tests__/organization-queries.ts";
import { createId } from "../../lib/id.ts";
import {
  users,
  members,
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
import * as queries from "../../__tests__/entitlement-queries.ts";
test("entitlement CRUD filters, pagination and organisation isolation", async () => {
  const { db, org, other, group, ids, resource, clientId } = await seed();
  const a = await createEntitlement(db, {
    organizationId: org.id,
    resource,
    scopes: ["read"],
  });
  const b = await createEntitlement(db, {
    organizationId: org.id,
    resource,
    groupId: group.id,
    scopes: ["write"],
    validFrom: past,
    validUntil: future,
  });
  const c = await createEntitlement(db, {
    organizationId: org.id,
    clientId,
    memberId: ids[0]!,
    scopes: ["openid"],
  });
  await createEntitlement(db, {
    organizationId: other.id,
    resource,
    scopes: ["read"],
  });
  expect(await queries.findEntitlement(db, org.id, a.id)).toEqual(a);
  expect(
    (await queries.listEntitlements(db, org.id, { limit: 1 })).map(
      (row) => row.id,
    ),
  ).toEqual([c.id, b.id]);
  expect(
    (
      await queries.listEntitlements(db, org.id, { limit: 1, cursor: b.id })
    ).map((row) => row.id),
  ).toEqual([a.id]);
  for (const [filter, expected] of [
    [{ resource }, [b.id, a.id]],
    [{ clientId }, [c.id]],
    [{ memberId: ids[0] }, [c.id]],
    [{ groupId: group.id }, [b.id]],
  ] as const) {
    expect(
      (
        await queries.listEntitlements(db, org.id, { limit: 10, ...filter })
      ).map((row) => row.id),
    ).toEqual([...expected]);
  }
  expect(
    await queries.updateEntitlement(db, org.id, b.id, {
      scopes: ["admin"],
      validFrom: null,
    }),
  ).toMatchObject({ scopes: ["admin"], validFrom: null, validUntil: future });
  expect(
    await queries.setEntitlementStatus(db, org.id, b.id, "disabled"),
  ).toMatchObject({ status: "disabled" });
  expect(
    (
      await queries.listEntitlements(db, org.id, {
        limit: 10,
        status: "disabled",
      })
    ).map((row) => row.id),
  ).toEqual([b.id]);
  expect(
    await queries.setEntitlementStatus(db, org.id, b.id, "active"),
  ).toMatchObject({ status: "active" });
  const missingOrganizationId = createId();
  for (const organizationId of [other.id, missingOrganizationId]) {
    if (organizationId === missingOrganizationId)
      await expect(
        queries.findEntitlement(db, organizationId, a.id),
      ).rejects.toMatchObject({ status: 404 });
    else
      expect(
        await queries.findEntitlement(db, organizationId, a.id),
      ).toBeNull();
    expect(
      await queries.updateEntitlement(db, organizationId, a.id, {
        validUntil: null,
      }),
    ).toBeNull();
    expect(
      await queries.setEntitlementStatus(db, organizationId, a.id, "disabled"),
    ).toBeNull();
    await queries.deleteEntitlement(db, organizationId, a.id);
  }
  expect(await queries.findEntitlement(db, org.id, a.id)).toEqual(a);
  await queries.deleteEntitlement(db, org.id, a.id);
  expect(await queries.findEntitlement(db, org.id, a.id)).toBeNull();
});
